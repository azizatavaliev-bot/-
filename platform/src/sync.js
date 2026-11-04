import { db, audit } from './db.js';
import { decrypt } from './security.js';
import * as meta from './meta.js';
import { utcToLocalParts } from './time.js';

export const creds = (p) => ({ token: decrypt(p.token_enc), accountId: p.ad_account_id });
const shift = (dateStr, days) => { const d = new Date(`${dateStr}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
export const dateRange = (from, to) => { const out = []; for (let d = from; d <= to; d = shift(d, 1)) out.push(d); return out; };

/** Проверка токена: работает ли, срок жизни. Обновляет статус проекта. */
export async function checkToken(p) {
  if (!p.token_enc || !p.ad_account_id) { setTokenState(p.id, 'none', null, 'Токен или ID аккаунта не заданы'); return { status: 'none' }; }
  const c = creds(p);
  try {
    const info = await meta.accountInfo(c);
    let status = 'ok', expiresAt = null, note = `Аккаунт «${info.name}», валюта ${info.currency}`;
    try {
      const t = await meta.inspectToken(c.token);
      if (t.known) {
        if (!t.valid) { status = 'invalid'; note = 'Токен недействителен'; }
        expiresAt = t.expiresAt;
        if (t.valid && t.expiresAt) {
          const left = (t.expiresAt - Date.now()) / 86400000;
          note += `. Токен истекает через ${Math.max(0, Math.floor(left))} дн.`;
          if (left < 7) status = 'expiring';
        } else if (t.valid) note += '. Токен бессрочный';
      } else note += '. (Срок токена не проверяется: не заданы META_APP_ID/META_APP_SECRET платформы)';
    } catch (e) { note += `. Срок токена узнать не удалось: ${e.message}`; }
    db.prepare('UPDATE projects SET currency = ? WHERE id = ?').run(info.currency || 'USD', p.id);
    setTokenState(p.id, status, expiresAt, note);
    return { status, expiresAt, note, account: info };
  } catch (e) {
    setTokenState(p.id, e.isAuth ? 'invalid' : 'invalid', null, e.message);
    return { status: 'invalid', note: e.message };
  }
}
function setTokenState(id, status, expiresAt, note) {
  db.prepare('UPDATE projects SET token_status=?, token_expires_at=?, token_checked_at=?, token_note=? WHERE id=?').run(status, expiresAt, Date.now(), note, id);
}

/** Тянет дневную статистику за последние `days` дней и записывает отчёты. Ручные правки не перетираются. */
export async function syncProject(p, { days = 2 } = {}) {
  if (p.status !== 'active' || !p.token_enc || !p.ad_account_id) return { skipped: true };
  const c = creds(p);
  let info;
  try { info = await meta.accountInfo(c); }
  catch (e) { setTokenState(p.id, 'invalid', null, e.message); audit(null, p.id, 'sync_error', e.message); throw e; }
  const tz = info.timezone_name || 'UTC';
  const today = utcToLocalParts(Date.now(), tz).date;
  const since = shift(today, -(days - 1));
  const rows = await meta.dailyCampaignInsights(c, { since, until: today, nameContains: p.name_filter });

  // агрегируем по дням
  const byDate = new Map();
  for (const r of rows) {
    const d = r.date_start;
    const a = byDate.get(d) || { spend: 0, impressions: 0, clicks: 0, res: { lead: 0, messages: 0, purchase: 0, link_click: 0 } };
    a.spend += Number(r.spend || 0); a.impressions += Number(r.impressions || 0); a.clicks += Number(r.clicks || 0);
    const er = meta.extractResults(r.actions);
    for (const k of Object.keys(a.res)) a.res[k] += er[k];
    byDate.set(d, a);
  }
  // какой тип результата считать
  let type = p.result_type;
  if (type === 'auto') {
    const tot = { lead: 0, messages: 0, purchase: 0, link_click: 0 };
    for (const a of byDate.values()) for (const k of Object.keys(tot)) tot[k] += a.res[k];
    type = ['lead', 'messages', 'purchase'].sort((x, y) => tot[y] - tot[x])[0];
    if (!tot[type]) type = tot.link_click ? 'link_click' : 'lead';
  }

  const now = Date.now();
  const get = db.prepare('SELECT source FROM daily_reports WHERE project_id=? AND date=?');
  const insert = db.prepare(`INSERT INTO daily_reports (project_id,date,spend,impressions,clicks,results,result_type,source,auto_spend,auto_results,partial,updated_at)
    VALUES (?,?,?,?,?,?,?,'auto',?,?,?,?)
    ON CONFLICT(project_id,date) DO UPDATE SET spend=excluded.spend, impressions=excluded.impressions, clicks=excluded.clicks, results=excluded.results,
      result_type=excluded.result_type, auto_spend=excluded.auto_spend, auto_results=excluded.auto_results, partial=excluded.partial, updated_at=excluded.updated_at`);
  const keepManual = db.prepare('UPDATE daily_reports SET auto_spend=?, auto_results=?, partial=?, updated_at=? WHERE project_id=? AND date=?');
  let written = 0;
  for (const date of dateRange(since, today)) {
    const a = byDate.get(date) || { spend: 0, impressions: 0, clicks: 0, res: { [type]: 0 } };
    const spend = Math.round(a.spend * 100) / 100, results = a.res[type] || 0, partial = date === today ? 1 : 0;
    if (get.get(p.id, date)?.source === 'manual') keepManual.run(spend, results, partial, now, p.id, date);
    else insert.run(p.id, date, spend, a.impressions, a.clicks, results, type, spend, results, partial, now);
    written++;
  }
  if (p.token_status !== 'ok' && p.token_status !== 'expiring') setTokenState(p.id, 'ok', p.token_expires_at, p.token_note);
  return { written, since, until: today, type, tz };
}

// ---------- анализ ----------
const sum = (a) => a.reduce((s, x) => s + x, 0);
export function analyze(p) {
  const rows = db.prepare('SELECT * FROM daily_reports WHERE project_id=? ORDER BY date DESC LIMIT 16').all(p.id);
  const done = rows.filter((r) => !r.partial);
  const y = done[0] || null;
  const prev = done.slice(1, 8);
  const flags = [];
  const flag = (code, level, text) => flags.push({ code, level, text });
  const cpl = (r) => (r && r.results > 0 ? r.spend / r.results : null);

  if (p.token_status === 'invalid') flag('token_invalid', 'bad', 'Токен не работает — отчёты не обновляются');
  if (p.token_status === 'expiring') flag('token_expiring', 'warn', 'Токен скоро истечёт — выпусти бессрочный (см. инструкцию)');
  if (p.token_status === 'none') flag('token_none', 'warn', 'Facebook-аккаунт не подключён');
  if (y && prev.length >= 3) {
    const avgSpend = sum(prev.map((r) => r.spend)) / prev.length;
    const avgRes = sum(prev.map((r) => r.results)) / prev.length;
    const prevCpl = sum(prev.map((r) => r.spend)) > 0 && sum(prev.map((r) => r.results)) > 0 ? sum(prev.map((r) => r.spend)) / sum(prev.map((r) => r.results)) : null;
    if (y.spend === 0 && avgSpend > 0) flag('no_spend', 'bad', 'Вчера расход 0 при обычном расходе — реклама стоит');
    else if (avgSpend > 0 && y.spend < avgSpend * 0.5) flag('spend_drop', 'warn', `Расход упал до ${Math.round((y.spend / avgSpend) * 100)}% от среднего за неделю`);
    else if (avgSpend > 0 && y.spend > avgSpend * 1.5) flag('spend_spike', 'warn', `Расход вырос до ${Math.round((y.spend / avgSpend) * 100)}% от среднего за неделю`);
    if (y.spend > 0 && y.results === 0 && avgRes > 0) flag('no_results', 'bad', 'Есть расход, но 0 результатов (в среднем были)');
    else if (cpl(y) && prevCpl && cpl(y) > prevCpl * 1.3) flag('cpl_up', 'warn', `Цена результата +${Math.round((cpl(y) / prevCpl - 1) * 100)}% к средней за неделю`);
  } else if (!y && p.token_status === 'ok') flag('no_data', 'warn', 'Нет данных за вчера');
  for (const r of rows.slice(0, 7)) {
    if (r.source === 'manual' && r.auto_spend != null && Math.abs(r.auto_spend - r.spend) > Math.max(1, r.auto_spend * 0.05))
      flag('manual_mismatch', 'warn', `${r.date}: ручной расход ${r.spend} ≠ Facebook ${r.auto_spend}`);
  }
  const avg7 = prev.length ? { spend: Math.round(sum(prev.map((r) => r.spend)) / prev.length * 100) / 100, results: Math.round(sum(prev.map((r) => r.results)) / prev.length * 10) / 10 } : null;
  return { yesterday: y, cpl_yesterday: cpl(y) ? Math.round(cpl(y) * 100) / 100 : null, avg7, flags };
}
