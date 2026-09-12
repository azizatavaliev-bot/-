// Куда уходят заполненные анкеты.
//
// Два независимых приёмника, оба необязательные:
//   1. Файл data/leads.ndjson — работает на VPS/локально. На serverless-хостинге
//      файловая система только для чтения, поэтому ошибка записи не считается
//      фатальной: заявка не теряется, если настроен Telegram.
//   2. Telegram — если заданы TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID, заявка
//      сразу падает в личку или в рабочий чат.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LEADS_FILE = path.join(DATA_DIR, 'leads.ndjson');

const fileSink = { available: true, reason: '' };

function readAll() {
  if (!fs.existsSync(LEADS_FILE)) return [];
  return fs
    .readFileSync(LEADS_FILE, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function saveToFile(lead) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(LEADS_FILE, JSON.stringify(lead) + '\n');
    return true;
  } catch (error) {
    fileSink.available = false;
    fileSink.reason = error.code || String(error.message);
    return false;
  }
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function sendToTelegram(lead, fields) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { sent: false, reason: 'not_configured' };

  const lines = ['<b>Новая анкета NEW G</b>', ''];
  for (const field of fields) {
    const value = lead.answers[field.name];
    if (value) lines.push('<b>' + escapeHtml(field.label) + ':</b> ' + escapeHtml(value));
  }

  try {
    const response = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: lines.join('\n'), parse_mode: 'HTML' }),
    });
    if (!response.ok) return { sent: false, reason: 'http_' + response.status };
    return { sent: true };
  } catch (error) {
    return { sent: false, reason: String(error.message) };
  }
}

// Заявка считается принятой, только если сработал хотя бы один приёмник.
// Иначе лучше показать человеку ошибку и дать отправить заново, чем молча
// потерять лид: на serverless-хостинге Telegram — единственный рабочий канал.
// Лог пишется всегда, это последняя линия обороны.
async function save(lead, fields) {
  const savedToFile = saveToFile(lead);
  const telegram = await sendToTelegram(lead, fields);
  const delivered = savedToFile || telegram.sent;

  console.log('[lead]', JSON.stringify({ ...lead, file: savedToFile, telegram, delivered }));
  if (!delivered) {
    console.error('[lead] заявка никуда не доставлена — проверьте TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID');
  }
  return { savedToFile, telegram, delivered };
}

module.exports = { save, readAll, fileSink };
