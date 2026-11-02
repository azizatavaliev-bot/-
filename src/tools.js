import crypto from 'node:crypto';
import { db, getSetting, audit } from './db.js';
import * as meta from './meta.js';
import { localToUtc, fmtLocal, nextRepeat } from './time.js';

// Колбэк отправки сообщений владельцу устанавливается из index.js (чтобы не было циклических импортов).
let notifyOwnerImpl = async () => {};
export function setNotifyOwner(fn) { notifyOwnerImpl = fn; }

const CONFIRM_TTL_MS = 30 * 60 * 1000;
const WRITE_TOOLS = new Set(['ads_set_status', 'ads_set_budget', 'ads_create_ad']);

const S = (props, required = []) => ({ type: 'object', properties: props, required });
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });

const DEFS = {
  // ----- напоминания -----
  set_reminder: {
    description:
      'Поставить напоминание или регулярную автозадачу. when — локальное время владельца в формате "YYYY-MM-DD HH:mm" (используй текущее время из системного промпта, чтобы посчитать «завтра», «через 2 часа»). kind="text" — отправить текст как есть; kind="task" — в момент срабатывания агент сам выполнит задачу (например, соберёт отчёт по рекламе) и пришлёт результат.',
    input_schema: S(
      {
        when: str('Локальное время "YYYY-MM-DD HH:mm"'),
        text: str('Текст напоминания или описание задачи'),
        kind: str('text | task', { enum: ['text', 'task'] }),
        repeat: str('none | daily | weekdays | weekly', { enum: ['none', 'daily', 'weekdays', 'weekly'] }),
        target: str('here — в этот чат, owner — владельцу (по умолчанию owner в режиме owner)', { enum: ['here', 'owner'] }),
      },
      ['when', 'text'],
    ),
    perm: (c) => c.mode === 'owner' || c.chat.reminders,
  },
  list_reminders: {
    description: 'Показать активные напоминания и автозадачи.',
    input_schema: S({}),
    perm: (c) => c.mode === 'owner' || c.chat.reminders,
  },
  cancel_reminder: {
    description: 'Отменить напоминание по id.',
    input_schema: S({ id: { type: 'integer' } }, ['id']),
    perm: (c) => c.mode === 'owner' || c.chat.reminders,
  },
  // ----- эскалация -----
  notify_owner: {
    description:
      'Сообщить владельцу о важном (клиент готов купить, жалоба, вопрос вне твоей компетенции, нужна оплата). Кратко: кто, что хочет, что нужно сделать.',
    input_schema: S({ message: str('Суть для владельца') }, ['message']),
    perm: (c) => c.mode === 'client',
  },
  // ----- чтение рекламы -----
  ads_account_info: {
    description: 'Рекламный аккаунт: валюта, статус, баланс, лимиты.',
    input_schema: S({}),
    perm: (c) => c.adsRead,
  },
  ads_insights: {
    description:
      'Статистика рекламы: расход, показы, клики, CTR, CPC, CPM, результаты (лиды/переписки/покупки) и цена результата. name_contains фильтрует кампании по части названия — так выбирается «направление». level: campaign|adset|ad|account. Для «сегодня» date_preset="today", «вчера» — "yesterday", неделя — "last_7d". Для произвольного периода since/until (YYYY-MM-DD). daily=true — разбивка по дням.',
    input_schema: S({
      date_preset: str('today|yesterday|last_3d|last_7d|last_14d|last_30d|this_month|last_month|maximum'),
      since: str('YYYY-MM-DD'),
      until: str('YYYY-MM-DD'),
      level: str('account|campaign|adset|ad', { enum: ['account', 'campaign', 'adset', 'ad'] }),
      name_contains: str('Часть названия кампании (направление)'),
      daily: { type: 'boolean' },
    }),
    perm: (c) => c.adsRead,
  },
  ads_list_campaigns: {
    description: 'Список кампаний со статусом и бюджетом. Можно фильтровать по части названия и effective_status (ACTIVE, PAUSED...).',
    input_schema: S({ name_contains: str('Часть названия'), status: str('ACTIVE|PAUSED|ARCHIVED') }),
    perm: (c) => c.adsRead,
  },
  ads_list_adsets: {
    description: 'Группы объявлений (адсеты): статус, бюджет, краткое описание таргетинга.',
    input_schema: S({ campaign_id: str('ID кампании (необязательно)'), status: str('ACTIVE|PAUSED') }),
    perm: (c) => c.adsRead,
  },
  ads_list_ads: {
    description: 'Объявления с названием креатива.',
    input_schema: S({ adset_id: str(''), campaign_id: str(''), status: str('ACTIVE|PAUSED') }),
    perm: (c) => c.adsRead,
  },
  // ----- изменение рекламы (только через подтверждение) -----
  ads_set_status: {
    description:
      'Включить (ACTIVE) или остановить (PAUSED) кампанию/адсет/объявление. НЕ выполняется сразу: создаёт запрос на подтверждение. Покажи пользователю summary и дождись его «да» в СЛЕДУЮЩЕМ сообщении, затем вызови confirm_action.',
    input_schema: S({ entity_id: str('ID кампании/адсета/объявления'), status: str('ACTIVE|PAUSED', { enum: ['ACTIVE', 'PAUSED'] }) }, ['entity_id', 'status']),
    perm: (c) => c.adsWrite,
  },
  ads_set_budget: {
    description:
      'Изменить дневной бюджет кампании или адсета (в валюте аккаунта, например 25.5). Есть лимиты безопасности на размер изменения. Требует подтверждения (см. ads_set_status).',
    input_schema: S({ entity_id: str(''), daily_budget: { type: 'number' } }, ['entity_id', 'daily_budget']),
    perm: (c) => c.adsWrite,
  },
  ads_create_ad: {
    description:
      'Создать новое объявление с новым креативом (картинка по публичному URL) в существующем адсете. Создаётся в статусе PAUSED; включение — отдельным подтверждением через ads_set_status. Требует подтверждения.',
    input_schema: S(
      {
        adset_id: str(''), name: str('Название объявления'), page_id: str('ID Facebook-страницы'),
        link: str('Ссылка назначения (сайт или wa.me/…)'), message: str('Основной текст'),
        headline: str('Заголовок'), image_url: str('Публичный URL картинки'),
        cta: str('LEARN_MORE|WHATSAPP_MESSAGE|SIGN_UP|SHOP_NOW|CONTACT_US|GET_QUOTE|BOOK_TRAVEL'),
      },
      ['adset_id', 'name', 'page_id', 'link', 'message', 'image_url'],
    ),
    perm: (c) => c.adsWrite,
  },
  confirm_action: {
    description: 'Выполнить ранее предложенное действие после явного согласия пользователя в ответном сообщении.',
    input_schema: S({ action_id: str('ID из ответа инструмента') }, ['action_id']),
    perm: (c) => c.adsWrite,
  },
  cancel_action: {
    description: 'Отменить предложенное действие.',
    input_schema: S({ action_id: str('') }, ['action_id']),
    perm: (c) => c.adsWrite,
  },
};

