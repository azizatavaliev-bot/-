import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { db, getSetting } from './db.js';
import { nowText } from './time.js';
import { toolsFor, runTool, visibleProjects } from './tools.js';

let client;
const getClient = () => (client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));

const addMsg = (uid, ch, role, text) => db.prepare('INSERT INTO messages (user_id,channel,role,text,ts) VALUES (?,?,?,?,?)').run(uid, ch, role, text, Date.now());
export const clearHistory = (uid, ch) => db.prepare('DELETE FROM messages WHERE user_id=? AND channel=?').run(uid, ch);

export function buildSystem(user) {
  const projects = visibleProjects(user).map((p) => `#${p.id} ${p.name}${user.role === 'owner' ? ` (${p.user_name})` : ''}`).join('; ') || 'пока нет';
  return `Ты — ассистент и советник-таргетолог в платформе команды, которая ведёт рекламу клиентов в Facebook/Instagram.
Пользователь: ${user.name || user.login}, роль: ${user.role === 'owner' ? 'владелец (видит всю команду)' : 'сотрудник (видит только свои проекты)'}.
Его проекты: ${projects}.
Сейчас: ${nowText(getSetting('timezone'))}.

Как работать:
- Цифры только из инструментов, не выдумывай. Всегда называй валюту проекта. Нет данных — так и скажи.
- Быстрые вопросы («сколько вчера/за неделю») — get_reports. «Сколько сегодня», разбивка по кампаниям — live_insights.
- Совет/разбор проекта: сначала analyze_project, затем конкретные рекомендации: что видно в цифрах → почему это важно → что сделать (какую кампанию/группу, на сколько изменить бюджет, что проверить в креативах/аудитории). Если данных мало для вывода (мало дней/результатов) — скажи прямо, не делай выводов на 2–3 конверсиях.
- Любое изменение рекламы (статус, бюджет): сначала инструмент-предложение, покажи summary, жди «да» отдельным сообщением, только потом confirm_action. Сам не подтверждай никогда.
- Если отчёт расходится с Facebook или пользователь просит исправить — edit_report с понятной заметкой.
- То, что нельзя сделать через API (оплата, привязка карты, обход блокировок аккаунта), скажи, что делает человек, и дай шаги.
- Формат: чат в Telegram. Коротко, по делу, сначала вывод. Без markdown-заголовков и таблиц; списки через «•». Не больше ~900 символов, если не просят подробно.`;
}

export async function runAgent({ user, channel, text }) {
  const runId = crypto.randomBytes(4).toString('hex');
  addMsg(user.id, channel, 'user', text);
  const limit = Math.max(4, Number(getSetting('history_limit')) || 24);
  const hist = db.prepare('SELECT role,text FROM (SELECT * FROM messages WHERE user_id=? AND channel=? ORDER BY id DESC LIMIT ?) ORDER BY id').all(user.id, channel, limit);
  const messages = [];
  for (const m of hist) {
    const last = messages[messages.length - 1];
    if (last && last.role === m.role) last.content += `\n${m.text}`; else messages.push({ role: m.role, content: m.text });
  }
  while (messages.length && messages[0].role !== 'user') messages.shift();

  const tools = toolsFor(user), system = buildSystem(user), model = getSetting('model');
  const ctx = { user, runId, channel };
  let reply = '';
  for (let step = 0; step < 10; step++) {
    const res = await getClient().messages.create({ model, max_tokens: 1800, system, messages, tools });
    if (res.stop_reason !== 'tool_use') { reply = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim(); break; }
    messages.push({ role: 'assistant', content: res.content });
    const results = [];
    for (const b of res.content.filter((x) => x.type === 'tool_use')) {
      const out = await runTool(b.name, b.input, ctx);
      let s = JSON.stringify(out); if (s.length > 14000) s = s.slice(0, 14000) + '…[обрезано]';
      results.push({ type: 'tool_result', tool_use_id: b.id, content: s, ...(out?.error ? { is_error: true } : {}) });
    }
    messages.push({ role: 'user', content: results });
  }
  if (!reply) reply = 'Не получилось сформировать ответ, попробуй переформулировать.';
  addMsg(user.id, channel, 'assistant', reply);
  return reply;
}
