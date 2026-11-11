// Сервер репетитора: принимает переписку и контекст ученика, вызывает Claude, возвращает ответ.
// Ключ берётся из переменной окружения ANTHROPIC_API_KEY и в браузер не попадает.
// Необязательно: ACCESS_CODE (код доступа), ANTHROPIC_MODEL, ANTHROPIC_API_URL.
const fs = require('fs');
const path = require('path');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const API_URL = process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1/messages';
const hits = new Map();

const SYSTEM = `Ты репетитор китайского языка для русскоязычного ученика. Цель ученика: HSK 1–6 и жизнь в Китае. Отвечай по-русски, коротко и по делу.

Тебе передан контекст ученика (JSON ниже): выбранные слова (selected), освоенные (mastered) и результаты по ним (results: "слово: вид_теста+ верно / вид_теста- неверно"), журнал тестов (tests), все уроки приложения (lessons: уровень HSK, номер, тема, слова "знак пиньинь перевод"), выученные карточки (learnedWords) и материалы ученика (materials).

Правила:
1. Задания строй только на словах из контекста (selected, lessons, materials, mastered), если ученик сам не просит другое. Новые слова добавляй только с пометкой.
2. Если ученик просит тест по уроку «N из HSK L», найди этот урок в lessons (lvl = L, n = N) или в materials и бери его слова.
3. Количество заданий равно ctx.count, если ученик не назвал другое число.
4. Пиньинь пиши только с тоновыми знаками.
5. Формат ответа: ТОЛЬКО JSON без markdown-обёртки: {"say":"текст","test":null}. Если нужен тест, test = {"title":"название","items":[...]}.
   Виды заданий в items:
   {"type":"card","hz":"你好","py":"nǐ hǎo","ru":"привет"}
   {"type":"quiz","q":"вопрос","opts":["a","b","c","d"],"a":0,"why":"пояснение"}  (ровно 4 варианта, a — индекс верного)
   {"type":"build","toks":["我","是","学生"],"ru":"Я студент","py":"wǒ shì xuésheng"}  (слова в правильном порядке, не больше 9)
   {"type":"write","hz":"学生","py":"xuésheng","ru":"студент"}  (слова из 1–4 знаков, ученик пишет их рукой и печатает пиньинь)
   Виды можно смешивать в одном тесте.
6. Если тест не просили (вопрос, объяснение, разбор ошибок), test = null, а say содержит ответ короткими абзацами. Для разбора ошибок опирайся на results и tests.
7. Не придумывай слов, которых нет в китайском. Если не уверен в слове или грамматике, скажи об этом.`;

function loadMaterials() {
  const dir = path.join(process.cwd(), 'materials');
  let out = '';
  try {
    for (const f of fs.readdirSync(dir).sort()) {
      if (!/\.(txt|md|json|csv|tsv)$/i.test(f) || /^readme/i.test(f)) continue;
      const t = fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 40000);
      if (out.length + t.length > 120000) break;
      out += `\n--- материал: ${f} ---\n${t}\n`;
    }
  } catch (e) { /* папки нет — не страшно */ }
  return out;
}

function limited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < 3600e3);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 60;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'no_key' });
  const need = process.env.ACCESS_CODE;
  if (need && req.headers['x-access-code'] !== need) return res.status(401).json({ error: 'code' });
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'ip';
  if (limited(ip)) return res.status(429).json({ error: 'rate' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || !Array.isArray(body.messages) || !body.messages.length) return res.status(400).json({ error: 'bad_request' });
  const messages = body.messages.slice(-16)
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.slice(0, 8000) }));
  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (!messages.length || messages[messages.length - 1].role !== 'user') return res.status(400).json({ error: 'bad_request' });

  const ctx = JSON.stringify(body.ctx || {}).slice(0, 150000);
  const system = `${SYSTEM}\n\nКонтекст ученика:\n${ctx}\n${loadMaterials()}`;
  try {
    const r = await fetch(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 4096, system, messages }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: 'upstream', status: r.status, detail: (j.error && j.error.message) || '' });
    const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    return res.status(200).json({ text });
  } catch (e) {
    return res.status(502).json({ error: 'upstream' });
  }
};
