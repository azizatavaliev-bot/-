// Meta Marketing API. Каждый вызов получает {token, accountId} конкретного проекта.
const VERSION = process.env.META_API_VERSION || 'v23.0';
const BASE = `https://graph.facebook.com/${VERSION}`;

export const normAccount = (id) => { const s = String(id || '').trim(); return s ? (s.startsWith('act_') ? s : `act_${s}`) : ''; };

async function call(token, method, path, params = {}) {
  const url = new URL(`${BASE}/${path.replace(/^\//, '')}`);
  const init = { method, headers: {} };
  const flat = {};
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) flat[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (method === 'GET') for (const [k, v] of Object.entries(flat)) url.searchParams.set(k, v);
  else { init.headers['Content-Type'] = 'application/x-www-form-urlencoded'; init.body = new URLSearchParams(flat).toString(); }
  if (token) url.searchParams.set('access_token', token);
  const res = await fetch(url, init);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const e = json.error || {};
    const err = new Error(`Meta: ${e.error_user_msg || e.message || res.statusText}${e.code ? ` (код ${e.code})` : ''}`);
    err.code = e.code; err.isAuth = e.code === 190 || e.type === 'OAuthException' && [190, 102, 463, 467].includes(e.code);
    throw err;
  }
  return json;
}

async function paged(c, path, params, max = 300) {
  const out = [];
  let res = await call(c.token, 'GET', path, { ...params, limit: 100 });
  out.push(...(res.data || []));
  while (res.paging?.next && out.length < max) {
    const r = await (await fetch(res.paging.next)).json();
    if (r.error) throw new Error(`Meta: ${r.error.message}`);
    res = r; out.push(...(r.data || []));
  }
  return out.slice(0, max);
}

// ---------- токен ----------
export async function accountInfo(c) {
  return call(c.token, 'GET', normAccount(c.accountId), { fields: 'name,account_status,currency,timezone_name,amount_spent,balance,disable_reason' });
}

/** Срок жизни токена. Нужны META_APP_ID и META_APP_SECRET платформы; без них — только проверка «работает ли». */
export async function inspectToken(token) {
  const appId = process.env.META_APP_ID, secret = process.env.META_APP_SECRET;
  if (!appId || !secret) return { known: false };
  const r = await call(`${appId}|${secret}`, 'GET', 'debug_token', { input_token: token });
  const d = r.data || {};
  return {
    known: true, valid: Boolean(d.is_valid), type: d.type, // USER | SYSTEM_USER ...
    expiresAt: d.expires_at ? d.expires_at * 1000 : null,   // 0/нет = бессрочный
    dataAccessExpiresAt: d.data_access_expires_at ? d.data_access_expires_at * 1000 : null,
    scopes: d.scopes || [], appId: d.app_id,
  };
}

/** Обмен короткого токена (≈2 ч) на длинный (≈60 дней). */
export async function exchangeToken({ appId, appSecret, shortToken }) {
  const r = await call(null, 'GET', 'oauth/access_token', {
    grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: shortToken,
  });
  return { token: r.access_token, expiresInSec: r.expires_in || null };
}

// ---------- статистика ----------
const GROUPS = {
  lead: ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead', 'onsite_web_lead'],
  messages: ['onsite_conversion.messaging_conversation_started_7d'],
  purchase: ['purchase', 'offsite_conversion.fb_pixel_purchase', 'omni_purchase'],
  link_click: ['link_click'],
};
export const RESULT_TYPES = Object.keys(GROUPS);
/** Внутри группы типы дублируют друг друга (lead и lead_grouped) — берём максимум, а не сумму. */
export function extractResults(actions = []) {
  const out = {};
  for (const [g, types] of Object.entries(GROUPS)) {
    out[g] = Math.max(0, ...actions.filter((a) => types.includes(a.action_type)).map((a) => Number(a.value) || 0));
  }
  return out;
}

/** Дневная статистика кампаний за период (включительно), фильтр по части названия кампании. */
export async function dailyCampaignInsights(c, { since, until, nameContains }) {
  const params = {
    level: 'campaign', time_increment: 1, time_range: { since, until },
    fields: 'campaign_id,campaign_name,spend,impressions,clicks,actions',
  };
  if (nameContains) params.filtering = [{ field: 'campaign.name', operator: 'CONTAIN', value: nameContains }];
  return paged(c, `${normAccount(c.accountId)}/insights`, params, 1000);
}

/** Live-срез для советника/бота: уровень campaign|adset|ad, период date_preset или since/until. */
export async function liveInsights(c, { datePreset, since, until, level = 'campaign', nameContains }) {
  const params = {
    level,
    fields: 'campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,reach,clicks,ctr,cpc,cpm,frequency,actions,cost_per_action_type',
  };
  if (since && until) params.time_range = { since, until }; else params.date_preset = datePreset || 'today';
  if (nameContains) params.filtering = [{ field: 'campaign.name', operator: 'CONTAIN', value: nameContains }];
  const rows = await paged(c, `${normAccount(c.accountId)}/insights`, params, 200);
  const num = (v) => (v === undefined ? undefined : Math.round(Number(v) * 100) / 100);
  return rows.map((r) => ({
    campaign: r.campaign_name, campaign_id: r.campaign_id, adset: r.adset_name, adset_id: r.adset_id, ad: r.ad_name, ad_id: r.ad_id,
    spend: num(r.spend), impressions: Number(r.impressions || 0), clicks: Number(r.clicks || 0),
    ctr_pct: num(r.ctr), cpc: num(r.cpc), cpm: num(r.cpm), frequency: num(r.frequency), results: extractResults(r.actions),
  }));
}

const budgets = (r) => { const o = { ...r }; for (const k of ['daily_budget', 'lifetime_budget', 'budget_remaining']) if (o[k] !== undefined) o[k] = Number(o[k]) / 100; return o; };
export async function listEntities(c, kind, { parentId, status, nameContains } = {}) {
  const fields = { campaigns: 'id,name,status,effective_status,objective,daily_budget,lifetime_budget', adsets: 'id,name,status,effective_status,campaign_id,daily_budget,lifetime_budget,optimization_goal', ads: 'id,name,status,effective_status,adset_id,campaign_id' }[kind];
  const params = { fields };
  const filtering = [];
  if (status) filtering.push({ field: 'effective_status', operator: 'IN', value: [status] });
  if (nameContains) filtering.push({ field: 'name', operator: 'CONTAIN', value: nameContains });
  if (filtering.length) params.filtering = filtering;
  const rows = await paged(c, parentId ? `${parentId}/${kind}` : `${normAccount(c.accountId)}/${kind}`, params, 150);
  return rows.map(budgets);
}
export const getEntity = async (c, id) => budgets(await call(c.token, 'GET', id, { fields: 'id,name,status,effective_status,daily_budget,lifetime_budget' }));
export const setStatus = (c, id, status) => call(c.token, 'POST', id, { status });
export const setDailyBudget = (c, id, amount) => call(c.token, 'POST', id, { daily_budget: Math.round(Number(amount) * 100) });
