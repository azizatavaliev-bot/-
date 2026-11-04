import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
fs.mkdirSync(DATA_DIR, { recursive: true });
export const db = new DatabaseSync(path.join(DATA_DIR, 'platform.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  login TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'employee',      -- owner | employee
  active INTEGER NOT NULL DEFAULT 1,
  tg_chat_id TEXT,                            -- привязанный Telegram
  tg_code TEXT, tg_code_exp INTEGER,          -- одноразовый код привязки
  digest INTEGER NOT NULL DEFAULT 1,          -- утренняя сводка в Telegram
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  ad_account_id TEXT NOT NULL DEFAULT '',
  token_enc TEXT NOT NULL DEFAULT '',
  token_status TEXT NOT NULL DEFAULT 'none',   -- none | ok | invalid | expiring
  token_expires_at INTEGER,                    -- NULL = бессрочный или неизвестно
  token_checked_at INTEGER,
  token_note TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL DEFAULT 'USD',
  name_filter TEXT NOT NULL DEFAULT '',        -- брать в отчёт только кампании, где в названии есть это
  result_type TEXT NOT NULL DEFAULT 'auto',    -- auto | lead | messages | purchase | link_click
  client_fee REAL NOT NULL DEFAULT 0,          -- сколько клиент платит в месяц
  fee_currency TEXT NOT NULL DEFAULT 'USD',
  employee_pct REAL NOT NULL DEFAULT 0,        -- % от оплаты клиента — исполнителю
  owner_pct REAL NOT NULL DEFAULT 0,           -- % от оплаты клиента — владельцу
  status TEXT NOT NULL DEFAULT 'active',       -- active | archived
  started_at TEXT, ended_at TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS daily_reports (
  project_id INTEGER NOT NULL REFERENCES projects(id),
  date TEXT NOT NULL,                          -- YYYY-MM-DD в часовом поясе рекламного аккаунта
  spend REAL NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  results REAL NOT NULL DEFAULT 0,
  result_type TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'auto',         -- auto | manual
  note TEXT NOT NULL DEFAULT '',
  auto_spend REAL, auto_results REAL,          -- что насчитал Facebook (для сверки с ручной правкой)
  partial INTEGER NOT NULL DEFAULT 0,          -- день ещё идёт
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, date)
);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, channel TEXT NOT NULL,
  role TEXT NOT NULL, text TEXT NOT NULL, ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_msg ON messages (user_id, channel, id);
CREATE TABLE IF NOT EXISTS pending_actions (
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, project_id INTEGER NOT NULL, tool TEXT NOT NULL,
  args TEXT NOT NULL, summary TEXT NOT NULL, created_at INTEGER NOT NULL, run_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, user_id INTEGER, project_id INTEGER,
  action TEXT NOT NULL, detail TEXT
);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
`);

export const DEFAULTS = {
  timezone: process.env.TZ_DEFAULT || 'Asia/Bishkek',
  model: process.env.CLAUDE_MODEL || 'claude-sonnet-5-5',
  digest_hour: '9',                // во сколько слать утреннюю сводку (по timezone)
  max_budget_change_pct: '30',
  history_limit: '24',
};
export const getSetting = (k) => db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value ?? DEFAULTS[k] ?? '';
export function setSetting(k, v) {
  if (!(k in DEFAULTS)) throw new Error(`Неизвестная настройка: ${k}`);
  db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));
}
export const allSettings = () => Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, getSetting(k)]));
export const kvGet = (k) => db.prepare('SELECT value FROM kv WHERE key=?').get(k)?.value ?? null;
export const kvSet = (k, v) => db.prepare('INSERT INTO kv (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));

export function audit(userId, projectId, action, detail = '') {
  db.prepare('INSERT INTO audit (ts,user_id,project_id,action,detail) VALUES (?,?,?,?,?)').run(
    Date.now(), userId ?? null, projectId ?? null, action, typeof detail === 'string' ? detail : JSON.stringify(detail),
  );
}
