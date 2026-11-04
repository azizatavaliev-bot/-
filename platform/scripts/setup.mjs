// Создаёт .env с готовыми секретами. Запуск: npm run setup
import fs from 'node:fs';
import crypto from 'node:crypto';

if (fs.existsSync('.env')) { console.log('.env уже есть — ничего не меняю. Удали его, если нужно начать заново.'); process.exit(0); }
const rnd = (n) => crypto.randomBytes(n).toString('base64url');
const password = rnd(9);
let env = fs.readFileSync('.env.example', 'utf8');
env = env
  .replace(/^OWNER_PASSWORD=.*$/m, `OWNER_PASSWORD=${password}`)
  .replace(/^APP_SECRET=.*$/m, `APP_SECRET=${rnd(32)}`);
fs.writeFileSync('.env', env, { mode: 0o600 });
console.log(`
✅ Создан .env с секретами.

Вход в платформу:  http://localhost:3000
Логин:   owner
Пароль:  ${password}

Для первого теста ничего больше не нужно: подключи токен Facebook в проекте.
Позже в .env добавь ANTHROPIC_API_KEY (советник) и TELEGRAM_BOT_TOKEN (бот).
⚠️ Сохрани APP_SECRET: без него сохранённые токены не расшифровать.
`);
