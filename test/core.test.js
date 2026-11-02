import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-test-'));
process.env.META_ACCESS_TOKEN = 'test-token';
process.env.ADMIN_PASSWORD = 'pw';
const realFetch = globalThis.fetch;

const { localToUtc, utcToLocalParts, nextRepeat } = await import('../src/time.js');
const { setSetting, upsertChat, getChat, db } = await import('../src/db.js');
const { runTool, toolsFor } = await import('../src/tools.js');

test('время: Бишкек = UTC+6', () => {
  assert.equal(localToUtc('2026-11-03 21:30', 'Asia/Bishkek'), Date.UTC(2026, 10, 3, 15, 30));
  assert.equal(utcToLocalParts(Date.UTC(2026, 10, 3, 15, 30), 'Asia/Bishkek').text, '2026-11-03 21:30');
  assert.equal(localToUtc('мусор', 'Asia/Bishkek'), null);
});

test('повторы: daily и weekdays пропускают выходные', () => {
  const tz = 'Asia/Bishkek';
  const fri = localToUtc('2026-11-06 21:00', tz); // пятница
  const n = nextRepeat('weekdays', '21:00', tz, fri);
  assert.equal(utcToLocalParts(n, tz).text, '2026-11-09 21:00'); // понедельник
  assert.equal(utcToLocalParts(nextRepeat('daily', '21:00', tz, fri), tz).text, '2026-11-07 21:00');
});

test('права: клиентский чат не видит рекламу и confirm', () => {
  const chat = upsertChat('1@s.whatsapp.net', { name: 'x' });
  const ctx = { jid: chat.jid, chat, mode: 'client', adsRead: false, adsWrite: false, runId: 'a' };
  const names = toolsFor(ctx).map((t) => t.name);
  assert.deepEqual(names, ['notify_owner']);
  const ownerCtx = { ...ctx, mode: 'owner', adsRead: true, adsWrite: true };
  const on = toolsFor(ownerCtx).map((t) => t.name);
  assert.ok(on.includes('ads_insights') && on.includes('confirm_action') && on.includes('set_reminder'));
});

test('напоминание создаётся и в прошлое нельзя', async () => {
  const chat = upsertChat('2@s.whatsapp.net', {});
  const ctx = { jid: chat.jid, chat, mode: 'owner', adsRead: true, adsWrite: true, runId: 'r1', ownerJid: chat.jid };
  const past = await runTool('set_reminder', { when: '2020-01-01 10:00', text: 'x' }, ctx);
  assert.match(past.error, /прошло/);
  const ok = await runTool('set_reminder', { when: '2999-01-01 10:00', text: 'позвонить' }, ctx);
  assert.equal(ok.ok, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM reminders').get().n, 1);
});

function mockMeta(state) {
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? Object.fromEntries(new URLSearchParams(init.body)) : {};
    state.calls.push({ method: init.method || 'GET', path: u.pathname, body });
    const json = (o) => ({ ok: true, json: async () => o });
    if (u.pathname.endsWith('/777')) {
      if ((init.method || 'GET') === 'POST') return json({ success: true });
      return json({ id: '777', name: 'Кампания А', status: 'ACTIVE', daily_budget: '10000' }); // 100.00
    }
    return json({ data: [] });
  };
}

test('запись в рекламу: только через подтверждение в другом «ходе»', async () => {
  const state = { calls: [] };
  mockMeta(state);
  setSetting('ads_max_budget_change_pct', '30');
  const chat = upsertChat('3@s.whatsapp.net', {});
  const ctx1 = { jid: chat.jid, chat, mode: 'owner', adsRead: true, adsWrite: true, runId: 'run1' };

  const p = await runTool('ads_set_budget', { entity_id: '777', daily_budget: 120 }, ctx1);
  assert.equal(p.status, 'needs_confirmation');
  assert.equal(state.calls.some((c) => c.method === 'POST'), false, 'до подтверждения POST быть не должно');

  // модель пытается подтвердить сама в том же ходе
  const self = await runTool('confirm_action', { action_id: p.action_id }, ctx1);
  assert.match(self.error, /отдельным сообщением/);
  assert.equal(state.calls.some((c) => c.method === 'POST'), false);

  // пользователь ответил «да» — новый ход
  const ctx2 = { ...ctx1, runId: 'run2' };
  const done = await runTool('confirm_action', { action_id: p.action_id }, ctx2);
  assert.equal(done.ok, true);
  const post = state.calls.find((c) => c.method === 'POST');
  assert.equal(post.body.daily_budget, '12000'); // 120.00 в минорных единицах

  // повторно то же подтверждение не сработает
  assert.ok((await runTool('confirm_action', { action_id: p.action_id }, ctx2)).error);
});

test('лимит изменения бюджета и чужой чат', async () => {
  const state = { calls: [] };
  mockMeta(state);
  const chat = upsertChat('4@s.whatsapp.net', {});
  const ctx = { jid: chat.jid, chat, mode: 'owner', adsRead: true, adsWrite: true, runId: 'r' };
  const big = await runTool('ads_set_budget', { entity_id: '777', daily_budget: 500 }, ctx);
  assert.match(big.error, /лимита/);
  const p = await runTool('ads_set_budget', { entity_id: '777', daily_budget: 110 }, ctx);
  const other = upsertChat('5@s.whatsapp.net', {});
  const stranger = await runTool('confirm_action', { action_id: p.action_id }, { ...ctx, jid: other.jid, chat: other, runId: 'z' });
  assert.ok(stranger.error);
});

test('панель: вход по паролю, API закрыт без сессии', async () => {
  globalThis.fetch = realFetch;
  const { createServer } = await import('../src/server.js');
  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/status`)).status, 401);
    assert.equal((await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'bad' }) })).status, 401);
    const ok = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'pw' }) });
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get('set-cookie').split(';')[0];
    const st = await fetch(`${base}/api/status`, { headers: { cookie } });
    assert.equal(st.status, 200);
    const put = await fetch(`${base}/api/settings`, { method: 'PUT', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ business_name: 'Тест' }) });
    assert.equal((await put.json()).settings.business_name, 'Тест');
    const bad = await fetch(`${base}/api/settings`, { method: 'PUT', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ evil: '1' }) });
    assert.equal(bad.status, 400);
    assert.equal((await fetch(`${base}/`)).status, 200);
  } finally { srv.close(); }
});
