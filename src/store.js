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
