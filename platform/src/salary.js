import { db } from './db.js';

/** Зарплаты за месяц YYYY-MM. Проект учитывается, если был активен хотя бы часть месяца (без пропорции по дням). */
export function salaryForMonth(month, { userId } = {}) {
  const first = `${month}-01`;
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const rows = db.prepare(`
    SELECT p.*, u.name AS user_name, u.login AS user_login FROM projects p JOIN users u ON u.id = p.user_id
    WHERE (? IS NULL OR p.user_id = ?)
      AND COALESCE(p.started_at, date(p.created_at/1000,'unixepoch')) <= ?
      AND (p.ended_at IS NULL OR p.ended_at >= ?)
    ORDER BY u.name, p.name`).all(userId ?? null, userId ?? null, last, first);
  const r2 = (x) => Math.round(x * 100) / 100;
  const projects = rows.map((p) => {
    const spend = db.prepare('SELECT COALESCE(SUM(spend),0) s FROM daily_reports WHERE project_id=? AND date BETWEEN ? AND ?').get(p.id, first, last).s;
    return {
      project_id: p.id, project: p.name, employee: p.user_name || p.user_login, user_id: p.user_id,
      client_fee: p.client_fee, fee_currency: p.fee_currency, employee_pct: p.employee_pct, owner_pct: p.owner_pct,
      employee_amount: r2((p.client_fee * p.employee_pct) / 100), owner_amount: r2((p.client_fee * p.owner_pct) / 100),
      remainder: r2(p.client_fee - (p.client_fee * (p.employee_pct + p.owner_pct)) / 100),
      ad_spend: r2(spend), ad_currency: p.currency,
    };
  });
  const byEmployee = {};
  for (const p of projects) {
    const k = `${p.user_id}|${p.fee_currency}`;
    byEmployee[k] ??= { user_id: p.user_id, employee: p.employee, currency: p.fee_currency, amount: 0, projects: 0 };
    byEmployee[k].amount = r2(byEmployee[k].amount + p.employee_amount); byEmployee[k].projects++;
  }
  const totals = {};
  for (const p of projects) {
    const t = (totals[p.fee_currency] ??= { fees: 0, employees: 0, owner: 0, remainder: 0 });
    t.fees = r2(t.fees + p.client_fee); t.employees = r2(t.employees + p.employee_amount); t.owner = r2(t.owner + p.owner_amount); t.remainder = r2(t.remainder + p.remainder);
  }
  return { month, projects, employees: Object.values(byEmployee), totals };
}
