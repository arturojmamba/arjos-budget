/**
 * Reports: trends, merchants, explore, compare, net worth over time and the year in review.
 *
 * Ranges that cover whole calendar months are matched by the month a transaction
 * counts towards (so salary paid on the last working day lands in the next month,
 * as everywhere else). Other ranges, like the tax year (6 April – 5 April), use the
 * transaction date.
 */
import { type DB } from './db.ts';
import { ValidationError } from './money.ts';
import { addMonths, daysInMonth, isIsoDate, monthOf, todayIso } from './dates.ts';
import { listAccounts, SAVED_SQL } from './queries.ts';
import { taxYear } from './investments.ts';
import { merchantKey } from './merchant.ts';
export { merchantKey };

export interface Range { from: string; to: string }

export const monthEnd = (m: string) => `${m}-${String(daysInMonth(m)).padStart(2, '0')}`;

/** SQL condition (on alias t) for a range, plus its parameters. */
export function rangeWhere(r: Range): { sql: string; params: string[] } {
  if (!isIsoDate(r.from) || !isIsoDate(r.to) || r.from > r.to) throw new ValidationError('Choose a valid date range');
  const whole = r.from.endsWith('-01') && r.to === monthEnd(monthOf(r.to));
  return whole ? { sql: 't.period BETWEEN ? AND ?', params: [monthOf(r.from), monthOf(r.to)] } : { sql: 't.date BETWEEN ? AND ?', params: [r.from, r.to] };
}

export function monthsIn(r: Range): string[] {
  const out: string[] = [];
  for (let m = monthOf(r.from); m <= monthOf(r.to); m = addMonths(m, 1)) out.push(m);
  return out;
}

const TOP_JOIN = `LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN categories top ON top.id = IFNULL(c.parent_id, c.id)`;

export function totals(db: DB, r: Range) {
  const w = rangeWhere(r);
  const x = db.prepare(
    `SELECT IFNULL(SUM(CASE WHEN t.kind = 'income' THEN p.amount END), 0) AS income,
            IFNULL(SUM(CASE WHEN t.kind = 'expense' THEN -p.amount END), 0) AS spending
     FROM postings p JOIN transactions t ON t.id = p.transaction_id WHERE ${w.sql}`,
  ).get(...w.params) as { income: number; spending: number };
  const saved = (db.prepare(`SELECT IFNULL(SUM(${SAVED_SQL}), 0) AS n FROM transactions t WHERE t.kind = 'transfer' AND ${w.sql}`).get(...w.params) as { n: number }).n;
  return { income: x.income, spending: x.spending, saved, net: x.income - x.spending, savingsRate: x.income > 0 ? saved / x.income : null };
}

export function byCategory(db: DB, r: Range) {
  const w = rangeWhere(r);
  return (db.prepare(
    `SELECT top.id AS id, IFNULL(top.name, 'Uncategorised') AS name, IFNULL(top.colour, '#94a3b8') AS colour, IFNULL(top.is_fixed, 0) AS fixed,
            SUM(-p.amount) AS amount, COUNT(DISTINCT t.id) AS n
     FROM postings p JOIN transactions t ON t.id = p.transaction_id ${TOP_JOIN}
     WHERE t.kind = 'expense' AND ${w.sql} GROUP BY top.id ORDER BY amount DESC`,
  ).all(...w.params) as any[]).map((x) => ({ categoryId: x.id as number | null, name: x.name as string, colour: x.colour as string, isFixed: !!x.fixed, amount: x.amount as number, count: x.n as number }));
}

/** Repayments into loans and money owed to people (cards are left out: card spending is already counted). */
function loanRepayments(db: DB, r: Range): number {
  const w = rangeWhere(r);
  return (db.prepare(
    `SELECT IFNULL(SUM(p.amount), 0) AS n FROM postings p JOIN transactions t ON t.id = p.transaction_id JOIN accounts a ON a.id = p.account_id
     WHERE t.kind = 'transfer' AND p.amount > 0 AND a.type IN ('loan', 'other_liability') AND ${w.sql}`,
  ).get(...w.params) as { n: number }).n;
}

// ---------------------------------------------------------------------------

