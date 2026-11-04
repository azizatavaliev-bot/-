import 'dotenv/config';
import crypto from 'node:crypto';
import { db } from './db.js';
import { hashPassword } from './security.js';
import { createServer } from './server.js';
import { startTelegram } from './telegram.js';
import { startScheduler } from './scheduler.js';

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));

if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
  const login = (process.env.OWNER_LOGIN || 'owner').toLowerCase();
  const pw = process.env.OWNER_PASSWORD || crypto.randomBytes(9).toString('base64url');
  db.prepare("INSERT INTO users (login,pass_hash,name,role,created_at) VALUES (?,?,?,'owner',?)").run(login, hashPassword(pw), 'Владелец', Date.now());
  console.log(`[setup] создан владелец. Логин: ${login}  Пароль: ${process.env.OWNER_PASSWORD ? '(из OWNER_PASSWORD)' : pw}`);
}
if (!process.env.ANTHROPIC_API_KEY) console.warn('[warn] ANTHROPIC_API_KEY не задан — советник и бот-диалог работать не будут (отчёты и сводки работают).');

const port = Number(process.env.PORT) || 3000;
createServer().listen(port, '0.0.0.0', () => console.log(`[panel] http://localhost:${port}`));
startScheduler();
startTelegram();
