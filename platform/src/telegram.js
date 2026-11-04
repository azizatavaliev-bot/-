import { db, kvGet, kvSet, audit, getSetting } from './db.js';
import { runAgent, clearHistory } from './agent.js';
import { visibleProjects } from './tools.js';
import { syncProject, analyze } from './sync.js';
import { salaryForMonth } from './salary.js';
import { utcToLocalParts } from './time.js';

const base = () => `${process.env.TELEGRAM_API_BASE || 'https://api.telegram.org'}/bot${process.env.TELEGRAM_BOT_TOKEN}`;
export const telegramEnabled = () => Boolean(process.env.TELEGRAM_BOT_TOKEN);

async function api(method, body = {}) {
  const res = await fetch(`${base()}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description || res.status}`);
  return j.result;
}
export async function sendTelegram(chatId, text) {
  for (let i = 0; i < text.length; i += 3800) await api('sendMessage', { chat_id: chatId, text: text.slice(i, i + 3800), disable_web_page_preview: true });
}
export const botInfo = () => api('getMe');

// ---------- сводки ----------
const fmt = (n) => (n == null ? '—' : Math.round(n * 100) / 100);
const todayLocal = () => utcToLocalParts(Date.now(), getSetting('timezone')).date;
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

/** kind: 'today' | 'yesterday'. Предварительно подтягивает свежие данные из Facebook. */
export async function summaryText(user, kind, { refresh = true } = {}) {
  const projects = visibleProjects(user);
  if (!projects.length) return 'У тебя пока нет проектов. Добавь их в платформе.';
  if (refresh) await Promise.all(projects.filter((p) => p.token_enc).map((p) => syncProject(p, { days: 2 }).catch(() => null)));
  const date = kind === 'today' ? todayLocal() : addDays(todayLocal(), -1);
  const lines = [], alerts = [], totals = {};
  const rows = db.prepare('SELECT * FROM daily_reports WHERE project_id=? AND date=?');
  for (const p of projects) {
    const r = rows.get(p.id, date);
    const who = user.role === 'owner' ? ` (${p.user_name})` : '';
    if (!r) { lines.push(`• ${p.name}${who} — нет данных`); }
    else {
      const cpr = r.results > 0 ? r.spend / r.results : null;
      lines.push(`• ${p.name}${who} — ${fmt(r.spend)} ${p.currency} · рез. ${fmt(r.results)} · цена ${fmt(cpr)}${r.source === 'manual' ? ' ✎' : ''}`);
      totals[p.currency] = (totals[p.currency] || 0) + r.spend;
    }
    for (const f of analyze(p).flags) alerts.push(`⚠️ ${p.name}: ${f.text}`);
  }
  const total = Object.entries(totals).map(([c, v]) => `${fmt(v)} ${c}`).join(' + ') || '—';
  return [`📊 ${kind === 'today' ? 'Сегодня (на данный момент)' : 'Вчера'} · ${date}`, ...lines, `Итого расход: ${total}`, ...(alerts.length ? ['', ...[...new Set(alerts)].slice(0, 12)] : [])].join('\n');
}

export function salaryText(user) {
  const month = todayLocal().slice(0, 7);
  const s = salaryForMonth(month, user.role === 'owner' ? {} : { userId: user.id });
  if (!s.projects.length) return `За ${month} нет проектов с начислениями.`;
  const lines = s.projects.map((p) => `• ${p.project}${user.role === 'owner' ? ` (${p.employee})` : ''}: клиент ${p.client_fee} ${p.fee_currency}, ${p.employee_pct}% → ${p.employee_amount}`);
  const mine = s.employees.map((e) => `${user.role === 'owner' ? `${e.employee}: ` : ''}${e.amount} ${e.currency}`).join('; ');
  return [`💰 Начисления за ${month}`, ...lines, `Итого к выплате: ${mine || '—'}`].join('\n');
}

export async function buildDigest(user) {
  return `☀️ Доброе утро!\n\n${await summaryText(user, 'yesterday')}`;
}

