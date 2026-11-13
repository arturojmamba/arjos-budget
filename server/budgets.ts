/**
 * Budgets: spending limits for one or more categories, per week, month or year.
 *
 * - Spending = expense postings in the budget's categories (and their
 *   subcategories). Refunds reduce it. Transfers and card repayments never count.
 * - Monthly and annual budgets use the month a transaction counts towards;
 *   weekly budgets run Monday to Sunday by date.
 * - Limits are kept as a history, so raising a budget today doesn't change how
 *   last month looks.
 * - Rollover adds money left unused in a period to the next one (overspending
 *   isn't carried, so one bad month doesn't snowball).
 * - Savings goals ("saving" budgets) are targets for money moved into one
 *   account (e.g. Trading 212 or the emergency fund). Progress is transfers in
 *   minus transfers out; market growth and interest don't count.
 */
import { type DB, tx } from './db.ts';
import { ValidationError, assertPence } from './money.ts';
import { addDays, addMonths, daysBetween, daysInMonth, monthOf, todayIso } from './dates.ts';

export type BudgetPeriod = 'weekly' | 'monthly' | 'annual';

const WARN_AT = 0.85;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export interface Period { key: string; start: string; end: string; label: string; short: string }

export function periodFor(type: BudgetPeriod, date: string): Period {
  if (type === 'monthly') {
    const m = monthOf(date);
    const [y, mo] = m.split('-').map(Number);
    return { key: m, start: `${m}-01`, end: `${m}-${String(daysInMonth(m)).padStart(2, '0')}`, label: `${MONTHS[mo - 1]} ${y}`, short: MONTHS[mo - 1].slice(0, 3) };
  }
  if (type === 'annual') {
    const y = date.slice(0, 4);
    return { key: y, start: `${y}-01-01`, end: `${y}-12-31`, label: y, short: y };
  }
  const dow = new Date(date + 'T00:00:00Z').getUTCDay(); // 0 = Sunday
  const start = addDays(date, -((dow + 6) % 7));
  const end = addDays(start, 6);
  const fmt = (d: string) => `${Number(d.slice(8))} ${MONTHS[Number(d.slice(5, 7)) - 1].slice(0, 3)}`;
  return { key: start, start, end, label: `${fmt(start)} – ${fmt(end)}`, short: fmt(start) };
}

export function previousPeriod(type: BudgetPeriod, p: Period): Period {
  if (type === 'monthly') return periodFor(type, `${addMonths(p.key, -1)}-01`);
  if (type === 'annual') return periodFor(type, `${Number(p.key) - 1}-06-01`);
  return periodFor(type, addDays(p.start, -7));
}

export function nextPeriod(type: BudgetPeriod, p: Period): Period {
  return periodFor(type, addDays(p.end, 1));
}

interface BudgetRow {
  id: number; name: string; period: BudgetPeriod; rollover: number; start_date: string;
  colour: string; icon: string | null; sort_order: number; archived: number; percent: number | null;
  kind: 'spending' | 'saving'; account_id: number | null;
}

/** Money moved into an account (net of withdrawals) per period key. */
function savedByPeriod(db: DB, type: BudgetPeriod, accountId: number, from: string, to: string): Map<string, number> {
  const out = new Map<string, number>();
  const key = type === 'weekly'
    ? `date(t.date, '-' || ((CAST(strftime('%w', t.date) AS INTEGER) + 6) % 7) || ' days')`
    : type === 'monthly' ? 't.period' : 'substr(t.period, 1, 4)';
  const range = type === 'weekly' ? 't.date BETWEEN ? AND ?' : 't.period BETWEEN ? AND ?';
  const rows = db.prepare(
    `SELECT ${key} AS k, SUM(p.amount) AS n FROM postings p JOIN transactions t ON t.id = p.transaction_id
     WHERE t.kind = 'transfer' AND p.account_id = ? AND ${range} GROUP BY k`,
  ).all(accountId, ...(type === 'weekly' ? [from, to] : [monthOf(from), monthOf(to)])) as { k: string; n: number }[];
  for (const r of rows) out.set(r.k, r.n);
  return out;
}

/** Budget categories plus their subcategories. */
function categoryIds(db: DB, budgetId: number): number[] {
  return (db.prepare(
    `SELECT DISTINCT c.id FROM budget_categories bc JOIN categories c ON c.id = bc.category_id OR c.parent_id = bc.category_id
     WHERE bc.budget_id = ?`,
  ).all(budgetId) as { id: number }[]).map((r) => r.id);
}

