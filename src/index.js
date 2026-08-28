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
