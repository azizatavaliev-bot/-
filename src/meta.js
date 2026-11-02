// Обёртка над Meta Marketing API (Graph API).
// Токен: System User в Business Manager, срок действия "Никогда" — такой токен не протухает.
import { getSetting } from './db.js';

const VERSION = process.env.META_API_VERSION || 'v23.0';
const BASE = `https://graph.facebook.com/${VERSION}`;

export function metaConfigured() {
  return Boolean(process.env.META_ACCESS_TOKEN && getSetting('ads_account_id'));
}
export function accountId() {
  const id = getSetting('ads_account_id').trim();
  if (!id) throw new Error('Не указан ID рекламного аккаунта (Настройки → Meta Ads).');
  return id.startsWith('act_') ? id : `act_${id}`;
}

async function call(method, path, params = {}) {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) throw new Error('META_ACCESS_TOKEN не задан в .env');
  const url = new URL(`${BASE}/${path.replace(/^\//, '')}`);
  const init = { method, headers: {} };
  const flat = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    flat[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
  if (method === 'GET') {
    for (const [k, v] of Object.entries(flat)) url.searchParams.set(k, v);
  } else {
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = new URLSearchParams(flat).toString();
  }
  url.searchParams.set('access_token', token);
  const res = await fetch(url, init);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const e = json.error || {};
    const err = new Error(`Meta API: ${e.error_user_msg || e.message || res.statusText}${e.code ? ` (код ${e.code})` : ''}`);
    err.meta = e;
    throw err;
  }
  return json;
}
export const metaGet = (p, q) => call('GET', p, q);
export const metaPost = (p, b) => call('POST', p, b);

async function paged(path, params, max = 100) {
  const out = [];
  let res = await metaGet(path, { ...params, limit: Math.min(max, 100) });
  out.push(...(res.data || []));
  while (res.paging?.next && out.length < max) {
    const r = await fetch(res.paging.next);
    res = await r.json();
    if (res.error) throw new Error(`Meta API: ${res.error.message}`);
    out.push(...(res.data || []));
  }
  return out.slice(0, max);
}

// ---------- чтение ----------
export async function accountInfo() {
  return metaGet(accountId(), { fields: 'name,account_status,currency,timezone_name,amount_spent,balance,spend_cap' });
}

const money = (v) => (v === undefined ? undefined : Math.round(Number(v) * 100) / 100);
const RESULT_ACTIONS = [
  'lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead',
  'onsite_conversion.messaging_conversation_started_7d', 'offsite_conversion.fb_pixel_purchase', 'purchase',
  'link_click', 'landing_page_view',
];
function pickActions(list = []) {
  const out = {};
  for (const a of list) if (RESULT_ACTIONS.includes(a.action_type)) out[a.action_type] = Number(a.value);
  return out;
}
function pickCosts(list = []) {
  const out = {};
  for (const a of list) if (RESULT_ACTIONS.includes(a.action_type)) out[a.action_type] = money(a.value);
  return out;
}

/**
 * Статистика. level: account|campaign|adset|ad. nameContains — фильтр по названию кампании («направление»).
 */
export async function insights({ datePreset, since, until, level = 'campaign', nameContains, daily = false }) {
  const params = {
    level,
    fields:
      'campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,reach,clicks,ctr,cpc,cpm,frequency,actions,cost_per_action_type',
  };
  if (since && until) params.time_range = { since, until };
  else params.date_preset = datePreset || 'today';
  if (daily) params.time_increment = 1;
  if (nameContains) params.filtering = [{ field: 'campaign.name', operator: 'CONTAIN', value: nameContains }];
  const rows = await paged(`${accountId()}/insights`, params, 200);
  const info = await accountInfo().catch(() => ({}));
  const mapped = rows.map((r) => ({
    campaign: r.campaign_name, campaign_id: r.campaign_id,
    adset: r.adset_name, adset_id: r.adset_id,
    ad: r.ad_name, ad_id: r.ad_id,
    date: r.date_start === r.date_stop ? r.date_start : `${r.date_start}…${r.date_stop}`,
    spend: money(r.spend), impressions: Number(r.impressions || 0), clicks: Number(r.clicks || 0),
    ctr_pct: money(r.ctr), cpc: money(r.cpc), cpm: money(r.cpm), frequency: money(r.frequency),
    results: pickActions(r.actions), cost_per_result: pickCosts(r.cost_per_action_type),
  }));
  const total = mapped.reduce((s, r) => s + (r.spend || 0), 0);
  return { currency: info.currency, account: info.name, total_spend: money(total), rows: mapped };
}

