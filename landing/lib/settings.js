// Настройки доставки, которые задаются прямо в админке сайта.
//
// Переменные окружения хостинга остаются рабочим вариантом, но их не везде
// удаётся сохранить, а сюда владелец вписывает значения сам и сразу видит
// результат. Файл лежит на том же постоянном диске, что и заявки.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.LEADS_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'settings.json');

const KEYS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'SHEETS_WEBHOOK_URL'];

function readFile() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {}; // файла ещё нет или он повреждён — работаем на переменных окружения
  }
}

// Значение из админки важнее переменной окружения: последняя правка побеждает.
function get(key) {
  const saved = readFile()[key];
  if (typeof saved === 'string' && saved.trim()) return saved.trim();
  return (process.env[key] || '').trim();
}

function save(values) {
  const current = readFile();
  for (const key of KEYS) {
    if (typeof values[key] !== 'string') continue;
    const value = values[key].trim();
    if (value) current[key] = value;
    else delete current[key]; // пустая строка означает «убрать и вернуться к окружению»
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(current, null, 2));
  return status();
}

// Наружу отдаём только факт заполненности и длину — сами значения не раскрываем.
function status() {
  const result = {};
  for (const key of KEYS) {
    const value = get(key);
    result[key] = {
      задано: Boolean(value),
      длина: value.length,
      источник: readFile()[key] ? 'админка' : process.env[key] ? 'переменные хостинга' : 'нет',
    };
  }
  return result;
}

module.exports = { get, save, status, KEYS };