/** Month-by-month spending per category, income/spending/saved, fixed vs flexible, and what's changed. */
export function trends(db: DB, months = 12, today = todayIso()) {
  const n = Math.min(Math.max(Math.round(months) || 12, 3), 36);
  const cur = monthOf(today);
  const firstData = (db.prepare('SELECT MIN(period) AS m FROM transactions').get() as { m: string | null }).m ?? cur;
  // Leave out months before your data starts, so charts aren't mostly empty.
  const list = Array.from({ length: n }, (_, i) => addMonths(cur, i - n + 1)).filter((m) => m >= firstData);
  const range = { from: `${list[0]}-01`, to: monthEnd(cur) };
  const w = rangeWhere(range);
  const rows = db.prepare(
    `SELECT t.period AS m, top.id AS id, SUM(-p.amount) AS amount FROM postings p JOIN transactions t ON t.id = p.transaction_id ${TOP_JOIN}
     WHERE t.kind = 'expense' AND ${w.sql} GROUP BY t.period, top.id`,
  ).all(...w.params) as { m: string; id: number | null; amount: number }[];
  const cats = byCategory(db, range);
  const full = list.filter((m) => m < cur);
  const categories = cats.map((c) => {
    const series = list.map((m) => rows.find((r) => r.m === m && r.id === c.categoryId)?.amount ?? 0);
    const fullVals = series.slice(0, full.length);
    const withData = fullVals.filter((_, i) => monthHasData(db, full[i]));
    const average = withData.length ? Math.round(withData.reduce((s, v) => s + v, 0) / withData.length) : 0;
    const last = fullVals[fullVals.length - 1] ?? 0;
    const change = average > 0 ? (last - average) / average : null;
    return { ...c, series, average, last, change };
  });
  const flow = list.map((m) => {
    const r = { from: `${m}-01`, to: monthEnd(m) };
    const t = totals(db, r);
    const fixedSpend = byCategory(db, r).filter((c) => c.isFixed).reduce((s, c) => s + c.amount, 0);
    const loans = loanRepayments(db, r);
    return { month: m, ...t, fixed: fixedSpend + loans, flexible: Math.max(0, t.spending - fixedSpend), loanRepayments: loans };
  });
  // What stood out last full month compared with your usual.
  const insights = categories
    .filter((c) => c.change !== null && Math.abs(c.last - c.average) >= 2000 && Math.abs(c.change) >= 0.2)
    .sort((a, b) => Math.abs(b.last - b.average) - Math.abs(a.last - a.average))
    .slice(0, 5)
    .map((c) => ({ categoryId: c.categoryId, name: c.name, colour: c.colour, last: c.last, average: c.average, change: c.change!, month: full[full.length - 1] }));
  return { months: list, categories, flow, insights };
}

function monthHasData(db: DB, m: string): boolean {
  return !!db.prepare('SELECT 1 FROM transactions WHERE period = ? LIMIT 1').get(m);
}

/** Where the money goes: spending grouped by merchant. */
export function merchants(db: DB, r: Range, limit = 40) {
  const w = rangeWhere(r);
  const rows = db.prepare(
    `SELECT CASE WHEN t.merchant != '' THEN t.merchant ELSE t.description END AS merchant, IFNULL(top.name, 'Uncategorised') AS category,
            SUM(-p.amount) AS total, COUNT(DISTINCT t.id) AS n, MAX(t.date) AS last
     FROM postings p JOIN transactions t ON t.id = p.transaction_id ${TOP_JOIN}
     WHERE t.kind = 'expense' AND ${w.sql} GROUP BY 1, 2`,
  ).all(...w.params) as { merchant: string; category: string; total: number; n: number; last: string }[];
  const groups = new Map<string, { merchant: string; search: string; total: number; count: number; last: string; cats: Map<string, number> }>();
  for (const x of rows) {
    const key = merchantKey(x.merchant);
    const g = groups.get(key) ?? { merchant: key, search: x.merchant, total: 0, count: 0, last: '', cats: new Map() };
    g.total += x.total; g.count += x.n; if (x.last > g.last) g.last = x.last;
    g.cats.set(x.category, (g.cats.get(x.category) ?? 0) + x.total);
    if (x.merchant.length < g.search.length) g.search = x.merchant;
    groups.set(key, g);
  }
  const all = totals(db, r).spending;
  const list = [...groups.values()].sort((a, b) => b.total - a.total).slice(0, limit);
  return {
    range: r,
    spending: all,
    merchants: list.map((g) => ({
      merchant: g.merchant, search: merchantKey(g.search).toLowerCase(), total: g.total, count: g.count, average: Math.round(g.total / g.count), last: g.last,
      category: [...g.cats.entries()].sort((a, b) => b[1] - a[1])[0][0], share: all > 0 ? g.total / all : 0,
    })),
  };
}

