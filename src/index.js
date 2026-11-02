import 'dotenv/config';
import crypto from 'node:crypto';
import { createServer } from './server.js';
import { startWhatsApp, wa } from './whatsapp.js';
import { onIncoming, notifyOwners } from './handler.js';
import { startScheduler } from './scheduler.js';
import { setNotifyOwner } from './tools.js';

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));

if (!process.env.ADMIN_PASSWORD) {
  process.env.ADMIN_PASSWORD = crypto.randomBytes(9).toString('base64url');
  console.log(`[panel] ADMIN_PASSWORD не задан — временный пароль на этот запуск: ${process.env.ADMIN_PASSWORD}`);
}
if (!process.env.ANTHROPIC_API_KEY) console.warn('[warn] ANTHROPIC_API_KEY не задан — агент отвечать не сможет.');

setNotifyOwner(notifyOwners);
wa.onMessage = onIncoming;

const port = Number(process.env.PORT) || 3000;
createServer().listen(port, '0.0.0.0', () => console.log(`[panel] http://localhost:${port}`));
startScheduler();
startWhatsApp().catch((e) => console.error('[wa] старт не удался', e));
