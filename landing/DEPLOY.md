# Деплой на Railway

Railway подходит этому проекту лучше, чем serverless-хостинг: обычный
Node-процесс, переменные окружения в интерфейсе и постоянный диск, на котором
живут заявки. Значит заработают и файл с лидами, и страница `/admin.html`,
и выгрузка в CSV — без Telegram как единственного канала.

## Шаги

1. **railway.app** → войти через GitHub → **New Project** → **Deploy from GitHub repo**
2. Выбрать этот репозиторий, ветку `claude/gallant-tesla-nwmits`
3. **Settings → Root Directory** → указать `landing`
4. **Variables** → добавить:

   | Переменная | Значение |
   |---|---|
   | `SESSION_SECRET` | длинная случайная строка, задаётся один раз |
   | `ADMIN_KEY` | пароль к списку заявок |
   | `LEADS_DIR` | `/data` |
   | `TELEGRAM_BOT_TOKEN` | токен от @BotFather |
   | `TELEGRAM_CHAT_ID` | ваш id от @userinfobot |

   `SESSION_SECRET` удобно сгенерировать так:
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

5. **Settings → Volumes** → создать том, точка монтирования `/data`.
   Без тома заявки будут теряться при каждом передеплое.
6. **Settings → Networking → Generate Domain** — получите рабочую ссылку.

Порт Railway передаёт сам через `PORT`, трогать его не нужно.

## Проверка после деплоя

- Открыть сайт — таймер должен стартовать с `24:00:00`
- Отправить тестовую анкету — она придёт в Telegram и появится в
  `/admin.html?key=ВАШ_КЛЮЧ`
- Перезайти на сайт — таймер продолжается, а не начинается заново

## Свой домен

**Settings → Networking → Custom Domain**, добавить CNAME у регистратора.
Под https cookie автоматически получает флаг `Secure`.