/** Answer "how much did I spend on X": by category and/or text, over a range. */
export function explore(db: DB, q: Range & { categoryId?: number | null; search?: string; kind?: 'expense' | 'income' }) {
  const w = rangeWhere(q);
  const kind = q.kind === 'income' ? 'income' : 'expense';
  const where = [`t.kind = '${kind}'`, w.sql];
  const params: (string | number)[] = [...w.params];
  if (q.categoryId) { where.push('(c.id = ? OR c.parent_id = ?)'); params.push(q.categoryId, q.categoryId); }
  if (q.search?.trim()) {
    where.push("(lower(t.description) LIKE ? OR lower(t.merchant) LIKE ? OR lower(IFNULL(t.notes, '')) LIKE ?)");
    const like = `%${q.search.trim().toLowerCase()}%`;
    params.push(like, like, like);
  }
  const sign = kind === 'expense' ? -1 : 1;
  const base = `FROM postings p JOIN transactions t ON t.id = p.transaction_id ${TOP_JOIN} WHERE ${where.join(' AND ')}`;
  const sum = db.prepare(`SELECT IFNULL(SUM(${sign} * p.amount), 0) AS total, COUNT(DISTINCT t.id) AS n, MIN(t.date) AS first, MAX(t.date) AS last ${base}`).get(...params) as any;
  const monthly = db.prepare(`SELECT substr(t.date, 1, 7) AS m, SUM(${sign} * p.amount) AS total, COUNT(DISTINCT t.id) AS n ${base} GROUP BY m ORDER BY m`).all(...params) as any[];
  const biggest = db.prepare(`SELECT t.id, t.date, t.description, SUM(${sign} * p.amount) AS amount ${base} GROUP BY t.id ORDER BY amount DESC LIMIT 5`).all(...params) as any[];
  const months = monthsIn(q);
  return {
    total: sum.total, count: sum.n, first: sum.first, last: sum.last,
    perMonth: months.length ? Math.round(sum.total / months.length) : 0,
    average: sum.n ? Math.round(sum.total / sum.n) : 0,
    monthly: months.map((m) => ({ month: m, total: monthly.find((x) => x.m === m)?.total ?? 0, count: monthly.find((x) => x.m === m)?.n ?? 0 })),
    biggest: biggest.map((b) => ({ id: b.id, date: b.date, description: b.description, amount: b.amount })),
  };
}

/** Two periods side by side, by category: `a` against `b` (diff = a − b). */
export function compare(db: DB, a: Range, b: Range) {
  const ca = byCategory(db, a), cb = byCategory(db, b);
  const keys = new Map<string, { categoryId: number | null; name: string; colour: string }>();
  for (const c of [...ca, ...cb]) keys.set(String(c.categoryId), { categoryId: c.categoryId, name: c.name, colour: c.colour });
  const rows = [...keys.values()].map((k) => {
    const va = ca.find((c) => c.categoryId === k.categoryId)?.amount ?? 0;
    const vb = cb.find((c) => c.categoryId === k.categoryId)?.amount ?? 0;
    return { ...k, a: va, b: vb, diff: va - vb, change: vb > 0 ? (va - vb) / vb : null };
  }).sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff));
  return { a: { range: a, ...totals(db, a) }, b: { range: b, ...totals(db, b) }, categories: rows };
}

// ---------------------------------------------------------------------------

const GROUP_OF: Record<string, 'cash' | 'savings' | 'investments' | 'cards' | 'loans'> = {
  current: 'cash', cash: 'cash', savings: 'savings', pot: 'savings', investment: 'investments',
  credit_card: 'cards', loan: 'loans', other_liability: 'loans',
};