export function toolsFor(ctx) {
  return Object.entries(DEFS)
    .filter(([, d]) => d.perm(ctx))
    .map(([name, d]) => ({ name, description: d.description, input_schema: d.input_schema }));
}

// ---------- выполнение ----------
export async function runTool(name, input, ctx) {
  const def = DEFS[name];
  if (!def || !def.perm(ctx)) return { error: `Инструмент ${name} недоступен в этом чате.` };
  try {
    const out = await impl[name](input || {}, ctx);
    audit(ctx.jid, `tool:${name}`, { input, ok: !out?.error });
    return out;
  } catch (e) {
    audit(ctx.jid, `tool_error:${name}`, { input, error: e.message });
    return { error: e.message };
  }
}

function propose(ctx, tool, args, summary) {
  const id = crypto.randomBytes(3).toString('hex');
  db.prepare(
    'INSERT INTO pending_actions (id, jid, tool, args, summary, created_at, run_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, ctx.jid, tool, JSON.stringify(args), summary, Date.now(), ctx.runId);
  return {
    status: 'needs_confirmation',
    action_id: id,
    summary,
    instruction: 'Покажи summary пользователю и спроси подтверждение. Ничего не выполнено. Вызывай confirm_action только после ответа «да» в следующем сообщении.',
  };
}

const checkBudget = async (id, newAmount) => {
  const cur = await meta.getEntity(id);
  const old = cur.daily_budget;
  if (old === undefined) throw new Error('У этого объекта нет дневного бюджета (возможно, бюджет на уровне кампании или lifetime).');
  const maxPct = Number(getSetting('ads_max_budget_change_pct')) || 0;
  const cap = Number(getSetting('ads_max_daily_budget')) || 0;
  if (cap > 0 && newAmount > cap) throw new Error(`Выше потолка дневного бюджета ${cap}. Потолок меняется в настройках.`);
  if (maxPct > 0 && old > 0) {
    const pct = (Math.abs(newAmount - old) / old) * 100;
    if (pct > maxPct) throw new Error(`Изменение ${pct.toFixed(0)}% больше лимита ${maxPct}% за раз (сейчас ${old}). Меняй шагами или подними лимит в настройках.`);
  }
  return cur;
};

const impl = {
  async set_reminder({ when, text, kind = 'text', repeat = 'none', target }, ctx) {
    const tz = getSetting('timezone');
    const due = localToUtc(when, tz);
    if (due == null) return { error: 'Неверный формат when. Нужно "YYYY-MM-DD HH:mm".' };
    if (due < Date.now() - 60_000) return { error: 'Это время уже прошло.' };
    if (kind === 'task' && ctx.mode !== 'owner') return { error: 'Автозадачи доступны только владельцу.' };
    let jid = ctx.jid;
    if (ctx.mode === 'owner' && target !== 'here') jid = ctx.ownerJid || ctx.jid;
    const localTime = when.trim().slice(11, 16);
    const r = db
      .prepare('INSERT INTO reminders (jid, kind, text, due_at, repeat, local_time, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(jid, kind, text, due, repeat, localTime, ctx.jid, Date.now());
    return { ok: true, id: Number(r.lastInsertRowid), fires_at: fmtLocal(due, tz), repeat };
  },
  async list_reminders(_, ctx) {
    const tz = getSetting('timezone');
    const rows = ctx.mode === 'owner'
      ? db.prepare('SELECT * FROM reminders WHERE done = 0 ORDER BY due_at').all()
      : db.prepare('SELECT * FROM reminders WHERE done = 0 AND jid = ? ORDER BY due_at').all(ctx.jid);
    return rows.map((r) => ({ id: r.id, kind: r.kind, text: r.text, fires_at: fmtLocal(r.due_at, tz), repeat: r.repeat }));
  },
  async cancel_reminder({ id }, ctx) {
    const row = db.prepare('SELECT * FROM reminders WHERE id = ? AND done = 0').get(id);
    if (!row) return { error: 'Не найдено.' };
    if (ctx.mode !== 'owner' && row.jid !== ctx.jid) return { error: 'Не найдено.' };
    db.prepare('UPDATE reminders SET done = 1 WHERE id = ?').run(id);
    return { ok: true };
  },
  async notify_owner({ message }, ctx) {
    const who = ctx.chat.name || ctx.chat.phone || ctx.jid;
    await notifyOwnerImpl(`🔔 Чат: ${who} (${ctx.chat.phone || ctx.jid})\n${message}`);
    return { ok: true, note: 'Владелец уведомлён. Скажи клиенту, что менеджер скоро свяжется.' };
  },

  async ads_account_info() {
    return meta.accountInfo();
  },
  async ads_insights(a) {
    const r = await meta.insights({
      datePreset: a.date_preset, since: a.since, until: a.until,
      level: a.level === 'account' ? 'account' : a.level || 'campaign',
      nameContains: a.name_contains, daily: a.daily,
    });
    if (r.rows.length > 60) r.rows = r.rows.slice(0, 60), (r.truncated = true);
    return r;
  },
  async ads_list_campaigns(a) {
    return meta.listCampaigns({ nameContains: a.name_contains, status: a.status });
  },
  async ads_list_adsets(a) {
    return meta.listAdsets({ campaignId: a.campaign_id, status: a.status });
  },
  async ads_list_ads(a) {
    return meta.listAds({ adsetId: a.adset_id, campaignId: a.campaign_id, status: a.status });
  },

  async ads_set_status({ entity_id, status }, ctx) {
    const cur = await meta.getEntity(entity_id);
    return propose(ctx, 'ads_set_status', { entity_id, status }, `«${cur.name}» (${entity_id}): ${cur.status} → ${status}`);
  },
  async ads_set_budget({ entity_id, daily_budget }, ctx) {
    const cur = await checkBudget(entity_id, daily_budget);
    return propose(ctx, 'ads_set_budget', { entity_id, daily_budget }, `«${cur.name}» (${entity_id}): дневной бюджет ${cur.daily_budget} → ${daily_budget}`);
  },
  async ads_create_ad(a, ctx) {
    return propose(ctx, 'ads_create_ad', a, `Новое объявление «${a.name}» в адсете ${a.adset_id}, картинка ${a.image_url}, заголовок «${a.headline || ''}», ссылка ${a.link}. Будет создано на паузе.`);
  },

  async confirm_action({ action_id }, ctx) {
    const row = db.prepare("SELECT * FROM pending_actions WHERE id = ? AND status = 'pending'").get(action_id);
    if (!row || row.jid !== ctx.jid) return { error: 'Нет такого ожидающего действия.' };
    if (row.run_id === ctx.runId) return { error: 'Подтверждение должно прийти от пользователя отдельным сообщением. Спроси его.' };
    if (Date.now() - row.created_at > CONFIRM_TTL_MS) {
      db.prepare("UPDATE pending_actions SET status = 'expired' WHERE id = ?").run(action_id);
      return { error: 'Запрос устарел (30 мин). Предложи действие заново.' };
    }
    const a = JSON.parse(row.args);
    let result;
    if (row.tool === 'ads_set_status') result = await meta.setStatus(a.entity_id, a.status);
    else if (row.tool === 'ads_set_budget') {
      await checkBudget(a.entity_id, a.daily_budget); // перепроверка лимитов в момент выполнения
      result = await meta.setDailyBudget(a.entity_id, a.daily_budget);
    } else if (row.tool === 'ads_create_ad') {
      result = await meta.createAdWithCreative({
        adsetId: a.adset_id, name: a.name, pageId: a.page_id, link: a.link, message: a.message,
        headline: a.headline, imageUrl: a.image_url, cta: a.cta,
      });
    } else return { error: 'Неизвестное действие.' };
    db.prepare("UPDATE pending_actions SET status = 'done' WHERE id = ?").run(action_id);
    audit(ctx.jid, 'ads_write', { tool: row.tool, args: a, result });
    return { ok: true, result };
  },
  async cancel_action({ action_id }, ctx) {
    db.prepare("UPDATE pending_actions SET status = 'cancelled' WHERE id = ? AND jid = ? AND status = 'pending'").run(action_id, ctx.jid);
    return { ok: true };
  },
};

export { WRITE_TOOLS, nextRepeat };