export async function listCampaigns({ nameContains, status } = {}) {
  const params = {
    fields: 'id,name,status,effective_status,objective,daily_budget,lifetime_budget,budget_remaining',
  };
  const filtering = [];
  if (nameContains) filtering.push({ field: 'name', operator: 'CONTAIN', value: nameContains });
  if (status) filtering.push({ field: 'effective_status', operator: 'IN', value: [status] });
  if (filtering.length) params.filtering = filtering;
  const rows = await paged(`${accountId()}/campaigns`, params, 100);
  return rows.map(normBudget);
}
export async function listAdsets({ campaignId, status } = {}) {
  const params = {
    fields: 'id,name,status,effective_status,campaign_id,daily_budget,lifetime_budget,optimization_goal,targeting',
  };
  if (status) params.filtering = [{ field: 'effective_status', operator: 'IN', value: [status] }];
  const path = campaignId ? `${campaignId}/adsets` : `${accountId()}/adsets`;
  const rows = await paged(path, params, 100);
  return rows.map((r) => {
    const t = r.targeting || {};
    return normBudget({
      ...r,
      targeting: undefined,
      targeting_summary: {
        age: t.age_min || t.age_max ? `${t.age_min ?? '?'}–${t.age_max ?? '?'}` : undefined,
        genders: t.genders,
        countries: t.geo_locations?.countries,
        cities: t.geo_locations?.cities?.map((c) => c.name),
      },
    });
  });
}
export async function listAds({ adsetId, campaignId, status } = {}) {
  const params = { fields: 'id,name,status,effective_status,adset_id,campaign_id,creative{id,name,title,body}' };
  if (status) params.filtering = [{ field: 'effective_status', operator: 'IN', value: [status] }];
  const path = adsetId ? `${adsetId}/ads` : campaignId ? `${campaignId}/ads` : `${accountId()}/ads`;
  return paged(path, params, 100);
}
function normBudget(r) {
  const o = { ...r };
  // Meta отдаёт бюджет в минорных единицах валюты (центы). Для USD/KGS/RUB делим на 100.
  for (const k of ['daily_budget', 'lifetime_budget', 'budget_remaining']) if (o[k] !== undefined) o[k] = Number(o[k]) / 100;
  return o;
}
export async function getEntity(id) {
  const r = await metaGet(id, { fields: 'id,name,status,effective_status,daily_budget,lifetime_budget' });
  return normBudget(r);
}

// ---------- запись ----------
export async function setStatus(id, status) {
  if (!['ACTIVE', 'PAUSED'].includes(status)) throw new Error('status: ACTIVE или PAUSED');
  await metaPost(id, { status });
  return { id, status };
}
export async function setDailyBudget(id, amount) {
  await metaPost(id, { daily_budget: Math.round(Number(amount) * 100) });
  return { id, daily_budget: Number(amount) };
}

/** Новое объявление с новым креативом (картинка по URL). Создаётся PAUSED. */
export async function createAdWithCreative({ adsetId, name, pageId, link, message, headline, imageUrl, cta = 'LEARN_MORE' }) {
  const creative = await metaPost(`${accountId()}/adcreatives`, {
    name,
    object_story_spec: {
      page_id: pageId,
      link_data: {
        link, message, name: headline, picture: imageUrl,
        call_to_action: { type: cta, value: { link } },
      },
    },
  });
  const ad = await metaPost(`${accountId()}/ads`, {
    name, adset_id: adsetId, creative: { creative_id: creative.id }, status: 'PAUSED',
  });
  return { ad_id: ad.id, creative_id: creative.id, status: 'PAUSED' };
}

/** Копия объявления в тот же адсет (быстро протестировать вариант). */
export async function copyAd(adId, { status = 'PAUSED' } = {}) {
  const r = await metaPost(`${adId}/copies`, { status_option: status === 'ACTIVE' ? 'INHERITED_FROM_SOURCE' : 'PAUSED' });
  return r;
}