/** Month-end net worth split by type of account, what moved it, and milestones. */
export function netWorthHistory(db: DB, months = 24, today = todayIso()) {
  const n = Math.min(Math.max(Math.round(months) || 24, 3), 60);
  const cur = monthOf(today);
  const first = (db.prepare('SELECT MIN(date) AS d FROM transactions').get() as { d: string | null }).d;
  const start = first ? monthOf(first) : cur;
  const list = Array.from({ length: n }, (_, i) => addMonths(cur, i - n + 1)).filter((m) => m >= start);
  const points = list.map((m) => {
    const asOf = m === cur ? today : monthEnd(m);
    const g = { cash: 0, savings: 0, investments: 0, cards: 0, loans: 0 };
    for (const a of listAccounts(db, { asOf, includeArchived: true })) g[GROUP_OF[a.type] ?? 'cash'] += a.balance;
    const assets = g.cash + g.savings + g.investments;
    const debts = g.cards + g.loans; // negative
    return { month: m, ...g, assets, debts, netWorth: assets + debts };
  });
  // What changed each month: money saved and invested, investment growth, debt paid down.
  const changes = points.map((p, i) => {
    if (i === 0) return null;
    const prev = points[i - 1];
    const r = { from: `${p.month}-01`, to: monthEnd(p.month) };
    const w = rangeWhere(r);
    const invested = (db.prepare(
      `SELECT IFNULL(SUM(p.amount), 0) AS n FROM postings p JOIN transactions t ON t.id = p.transaction_id JOIN accounts a ON a.id = p.account_id
       WHERE t.kind = 'transfer' AND a.type = 'investment' AND ${w.sql}`,
    ).get(...w.params) as { n: number }).n;
    return {
      month: p.month,
      change: p.netWorth - prev.netWorth,
      saved: totals(db, r).saved,
      growth: (p.investments - prev.investments) - invested,
      debtPaid: (p.debts - prev.debts),
    };
  }).filter((x): x is NonNullable<typeof x> => !!x);
  const milestones: { month: string; label: string }[] = [];
  const marks = [100000, 500000, 1000000, 2000000, 2500000, 5000000, 7500000, 10000000, 25000000];
  for (let i = 1; i < points.length; i++) {
    for (const m of marks) if (points[i - 1].netWorth < m && points[i].netWorth >= m) milestones.push({ month: points[i].month, label: `Net worth passed £${(m / 100).toLocaleString('en-GB')}` });
    if (points[i - 1].cards < 0 && points[i].cards >= 0) milestones.push({ month: points[i].month, label: 'Credit cards cleared' });
    if (points[i - 1].loans < 0 && points[i].loans >= 0) milestones.push({ month: points[i].month, label: 'Loans paid off' });
  }
  const high = points.reduce((a, p) => (p.netWorth > a.netWorth ? p : a), points[0] ?? { month: cur, netWorth: 0 } as any);
  return { points, changes, milestones, high: points.length ? { month: high.month, value: high.netWorth } : null };
}

// ---------------------------------------------------------------------------

/** Calendar year (Jan–Dec) or UK tax year starting 6 April of `year`. */
export function yearRange(kind: 'calendar' | 'tax', year: number): Range & { label: string } {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new ValidationError('Choose a year');
  if (kind === 'tax') { const t = taxYear(`${year}-04-06`); return { from: t.start, to: t.end, label: `Tax year ${t.label}` }; }
  return { from: `${year}-01-01`, to: `${year}-12-31`, label: String(year) };
}