/** Spending per period key between two dates (inclusive). */
function spendingByPeriod(db: DB, type: BudgetPeriod, cats: number[], from: string, to: string): Map<string, number> {
  const out = new Map<string, number>();
  if (cats.length === 0) return out;
  const marks = cats.map(() => '?').join(',');
  let sql: string;
  let params: (string | number)[];
  if (type === 'weekly') {
    sql = `SELECT date(t.date, '-' || ((CAST(strftime('%w', t.date) AS INTEGER) + 6) % 7) || ' days') AS k, SUM(-p.amount) AS n
           FROM postings p JOIN transactions t ON t.id = p.transaction_id
           WHERE t.kind = 'expense' AND p.category_id IN (${marks}) AND t.date BETWEEN ? AND ? GROUP BY k`;
    params = [...cats, from, to];
  } else {
    const key = type === 'monthly' ? 't.period' : 'substr(t.period, 1, 4)';
    sql = `SELECT ${key} AS k, SUM(-p.amount) AS n
           FROM postings p JOIN transactions t ON t.id = p.transaction_id
           WHERE t.kind = 'expense' AND p.category_id IN (${marks}) AND t.period BETWEEN ? AND ? GROUP BY k`;
    params = [...cats, monthOf(from), monthOf(to)];
  }
  for (const r of db.prepare(sql).all(...params) as { k: string; n: number }[]) out.set(r.k, r.n);
  return out;
}

/** The limit that applied in a period: latest change on or before its end (or the first limit, for earlier periods). */
function limitFor(amounts: { effective_date: string; amount: number }[], p: Period): number {
  let found: number | null = null;
  for (const a of amounts) if (a.effective_date <= p.end) found = a.amount;
  return found ?? amounts[0]?.amount ?? 0;
}

export interface BudgetView {
  id: number; name: string; period: BudgetPeriod; rollover: boolean; colour: string; icon: string | null; archived: boolean;
  /** 'saving': a target for money moved into `account`; `spent` is the amount saved. */
  kind: 'spending' | 'saving';
  account: { id: number; name: string; colour: string } | null;
  /** Basis points of monthly take-home pay, when the limit follows your pay. */
  percent: number | null;
  categories: { id: number; name: string; colour: string }[];
  current: Period;
  limit: number; carried: number; available: number; spent: number; remaining: number; pct: number;
  status: 'ok' | 'warn' | 'over';
  pace: { elapsed: number; expected: number; projected: number; perDayLeft: number | null; daysLeft: number; onTrack: boolean } | null;
  history: { key: string; label: string; short: string; limit: number; spent: number }[];
}

export function budgetView(db: DB, b: BudgetRow, refDate: string, today = todayIso()): BudgetView {
  const type = b.period;
  const current = periodFor(type, refDate);
  const cats = categoryIds(db, b.id);
  const amounts = db.prepare('SELECT effective_date, amount FROM budget_amounts WHERE budget_id = ? ORDER BY effective_date, id').all(b.id) as { effective_date: string; amount: number }[];

  // History: the 6 periods up to and including the current one.
  const hist: Period[] = [current];
  while (hist.length < 6) hist.unshift(previousPeriod(type, hist[0]));
  const first = periodFor(type, b.start_date);
  const from = first.start < hist[0].start ? first.start : hist[0].start;
  const saving = b.kind === 'saving' && b.account_id != null;
  const spent = saving ? savedByPeriod(db, type, b.account_id!, from, current.end) : spendingByPeriod(db, type, cats, from, current.end);

  // Rollover: carry unused money forward from the period the budget started.
  let carried = 0;
  if (b.rollover && !saving && first.start < current.start) {
    let guard = 0;
    for (let p = first; p.start < current.start && guard < 600; p = nextPeriod(type, p), guard++) {
      carried = Math.max(0, limitFor(amounts, p) + carried - (spent.get(p.key) ?? 0));
    }
  }

  const limit = limitFor(amounts, current);
  const available = limit + carried;
  const s = spent.get(current.key) ?? 0;
  const pct = available > 0 ? s / available : s > 0 ? Infinity : 0;

  let pace: BudgetView['pace'] = null;
  if (today >= current.start && today <= current.end) {
    const total = daysBetween(current.start, current.end) + 1;
    const elapsedDays = daysBetween(current.start, today) + 1;
    const elapsed = elapsedDays / total;
    const daysLeft = total - elapsedDays + 1; // including today
    pace = {
      elapsed,
      expected: Math.round(available * elapsed),
      projected: Math.round(s / elapsed),
      perDayLeft: available - s > 0 ? Math.floor((available - s) / daysLeft) : null,
      daysLeft,
      onTrack: s <= available * elapsed * 1.05,
    };
  }

  const names = db.prepare('SELECT c.id, c.name, c.colour FROM budget_categories bc JOIN categories c ON c.id = bc.category_id WHERE bc.budget_id = ? ORDER BY c.name').all(b.id) as { id: number; name: string; colour: string }[];
  const account = saving ? (db.prepare('SELECT id, name, colour FROM accounts WHERE id = ?').get(b.account_id!) as { id: number; name: string; colour: string } | undefined) ?? null : null;

  // A savings goal is never "over"; it's behind when the period is running out faster than the money is going in.
  let status: BudgetView['status'] = pct >= 1 && s > 0 ? 'over' : pct >= WARN_AT ? 'warn' : 'ok';
  if (saving) status = s >= available ? 'ok' : pace && pace.elapsed > 0.5 && s < pace.expected * 0.8 ? 'warn' : 'ok';
  if (saving && pace) {
    pace.perDayLeft = available - s > 0 ? Math.ceil((available - s) / pace.daysLeft) : null;
    pace.onTrack = s >= pace.expected * 0.8 || s >= available;
  }

  return {
    id: b.id, name: b.name, period: type, rollover: !!b.rollover && !saving, colour: b.colour, icon: b.icon, archived: !!b.archived, percent: b.percent ?? null,
    kind: saving ? 'saving' : 'spending', account: account ? { id: account.id, name: account.name, colour: account.colour } : null,
    categories: names.map((n) => ({ id: n.id, name: n.name, colour: n.colour })),
    current, limit, carried, available, spent: s, remaining: available - s, pct: Number.isFinite(pct) ? pct : 9.99,
    status,
    pace,
    history: hist.map((p) => ({ key: p.key, label: p.label, short: p.short, limit: limitFor(amounts, p), spent: spent.get(p.key) ?? 0 })),
  };
}

