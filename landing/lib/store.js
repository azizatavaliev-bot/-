// Хранилище на файлах в формате NDJSON (одна JSON-строка = одна запись).
// Запись только дописывается в конец файла, поэтому она устойчива к падению
// процесса и не требует внешней базы. При старте файлы читаются в память.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.ndjson');
const LEADS_FILE = path.join(DATA_DIR, 'leads.ndjson');

/** @type {Map<string, {id: string, deadline: number, createdAt: number, submittedAt: number|null}>} */
const sessions = new Map();
/** @type {Array<object>} */
const leads = [];

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null; // недописанная строка после аварийного завершения
      }
    })
    .filter(Boolean);
}

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Сессии применяются по порядку: более поздняя запись с тем же id обновляет предыдущую.
  for (const row of readLines(SESSIONS_FILE)) {
    sessions.set(row.id, { ...(sessions.get(row.id) || {}), ...row });
  }
  for (const row of readLines(LEADS_FILE)) leads.push(row);
}

function append(file, row) {
  fs.appendFileSync(file, JSON.stringify(row) + '\n');
}

function getSession(id) {
  if (!id) return null;
  return sessions.get(id) || null;
}

function createSession({ id, deadline, meta }) {
  const row = { id, deadline, createdAt: Date.now(), submittedAt: null, meta };
  sessions.set(id, row);
  append(SESSIONS_FILE, row);
  return row;
}

function markSubmitted(id) {
  const session = sessions.get(id);
  if (!session) return null;
  session.submittedAt = Date.now();
  // Дописываем «патч» — при следующей загрузке он наложится поверх исходной записи.
  append(SESSIONS_FILE, { id, submittedAt: session.submittedAt });
  return session;
}

function addLead(lead) {
  leads.push(lead);
  append(LEADS_FILE, lead);
  return lead;
}

function allLeads() {
  return leads;
}

function stats() {
  const now = Date.now();
  let active = 0;
  for (const s of sessions.values()) if (!s.submittedAt && s.deadline > now) active += 1;
  return { visitors: sessions.size, leads: leads.length, active };
}

load();

module.exports = { getSession, createSession, markSubmitted, addLead, allLeads, stats };
