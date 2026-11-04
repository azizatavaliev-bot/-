# Запуск и деплой

## 1. Проверить прямо сейчас (на своём компьютере, без деплоя)
Нужен Node.js 22.13+ (`node -v`).
```bash
cd platform
npm install
npm run setup     # создаст .env с секретами и покажет логин/пароль
npm start         # открой http://localhost:3000
```
Платформа сама ходит в Facebook и Telegram (polling), входящий адрес ей не нужен — для ручного теста первого аккаунта локального запуска достаточно. Пока компьютер выключен, отчёты не обновляются (данные за пропущенные дни подтянутся при следующем запуске — за последние 2 дня; глубже: «Обновить отчёты (14 дн.)» в проекте).

**Тест первого аккаунта:** Проекты → «Новый проект» → название + ID рекламного аккаунта → Сохранить → в карточке вставь токен → «Сохранить токен и проверить». Должно показать название аккаунта, валюту и загрузить 14 дней. Потом смотри «Дашборд» и «Отчёты». Токен: вкладка «Инструкция».

Без `ANTHROPIC_API_KEY` советник не отвечает, всё остальное (отчёты, анализ, зарплаты, сводки) работает. Telegram: создай бота у @BotFather, токен в `TELEGRAM_BOT_TOKEN`, перезапусти, в «Профиль» нажми «Подключить Telegram».

## 2. Чтобы работало 24/7 (после теста)

**VPS (самый простой и дешёвый, ~$5/мес)** — любой Ubuntu с Docker:
```bash
git clone <репозиторий> && cd <папка>/platform
npm run setup 2>/dev/null || cp .env.example .env   # заполни .env
docker compose up -d --build
```
HTTPS: Caddy → `adops.твойдомен.com { reverse_proxy 127.0.0.1:3000 }`. Пока домена нет: `ssh -L 3000:localhost:3000 user@server` и открывай http://localhost:3000.

**Fly.io**: `cd platform && fly launch --no-deploy --copy-config && fly volumes create adops_data --size 1 && fly secrets set OWNER_PASSWORD=… APP_SECRET=… ANTHROPIC_API_KEY=… TELEGRAM_BOT_TOKEN=… && fly deploy`.

**Render**: New → Blueprint → этот репозиторий (`render.yaml` в корне). План starter с диском.

Vercel/Netlify не подходят: нужен постоянный процесс и диск.

Важно: том/диск `/data` не терять (БД). `APP_SECRET` держать в надёжном месте.
