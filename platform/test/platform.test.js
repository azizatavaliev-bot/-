import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'adops-'));
process.env.TELEGRAM_BOT_TOKEN = 'tgtest';
const realFetch = globalThis.fetch;

// ---- подставные Facebook и Telegram ----
const fb = { calls: [], insights: [], tokenValid: true };
const tg = { sent: [] };
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status });
  if (u.hostname === 'graph.facebook.com') {
    const body = init.body ? Object.fromEntries(new URLSearchParams(init.body)) : {};
    fb.calls.push({ method: init.method || 'GET', path: u.pathname, q: Object.fromEntries(u.searchParams), body });
    if (!fb.tokenValid) return json({ error: { message: 'Invalid OAuth access token.', code: 190, type: 'OAuthException' } }, 400);
    if (u.pathname.endsWith('/insights')) return json({ data: fb.insights });
    if (u.pathname.endsWith('/777')) return (init.method === 'POST') ? json({ success: true }) : json({ id: '777', name: 'Кампания А', status: 'ACTIVE', daily_budget: '10000' });
    if (u.pathname.startsWith('/v23.0/act_')) return json({ name: 'Аккаунт', currency: 'USD', account_status: 1, timezone_name: 'Asia/Bishkek' });
    return json({ data: [] });
  }
  if (u.hostname === 'tg.local') {
    const method = u.pathname.split('/').pop();
    if (method === 'sendMessage') tg.sent.push(JSON.parse(init.body));
    return json({ ok: true, result: method === 'getMe' ? { username: 'adops_bot' } : true });
  }
  return realFetch(url, init);
};
process.env.TELEGRAM_API_BASE = 'http://tg.local';

const { db } = await import('../src/db.js');
const { encrypt, decrypt, hashPassword, verifyPassword } = await import('../src/security.js');
const { syncProject, analyze, checkToken } = await import('../src/sync.js');
const { salaryForMonth } = await import('../src/salary.js');
const { runTool, toolsFor, resolveProject } = await import('../src/tools.js');
const { handleMessage } = await import('../src/telegram.js');
const { utcToLocalParts } = await import('../src/time.js');