// ---------- привязка и приём сообщений ----------
const badTries = new Map();
function linkByCode(chatId, code) {
  const now = Date.now();
  const t = (badTries.get(chatId) || []).filter((x) => now - x < 15 * 60_000);
  if (t.length >= 5) return { error: 'Слишком много неверных кодов. Подожди 15 минут.' };
  const u = db.prepare('SELECT * FROM users WHERE tg_code = ? AND tg_code_exp > ? AND active = 1').get(String(code).trim().toUpperCase(), now);
  if (!u) { t.push(now); badTries.set(chatId, t); return { error: 'Код неверный или устарел. Сгенерируй новый в платформе → Профиль.' }; }
  db.prepare('UPDATE users SET tg_chat_id = NULL WHERE tg_chat_id = ? AND id != ?').run(String(chatId), u.id);
  db.prepare('UPDATE users SET tg_chat_id = ?, tg_code = NULL, tg_code_exp = NULL WHERE id = ?').run(String(chatId), u.id);
  audit(u.id, null, 'tg_linked', String(chatId));
  return { user: u };
}

const HELP = `Я помогаю вести рекламу. Пиши обычным языком:
• «сколько потратили сегодня по проекту X»
• «что с проектом X, что подкрутить?»
• «останови кампанию …» (спрошу подтверждение)
• «исправь вчерашний расход в X на 35»

Быстрые команды: /today · /yesterday · /projects · /salary · /reset`;

const busy = new Set();
export async function handleMessage(msg) {
  if (msg.chat?.type !== 'private' || !msg.text) return;
  const chatId = String(msg.chat.id);
  const text = msg.text.trim();
  const user = db.prepare('SELECT * FROM users WHERE tg_chat_id = ? AND active = 1').get(chatId);

  if (!user) {
    const m = /^\/start(?:@\w+)?\s+(\S+)/i.exec(text) || /^([A-Z0-9]{6,10})$/i.exec(text);
    if (m) {
      const r = linkByCode(chatId, m[1]);
      if (r.error) return sendTelegram(chatId, `❌ ${r.error}`);
      return sendTelegram(chatId, `✅ Привязано: ${r.user.name || r.user.login}.\n\n${HELP}`);
    }
    return sendTelegram(chatId, 'Привет! Чтобы начать, открой платформу → Профиль → «Подключить Telegram», получи код и отправь его сюда.');
  }

  if (busy.has(chatId)) return sendTelegram(chatId, 'Секунду, ещё думаю над предыдущим…');
  busy.add(chatId);
  try {
    api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    const cmd = text.split(/\s+/)[0].toLowerCase().replace(/@\w+$/, '');
    if (cmd === '/start' || cmd === '/help') return await sendTelegram(chatId, HELP);
    if (cmd === '/today') return await sendTelegram(chatId, await summaryText(user, 'today'));
    if (cmd === '/yesterday') return await sendTelegram(chatId, await summaryText(user, 'yesterday'));
    if (cmd === '/salary') return await sendTelegram(chatId, salaryText(user));
    if (cmd === '/projects') {
      const ps = visibleProjects(user);
      const ic = { ok: '🟢', expiring: '🟡', invalid: '🔴', none: '⚪' };
      return await sendTelegram(chatId, ps.length ? ps.map((p) => `${ic[p.token_status] || '⚪'} #${p.id} ${p.name}${user.role === 'owner' ? ` (${p.user_name})` : ''}`).join('\n') : 'Проектов пока нет.');
    }
    if (cmd === '/reset') { clearHistory(user.id, 'telegram'); return await sendTelegram(chatId, 'Контекст диалога очищен.'); }
    const reply = await runAgent({ user, channel: 'telegram', text });
    await sendTelegram(chatId, reply);
  } catch (e) {
    console.error('[tg]', e);
    audit(user.id, null, 'tg_error', e.message);
    await sendTelegram(chatId, `⚠️ Ошибка: ${e.message}`).catch(() => {});
  } finally { busy.delete(chatId); }
}

let running = false;
export async function startTelegram() {
  if (!telegramEnabled()) { console.log('[tg] TELEGRAM_BOT_TOKEN не задан — бот выключен'); return; }
  running = true;
  try { const me = await botInfo(); console.log(`[tg] бот @${me.username} запущен`); kvSet('bot_username', me.username); } catch (e) { console.error('[tg]', e.message); }
  let offset = Number(kvGet('tg_offset') || 0);
  while (running) {
    try {
      const updates = await api('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] });
      for (const u of updates) {
        offset = u.update_id + 1; kvSet('tg_offset', offset);
        handleMessage(u.message || {}).catch((e) => console.error('[tg]', e));
      }
    } catch (e) { console.error('[tg] poll:', e.message); await new Promise((r) => setTimeout(r, 5000)); }
  }
}
export const stopTelegram = () => { running = false; };
