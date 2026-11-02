import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import {
  db, allSettings, setSetting, DEFAULT_SETTINGS, listChats, getChat, upsertChat, updateChat,
  getMessages, clearMessages, addMessage, audit,
} from './db.js';
import { wa, sendText, logoutWhatsApp } from './whatsapp.js';
import { runAgent } from './agent.js';
import { accountInfo, metaConfigured } from './meta.js';
import { fmtLocal, localToUtc } from './time.js';
import { getSetting } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sessions = new Map(); // token -> expiresAt
const attempts = new Map(); // ip -> [timestamps]
const SESSION_MS = 7 * 24 * 3600 * 1000;

function parseCookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p.length === 2).map(([k, v]) => [k, decodeURIComponent(v)]),
  );
}
const safeEq = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};

export function createServer() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '200kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  const adminPassword = process.env.ADMIN_PASSWORD;

  app.post('/api/login', (req, res) => {
    const ip = req.ip;
    const now = Date.now();
    const recent = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60_000);
    if (recent.length >= 10) return res.status(429).json({ error: 'Слишком много попыток. Подожди 15 минут.' });
    recent.push(now);
    attempts.set(ip, recent);
    if (!adminPassword || !safeEq(req.body?.password ?? '', adminPassword)) return res.status(401).json({ error: 'Неверный пароль' });
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, now + SESSION_MS);
    const secure = req.secure ? '; Secure' : '';
    res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure}`);
    res.json({ ok: true });
  });

  const auth = (req, res, next) => {
    const t = parseCookies(req).sid;
    const exp = t && sessions.get(t);
    if (!exp || exp < Date.now()) return res.status(401).json({ error: 'auth' });
    next();
  };

  app.post('/api/logout', auth, (req, res) => {
    sessions.delete(parseCookies(req).sid);
    res.setHeader('Set-Cookie', 'sid=; Max-Age=0; Path=/');
    res.json({ ok: true });
  });

  app.use(express.static(path.join(__dirname, 'public')));
  app.use('/api', auth);
  const wrap = (fn) => (req, res) => Promise.resolve().then(() => fn(req, res)).catch((e) => res.status(400).json({ error: e.message }));

  // ---- статус ----
  app.get('/api/status', (req, res) => {
    res.json({
      wa: { status: wa.status, qr: wa.qrDataUrl, me: wa.me?.id || null },
      anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
      meta: { token: Boolean(process.env.META_ACCESS_TOKEN), account: metaConfigured() },
      time: fmtLocal(Date.now(), getSetting('timezone')),
      counts: {
        chats: db.prepare('SELECT COUNT(*) n FROM chats').get().n,
        active: db.prepare("SELECT COUNT(*) n FROM chats WHERE mode IN ('client','owner')").get().n,
        reminders: db.prepare('SELECT COUNT(*) n FROM reminders WHERE done = 0').get().n,
      },
    });
  });
  app.post('/api/wa/logout', wrap(async (req, res) => { await logoutWhatsApp(); res.json({ ok: true }); }));

  // ---- настройки ----
  app.get('/api/settings', (req, res) => res.json({ settings: allSettings(), defaults: DEFAULT_SETTINGS }));
  app.put('/api/settings', wrap((req, res) => {
    for (const [k, v] of Object.entries(req.body || {})) setSetting(k, v);
    audit(null, 'settings_update', Object.keys(req.body || {}));
    res.json({ settings: allSettings() });
  }));
  app.get('/api/meta/check', wrap(async (req, res) => res.json(await accountInfo())));

  // ---- чаты ----
  app.get('/api/chats', (req, res) => res.json({ chats: listChats().filter((c) => !c.jid.startsWith('test:')), default_mode: getSetting('default_mode') }));
  app.post('/api/chats', wrap((req, res) => {
    const n = String(req.body?.phone || '').replace(/\D/g, '');
    if (n.length < 7) throw new Error('Введи номер в международном формате, только цифры');
    const jid = `${n}@s.whatsapp.net`;
    upsertChat(jid, { name: req.body?.name || '', phone: n });
    res.json({ chat: updateChat(jid, { mode: req.body?.mode || 'client' }) });
  }));
  app.get('/api/chat', wrap((req, res) => {
    const jid = String(req.query.jid);
    const chat = getChat(jid);
    if (!chat) throw new Error('Чат не найден');
    res.json({ chat, messages: getMessages(jid, 60) });
  }));
  app.put('/api/chat', wrap((req, res) => {
    const jid = String(req.query.jid);
    if (!getChat(jid)) throw new Error('Чат не найден');
    const patch = { ...req.body };
    if (patch.unpause) { patch.paused_until = 0; delete patch.unpause; }
    res.json({ chat: updateChat(jid, patch) });
  }));
  app.delete('/api/chat/messages', wrap((req, res) => { clearMessages(String(req.query.jid)); res.json({ ok: true }); }));
  app.post('/api/chat/send', wrap(async (req, res) => {
    const jid = String(req.query.jid);
    const text = String(req.body?.text || '').trim();
    if (!text) throw new Error('Пустое сообщение');
    await sendText(jid, text);
    addMessage(jid, 'human', text);
    res.json({ ok: true });
  }));

  // ---- напоминания ----
  app.get('/api/reminders', (req, res) => {
    const tz = getSetting('timezone');
    const rows = db.prepare('SELECT * FROM reminders WHERE done = 0 ORDER BY due_at').all();
    res.json({ reminders: rows.map((r) => ({ ...r, when_local: fmtLocal(r.due_at, tz), chat: getChat(r.jid)?.name || r.jid })) });
  });
  app.post('/api/reminders', wrap((req, res) => {
    const { jid, text, when, kind = 'text', repeat = 'none' } = req.body || {};
    const due = localToUtc(when, getSetting('timezone'));
    if (!jid || !text || due == null) throw new Error('Нужны jid, text, when ("YYYY-MM-DD HH:mm")');
    const r = db.prepare('INSERT INTO reminders (jid, kind, text, due_at, repeat, local_time, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(jid, kind, text, due, repeat, String(when).slice(11, 16), 'panel', Date.now());
    res.json({ id: Number(r.lastInsertRowid) });
  }));
  app.delete('/api/reminders/:id', wrap((req, res) => {
    db.prepare('UPDATE reminders SET done = 1 WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  }));

  // ---- лог ----
  app.get('/api/audit', (req, res) => {
    res.json({ rows: db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 100').all() });
  });

  // ---- песочница: проверить агента, не трогая WhatsApp ----
  app.post('/api/test', wrap(async (req, res) => {
    const mode = req.body?.mode === 'owner' ? 'owner' : 'client';
    const jid = `test:${mode}`;
    upsertChat(jid, { name: `Тест (${mode})` });
    const chat = {
      ...getChat(jid),
      prompt: String(req.body?.prompt || ''),
      ads_read: req.body?.ads_read ? 1 : 0,
      ads_write: req.body?.ads_write ? 1 : 0,
      reminders: 1,
    };
    if (req.body?.reset) clearMessages(jid);
    const reply = await runAgent({ jid, chat, mode, text: String(req.body?.text || ''), ownerJid: jid });
    res.json({ reply });
  }));

  return app;
}
