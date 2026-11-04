import { db, kvGet, kvSet, getSetting, audit } from './db.js';
import { syncProject, checkToken } from './sync.js';
import { utcToLocalParts } from './time.js';
import { buildDigest, sendTelegram, telegramEnabled } from './telegram.js';

let syncing = false;
export async function syncAll() {
  if (syncing) return; syncing = true;
  try {
    const today = utcToLocalParts(Date.now(), getSetting('timezone')).date;
    for (const p of db.prepare("SELECT * FROM projects WHERE status='active' AND token_enc != '' AND ad_account_id != ''").all()) {
      try {
        await syncProject(p, { days: 2 });
        if (kvGet(`tokcheck_${p.id}`) !== today) { await checkToken(p); kvSet(`tokcheck_${p.id}`, today); }
      } catch (e) { console.error('[sync]', p.name, e.message); }
      await new Promise((r) => setTimeout(r, 400)); // не долбим API
    }
  } finally { syncing = false; }
}

export async function sendDigests(now = Date.now()) {
  if (!telegramEnabled()) return;
  const lp = utcToLocalParts(now, getSetting('timezone'));
  if (Number(lp.time.slice(0, 2)) < Number(getSetting('digest_hour')) || kvGet('digest_sent') === lp.date) return;
  kvSet('digest_sent', lp.date); // сначала отметка — чтобы не слать дубли при сбое
  for (const u of db.prepare("SELECT * FROM users WHERE active=1 AND digest=1 AND tg_chat_id IS NOT NULL").all()) {
    try { await sendTelegram(u.tg_chat_id, await buildDigest(u)); audit(u.id, null, 'digest_sent'); }
    catch (e) { console.error('[digest]', u.login, e.message); }
  }
}

export function startScheduler() {
  setTimeout(syncAll, 15_000);
  setInterval(syncAll, 30 * 60_000);
  setInterval(() => sendDigests().catch((e) => console.error('[digest]', e)), 60_000);
  console.log('[scheduler] запущен: синхронизация каждые 30 мин, сводка в telegram по расписанию');
}
