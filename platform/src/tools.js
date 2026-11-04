import crypto from 'node:crypto';
import { db, getSetting, audit } from './db.js';
import * as meta from './meta.js';
import { creds, syncProject, analyze } from './sync.js';
import { salaryForMonth } from './salary.js';
import { utcToLocalParts } from './time.js';

const CONFIRM_TTL = 30 * 60 * 1000;
const S = (properties, required = []) => ({ type: 'object', properties, required });
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const PROJ = str('ID или часть названия проекта');

export const visibleProjects = (user, { all = false } = {}) =>
  (user.role === 'owner'
    ? db.prepare(`SELECT p.*, u.name AS user_name FROM projects p JOIN users u ON u.id=p.user_id ${all ? '' : "WHERE p.status='active'"} ORDER BY p.name`).all()
    : db.prepare(`SELECT p.*, u.name AS user_name FROM projects p JOIN users u ON u.id=p.user_id WHERE p.user_id=? ${all ? '' : "AND p.status='active'"} ORDER BY p.name`).all(user.id));

export function resolveProject(user, ref, { needAds = false } = {}) {
  const list = visibleProjects(user);
  let found = [];
  if (ref !== undefined && ref !== null && ref !== '') {
    const s = String(ref).trim().toLowerCase();
    found = list.filter((p) => String(p.id) === s);
    if (!found.length) found = list.filter((p) => p.name.toLowerCase() === s);
    if (!found.length) found = list.filter((p) => p.name.toLowerCase().includes(s));
  } else if (list.length === 1) found = list;
  if (found.length === 0) throw new Error(ref ? `Проект «${ref}» не найден среди доступных тебе.` : 'Укажи проект.');
  if (found.length > 1) throw new Error(`Под «${ref}» подходит несколько проектов: ${found.map((p) => `${p.name} (#${p.id})`).join(', ')}. Уточни.`);
  const p = found[0];
  if (needAds && (!p.token_enc || !p.ad_account_id)) throw new Error(`У проекта «${p.name}» не подключён Facebook-аккаунт.`);
  return p;
}

const DEFS = {
  list_projects: { description: 'Проекты пользователя: статус токена, ставка, валюта.', input_schema: S({}) },
  get_reports: {
    description: 'Дневные отчёты (расход, показы, клики, результаты) из базы платформы за период. Быстро, без обращения к Facebook. По умолчанию последние 7 дней. Без project — по всем доступным проектам.',
    input_schema: S({ project: PROJ, from: str('YYYY-MM-DD'), to: str('YYYY-MM-DD') }),
  },
  live_insights: {
    description: 'Свежая статистика прямо из Facebook (для «сколько потратили сегодня», разбивка по кампаниям/группам/объявлениям). level: campaign|adset|ad. date_preset: today|yesterday|last_7d|last_30d|this_month|last_month или since/until.',
    input_schema: S({ project: PROJ, date_preset: str(''), since: str(''), until: str(''), level: str('', { enum: ['campaign', 'adset', 'ad'] }), name_contains: str('часть названия кампании') }, ['project']),
  },
  list_entities: {
    description: 'Кампании, группы или объявления проекта со статусом и бюджетом.',
    input_schema: S({ project: PROJ, kind: str('', { enum: ['campaigns', 'adsets', 'ads'] }), parent_id: str('ID кампании/группы'), status: str('ACTIVE|PAUSED'), name_contains: str('') }, ['project', 'kind']),
  },
  analyze_project: {
    description: 'Данные для советника: флаги проблем, вчера vs среднее за неделю, 14 дней динамики и разбивка по кампаниям за 7 дней. Используй перед рекомендациями.',
    input_schema: S({ project: PROJ }, ['project']),
  },
  sync_now: { description: 'Обновить отчёты из Facebook прямо сейчас (последние 2 дня). Без project — все проекты.', input_schema: S({ project: PROJ }) },
  edit_report: {
    description: 'Исправить дневной отчёт вручную (расход/результаты/заметка). Помечается как ручная правка и сверяется с Facebook.',
    input_schema: S({ project: PROJ, date: str('YYYY-MM-DD'), spend: { type: 'number' }, results: { type: 'number' }, note: str('Причина правки') }, ['project', 'date']),
  },
  my_salary: { description: 'Начисления за месяц YYYY-MM (по умолчанию текущий): по проектам и итого. Владелец видит всех.', input_schema: S({ month: str('YYYY-MM') }) },
  team_overview: { description: 'Только владелец: все проекты команды — вчерашний расход/результаты и флаги проблем.', input_schema: S({}), ownerOnly: true },
  ads_set_status: {
    description: 'Включить/остановить кампанию, группу или объявление. НЕ выполняется сразу — возвращает запрос на подтверждение. Покажи summary, дождись «да» в СЛЕДУЮЩЕМ сообщении, затем confirm_action.',
    input_schema: S({ project: PROJ, entity_id: str(''), status: str('', { enum: ['ACTIVE', 'PAUSED'] }) }, ['project', 'entity_id', 'status']),
  },
  ads_set_budget: {
    description: 'Изменить дневной бюджет кампании/группы (в валюте аккаунта). Есть лимит изменения за раз. Требует подтверждения, как ads_set_status.',
    input_schema: S({ project: PROJ, entity_id: str(''), daily_budget: { type: 'number' } }, ['project', 'entity_id', 'daily_budget']),
  },
  confirm_action: { description: 'Выполнить предложенное действие после явного «да» пользователя в отдельном сообщении.', input_schema: S({ action_id: str('') }, ['action_id']) },
  cancel_action: { description: 'Отменить предложенное действие.', input_schema: S({ action_id: str('') }, ['action_id']) },
};

export function toolsFor(user) {
  return Object.entries(DEFS).filter(([, d]) => !d.ownerOnly || user.role === 'owner')
    .map(([name, d]) => ({ name, description: d.description, input_schema: d.input_schema }));
}

export async function runTool(name, input, ctx) {
  const def = DEFS[name];
  if (!def || (def.ownerOnly && ctx.user.role !== 'owner')) return { error: `Инструмент ${name} недоступен.` };
  try {
    const out = await impl[name](input || {}, ctx);
    audit(ctx.user.id, out?.project_id ?? null, `tool:${name}`, { input, ok: !out?.error });
    return out;
  } catch (e) {
    audit(ctx.user.id, null, `tool_error:${name}`, { input, error: e.message });
    return { error: e.message };
  }
}

function propose(ctx, p, tool, args, summary) {
  const id = crypto.randomBytes(3).toString('hex');
  db.prepare('INSERT INTO pending_actions (id,user_id,project_id,tool,args,summary,created_at,run_id) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, ctx.user.id, p.id, tool, JSON.stringify(args), summary, Date.now(), ctx.runId);
  return { status: 'needs_confirmation', action_id: id, summary, instruction: 'Ничего не выполнено. Покажи summary и спроси «подтверждаешь?». confirm_action — только после «да» в следующем сообщении.' };
}
async function checkBudget(c, id, amount) {
  const cur = await meta.getEntity(c, id);
  const old = cur.daily_budget;
  if (old === undefined) throw new Error('У этого объекта нет дневного бюджета (бюджет на другом уровне или lifetime).');
  const maxPct = Number(getSetting('max_budget_change_pct')) || 0;
  if (maxPct > 0 && old > 0) {
    const pct = (Math.abs(amount - old) / old) * 100;
    if (pct > maxPct) throw new Error(`Изменение на ${pct.toFixed(0)}% больше лимита ${maxPct}% за раз (сейчас ${old}). Меняй шагами.`);
  }
  return cur;
}

const todayIn = (tz) => utcToLocalParts(Date.now(), tz).date;
const addDays = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

const impl = {
  async list_projects(_, { user }) {
    return visibleProjects(user).map((p) => ({
      id: p.id, name: p.name, owner: p.user_name, currency: p.currency, token: p.token_status, token_note: p.token_note,
      name_filter: p.name_filter || null, client_fee: p.client_fee, fee_currency: p.fee_currency, employee_pct: p.employee_pct,
    }));
  },
  async get_reports({ project, from, to }, { user }) {
    const list = project ? [resolveProject(user, project)] : visibleProjects(user);
    const end = to || todayIn(getSetting('timezone')), start = from || addDays(end, -6);
    const out = [];
    for (const p of list) {
      const rows = db.prepare('SELECT date,spend,impressions,clicks,results,result_type,source,partial,note FROM daily_reports WHERE project_id=? AND date BETWEEN ? AND ? ORDER BY date').all(p.id, start, end);
      const spend = rows.reduce((s, r) => s + r.spend, 0), results = rows.reduce((s, r) => s + r.results, 0);
      out.push({ project: p.name, project_id: p.id, currency: p.currency, total_spend: Math.round(spend * 100) / 100, total_results: results, cost_per_result: results ? Math.round((spend / results) * 100) / 100 : null, days: rows });
    }
    return { from: start, to: end, projects: out };
  },
  async live_insights({ project, date_preset, since, until, level, name_contains }, { user }) {
    const p = resolveProject(user, project, { needAds: true });
    const rows = await meta.liveInsights(creds(p), { datePreset: date_preset, since, until, level, nameContains: name_contains || p.name_filter || undefined });
    return { project: p.name, currency: p.currency, total_spend: Math.round(rows.reduce((s, r) => s + (r.spend || 0), 0) * 100) / 100, rows: rows.slice(0, 60) };
  },
  async list_entities({ project, kind, parent_id, status, name_contains }, { user }) {
    const p = resolveProject(user, project, { needAds: true });
    return { project: p.name, items: await meta.listEntities(creds(p), kind, { parentId: parent_id, status, nameContains: name_contains }) };
  },
  async analyze_project({ project }, { user }) {
    const p = resolveProject(user, project);
    const a = analyze(p);
    const days = db.prepare('SELECT date,spend,results,partial FROM daily_reports WHERE project_id=? ORDER BY date DESC LIMIT 14').all(p.id).reverse();
    let campaigns = null;
    if (p.token_enc && p.ad_account_id) {
      try { campaigns = (await meta.liveInsights(creds(p), { datePreset: 'last_7d', level: 'campaign', nameContains: p.name_filter || undefined })).slice(0, 25); }
      catch (e) { campaigns = `не удалось получить: ${e.message}`; }
    }
    return { project: p.name, project_id: p.id, currency: p.currency, result_type: p.result_type, ...a, last_14_days: days, campaigns_last_7d: campaigns };
  },
  async sync_now({ project }, { user }) {
    const list = project ? [resolveProject(user, project, { needAds: true })] : visibleProjects(user).filter((p) => p.token_enc);
    const res = [];
    for (const p of list) { try { res.push({ project: p.name, ...(await syncProject(p, { days: 2 })) }); } catch (e) { res.push({ project: p.name, error: e.message }); } }
    return res;
  },
  async edit_report({ project, date, spend, results, note }, { user }) {
    const p = resolveProject(user, project);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date: YYYY-MM-DD');
    const row = db.prepare('SELECT * FROM daily_reports WHERE project_id=? AND date=?').get(p.id, date);
    const now = Date.now();
    if (!row) db.prepare("INSERT INTO daily_reports (project_id,date,spend,results,source,note,updated_at) VALUES (?,?,?,?,'manual',?,?)").run(p.id, date, spend ?? 0, results ?? 0, note || '', now);
    else db.prepare("UPDATE daily_reports SET spend=?, results=?, source='manual', note=?, updated_at=? WHERE project_id=? AND date=?").run(spend ?? row.spend, results ?? row.results, note ?? row.note, now, p.id, date);
    audit(user.id, p.id, 'report_edit', { date, spend, results, note, before: row ? { spend: row.spend, results: row.results } : null });
    return { ok: true, project_id: p.id, project: p.name, date, spend: spend ?? row?.spend ?? 0, results: results ?? row?.results ?? 0 };
  },
  async my_salary({ month }, { user }) {
    const m = month || utcToLocalParts(Date.now(), getSetting('timezone')).date.slice(0, 7);
    return salaryForMonth(m, user.role === 'owner' ? {} : { userId: user.id });
  },
  async team_overview(_, { user }) {
    return visibleProjects(user).map((p) => {
      const a = analyze(p);
      return { project: p.name, project_id: p.id, employee: p.user_name, currency: p.currency, yesterday_spend: a.yesterday?.spend ?? null, yesterday_results: a.yesterday?.results ?? null, cost_per_result: a.cpl_yesterday, avg7: a.avg7, flags: a.flags.map((f) => f.text) };
    });
  },
  async ads_set_status({ project, entity_id, status }, ctx) {
    const p = resolveProject(ctx.user, project, { needAds: true });
    const cur = await meta.getEntity(creds(p), entity_id);
    return propose(ctx, p, 'ads_set_status', { entity_id, status }, `[${p.name}] «${cur.name}» (${entity_id}): ${cur.status} → ${status}`);
  },
  async ads_set_budget({ project, entity_id, daily_budget }, ctx) {
    const p = resolveProject(ctx.user, project, { needAds: true });
    const cur = await checkBudget(creds(p), entity_id, daily_budget);
    return propose(ctx, p, 'ads_set_budget', { entity_id, daily_budget }, `[${p.name}] «${cur.name}» (${entity_id}): дневной бюджет ${cur.daily_budget} → ${daily_budget} ${p.currency}`);
  },
  async confirm_action({ action_id }, { user, runId }) {
    const row = db.prepare("SELECT * FROM pending_actions WHERE id=? AND status='pending'").get(action_id);
    if (!row || row.user_id !== user.id) return { error: 'Нет такого ожидающего действия.' };
    if (row.run_id === runId) return { error: 'Подтверждение должно прийти от пользователя отдельным сообщением. Спроси его.' };
    if (Date.now() - row.created_at > CONFIRM_TTL) { db.prepare("UPDATE pending_actions SET status='expired' WHERE id=?").run(action_id); return { error: 'Запрос устарел (30 мин). Предложи заново.' }; }
    const p = resolveProject(user, row.project_id, { needAds: true });
    const a = JSON.parse(row.args), c = creds(p);
    if (row.tool === 'ads_set_status') await meta.setStatus(c, a.entity_id, a.status);
    else if (row.tool === 'ads_set_budget') { await checkBudget(c, a.entity_id, a.daily_budget); await meta.setDailyBudget(c, a.entity_id, a.daily_budget); }
    else return { error: 'Неизвестное действие.' };
    db.prepare("UPDATE pending_actions SET status='done' WHERE id=?").run(action_id);
    audit(user.id, p.id, 'ads_write', { tool: row.tool, args: a });
    return { ok: true, done: row.summary };
  },
  async cancel_action({ action_id }, { user }) {
    db.prepare("UPDATE pending_actions SET status='cancelled' WHERE id=? AND user_id=? AND status='pending'").run(action_id, user.id);
    return { ok: true };
  },
};
