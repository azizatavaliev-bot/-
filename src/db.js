import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'agent.db'));
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chats (
  jid TEXT PRIMARY KEY,
  name TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  is_group INTEGER DEFAULT 0,
  mode TEXT DEFAULT NULL,          -- off | client | owner ; NULL = как "режим по умолчанию"
  prompt TEXT DEFAULT '',          -- доп. инструкции только для этого чата
  ads_read INTEGER DEFAULT 0,      -- можно читать статистику рекламы
  ads_write INTEGER DEFAULT 0,     -- можно менять рекламу (после подтверждения)
  reminders INTEGER DEFAULT 0,     -- можно ставить напоминания (в режиме owner включено всегда)
  paused_until INTEGER DEFAULT 0,  -- человек вмешался — бот молчит до этого времени (ms)
  last_message_at INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jid TEXT NOT NULL,
  role TEXT NOT NULL,              -- user | assistant | human (ты сам ответил с телефона)
  text TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_jid ON messages (jid, id);
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jid TEXT NOT NULL,               -- куда отправить
  kind TEXT NOT NULL DEFAULT 'text', -- text | task (агент выполняет задачу и шлёт результат)
  text TEXT NOT NULL,
  due_at INTEGER NOT NULL,         -- UTC ms
  repeat TEXT NOT NULL DEFAULT 'none', -- none | daily | weekdays | weekly
  local_time TEXT DEFAULT '',      -- HH:mm в часовом поясе — для повторов
  done INTEGER DEFAULT 0,
  created_by TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pending_actions (
  id TEXT PRIMARY KEY,
  jid TEXT NOT NULL,
  tool TEXT NOT NULL,
  args TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' -- pending | done | cancelled | expired
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  jid TEXT,
  action TEXT NOT NULL,
  detail TEXT
);
`);

export const DEFAULT_SETTINGS = {
  business_name: 'Моя компания',
  business_info:
    'Опишите здесь услугу, цены, условия, график работы, частые вопросы и ответы. Именно из этого текста агент отвечает клиентам.',
  tone: 'Дружелюбно, коротко и по делу, как живой менеджер. Пиши на языке клиента.',
  default_mode: 'off', // что делать с НОВЫМИ чатами: off | client
  owner_numbers: '', // номера владельца через запятую, только цифры (996555123456)
  timezone: process.env.TZ_DEFAULT || 'Asia/Bishkek',
  model: process.env.CLAUDE_MODEL || 'claude-sonnet-5-5',
  history_limit: '30',
  handoff_minutes: '60', // сколько молчать после того, как ты сам написал в чат
  reply_delay_sec: '3', // «человеческая» пауза и склейка быстрых сообщений
  ads_account_id: process.env.META_AD_ACCOUNT_ID || '',
  ads_max_budget_change_pct: '30', // максимум изменения бюджета за одно действие
  ads_max_daily_budget: '0', // абсолютный потолок дневного бюджета в валюте аккаунта; 0 = без потолка
  group_trigger: '', // слово-триггер в группах (например "бот"); пусто = только @упоминание
};

export function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : DEFAULT_SETTINGS[key] ?? '';
}
export function setSetting(key, value) {
  if (!(key in DEFAULT_SETTINGS)) throw new Error(`Неизвестная настройка: ${key}`);
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    String(value ?? ''),
  );
}
export function allSettings() {
  const out = {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) out[k] = getSetting(k);
  return out;
}

export function audit(jid, action, detail = '') {
  db.prepare('INSERT INTO audit (ts, jid, action, detail) VALUES (?, ?, ?, ?)').run(
    Date.now(),
    jid || null,
    action,
    typeof detail === 'string' ? detail : JSON.stringify(detail),
  );
}

// ---------- чаты ----------
export function upsertChat(jid, { name, phone, isGroup } = {}) {
  const row = db.prepare('SELECT jid FROM chats WHERE jid = ?').get(jid);
  const now = Date.now();
  if (!row) {
    db.prepare('INSERT INTO chats (jid, name, phone, is_group, last_message_at) VALUES (?, ?, ?, ?, ?)').run(
      jid,
      name || '',
      phone || '',
      isGroup ? 1 : 0,
      now,
    );
  } else {
    db.prepare(
      'UPDATE chats SET last_message_at = ?, name = COALESCE(NULLIF(?, \'\'), name), phone = COALESCE(NULLIF(?, \'\'), phone) WHERE jid = ?',
    ).run(now, name || '', phone || '', jid);
  }
  return getChat(jid);
}
export function getChat(jid) {
  return db.prepare('SELECT * FROM chats WHERE jid = ?').get(jid);
}
export function listChats() {
  return db.prepare('SELECT * FROM chats ORDER BY last_message_at DESC').all();
}
const CHAT_FIELDS = ['name', 'mode', 'prompt', 'ads_read', 'ads_write', 'reminders', 'paused_until'];
export function updateChat(jid, patch) {
  const sets = [];
  const vals = [];
  for (const f of CHAT_FIELDS) {
    if (f in patch) {
      sets.push(`${f} = ?`);
      let v = patch[f];
      if (['ads_read', 'ads_write', 'reminders'].includes(f)) v = v ? 1 : 0;
      if (f === 'mode' && !['off', 'client', 'owner', null, ''].includes(v)) throw new Error('mode: off|client|owner');
      if (f === 'mode' && v === '') v = null;
      vals.push(v);
    }
  }
  if (!sets.length) return getChat(jid);
  db.prepare(`UPDATE chats SET ${sets.join(', ')} WHERE jid = ?`).run(...vals, jid);
  return getChat(jid);
}

// ---------- сообщения ----------
export function addMessage(jid, role, text) {
  db.prepare('INSERT INTO messages (jid, role, text, ts) VALUES (?, ?, ?, ?)').run(jid, role, text, Date.now());
}
export function getMessages(jid, limit = 30) {
  return db
    .prepare('SELECT role, text, ts FROM (SELECT * FROM messages WHERE jid = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC')
    .all(jid, limit);
}
export function clearMessages(jid) {
  db.prepare('DELETE FROM messages WHERE jid = ?').run(jid);
}