export function yearReview(db: DB, kind: 'calendar' | 'tax', year: number, today = todayIso()) {
  const r = yearRange(kind, year);
  const t = totals(db, r);
  const cats = byCategory(db, r);
  const w = rangeWhere(r);
  const months = monthsIn(r);
  const monthly = months.map((m) => {
    const mr = { from: m === monthOf(r.from) ? r.from : `${m}-01`, to: m === monthOf(r.to) ? r.to : monthEnd(m) };
    const x = totals(db, mr);
    return { month: m, income: x.income, spending: x.spending, saved: x.saved };
  });
  const biggest = db.prepare(
    `SELECT t.id, t.date, t.description, SUM(-p.amount) AS amount, (SELECT IFNULL(top.name, 'Uncategorised') FROM postings p2 ${TOP_JOIN.replace(/p\.category_id/g, 'p2.category_id')} WHERE p2.transaction_id = t.id LIMIT 1) AS category
     FROM postings p JOIN transactions t ON t.id = p.transaction_id WHERE t.kind = 'expense' AND ${w.sql} GROUP BY t.id ORDER BY amount DESC LIMIT 5`,
  ).all(...w.params) as any[];
  const interest = (db.prepare(
    `SELECT IFNULL(SUM(-p.amount), 0) AS n FROM postings p JOIN transactions t ON t.id = p.transaction_id ${TOP_JOIN}
     WHERE t.kind = 'expense' AND top.name = 'Interest & Fees' AND ${w.sql}`,
  ).get(...w.params) as { n: number }).n;
  const end = r.to < today ? r.to : today;
  const startNW = listAccounts(db, { asOf: dayBefore(r.from), includeArchived: true });
  const endNW = listAccounts(db, { asOf: end, includeArchived: true });
  const sum = (list: typeof startNW, f: (t: string) => boolean) => list.filter((a) => f(a.type)).reduce((s, a) => s + a.balance, 0);
  const isDebt = (t: string) => ['credit_card', 'loan', 'other_liability'].includes(t);
  const debtStart = -sum(startNW, isDebt), debtEnd = -sum(endNW, isDebt);
  const isaPaid = (db.prepare(
    `SELECT IFNULL(SUM(p.amount), 0) AS n FROM postings p JOIN transactions t ON t.id = p.transaction_id JOIN accounts a ON a.id = p.account_id
     WHERE a.wrapper = 'isa' AND p.amount > 0 AND t.kind = 'transfer' AND t.date BETWEEN ? AND ?`,
  ).get(r.from, r.to) as { n: number }).n;
  const goals = db.prepare('SELECT name, icon, target, completed_at FROM goals WHERE completed_at BETWEEN ? AND ? ORDER BY completed_at').all(r.from, r.to) as any[];
  const days = db.prepare(`SELECT COUNT(DISTINCT t.date) AS n FROM transactions t WHERE t.kind = 'expense' AND t.date BETWEEN ? AND ?`).get(r.from, end) as { n: number };
  const elapsed = Math.max(0, Math.round((Date.parse(`${end}T12:00:00Z`) - Date.parse(`${r.from}T12:00:00Z`)) / 86400000) + 1);
  const subs = cats.find((c) => c.name === 'Subscriptions')?.amount ?? 0;
  const count = (db.prepare(`SELECT COUNT(DISTINCT t.id) AS n FROM transactions t WHERE ${w.sql}`).get(...w.params) as { n: number }).n;
  return {
    kind, year, label: r.label, range: { from: r.from, to: r.to }, partial: r.to > today, through: end,
    ...t,
    categories: cats.slice(0, 8),
    fixed: cats.filter((c) => c.isFixed).reduce((s, c) => s + c.amount, 0),
    merchants: merchants(db, r, 5).merchants,
    monthly,
    biggest: biggest.map((b) => ({ id: b.id, date: b.date, description: b.description, amount: b.amount, category: b.category })),
    interest, subscriptions: subs,
    debt: { start: debtStart, end: debtEnd, paidDown: debtStart - debtEnd },
    netWorth: { start: startNW.reduce((s, a) => s + a.balance, 0), end: endNW.reduce((s, a) => s + a.balance, 0) },
    isa: { paidIn: isaPaid, allowance: 2000000 },
    goals: goals.map((g) => ({ name: g.name, icon: g.icon, target: g.target, date: g.completed_at })),
    noSpendDays: Math.max(0, elapsed - days.n), days: elapsed, transactions: count,
  };
}

function dayBefore(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Years (calendar and tax) that have any transactions, newest first. */
export function reportYears(db: DB) {
  const r = db.prepare('SELECT MIN(date) AS a, MAX(date) AS b FROM transactions').get() as { a: string | null; b: string | null };
  const now = todayIso();
  if (!r.a) return { calendar: [Number(now.slice(0, 4))], tax: [Number(taxYear(now).start.slice(0, 4))] };
  const cal: number[] = [];
  for (let y = Number((r.b! > now ? r.b! : now).slice(0, 4)); y >= Number(r.a.slice(0, 4)); y--) cal.push(y);
  const tax: number[] = [];
  for (let y = Number(taxYear(now).start.slice(0, 4)); y >= Number(taxYear(r.a).start.slice(0, 4)); y--) tax.push(y);
  return { calendar: cal, tax };
}
