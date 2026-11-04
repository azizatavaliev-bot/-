# Снимок кода

Актуально на коммит `94fae23`.

## `package.json`

```json
{
  "name": "whatsapp-sales-bot",
  "version": "1.0.0",
  "description": "WhatsApp-бот для продажи услуги с ИИ-диалогом на базе Claude",
  "main": "src/index.js",
  "type": "commonjs",
  "scripts": {
    "start": "node src/index.js"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.32.1",
    "@whiskeysockets/baileys": "^6.7.9",
    "dotenv": "^16.4.5",
    "pino": "^9.4.0",
    "qrcode-terminal": "^0.12.0"
  }
}
```

## `.env.example`

```
# Ключ API Claude (https://console.anthropic.com/)
ANTHROPIC_API_KEY=

# Модель Claude для диалога
CLAUDE_MODEL=claude-sonnet-5

# Номер/контакт владельца бота, куда пересылать заявки на покупку (в формате 79991234567@s.whatsapp.net), необязательно
OWNER_NOTIFY_JID=
```

## `.gitignore`

```
node_modules/
.env
auth_info/
*.log
```

## `src/config.js`

```js
// Настройте здесь описание вашей услуги, цену и стиль общения бота.
// Именно этот текст видит ИИ и на его основе ведёт диалог с клиентом.
module.exports = {
  business: {
    name: 'Моя компания',
    service: 'Опишите здесь вашу услугу: что именно вы продаёте, для кого она, какую проблему решает.',
    price: 'Укажите цену или диапазон цен (например: "от 5000 руб." или "10000 руб. за консультацию").',
    workingHours: 'Например: с 10:00 до 20:00 по будням',
  },

  // Системный промпт для ИИ — можно донастроить тон и правила общения
  systemPrompt: ({ business }) => `Ты — менеджер по продажам компании "${business.name}" в WhatsApp.
Ты продаёшь следующую услугу: ${business.service}
Цена: ${business.price}
Часы работы: ${business.workingHours}

Правила общения:
- Отвечай дружелюбно, кратко и по делу, как живой менеджер, а не робот.
- Задавай уточняющие вопросы, чтобы понять потребность клиента.
- Мягко подводи клиента к покупке/записи, но не будь навязчивым.
- Если клиент готов купить или записаться — попроси у него имя и удобное время/способ связи, и сообщи, что дальше свяжется менеджер.
- Если не знаешь ответа на вопрос — честно скажи, что уточнишь у менеджера.
- Не выдумывай факты о компании, которых нет в этом описании.
- Пиши на языке, на котором пишет клиент.`,

  // Сколько последних сообщений диалога хранить в памяти для контекста
  historyLimit: 20,
};
```

## `src/index.js`

```js
require('dotenv').config();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

const { getReply } = require('./ai');
const { getHistory, addMessage } = require('./store');

const logger = pino({ level: 'silent' });

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('Отсканируйте этот QR-код в WhatsApp (Связанные устройства):');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('Соединение закрыто.', shouldReconnect ? 'Переподключаюсь...' : 'Нужна повторная авторизация.');
      if (shouldReconnect) {
        startBot();
      }
    } else if (connection === 'open') {
      console.log('Бот подключён к WhatsApp и готов к работе.');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;

      const jid = msg.key.remoteJid;
      if (!jid || jid === 'status@broadcast') continue;

      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        '';

      if (!text) continue;

      try {
        await sock.sendPresenceUpdate('composing', jid);

        addMessage(jid, 'user', text);
        const history = getHistory(jid);
        const reply = await getReply(history);
        addMessage(jid, 'assistant', reply);

        await sock.sendMessage(jid, { text: reply });
      } catch (err) {
        console.error('Ошибка обработки сообщения:', err);
        await sock.sendMessage(jid, {
          text: 'Извините, произошла техническая ошибка. Мы уже разбираемся, попробуйте написать чуть позже.',
        });
      }
    }
  });
}

startBot().catch((err) => {
  console.error('Не удалось запустить бота:', err);
  process.exit(1);
});
```

## `src/ai.js`

```js
const Anthropic = require('@anthropic-ai/sdk');
const config = require('./config');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const model = process.env.CLAUDE_MODEL || 'claude-sonnet-5';

async function getReply(history) {
  const system = config.systemPrompt(config);

  const response = await client.messages.create({
    model,
    max_tokens: 500,
    system,
    messages: history.map((m) => ({ role: m.role, content: m.text })),
  });

  const textBlock = response.content.find((block) => block.type === 'text');
  return textBlock ? textBlock.text : 'Извините, не смог сформировать ответ. Попробуйте ещё раз.';
}

module.exports = { getReply };
```

## `src/store.js`

```js
const config = require('./config');

// Простое хранилище истории диалогов в памяти (на один процесс).
// Для продакшена стоит заменить на БД (Redis/Postgres).
const conversations = new Map();

function getHistory(jid) {
  if (!conversations.has(jid)) {
    conversations.set(jid, []);
  }
  return conversations.get(jid);
}

function addMessage(jid, role, text) {
  const history = getHistory(jid);
  history.push({ role, text });
  if (history.length > config.historyLimit) {
    history.splice(0, history.length - config.historyLimit);
  }
}

module.exports = { getHistory, addMessage };
```
