/**
 * The payday routine. Each payday ("cycle", the date pay lands) gets six steps:
 *  1. pay      – did the expected pay arrive?
 *  2. close    – how last month went, and loose ends to tidy
 *  3. plan     – every pound of this pay given a job: bills, debts, savings, budgets, buffer
 *  4. moves    – transfers to make; each ticks itself off when it shows up in an import
 *  5. budgets  – limits for the month this pay funds
 *  6. done     – a log of the plan, to look back on
 * plus any steps of your own.
 *
 * Pay on the last working day funds the next month (the "period"), as everywhere else in the app.
 */
import { type DB, tx } from './db.ts';
import { ValidationError, assertPence } from './money.ts';
import { addDays, addMonths, daysInMonth, isIsoDate, monthOf, todayIso } from './dates.ts';
import { lastWorkingDay } from './calendar.ts';
import { occurrences, listRecurring } from './recurring.ts';
import { listBudgets } from './budgets.ts';
import { listGoals } from './goals.ts';
import { listDebts } from './debts.ts';
import { healthChecks } from './health.ts';
import { totals } from './reports.ts';
import { budgetRecord } from './insights.ts';

export const STEPS = ['pay', 'close', 'plan', 'moves', 'budgets'] as const;

interface SalaryRow { id: number; name: string; amount: number; schedule: string; start_date: string; account_id: number; category_id: number | null }

/** Your main pay: the biggest active monthly income item, if you've set one up. */
function salary(db: DB): SalaryRow | null {
  return (db.prepare(
    "SELECT id, name, amount, schedule, start_date, account_id, category_id FROM recurring WHERE type = 'income' AND active = 1 AND frequency = 'monthly' ORDER BY amount DESC LIMIT 1",
  ).get() as SalaryRow | undefined) ?? null;
}

/** The date pay lands in a month: last working day, or the same day of the month as the first payment. */
function payDateIn(month: string, s: SalaryRow | null): string {
  if (!s || s.schedule === 'last_working_day') return lastWorkingDay(month);
  const day = Math.min(Number(s.start_date.slice(8, 10)), daysInMonth(month));
  return `${month}-${String(day).padStart(2, '0')}`;
}

/** The latest payday on or before a date. */
export function currentCycle(db: DB, today = todayIso()): string {
  const s = salary(db);
  const here = payDateIn(monthOf(today), s);
  return here <= today ? here : payDateIn(addMonths(monthOf(today), -1), s);
}

function checks(db: DB, cycle: string): Map<string, string> {
  return new Map((db.prepare('SELECT key, at FROM payday_checks WHERE cycle = ?').all(cycle) as { key: string; at: string }[]).map((r) => [r.key, r.at]));
}

export function setCheck(db: DB, cycle: string, key: string, done: boolean) {
  if (!isIsoDate(cycle)) throw new ValidationError('Unknown payday');
  if (typeof key !== 'string' || !/^[a-z0-9:_-]{1,80}$/i.test(key)) throw new ValidationError('Unknown step');
  if (done) db.prepare('INSERT OR IGNORE INTO payday_checks (cycle, key) VALUES (?, ?)').run(cycle, key);
  else db.prepare('DELETE FROM payday_checks WHERE cycle = ? AND key = ?').run(cycle, key);
}

/** Money moved into an account (from any other account) between two dates. */
function movedInto(db: DB, accountId: number, from: string, to: string) {
  return db.prepare(
    `SELECT IFNULL(SUM(p.amount), 0) AS amount, MAX(t.date) AS last FROM postings p JOIN transactions t ON t.id = p.transaction_id
     WHERE p.account_id = ? AND t.kind = 'transfer' AND p.amount > 0 AND t.date BETWEEN ? AND ?`,
  ).get(accountId, from, to) as { amount: number; last: string | null };
}