const mkUser = (login, role = 'employee') => db.prepare('INSERT INTO users (login,pass_hash,name,role,created_at) VALUES (?,?,?,?,?)').run(login, hashPassword('password123'), login, role, Date.now()).lastInsertRowid;
const mkProject = (uid, name, extra = {}) => {
  const r = db.prepare('INSERT INTO projects (user_id,name,ad_account_id,token_enc,token_status,client_fee,employee_pct,owner_pct,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(uid, name, 'act_1', encrypt('EAAB-secret-token-123456789'), 'ok', extra.fee ?? 0, extra.emp ?? 0, extra.own ?? 0, Date.now());
  return db.prepare('SELECT * FROM projects WHERE id=?').get(r.lastInsertRowid);
};
const row = (uid) => db.prepare('SELECT * FROM users WHERE id=?').get(uid);
const tzToday = () => utcToLocalParts(Date.now(), 'Asia/Bishkek').date;
const ago = (n) => { const d = new Date(`${tzToday()}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };

const ownerId = mkUser('boss', 'owner'), aId = mkUser('anna'), bId = mkUser('boris');
const pA = mkProject(aId, 'Клиент А', { fee: 1000, emp: 30, own: 20 });
const pB = mkProject(bId, 'Клиент Б', { fee: 500, emp: 40, own: 10 });

test('токен шифруется, пароль хэшируется', () => {
  const enc = encrypt('EAAB-secret');
  assert.ok(!enc.includes('EAAB'));
  assert.equal(decrypt(enc), 'EAAB-secret');
  const h = hashPassword('abc12345');
  assert.ok(verifyPassword('abc12345', h) && !verifyPassword('wrong', h));
});

test('синхронизация: агрегирует кампании, считает результаты без дублей, не перетирает ручные правки', async () => {
  fb.insights = [
    { campaign_name: 'K1', date_start: ago(1), spend: '10.5', impressions: '1000', clicks: '50', actions: [{ action_type: 'lead', value: '4' }, { action_type: 'onsite_conversion.lead_grouped', value: '4' }] },
    { campaign_name: 'K2', date_start: ago(1), spend: '4.5', impressions: '500', clicks: '20', actions: [{ action_type: 'lead', value: '1' }] },
    { campaign_name: 'K1', date_start: tzToday(), spend: '3', impressions: '100', clicks: '5', actions: [] },
  ];
  const r = await syncProject(pA, { days: 2 });
  assert.equal(r.type, 'lead');
  const y = db.prepare('SELECT * FROM daily_reports WHERE project_id=? AND date=?').get(pA.id, ago(1));
  assert.equal(y.spend, 15); assert.equal(y.results, 5); assert.equal(y.partial, 0);
  assert.equal(db.prepare('SELECT partial FROM daily_reports WHERE project_id=? AND date=?').get(pA.id, tzToday()).partial, 1);

  // ручная правка — при следующей синхронизации сохраняется, а расхождение с FB фиксируется
  const out = await runTool('edit_report', { project: 'Клиент А', date: ago(1), spend: 20, note: 'часть расхода вне FB' }, { user: row(aId), runId: 'r' });
  assert.equal(out.ok, true);
  await syncProject(pA, { days: 2 });
  const y2 = db.prepare('SELECT * FROM daily_reports WHERE project_id=? AND date=?').get(pA.id, ago(1));
  assert.equal(y2.spend, 20); assert.equal(y2.auto_spend, 15); assert.equal(y2.source, 'manual');
  assert.ok(analyze(db.prepare('SELECT * FROM projects WHERE id=?').get(pA.id)).flags.some((f) => f.code === 'manual_mismatch'));
});

test('анализ: флаг «реклама встала» при нулевом вчера', () => {
  const p = mkProject(aId, 'Проект Нули');
  for (let i = 2; i <= 8; i++) db.prepare("INSERT INTO daily_reports (project_id,date,spend,results,updated_at) VALUES (?,?,?,?,?)").run(p.id, ago(i), 20, 4, Date.now());
  db.prepare("INSERT INTO daily_reports (project_id,date,spend,results,updated_at) VALUES (?,?,0,0,?)").run(p.id, ago(1), Date.now());
  const a = analyze(p);
  assert.ok(a.flags.some((f) => f.code === 'no_spend' && f.level === 'bad'));
});

test('токен: ошибка 190 помечает проект как невалидный', async () => {
  fb.tokenValid = false;
  const p = mkProject(bId, 'Проект Токен');
  const r = await checkToken(p);
  fb.tokenValid = true;
  assert.equal(r.status, 'invalid');
  assert.equal(db.prepare('SELECT token_status FROM projects WHERE id=?').get(p.id).token_status, 'invalid');
});

test('изоляция: сотрудник не видит и не трогает чужие проекты', async () => {
  const anna = row(aId);
  assert.throws(() => resolveProject(anna, 'Клиент Б'), /не найден/);
  const rep = await runTool('get_reports', { project: 'Клиент Б' }, { user: anna, runId: 'r' });
  assert.match(rep.error, /не найден/);
  const edit = await runTool('edit_report', { project: String(pB.id), date: ago(1), spend: 1 }, { user: anna, runId: 'r' });
  assert.match(edit.error, /не найден/);
  assert.ok(!toolsFor(anna).some((t) => t.name === 'team_overview'));
  assert.ok(toolsFor(row(ownerId)).some((t) => t.name === 'team_overview'));
  const ov = await runTool('team_overview', {}, { user: anna, runId: 'r' });
  assert.match(ov.error, /недоступен/);
});

test('изменение рекламы: двухшаговое подтверждение, лимит бюджета, чужое подтверждение', async () => {
  const anna = row(aId), ctx1 = { user: anna, runId: 'a1' };
  const big = await runTool('ads_set_budget', { project: 'Клиент А', entity_id: '777', daily_budget: 500 }, ctx1);
  assert.match(big.error, /лимита/);
  fb.calls.length = 0;
  const p = await runTool('ads_set_budget', { project: 'Клиент А', entity_id: '777', daily_budget: 120 }, ctx1);
  assert.equal(p.status, 'needs_confirmation');
  assert.ok(!fb.calls.some((c) => c.method === 'POST'));
  assert.match((await runTool('confirm_action', { action_id: p.action_id }, ctx1)).error, /отдельным сообщением/);
  assert.ok((await runTool('confirm_action', { action_id: p.action_id }, { user: row(bId), runId: 'b' })).error, 'чужой пользователь не подтвердит');
  const ok = await runTool('confirm_action', { action_id: p.action_id }, { user: anna, runId: 'a2' });
  assert.equal(ok.ok, true);
  assert.equal(fb.calls.find((c) => c.method === 'POST').body.daily_budget, '12000');
});

test('зарплаты: проценты от оплаты клиента, архивный проект выпадает', () => {
  const m = tzToday().slice(0, 7);
  const s = salaryForMonth(m, { userId: aId });
  const p = s.projects.find((x) => x.project === 'Клиент А');
  assert.equal(p.employee_amount, 300); assert.equal(p.owner_amount, 200); assert.equal(p.remainder, 500);
  assert.equal(s.projects.some((x) => x.project === 'Клиент Б'), false, 'чужие проекты не попадают');
  const all = salaryForMonth(m);
  assert.equal(all.totals.USD.fees, 1500);
  db.prepare("UPDATE projects SET status='archived', ended_at='2000-01-01' WHERE id=?").run(pB.id);
  assert.equal(salaryForMonth(m).projects.some((x) => x.project === 'Клиент Б'), false);
});

test('telegram: привязка по коду, чужой чат без привязки не получает данных, команды работают', async () => {
  const anna = row(aId);
  tg.sent.length = 0;
  await handleMessage({ chat: { id: 111, type: 'private' }, text: '/today' });
  assert.match(tg.sent.at(-1).text, /Чтобы начать/);
  await handleMessage({ chat: { id: 111, type: 'private' }, text: '/start WRONG1' });
  assert.match(tg.sent.at(-1).text, /неверный/i);
  db.prepare('UPDATE users SET tg_code=?, tg_code_exp=? WHERE id=?').run('ABC123', Date.now() + 60000, aId);
  await handleMessage({ chat: { id: 111, type: 'private' }, text: '/start ABC123' });
  assert.match(tg.sent.at(-1).text, /Привязано/);
  assert.equal(row(aId).tg_chat_id, '111');
  assert.equal(row(aId).tg_code, null, 'код одноразовый');
  await handleMessage({ chat: { id: 111, type: 'private' }, text: '/salary' });
  assert.match(tg.sent.at(-1).text, /Клиент А/); assert.doesNotMatch(tg.sent.at(-1).text, /Клиент Б/);
  fb.insights = [{ campaign_name: 'K1', date_start: tzToday(), spend: '7', impressions: '1', clicks: '1', actions: [{ action_type: 'lead', value: '2' }] }];
  await handleMessage({ chat: { id: 111, type: 'private' }, text: '/today' });
  assert.match(tg.sent.at(-1).text, /Клиент А/);
  assert.doesNotMatch(tg.sent.at(-1).text, /Клиент Б/);
  await handleMessage({ chat: { id: 222, type: 'group' }, text: '/projects' });
  assert.equal(String(tg.sent.at(-1).chat_id), '111', 'групповые чаты игнорируются');
  void anna;
});

test('API: вход, роли, токен не отдаётся наружу', async () => {
  const { createServer } = await import('../src/server.js');
  const srv = createServer().listen(0);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (p, m = 'GET', body, cookie) => realFetch(base + p, { method: m, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  try {
    assert.equal((await call('/api/projects')).status, 401);
    assert.equal((await call('/api/login', 'POST', { login: 'anna', password: 'nope' })).status, 401);
    const lg = await call('/api/login', 'POST', { login: 'anna', password: 'password123' });
    assert.equal(lg.status, 200);
    const cookie = lg.headers.get('set-cookie').split(';')[0];
    const list = await (await call('/api/projects', 'GET', null, cookie)).json();
    assert.ok(list.projects.length >= 1 && list.projects.every((p) => p.user_id === aId));
    assert.ok(!JSON.stringify(list).includes('token_enc') && !JSON.stringify(list).includes('EAAB'));
    assert.ok(list.projects.every((p) => p.has_token === true));
    assert.equal((await call('/api/users', 'GET', null, cookie)).status, 403);
    assert.equal((await call(`/api/projects/${pB.id}`, 'PUT', { name: 'hack' }, cookie)).status, 400);
    // сотрудник не может выставить себе процент
    await call(`/api/projects/${pA.id}`, 'PUT', { employee_pct: 90, name: 'Клиент А' }, cookie);
    assert.equal(db.prepare('SELECT employee_pct FROM projects WHERE id=?').get(pA.id).employee_pct, 30);
    assert.equal((await call('/api/salary', 'GET', null, cookie)).status, 200);
    // владелец
    db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(hashPassword('ownerpass1'), ownerId);
    const o = await call('/api/login', 'POST', { login: 'boss', password: 'ownerpass1' });
    const oc = o.headers.get('set-cookie').split(';')[0];
    assert.equal((await call('/api/users', 'GET', null, oc)).status, 200);
    const mk = await call('/api/users', 'POST', { login: 'newbie', password: 'longenough1', name: 'Новичок' }, oc);
    assert.equal(mk.status, 200);
    assert.equal((await call('/api/users', 'POST', { login: 'newbie', password: 'longenough1' }, oc)).status, 400);
    assert.equal((await call('/api/me/telegram-code', 'POST', null, cookie)).status, 200);
    assert.equal((await call('/')).status, 200);
  } finally { srv.close(); }
});
