import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { db, allSettings, setSetting, audit, getSetting, kvGet } from './db.js';
import { hashPassword, verifyPassword, encrypt, randomCode } from './security.js';
import { checkToken, syncProject, analyze } from './sync.js';
import { exchangeToken, normAccount } from './meta.js';
import { salaryForMonth } from './salary.js';
import { runAgent, clearHistory } from './agent.js';
import { runTool, visibleProjects } from './tools.js';
import { telegramEnabled } from './telegram.js';
import { utcToLocalParts } from './time.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_MS = 7 * 24 * 3600 * 1000;
const attempts = new Map();

const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p.length === 2).map(([k, v]) => [k, decodeURIComponent(v)]));
const pub = (u) => u && ({ id: u.id, login: u.login, name: u.name, role: u.role, active: u.active, telegram: Boolean(u.tg_chat_id), digest: u.digest });
const safeProject = (p) => { const { token_enc, ...rest } = p; return { ...rest, has_token: Boolean(token_enc) }; };
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

export function createServer() {
  const app = express();
  app.disable('x-powered-by'); app.set('trust proxy', 1);
  app.use(express.json({ limit: '300kb' }));
  app.use((req, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'no-referrer'); next(); });

  app.post('/api/login', (req, res) => {
    const key = `${req.ip}`, now = Date.now();
    const recent = (attempts.get(key) || []).filter((t) => now - t < 15 * 60_000);
    if (recent.length >= 10) return res.status(429).json({ error: 'Слишком много попыток. Подожди 15 минут.' });
    recent.push(now); attempts.set(key, recent);
    const u = db.prepare('SELECT * FROM users WHERE login = ? AND active = 1').get(String(req.body?.login || '').trim().toLowerCase());
    if (!u || !verifyPassword(req.body?.password ?? '', u.pass_hash)) return res.status(401).json({ error: 'Неверный логин или пароль' });
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions (token,user_id,expires) VALUES (?,?,?)').run(token, u.id, now + SESSION_MS);
    res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${req.secure ? '; Secure' : ''}`);
    res.json({ user: pub(u) });
  });

  const auth = (req, res, next) => {
    const t = cookies(req).sid;
    const s = t && db.prepare('SELECT * FROM sessions WHERE token = ? AND expires > ?').get(t, Date.now());
    const u = s && db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(s.user_id);
    if (!u) return res.status(401).json({ error: 'auth' });
    req.user = u; req.sid = t; next();
  };
  const owner = (req, res, next) => (req.user.role === 'owner' ? next() : res.status(403).json({ error: 'Только для владельца' }));
  const wrap = (fn) => (req, res) => Promise.resolve().then(() => fn(req, res)).catch((e) => res.status(400).json({ error: e.message }));

  app.use(express.static(path.join(__dirname, 'public')));
  app.use('/api', auth);

  app.post('/api/logout', (req, res) => { db.prepare('DELETE FROM sessions WHERE token = ?').run(req.sid); res.setHeader('Set-Cookie', 'sid=; Max-Age=0; Path=/'); res.json({ ok: true }); });
  app.get('/api/me', (req, res) => res.json({
    user: pub(req.user),
    config: { telegram: telegramEnabled(), bot: kvGet('bot_username'), app_configured: Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET), timezone: getSetting('timezone') },
  }));
  app.put('/api/me', wrap((req, res) => {
    if ('digest' in req.body) db.prepare('UPDATE users SET digest = ? WHERE id = ?').run(req.body.digest ? 1 : 0, req.user.id);
    if (req.body.name) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(String(req.body.name).slice(0, 80), req.user.id);
    res.json({ ok: true });
  }));
  app.post('/api/me/password', wrap((req, res) => {
    if (!verifyPassword(req.body?.old ?? '', req.user.pass_hash)) throw new Error('Старый пароль неверный');
    if (String(req.body?.new || '').length < 8) throw new Error('Новый пароль — минимум 8 символов');
    db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(req.body.new), req.user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(req.user.id, req.sid);
    res.json({ ok: true });
  }));
  app.post('/api/me/telegram-code', wrap((req, res) => {
    const code = randomCode(6);
    db.prepare('UPDATE users SET tg_code = ?, tg_code_exp = ? WHERE id = ?').run(code, Date.now() + 15 * 60_000, req.user.id);
    res.json({ code, bot: kvGet('bot_username'), expires_min: 15 });
  }));
  app.delete('/api/me/telegram', wrap((req, res) => { db.prepare('UPDATE users SET tg_chat_id = NULL WHERE id = ?').run(req.user.id); res.json({ ok: true }); }));

  // ---- дашборд ----
  app.get('/api/dashboard', (req, res) => {
    const today = utcToLocalParts(Date.now(), getSetting('timezone')).date;
    const items = visibleProjects(req.user).map((p) => {
      const a = analyze(p);
      const spark = db.prepare('SELECT date,spend,results FROM daily_reports WHERE project_id=? ORDER BY date DESC LIMIT 14').all(p.id).reverse();
      return { ...safeProject(p), analysis: a, spark };
    });
    res.json({ today, projects: items });
  });

  // ---- проекты ----
  const OWNER_ONLY = ['client_fee', 'fee_currency', 'employee_pct', 'owner_pct', 'user_id', 'started_at', 'ended_at', 'status'];
  const EDITABLE = ['name', 'ad_account_id', 'name_filter', 'result_type', ...OWNER_ONLY];
  const getOwned = (req) => {
    const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(req.params.id));
    if (!p || (req.user.role !== 'owner' && p.user_id !== req.user.id)) throw new Error('Проект не найден');
    return p;
  };
  app.get('/api/projects', (req, res) => res.json({ projects: visibleProjects(req.user, { all: true }).map(safeProject) }));
  app.post('/api/projects', wrap((req, res) => {
    const b = req.body || {};
    if (!String(b.name || '').trim()) throw new Error('Укажи название проекта');
    const isOwner = req.user.role === 'owner';
    const userId = isOwner && b.user_id ? Number(b.user_id) : req.user.id;
    if (!db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').get(userId)) throw new Error('Сотрудник не найден');
    const r = db.prepare(`INSERT INTO projects (user_id,name,ad_account_id,name_filter,result_type,client_fee,fee_currency,employee_pct,owner_pct,started_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(userId, String(b.name).trim(), normAccount(b.ad_account_id), String(b.name_filter || ''), b.result_type || 'auto',
      isOwner ? num(b.client_fee) : 0, isOwner ? (b.fee_currency || 'USD') : 'USD', isOwner ? num(b.employee_pct) : 0, isOwner ? num(b.owner_pct) : 0, b.started_at || null, Date.now());
    audit(req.user.id, Number(r.lastInsertRowid), 'project_create', b.name);
    res.json({ id: Number(r.lastInsertRowid) });
  }));
  app.put('/api/projects/:id', wrap((req, res) => {
    const p = getOwned(req); const b = req.body || {};
    const sets = [], vals = [];
    for (const f of EDITABLE) {
      if (!(f in b)) continue;
      if (OWNER_ONLY.includes(f) && req.user.role !== 'owner') continue;
      let v = b[f];
      if (['client_fee', 'employee_pct', 'owner_pct'].includes(f)) v = num(v);
      if (f === 'ad_account_id') v = normAccount(v);
      if (f === 'status' && !['active', 'archived'].includes(v)) throw new Error('status: active|archived');
      if (f === 'result_type' && !['auto', 'lead', 'messages', 'purchase', 'link_click'].includes(v)) throw new Error('Неверный тип результата');
      if (f === 'status' && v === 'archived' && !p.ended_at && !('ended_at' in b)) { sets.push('ended_at = ?'); vals.push(utcToLocalParts(Date.now(), getSetting('timezone')).date); }
      if (f === 'status' && v === 'active' && !('ended_at' in b)) { sets.push('ended_at = NULL'); }
      if (['started_at', 'ended_at'].includes(f)) v = v || null;
      sets.push(`${f} = ?`); vals.push(v);
    }
    if (f_pct_over(b, p)) throw new Error('Сумма процентов исполнителя и владельца больше 100');
    if (sets.length) db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...vals, p.id);
    audit(req.user.id, p.id, 'project_update', Object.keys(b));
    res.json({ project: safeProject(db.prepare('SELECT * FROM projects WHERE id = ?').get(p.id)) });
  }));
  function f_pct_over(b, p) { return num(b.employee_pct ?? p.employee_pct) + num(b.owner_pct ?? p.owner_pct) > 100; }

  app.post('/api/projects/:id/token', wrap(async (req, res) => {
    const p = getOwned(req);
    const token = String(req.body?.token || '').trim();
    if (token.length < 20) throw new Error('Токен выглядит неправильно (слишком короткий)');
    if (req.body?.ad_account_id) db.prepare('UPDATE projects SET ad_account_id = ? WHERE id = ?').run(normAccount(req.body.ad_account_id), p.id);
    db.prepare("UPDATE projects SET token_enc = ?, token_status = 'none' WHERE id = ?").run(encrypt(token), p.id);
    audit(req.user.id, p.id, 'token_set');
    const fresh = db.prepare('SELECT * FROM projects WHERE id = ?').get(p.id);
    const check = await checkToken(fresh);
    let backfill = null;
    if (check.status === 'ok' || check.status === 'expiring') backfill = await syncProject(db.prepare('SELECT * FROM projects WHERE id = ?').get(p.id), { days: 14 }).catch((e) => ({ error: e.message }));
    res.json({ check, backfill });
  }));
  app.delete('/api/projects/:id/token', wrap((req, res) => {
    const p = getOwned(req);
    db.prepare("UPDATE projects SET token_enc = '', token_status = 'none', token_expires_at = NULL, token_note = '' WHERE id = ?").run(p.id);
    audit(req.user.id, p.id, 'token_removed'); res.json({ ok: true });
  }));
  app.post('/api/projects/:id/check', wrap(async (req, res) => res.json(await checkToken(getOwned(req)))));
  app.post('/api/projects/:id/sync', wrap(async (req, res) => res.json(await syncProject(getOwned(req), { days: Math.min(60, Math.max(1, num(req.body?.days, 7))) }))));

  // ---- отчёты ----
  app.get('/api/reports', wrap((req, res) => {
    const ids = visibleProjects(req.user, { all: true }).map((p) => p.id);
    const pid = req.query.project ? Number(req.query.project) : null;
    if (pid && !ids.includes(pid)) throw new Error('Проект не найден');
    const to = req.query.to || utcToLocalParts(Date.now(), getSetting('timezone')).date;
    const from = req.query.from || utcToLocalParts(Date.now() - 13 * 86400000, getSetting('timezone')).date;
    const use = pid ? [pid] : ids;
    if (!use.length) return res.json({ rows: [] });
    const q = `SELECT r.*, p.name AS project, p.currency FROM daily_reports r JOIN projects p ON p.id = r.project_id WHERE r.project_id IN (${use.map(() => '?').join(',')}) AND r.date BETWEEN ? AND ? ORDER BY r.date DESC, p.name`;
    res.json({ rows: db.prepare(q).all(...use, from, to) });
  }));
  app.put('/api/reports/:pid/:date', wrap(async (req, res) => {
    const out = await runTool('edit_report', { project: req.params.pid, date: req.params.date, spend: req.body.spend, results: req.body.results, note: req.body.note }, { user: req.user, runId: 'web' });
    if (out.error) throw new Error(out.error);
    res.json(out);
  }));
  app.post('/api/reports/:pid/:date/reset', wrap((req, res) => {
    const p = db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(req.params.pid));
    if (!p || (req.user.role !== 'owner' && p.user_id !== req.user.id)) throw new Error('Проект не найден');
    db.prepare("UPDATE daily_reports SET spend = COALESCE(auto_spend, spend), results = COALESCE(auto_results, results), source = 'auto', note = '' WHERE project_id = ? AND date = ?").run(p.id, req.params.date);
    audit(req.user.id, p.id, 'report_reset', req.params.date); res.json({ ok: true });
  }));

  // ---- зарплаты ----
  app.get('/api/salary', wrap((req, res) => {
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : utcToLocalParts(Date.now(), getSetting('timezone')).date.slice(0, 7);
    res.json(salaryForMonth(month, req.user.role === 'owner' ? {} : { userId: req.user.id }));
  }));

  // ---- команда ----
  app.get('/api/users', owner, (req, res) => res.json({ users: db.prepare('SELECT * FROM users ORDER BY name, login').all().map((u) => ({ ...pub(u), projects: db.prepare("SELECT COUNT(*) n FROM projects WHERE user_id = ? AND status = 'active'").get(u.id).n })) }));
  app.post('/api/users', owner, wrap((req, res) => {
    const { login, password, name, role = 'employee' } = req.body || {};
    const l = String(login || '').trim().toLowerCase();
    if (!/^[a-z0-9._-]{3,32}$/.test(l)) throw new Error('Логин: 3–32 символа, латиница/цифры/._-');
    if (String(password || '').length < 8) throw new Error('Пароль — минимум 8 символов');
    if (!['owner', 'employee'].includes(role)) throw new Error('Неверная роль');
    if (db.prepare('SELECT 1 FROM users WHERE login = ?').get(l)) throw new Error('Такой логин уже есть');
    const r = db.prepare('INSERT INTO users (login,pass_hash,name,role,created_at) VALUES (?,?,?,?,?)').run(l, hashPassword(password), String(name || '').slice(0, 80), role, Date.now());
    audit(req.user.id, null, 'user_create', l); res.json({ id: Number(r.lastInsertRowid) });
  }));
  app.put('/api/users/:id', owner, wrap((req, res) => {
    const id = Number(req.params.id), b = req.body || {};
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!u) throw new Error('Не найден');
    if (id === req.user.id && (b.active === false || (b.role && b.role !== 'owner'))) throw new Error('Нельзя отключить или разжаловать самого себя');
    if ('name' in b) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(String(b.name).slice(0, 80), id);
    if ('active' in b) { db.prepare('UPDATE users SET active = ? WHERE id = ?').run(b.active ? 1 : 0, id); if (!b.active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id); }
    if (b.role) { if (!['owner', 'employee'].includes(b.role)) throw new Error('Неверная роль'); db.prepare('UPDATE users SET role = ? WHERE id = ?').run(b.role, id); }
    if (b.password) { if (String(b.password).length < 8) throw new Error('Пароль — минимум 8 символов'); db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(b.password), id); db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id); }
    audit(req.user.id, null, 'user_update', { id, fields: Object.keys(b) }); res.json({ ok: true });
  }));

  // ---- чат с советником (то же ядро, что и Telegram) ----
  app.get('/api/chat', (req, res) => res.json({ messages: db.prepare("SELECT role,text FROM (SELECT * FROM messages WHERE user_id=? AND channel='web' ORDER BY id DESC LIMIT 40) ORDER BY id").all(req.user.id) }));
  app.post('/api/chat', wrap(async (req, res) => {
    if (req.body?.reset) { clearHistory(req.user.id, 'web'); return res.json({ ok: true }); }
    const text = String(req.body?.text || '').trim();
    if (!text) throw new Error('Пустое сообщение');
    res.json({ reply: await runAgent({ user: req.user, channel: 'web', text }) });
  }));

  // ---- инструменты ----
  app.post('/api/tools/exchange-token', wrap(async (req, res) => {
    const appId = req.body?.app_id || process.env.META_APP_ID, appSecret = req.body?.app_secret || process.env.META_APP_SECRET;
    if (!appId || !appSecret || !req.body?.short_token) throw new Error('Нужны App ID, App Secret и короткий токен');
    const r = await exchangeToken({ appId, appSecret, shortToken: String(req.body.short_token).trim() });
    audit(req.user.id, null, 'token_exchange');
    res.json({ token: r.token, expires_days: r.expiresInSec ? Math.round(r.expiresInSec / 86400) : null });
  }));

  // ---- настройки и журнал (владелец) ----
  app.get('/api/settings', owner, (req, res) => res.json({ settings: allSettings() }));
  app.put('/api/settings', owner, wrap((req, res) => { for (const [k, v] of Object.entries(req.body || {})) setSetting(k, v); res.json({ settings: allSettings() }); }));
  app.get('/api/audit', owner, (req, res) => res.json({ rows: db.prepare('SELECT a.*, u.login FROM audit a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 150').all() }));

  return app;
}