export function payday(db: DB, cycleIn?: string | null, today = todayIso()) {
  const s = salary(db);
  // Any date in a month means that month's payday.
  const cycle = cycleIn && isIsoDate(cycleIn) ? payDateIn(monthOf(cycleIn), s) : currentCycle(db, today);
  const next = payDateIn(addMonths(monthOf(cycle), 1), s);
  const windowEnd = addDays(next, -1);
  const period = addMonths(monthOf(cycle), 1); // the month this pay funds
  const closing = monthOf(cycle); // the month that's ending
  const done = checks(db, cycle);

  // 1. Pay
  const expected = s?.amount ?? null;
  const recorded = s ? db.prepare(
    `SELECT rp.amount, rp.paid_date AS date, t.description FROM recurring_payments rp LEFT JOIN transactions t ON t.id = rp.transaction_id
     WHERE rp.recurring_id = ? AND rp.status = 'paid' AND rp.due_date BETWEEN ? AND ?`,
  ).get(s.id, addDays(cycle, -5), addDays(cycle, 5)) as { amount: number; date: string; description: string } | undefined : undefined;
  const found = recorded ?? (db.prepare(
    `SELECT p.amount, t.date, t.description FROM postings p JOIN transactions t ON t.id = p.transaction_id
     WHERE t.kind = 'income' AND t.date BETWEEN ? AND ? ${s?.category_id ? 'AND p.category_id = ?' : ''} ${s ? 'AND p.account_id = ?' : ''}
     ORDER BY p.amount DESC LIMIT 1`,
  ).get(addDays(cycle, -4), addDays(cycle, 4), ...(s?.category_id ? [s.category_id] : []), ...(s ? [s.account_id] : [])) as { amount: number; date: string; description: string } | undefined);
  const otherIncome = db.prepare(
    `SELECT t.date, t.description, p.amount FROM postings p JOIN transactions t ON t.id = p.transaction_id
     WHERE t.kind = 'income' AND t.period = ? AND p.amount > 0 ORDER BY p.amount DESC LIMIT 8`,
  ).all(period) as { date: string; description: string; amount: number }[];
  const pay = {
    name: s?.name ?? 'Pay', expected, date: cycle,
    actual: found?.amount ?? null, actualDate: found?.date ?? null, description: found?.description ?? null,
    diff: found && expected != null ? found.amount - expected : null,
    arrived: !!found,
    other: otherIncome.filter((o) => !(found && o.description === found.description && o.amount === found.amount)).slice(0, 5),
  };
  const payAmount = pay.actual ?? pay.expected ?? 0;

  // 2. Close last month
  const t = totals(db, { from: `${closing}-01`, to: `${closing}-${String(daysInMonth(closing)).padStart(2, '0')}` });
  const closeBudgets = listBudgets(db, closing, today).budgets.filter((b: any) => b.kind === 'spending').map((b: any) => ({
    id: b.id, name: b.name, icon: b.icon, colour: b.colour, limit: b.available, spent: b.spent, over: b.spent > b.available,
  }));
  const looseEnds: { title: string; detail: string; link: string; linkLabel: string }[] = [];
  const uncategorised = (db.prepare(
    `SELECT COUNT(*) AS n FROM postings p JOIN transactions t ON t.id = p.transaction_id
     WHERE t.kind IN ('expense','income') AND p.category_id IS NULL AND t.date >= ?`,
  ).get(addDays(cycle, -62)) as { n: number }).n;
  if (uncategorised) looseEnds.push({ title: `${uncategorised} transaction${uncategorised === 1 ? '' : 's'} without a category`, detail: 'From the last two months.', link: '/transactions?uncategorised=1&month=all', linkLabel: 'Sort them' });
  for (const h of healthChecks(db, today)) looseEnds.push({ title: h.title, detail: h.detail, link: h.link, linkLabel: h.linkLabel });
  for (const r of listRecurring(db) as any[]) {
    if (!r.active || !r.shares?.length) continue;
    const c = r.shareCycles.find((x: any) => x.dueDate <= today);
    const missing = c ? c.people.filter((p: any) => !p.paid).map((p: any) => p.name) : [];
    if (missing.length) looseEnds.push({ title: `${r.name}: ${missing.length} of ${r.shares.length} haven't paid you back`, detail: `${missing.join(', ')} for ${c.dueDate}. Their payments may just not be imported yet.`, link: '/bills', linkLabel: 'Open Bills' });
  }

  // 3. Plan: what this pay has to cover before the next one.
  const occ = occurrences(db, cycle, windowEnd);
  const recurringRows = new Map((db.prepare(
    `SELECT r.id, r.category_id, r.transfer_account_id, ta.name AS transfer_name, a.name AS from_name, IFNULL((SELECT SUM(s.amount) FROM recurring_shares s WHERE s.recurring_id = r.id), 0) AS shared
     FROM recurring r JOIN accounts a ON a.id = r.account_id LEFT JOIN accounts ta ON ta.id = r.transfer_account_id`,
  ).all() as { id: number; category_id: number | null; transfer_account_id: number | null; transfer_name: string | null; from_name: string; shared: number }[]).map((r) => [r.id, r]));
  const budgetsNext = listBudgets(db, period, today).budgets.filter((b: any) => b.kind === 'spending');
  const budgetCats = new Map<number, string>();
  for (const b of budgetsNext as any[]) {
    const ids = db.prepare(
      'SELECT DISTINCT c.id FROM budget_categories bc JOIN categories c ON c.id = bc.category_id OR c.parent_id = bc.category_id WHERE bc.budget_id = ?',
    ).all(b.id) as { id: number }[];
    for (const { id } of ids) if (!budgetCats.has(id)) budgetCats.set(id, b.name);
  }
  const amountOf = (o: (typeof occ)[number]) => {
    const shared = recurringRows.get(o.recurringId)?.shared ?? 0;
    return Math.max(0, (o.status === 'paid' && o.paidAmount != null ? o.paidAmount : o.expected) - shared);
  };
  const billItems = occ.filter((o) => (o.type === 'bill' || o.type === 'subscription') && o.status !== 'skipped').map((o) => {
    const cat = recurringRows.get(o.recurringId)?.category_id;
    return { recurringId: o.recurringId, name: o.name, date: o.dueDate, amount: amountOf(o), paid: o.status === 'paid', coveredBy: cat != null ? budgetCats.get(cat) ?? null : null };
  });
  const debtItems = occ.filter((o) => o.isDebt && o.status !== 'skipped').map((o) => ({ recurringId: o.recurringId, name: o.name, date: o.dueDate, amount: amountOf(o), paid: o.status === 'paid', accountId: recurringRows.get(o.recurringId)?.transfer_account_id ?? null, to: recurringRows.get(o.recurringId)?.transfer_name ?? '', from: recurringRows.get(o.recurringId)?.from_name ?? '' }));
  const savingOcc = occ.filter((o) => o.type === 'saving' && !o.isDebt && o.status !== 'skipped');
  const goals = (listGoals(db, today) as any).goals?.filter((g: any) => !g.archived && !g.completedAt && g.monthlyTarget) ?? [];
  const goalAccounts = new Set(goals.map((g: any) => g.account?.id));
  const savingItems = [
    ...goals.map((g: any) => ({ key: `goal:${g.id}`, name: g.name, icon: g.icon, amount: g.monthlyTarget as number, accountId: g.account?.id as number, accountName: g.account?.name as string })),
    ...savingOcc.filter((o) => !goalAccounts.has(recurringRows.get(o.recurringId)?.transfer_account_id ?? -1))
      .map((o) => ({ key: `saving:${o.recurringId}`, name: o.name, icon: null, amount: amountOf(o), accountId: recurringRows.get(o.recurringId)?.transfer_account_id as number, accountName: o.accountName })),
  ];
  // Weekly and annual budgets as a month's worth, so they add up with everything else.
  const perMonth = (b: any) => (b.period === 'weekly' ? Math.round((b.limit * daysInMonth(period)) / 7) : b.period === 'annual' ? Math.round(b.limit / 12) : b.limit);
  const budgetItems = (budgetsNext as any[]).map((b) => ({ id: b.id, name: b.name, icon: b.icon, colour: b.colour, limit: perMonth(b), setLimit: b.limit, period: b.period }));
  const sum = (xs: { amount?: number; limit?: number }[], k: 'amount' | 'limit' = 'amount') => xs.reduce((n, x) => n + ((x as any)[k] ?? 0), 0);
  const billsCounted = billItems.filter((b) => !b.coveredBy);
  const plan = {
    pay: payAmount,
    bills: { total: sum(billsCounted), items: billItems },
    debts: { total: sum(debtItems), items: debtItems },
    savings: { total: sum(savingItems), items: savingItems },
    budgets: { total: sum(budgetItems, 'limit'), items: budgetItems },
    buffer: 0,
  };
  plan.buffer = plan.pay - plan.bills.total - plan.debts.total - plan.savings.total - plan.budgets.total;

  // 4. Moves: transfers to make, ticked off when they appear in an import.
  const from = addDays(cycle, -3);
  const moves: { key: string; kind: 'goal' | 'saving' | 'debt' | 'card'; title: string; to: string; amount: number; due: string | null; status: 'done' | 'partial' | 'waiting' | 'skipped'; moved: number; movedOn: string | null; note: string | null }[] = [];
  const status = (key: string, amount: number, moved: number) => (done.has(`skip:${key}`) ? 'skipped' : moved >= amount * 0.95 ? 'done' : moved > 0 ? 'partial' : 'waiting');
  for (const sv of savingItems) {
    if (!sv.accountId) continue;
    const m = movedInto(db, sv.accountId, from, windowEnd);
    moves.push({ key: sv.key, kind: sv.key.startsWith('goal') ? 'goal' : 'saving', title: `${sv.icon ? `${sv.icon} ` : ''}${sv.name}`, to: sv.accountName, amount: sv.amount, due: null, status: status(sv.key, sv.amount, m.amount), moved: m.amount, movedOn: m.last, note: null });
  }
  for (const d of debtItems) {
    const key = `debt:${d.recurringId}:${d.date}`;
    const m = d.accountId ? movedInto(db, d.accountId, addDays(d.date, -10), windowEnd) : { amount: d.paid ? d.amount : 0, last: null };
    const moved = d.paid ? Math.max(m.amount, d.amount) : m.amount;
    moves.push({ key, kind: 'debt', title: d.name, to: d.to, amount: d.amount, due: d.date, status: status(key, d.amount, moved), moved, movedOn: m.last, note: null });
  }
  // Credit cards with a statement due before next payday. Already counted in your spending, so not in the plan above.
  try {
    for (const c of (listDebts(db, today) as any).items as any[]) {
      const v = c.details;
      if (c.group !== 'card' || !v?.nextDue || v.nextDue < cycle || v.nextDue > windowEnd) continue;
      const amount = v.statementDue ?? v.minimum ?? 0;
      if (amount <= 0) continue;
      const key = `card:${c.accountId}:${v.nextDue}`;
      const m = movedInto(db, c.accountId, from, v.nextDue);
      moves.push({ key, kind: 'card', title: `Pay off ${c.name}`, to: c.name, amount, due: v.nextDue, status: status(key, amount, m.amount), moved: m.amount, movedOn: m.last, note: v.paysInFull ? 'Statement balance' : 'At least the minimum' });
    }
  } catch { /* debts page data is optional here */ }

  // 5. Budgets for the month this pay funds, with what your history suggests.
  const record = new Map((budgetRecord(db, today) as any[]).map((r) => [r.id, r]));
  const budgetStep = budgetItems.map((b) => {
    const r = record.get(b.id);
    return { ...b, typical: r?.typical ?? null, verdict: r?.verdict ?? null, suggestion: r?.suggestion ?? null, months: r?.months ?? 0, under: r?.under ?? 0 };
  });

  // Your own steps
  const items = (db.prepare('SELECT id, text FROM payday_items ORDER BY sort_order, id').all() as { id: number; text: string }[])
    .map((i) => ({ ...i, done: done.has(`item:${i.id}`) }));

  const log = db.prepare('SELECT completed_at FROM payday_logs WHERE cycle = ?').get(cycle) as { completed_at: string } | undefined;
  const movesDone = moves.length > 0 && moves.every((m) => m.status === 'done' || m.status === 'skipped');
  const stepDone: Record<string, boolean> = Object.fromEntries(STEPS.map((k) => [k, done.has(k) || (k === 'moves' && movesDone)]));
  return {
    cycle, next, period, closing, today,
    daysSince: Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${cycle}T12:00:00Z`)) / 86400000),
    daysToNext: Math.round((Date.parse(`${next}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86400000),
    steps: stepDone,
    pay,
    close: { month: closing, income: t.income, spending: t.spending, saved: t.saved, savingsRate: t.savingsRate, budgets: closeBudgets, looseEnds },
    plan, moves, budgets: budgetStep, items,
    completedAt: log?.completed_at ?? null,
  };
}