/** All budgets as they stood in a month (weekly/annual budgets use the period containing the reference day). */
export function listBudgets(db: DB, month: string, today = todayIso()) {
  syncPercentBudgets(db, today);
  const end = `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;
  const refDate = monthOf(today) === month ? today : end < today ? end : `${month}-01`;
  const rows = db.prepare('SELECT * FROM budgets WHERE archived = 0 ORDER BY sort_order, id').all() as unknown as BudgetRow[];
  const all = rows.map((b) => budgetView(db, b, refDate, today));
  const budgets = all.filter((b) => b.kind === 'spending');
  const goals = all.filter((b) => b.kind === 'saving');

  // Month totals. Monthly budgets count as-is; weekly ones are scaled to the month. A weekly budget whose
  // categories are all inside a monthly budget is a sub-limit (e.g. "lunches" within "eating out"), so it
  // isn't added again. Spending is counted once per category however many budgets include it.
  // Annual budgets are shown on their own.
  const catsOf = new Map(budgets.map((b) => [b.id, categoryIds(db, b.id)]));
  const monthlyCats = new Set(budgets.filter((b) => b.period === 'monthly').flatMap((b) => catsOf.get(b.id)!));
  let total = 0;
  const counted = new Set<number>();
  for (const b of budgets) {
    const cats = catsOf.get(b.id)!;
    if (b.period === 'monthly') { total += b.available; cats.forEach((c) => counted.add(c)); }
    if (b.period === 'weekly' && !cats.every((c) => monthlyCats.has(c))) {
      total += Math.round((b.limit * daysInMonth(month)) / 7);
      cats.forEach((c) => counted.add(c));
    }
  }
  let spent = 0;
  if (counted.size) {
    spent = (db.prepare(
      `SELECT IFNULL(SUM(-p.amount), 0) AS n FROM postings p JOIN transactions t ON t.id = p.transaction_id
       WHERE t.kind = 'expense' AND p.category_id IN (${[...counted].map(() => '?').join(',')}) AND t.period = ?`,
    ).get(...counted, month) as { n: number }).n;
  }

  // Day-to-day spending this month that no budget covers. Fixed costs (rent, bills,
  // subscriptions) are left out: they're planned on the Bills page.
  const covered = new Set(rows.filter((b) => b.kind !== 'saving').flatMap((b) => categoryIds(db, b.id)));
  const unbudgeted = (db.prepare(
    `SELECT IFNULL(top.id, 0) AS id, IFNULL(top.name, 'Uncategorised') AS name, IFNULL(top.colour, '#94a3b8') AS colour, p.category_id AS cid, SUM(-p.amount) AS n
     FROM postings p JOIN transactions t ON t.id = p.transaction_id
     LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN categories top ON top.id = IFNULL(c.parent_id, c.id)
     WHERE t.kind = 'expense' AND t.period = ? AND IFNULL(top.is_fixed, 0) = 0 GROUP BY p.category_id`,
  ).all(month) as { id: number; name: string; colour: string; cid: number | null; n: number }[])
    .filter((r) => r.cid === null || !covered.has(r.cid));
  const byTop = new Map<number, { id: number; name: string; colour: string; amount: number }>();
  for (const r of unbudgeted) {
    const e = byTop.get(r.id) ?? { id: r.id, name: r.name, colour: r.colour, amount: 0 };
    e.amount += r.n;
    byTop.set(r.id, e);
  }
  const unbudgetedList = [...byTop.values()].filter((e) => e.amount > 0).sort((a, b) => b.amount - a.amount);

  const pay = takeHome(db, today);
  const monthlyGoal = (b: BudgetView) => (b.period === 'monthly' ? b.available : b.period === 'weekly' ? Math.round((b.limit * daysInMonth(month)) / 7) : 0);
  const monthlyGoals = goals.filter((g) => g.period !== 'annual');
  return {
    month,
    budgets: all,
    takeHome: pay.amount,
    savings: {
      target: monthlyGoals.reduce((t, g) => t + monthlyGoal(g), 0),
      saved: monthlyGoals.reduce((t, g) => t + (g.period === 'monthly' ? g.spent : 0), 0)
        + monthlyGoals.filter((g) => g.period === 'weekly').reduce((t, g) => t + savedInMonth(db, g.account!.id, month), 0),
      count: goals.length,
    },
    summary: {
      total, spent, remaining: total - spent, pct: total > 0 ? spent / total : null,
      over: budgets.filter((b) => b.status === 'over').length,
      warn: budgets.filter((b) => b.status === 'warn').length,
      unbudgeted: unbudgetedList.reduce((s, e) => s + e.amount, 0),
      unbudgetedCategories: unbudgetedList,
    },
  };
}

function savedInMonth(db: DB, accountId: number, month: string): number {
  return (db.prepare(
    `SELECT IFNULL(SUM(p.amount), 0) AS n FROM postings p JOIN transactions t ON t.id = p.transaction_id
     WHERE t.kind = 'transfer' AND p.account_id = ? AND t.period = ?`,
  ).get(accountId, month) as { n: number }).n;
}

// ---------------------------------------------------------------------------
// CRUD

export interface BudgetInput {
  name: string;
  period: BudgetPeriod;
  /** 'saving' budgets are a target for money moved into accountId. */
  kind?: 'spending' | 'saving';
  accountId?: number | null;
  /** Fixed limit in pence. Ignored when percent is set. */
  amount?: number;
  /** Basis points of monthly take-home pay (1000 = 10%). */
  percent?: number | null;
  categoryIds: number[];
  rollover?: boolean;
  colour?: string;
  icon?: string | null;
  /** When the amount changes: 'now' keeps past periods as they were; 'all' rewrites history. */
  applyFrom?: 'now' | 'all';
}

function validate(db: DB, i: BudgetInput) {
  if (typeof i.name !== 'string' || !i.name.trim()) throw new ValidationError('Give the budget a name');
  if (!['weekly', 'monthly', 'annual'].includes(i.period)) throw new ValidationError('Choose weekly, monthly or yearly');
  if (i.percent != null) {
    if (!Number.isInteger(i.percent) || i.percent <= 0 || i.percent > 10000) throw new ValidationError('Percentage must be between 0.01% and 100%');
    const pay = takeHome(db).amount;
    if (!pay) throw new ValidationError('Set your take-home pay first (or add your salary under Bills and income)');
    i.amount = percentLimit(pay, i.percent, i.period);
  } else if (assertPence(i.amount, 'Amount') <= 0) throw new ValidationError('The limit must be more than £0');
  if (i.kind === 'saving') {
    const a = db.prepare('SELECT type FROM accounts WHERE id = ?').get(i.accountId ?? -1) as { type: string } | undefined;
    if (!a) throw new ValidationError('Choose the account you are saving into');
    if (['credit_card', 'loan', 'other_liability'].includes(a.type)) throw new ValidationError('Savings goals are for savings, pots and investment accounts. Pay off debts on the Debts page.');
    i.categoryIds = [];
    return;
  }
  if (i.kind !== undefined && i.kind !== 'spending') throw new ValidationError('Unknown budget type');
  if (!Array.isArray(i.categoryIds) || i.categoryIds.length === 0) throw new ValidationError('Choose at least one category');
  for (const id of i.categoryIds) {
    const c = db.prepare('SELECT kind FROM categories WHERE id = ?').get(id) as { kind: string } | undefined;
    if (!c) throw new ValidationError('Category not found');
    if (c.kind !== 'expense') throw new ValidationError('Budgets are for spending categories');
  }
  if (i.colour && !/^#[0-9a-fA-F]{6}$/.test(i.colour)) throw new ValidationError('Colour must be a hex value');
}

export function createBudget(db: DB, i: BudgetInput, today = todayIso()): number {
  validate(db, i);
  return tx(db, () => {
    const start = periodFor(i.period, today).start;
    const order = (db.prepare('SELECT IFNULL(MAX(sort_order), 0) + 1 AS n FROM budgets').get() as { n: number }).n;
    const saving = i.kind === 'saving';
    const colour = i.colour ?? (saving
      ? (db.prepare('SELECT colour FROM accounts WHERE id = ?').get(i.accountId!) as { colour: string }).colour
      : (db.prepare('SELECT colour FROM categories WHERE id = ?').get(i.categoryIds[0]) as { colour: string }).colour);
    const icon = i.icon !== undefined ? i.icon : saving ? '🎯' : (db.prepare('SELECT icon FROM categories WHERE id = ?').get(i.categoryIds[0]) as { icon: string | null }).icon;
    const id = Number(db.prepare('INSERT INTO budgets (name, period, rollover, start_date, colour, icon, sort_order, percent, kind, account_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(i.name.trim(), i.period, i.rollover && !saving ? 1 : 0, start, colour, icon, order, i.percent ?? null, saving ? 'saving' : 'spending', saving ? i.accountId! : null).lastInsertRowid);
    const ins = db.prepare('INSERT INTO budget_categories (budget_id, category_id) VALUES (?, ?)');
    for (const c of new Set(i.categoryIds)) ins.run(id, c);
    db.prepare('INSERT INTO budget_amounts (budget_id, effective_date, amount) VALUES (?, ?, ?)').run(id, start, i.amount!);
    return id;
  });
}

export function updateBudget(db: DB, id: number, i: BudgetInput, today = todayIso()) {
  validate(db, i);
  const b = db.prepare('SELECT * FROM budgets WHERE id = ?').get(id) as BudgetRow | undefined;
  if (!b) throw new ValidationError('Budget not found');
  tx(db, () => {
    let start = b.start_date;
    if (i.period !== b.period) {
      // A different period is effectively a new budget.
      start = periodFor(i.period, today).start;
      db.prepare('DELETE FROM budget_amounts WHERE budget_id = ?').run(id);
      db.prepare('INSERT INTO budget_amounts (budget_id, effective_date, amount) VALUES (?, ?, ?)').run(id, start, i.amount!);
    } else if (i.applyFrom === 'all') {
      db.prepare('DELETE FROM budget_amounts WHERE budget_id = ?').run(id);
      db.prepare('INSERT INTO budget_amounts (budget_id, effective_date, amount) VALUES (?, ?, ?)').run(id, start, i.amount!);
    } else {
      const amounts = db.prepare('SELECT effective_date, amount FROM budget_amounts WHERE budget_id = ? ORDER BY effective_date, id').all(id) as { effective_date: string; amount: number }[];
      const current = periodFor(i.period, today);
      if (limitFor(amounts, current) !== i.amount!) {
        db.prepare('INSERT INTO budget_amounts (budget_id, effective_date, amount) VALUES (?, ?, ?) ON CONFLICT(budget_id, effective_date) DO UPDATE SET amount = excluded.amount')
          .run(id, current.start < start ? start : current.start, i.amount!);
      }
    }
    const saving = i.kind === 'saving';
    db.prepare('UPDATE budgets SET name = ?, period = ?, rollover = ?, start_date = ?, colour = ?, icon = ?, percent = ?, kind = ?, account_id = ? WHERE id = ?')
      .run(i.name.trim(), i.period, i.rollover && !saving ? 1 : 0, start, i.colour ?? b.colour, i.icon !== undefined ? i.icon : b.icon, i.percent ?? null,
        saving ? 'saving' : 'spending', saving ? i.accountId! : null, id);
    db.prepare('DELETE FROM budget_categories WHERE budget_id = ?').run(id);
    const ins = db.prepare('INSERT INTO budget_categories (budget_id, category_id) VALUES (?, ?)');
    for (const c of new Set(i.categoryIds)) ins.run(id, c);
  });
}

export function deleteBudget(db: DB, id: number) {
  db.prepare('DELETE FROM budgets WHERE id = ?').run(id);
}

export function reorderBudgets(db: DB, ids: number[]) {
  tx(db, () => ids.forEach((id, i) => db.prepare('UPDATE budgets SET sort_order = ? WHERE id = ?').run(i, id)));
}

/** The account a savings goal saves into (for filtering transactions). */
export function budgetAccount(db: DB, id: number): number | null {
  return (db.prepare("SELECT account_id FROM budgets WHERE id = ? AND kind = 'saving'").get(id) as { account_id: number } | undefined)?.account_id ?? null;
}

/** Category ids a budget covers (for filtering transactions). */
export function budgetCategoryIds(db: DB, id: number): number[] {
  return categoryIds(db, id);
}

// ---------------------------------------------------------------------------
// Suggestions from the last three full months of spending

export function suggestBudgets(db: DB, today = todayIso()) {
  const thisMonth = monthOf(today);
  const months = [1, 2, 3].map((n) => addMonths(thisMonth, -n));
  const covered = new Set((db.prepare('SELECT category_id FROM budget_categories').all() as { category_id: number }[]).map((r) => r.category_id));
  const rows = db.prepare(
    `SELECT top.id, top.name, top.colour, top.icon, top.is_fixed, t.period, SUM(-p.amount) AS n
     FROM postings p JOIN transactions t ON t.id = p.transaction_id
     JOIN categories c ON c.id = p.category_id JOIN categories top ON top.id = IFNULL(c.parent_id, c.id)
     WHERE t.kind = 'expense' AND t.period IN (?, ?, ?)
     GROUP BY top.id, t.period`,
  ).all(...months) as { id: number; name: string; colour: string; icon: string | null; is_fixed: number; period: string; n: number }[];
  const by = new Map<number, { id: number; name: string; colour: string; icon: string | null; isFixed: boolean; months: Record<string, number> }>();
  for (const r of rows) {
    const e = by.get(r.id) ?? { id: r.id, name: r.name, colour: r.colour, icon: r.icon, isFixed: !!r.is_fixed, months: {} };
    e.months[r.period] = r.n;
    by.set(r.id, e);
  }
  const withData = months.filter((m) => rows.some((r) => r.period === m));
  const guide = readJsonSetting<Record<string, number | null>>(db, 'budget_guide', {});
  const pay = takeHome(db, today).amount;
  const n = Math.max(1, withData.length);
  return [...by.values()]
    .filter((e) => !covered.has(e.id) && !e.isFixed)
    .map((e) => {
      const avg = Math.round(Object.values(e.months).reduce((s, v) => s + v, 0) / n);
      const step = avg >= 20000 ? 2500 : 1000; // round up to £25 or £10
      const percent = guide[e.id] !== undefined ? guide[e.id] : DEFAULT_GUIDE[e.name] ?? null;
      return {
        categoryId: e.id, name: e.name, colour: e.colour, icon: e.icon, average: avg, suggested: Math.max(step, Math.ceil(avg / step) * step), months: withData.length,
        percent, recommended: percent != null && pay ? Math.round((pay * percent) / 10000) : null,
      };
    })
    .filter((e) => e.average >= 1000)
    .sort((a, b) => b.average - a.average);
}

export function isPeriod(v: unknown): v is BudgetPeriod {
  return v === 'weekly' || v === 'monthly' || v === 'annual';
}

// ---------------------------------------------------------------------------
// Budgets as a share of take-home pay

/**
 * Starting-point percentages of monthly take-home pay, for day-to-day
 * categories. Rules of thumb only — every value can be changed in the app.
 */
export const DEFAULT_GUIDE: Record<string, number> = {
  Groceries: 1000,
  'Eating Out': 500,
  Transport: 700,
  Shopping: 500,
  Entertainment: 400,
  'Personal Care': 300,
  'Health & Fitness': 300,
  Travel: 500,
  Education: 200,
  Miscellaneous: 300,
  Subscriptions: 200,
};
/** Day-to-day categories treated as needs in the 50/30/20 view (fixed costs always are). */
const NEED_NAMES = new Set(['Groceries', 'Transport', 'Education']);
export const DEFAULT_SPLIT = { needs: 5000, wants: 3000, savings: 2000 };

export interface TakeHome { amount: number | null; source: 'manual' | 'salary' | 'average' | 'none'; derived: number | null; derivedSource: 'salary' | 'average' | 'none' }

/** Monthly take-home pay: your own figure if set, else your salary bills entry, else average income. */
export function takeHome(db: DB, today = todayIso()): TakeHome {
  const manual = db.prepare("SELECT value FROM settings WHERE key = 'take_home'").get() as { value: string } | undefined;
  // Salary-like recurring income (categories marked "paid at the end of the month"), else any recurring income.
  const rec = db.prepare(
    `SELECT r.amount, r.frequency, IFNULL(c.roll_forward, 0) AS salary FROM recurring r LEFT JOIN categories c ON c.id = r.category_id
     WHERE r.type = 'income' AND r.active = 1
       AND NOT (r.frequency = 'annually' AND IFNULL(r.end_date, '') = r.start_date)  -- one-off bonuses aren't regular pay
       AND IFNULL(c.name, '') != 'Bonuses'`,
  ).all() as { amount: number; frequency: string; salary: number }[];
  const perYear: Record<string, number> = { weekly: 52, fortnightly: 26, four_weekly: 13, monthly: 12, quarterly: 4, annually: 1 };
  const pick = rec.some((r) => r.salary) ? rec.filter((r) => r.salary) : rec;
  let derived: number | null = null;
  let derivedSource: TakeHome['derivedSource'] = 'none';
  if (pick.length) {
    derived = Math.round(pick.reduce((s, r) => s + (r.amount * perYear[r.frequency]) / 12, 0));
    derivedSource = 'salary';
  } else {
    const months = [1, 2, 3].map((n) => addMonths(monthOf(today), -n));
    const r = db.prepare(
      `SELECT t.period, SUM(p.amount) AS n FROM postings p JOIN transactions t ON t.id = p.transaction_id
       WHERE t.kind = 'income' AND t.period IN (?, ?, ?) GROUP BY t.period`,
    ).all(...months) as { period: string; n: number }[];
    if (r.length) { derived = Math.round(r.reduce((s, x) => s + x.n, 0) / r.length); derivedSource = 'average'; }
  }
  if (manual && Number(manual.value) > 0) return { amount: Number(manual.value), source: 'manual', derived, derivedSource };
  return { amount: derived, source: derivedSource, derived, derivedSource };
}

function scaleMonthly(monthly: number, period: BudgetPeriod): number {
  return period === 'weekly' ? Math.round((monthly * 12) / 52) : period === 'annual' ? monthly * 12 : monthly;
}

/** Limit for a % budget, from monthly take-home pay. */
export function percentLimit(pay: number, percent: number, period: BudgetPeriod): number {
  return Math.max(1, scaleMonthly(Math.round((pay * percent) / 10000), period));
}

/**
 * Keep %-based budgets in line with take-home pay. A pay change starts a new
 * limit from the current period, so past months keep the limit they had.
 */
export function syncPercentBudgets(db: DB, today = todayIso()) {
  const pay = takeHome(db, today).amount;
  if (!pay) return;
  const rows = db.prepare('SELECT * FROM budgets WHERE percent IS NOT NULL AND archived = 0').all() as unknown as (BudgetRow & { percent: number })[];
  for (const b of rows) {
    const want = percentLimit(pay, b.percent, b.period);
    const amounts = db.prepare('SELECT effective_date, amount FROM budget_amounts WHERE budget_id = ? ORDER BY effective_date, id').all(b.id) as { effective_date: string; amount: number }[];
    const current = periodFor(b.period, today);
    if (limitFor(amounts, current) === want) continue;
    db.prepare('INSERT INTO budget_amounts (budget_id, effective_date, amount) VALUES (?, ?, ?) ON CONFLICT(budget_id, effective_date) DO UPDATE SET amount = excluded.amount')
      .run(b.id, current.start < b.start_date ? b.start_date : current.start, want);
  }
}

function readJsonSetting<T>(db: DB, key: string, fallback: T): T {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (!r) return fallback;
  try { return { ...fallback, ...JSON.parse(r.value) }; } catch { return fallback; }
}

/** Recommended share of pay per day-to-day category, the 50/30/20 split, and how this month compares. */
export function budgetGuide(db: DB, month: string, today = todayIso()) {
  const pay = takeHome(db, today);
  const custom = readJsonSetting<Record<string, number | null>>(db, 'budget_guide', {});
  const split = readJsonSetting(db, 'budget_split', DEFAULT_SPLIT);
  const cats = db.prepare("SELECT id, name, colour, icon, is_fixed FROM categories WHERE kind = 'expense' AND parent_id IS NULL AND archived = 0 ORDER BY sort_order, name").all() as { id: number; name: string; colour: string; icon: string | null; is_fixed: number }[];
  const budgets = db.prepare(
    `SELECT b.id, b.name, b.percent, bc.category_id FROM budgets b JOIN budget_categories bc ON bc.budget_id = b.id WHERE b.archived = 0`,
  ).all() as { id: number; name: string; percent: number | null; category_id: number }[];
  const months = [1, 2, 3].map((n) => addMonths(monthOf(today), -n));
  const avg = new Map((db.prepare(
    `SELECT IFNULL(c.parent_id, c.id) AS id, SUM(-p.amount) AS n FROM postings p JOIN transactions t ON t.id = p.transaction_id
     JOIN categories c ON c.id = p.category_id WHERE t.kind = 'expense' AND t.period IN (?, ?, ?) GROUP BY IFNULL(c.parent_id, c.id)`,
  ).all(...months) as { id: number; n: number }[]).map((r) => [r.id, Math.round(r.n / 3)]));

  const categories = cats.filter((c) => !c.is_fixed && c.name !== 'Interest & Fees').map((c) => {
    const percent = c.id in custom ? custom[c.id] : DEFAULT_GUIDE[c.name] ?? null;
    const b = budgets.find((x) => x.category_id === c.id);
    return {
      categoryId: c.id, name: c.name, colour: c.colour, icon: c.icon,
      group: NEED_NAMES.has(c.name) ? 'needs' : 'wants',
      percent, custom: c.id in custom,
      amount: percent != null && pay.amount ? Math.round((pay.amount * percent) / 10000) : null,
      average: avg.get(c.id) ?? 0,
      budgetId: b?.id ?? null, budgetName: b?.name ?? null,
    };
  });

  // 50/30/20 for the month: needs = fixed costs + essential day-to-day; wants = everything else;
  // savings = money moved into savings, pots and investments.
  const spend = db.prepare(
    `SELECT top.name AS name, top.is_fixed AS fixed, SUM(-p.amount) AS n FROM postings p JOIN transactions t ON t.id = p.transaction_id
     LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN categories top ON top.id = IFNULL(c.parent_id, c.id)
     WHERE t.kind = 'expense' AND t.period = ? GROUP BY top.id`,
  ).all(month) as { name: string | null; fixed: number | null; n: number }[];
  let needs = 0, wants = 0;
  for (const r of spend) (r.fixed || (r.name && NEED_NAMES.has(r.name)) ? (needs += r.n) : (wants += r.n));
  const saved = (db.prepare(
    `SELECT IFNULL(SUM(pin.amount), 0) AS n FROM transactions t
     JOIN postings pin ON pin.transaction_id = t.id AND pin.amount > 0 JOIN accounts a ON a.id = pin.account_id AND a.type IN ('savings','pot','investment')
     JOIN postings pout ON pout.transaction_id = t.id AND pout.amount < 0 JOIN accounts s ON s.id = pout.account_id AND s.type NOT IN ('savings','pot','investment')
     WHERE t.kind = 'transfer' AND t.period = ?`,
  ).get(month) as { n: number }).n;

  return {
    takeHome: pay,
    split,
    actual: { needs, wants, savings: saved },
    categories,
    totalPercent: categories.reduce((s, c) => s + (c.percent ?? 0), 0),
  };
}

export function updateGuide(db: DB, body: { takeHome?: number | null; percents?: Record<string, number | null>; split?: { needs: number; wants: number; savings: number }; reset?: boolean }) {
  tx(db, () => {
    if (body.takeHome !== undefined) {
      if (body.takeHome === null || body.takeHome === 0) db.prepare("DELETE FROM settings WHERE key = 'take_home'").run();
      else {
        assertPence(body.takeHome, 'Take-home pay');
        if (body.takeHome < 0) throw new ValidationError('Take-home pay must be positive');
        db.prepare("INSERT INTO settings(key, value) VALUES ('take_home', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(body.takeHome));
      }
    }
    if (body.reset) db.prepare("DELETE FROM settings WHERE key IN ('budget_guide', 'budget_split')").run();
    if (body.percents) {
      const current = readJsonSetting<Record<string, number | null>>(db, 'budget_guide', {});
      for (const [k, v] of Object.entries(body.percents)) {
        if (v !== null && (!Number.isInteger(v) || v < 0 || v > 10000)) throw new ValidationError('Percentages must be between 0 and 100');
        current[k] = v;
      }
      db.prepare("INSERT INTO settings(key, value) VALUES ('budget_guide', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(current));
    }
    if (body.split) {
      const { needs, wants, savings } = body.split;
      if (![needs, wants, savings].every((v) => Number.isInteger(v) && v >= 0 && v <= 10000) || needs + wants + savings !== 10000) {
        throw new ValidationError('Needs, wants and savings must add up to 100%');
      }
      db.prepare("INSERT INTO settings(key, value) VALUES ('budget_split', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify({ needs, wants, savings }));
    }
  });
  syncPercentBudgets(db);
}