/** The bits of the routine the Overview card needs, without the heavy lifting. */
export function paydayStatus(db: DB, today = todayIso()) {
  const cycle = currentCycle(db, today);
  const c = checks(db, cycle);
  const log = db.prepare('SELECT completed_at FROM payday_logs WHERE cycle = ?').get(cycle) as { completed_at: string } | undefined;
  const days = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${cycle}T12:00:00Z`)) / 86400000);
  const items = (db.prepare('SELECT COUNT(*) AS n FROM payday_items').get() as { n: number }).n;
  return {
    cycle, period: addMonths(monthOf(cycle), 1), daysSince: days,
    stepsDone: STEPS.filter((k) => c.has(k)).length, stepsTotal: STEPS.length + 1 + items,
    completedAt: log?.completed_at ?? null,
    // Show the nudge for the first ten days after payday, until it's done.
    show: !log && days >= 0 && days <= 10,
  };
}

/** Set limits for the month this pay funds (monthly budgets) without touching earlier months. */
export function setPaydayBudgets(db: DB, cycle: string, limits: Record<string, number>) {
  if (!isIsoDate(cycle)) throw new ValidationError('Unknown payday');
  const start = `${addMonths(monthOf(cycle), 1)}-01`;
  tx(db, () => {
    for (const [id, amount] of Object.entries(limits ?? {})) {
      const pence = assertPence(amount, 'Limit');
      if (pence <= 0) throw new ValidationError('A limit must be more than £0');
      const b = db.prepare("SELECT id, period, percent FROM budgets WHERE id = ? AND IFNULL(kind, 'spending') = 'spending'").get(Number(id)) as { id: number; period: string; percent: number | null } | undefined;
      if (!b) throw new ValidationError('Budget not found');
      const effective = b.period === 'monthly' ? start : todayIso();
      db.prepare('UPDATE budgets SET percent = NULL WHERE id = ?').run(b.id);
      db.prepare('INSERT INTO budget_amounts (budget_id, effective_date, amount) VALUES (?, ?, ?) ON CONFLICT(budget_id, effective_date) DO UPDATE SET amount = excluded.amount').run(b.id, effective, pence);
    }
  });
}

/** Finish the routine: keep a copy of the plan so you can compare it with what happened. */
export function completePayday(db: DB, cycle: string, today = todayIso()) {
  const r = payday(db, cycle, today);
  const snapshot = { pay: r.pay.actual ?? r.pay.expected, plan: { bills: r.plan.bills.total, debts: r.plan.debts.total, savings: r.plan.savings.total, budgets: r.plan.budgets.total, buffer: r.plan.buffer }, moves: r.moves.map((m) => ({ title: m.title, amount: m.amount, status: m.status })) };
  db.prepare('INSERT INTO payday_logs (cycle, period, snapshot) VALUES (?, ?, ?) ON CONFLICT(cycle) DO UPDATE SET snapshot = excluded.snapshot, completed_at = datetime(\'now\')').run(r.cycle, r.period, JSON.stringify(snapshot));
  return { ok: true };
}

export function reopenPayday(db: DB, cycle: string) {
  db.prepare('DELETE FROM payday_logs WHERE cycle = ?').run(cycle);
}

/** Past paydays: what you planned and what actually happened in that month. */
export function paydayLogs(db: DB, today = todayIso()) {
  const rows = db.prepare('SELECT cycle, period, completed_at, snapshot FROM payday_logs ORDER BY cycle DESC LIMIT 24').all() as { cycle: string; period: string; completed_at: string; snapshot: string }[];
  return rows.map((r) => {
    const s = JSON.parse(r.snapshot);
    const end = `${r.period}-${String(daysInMonth(r.period)).padStart(2, '0')}`;
    const t = totals(db, { from: `${r.period}-01`, to: end });
    return {
      cycle: r.cycle, period: r.period, completedAt: r.completed_at, inProgress: end >= today,
      planned: s, actual: { income: t.income, spending: t.spending, saved: t.saved, left: t.income - t.spending - t.saved },
    };
  });
}

export function addPaydayItem(db: DB, text: string) {
  const t = typeof text === 'string' ? text.trim() : '';
  if (!t) throw new ValidationError('Write the step');
  if (t.length > 120) throw new ValidationError('Keep it under 120 characters');
  const order = (db.prepare('SELECT IFNULL(MAX(sort_order), 0) + 1 AS n FROM payday_items').get() as { n: number }).n;
  return Number(db.prepare('INSERT INTO payday_items (text, sort_order) VALUES (?, ?)').run(t, order).lastInsertRowid);
}

export function deletePaydayItem(db: DB, id: number) {
  db.prepare('DELETE FROM payday_items WHERE id = ?').run(id);
  db.prepare('DELETE FROM payday_checks WHERE key = ?').run(`item:${id}`);
}
