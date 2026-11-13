import type { DB } from './db.ts';
import { isLiability } from './ledger.ts';
import { addMonths, monthOf, todayIso, daysInMonth } from './dates.ts';
import { parseMoney } from './money.ts';
import { merchantKey } from './merchant.ts';

export interface AccountView {
  id: number;
  name: string;
  type: string;
  institution: string | null;
  parentId: number | null;
  currency: string;
  anchorBalance: number;
  anchorDate: string;
  colour: string;
  archived: boolean;
  sortOrder: number;
  isLiability: boolean;
  /** For investments this is the market value; for everything else the ledger balance. */
  balance: number;
  transactionCount: number;
  lastActivity: string | null;
  wrapper: string | null;
  syncProvider: string | null;
  lastSyncedAt: string | null;
  syncError: string | null;
  /** Investments only: money paid in (ledger balance), last valuation date and growth. */
  contributed: number | null;
  valuationDate: string | null;
  growth: number | null;
}

export function listAccounts(db: DB, opts: { asOf?: string; includeArchived?: boolean } = {}): AccountView[] {
  const asOf = opts.asOf ?? '9999-12-31';
  const rows = db
    .prepare(
      // Balance is anchored to a known (reconciled) balance at the end of
      // anchor_date, then rolled forward or backward to the requested date.
      `SELECT a.*,
              a.anchor_balance + IFNULL((SELECT SUM(CASE
                    WHEN t.date > a.anchor_date AND t.date <= ?1 THEN p.amount
                    WHEN t.date > ?1 AND t.date <= a.anchor_date THEN -p.amount
                    ELSE 0 END)
                  FROM postings p JOIN transactions t ON t.id = p.transaction_id
                  WHERE p.account_id = a.id), 0) AS balance,
              (SELECT COUNT(*) FROM postings p WHERE p.account_id = a.id) AS txn_count,
              (SELECT MAX(t.date) FROM postings p JOIN transactions t ON t.id = p.transaction_id WHERE p.account_id = a.id) AS last_activity
       FROM accounts a
       ${opts.includeArchived ? '' : 'WHERE a.archived = 0'}
       ORDER BY a.sort_order, a.id`,
    )
    .all(asOf) as any[];
  return rows.map((r) => {
    let balance = r.balance;
    let contributed: number | null = null;
    let valuationDate: string | null = null;
    if (r.type === 'investment') {
      contributed = r.balance;
      // Market value = latest valuation on or before the date, plus anything paid in or out since.
      const v = db.prepare('SELECT date, value FROM valuations WHERE account_id = ? AND date <= ? ORDER BY date DESC LIMIT 1').get(r.id, asOf) as { date: string; value: number } | undefined;
      if (v) {
        valuationDate = v.date;
        const since = db.prepare(
          'SELECT IFNULL(SUM(p.amount), 0) AS n FROM postings p JOIN transactions t ON t.id = p.transaction_id WHERE p.account_id = ? AND t.date > ? AND t.date <= ?',
        ).get(r.id, v.date, asOf) as { n: number };
        balance = v.value + since.n;
      }
    }
    return {
    id: r.id,
    name: r.name,
    type: r.type,
    institution: r.institution,
    parentId: r.parent_id,
    currency: r.currency,
    anchorBalance: r.anchor_balance,
    anchorDate: r.anchor_date,
    colour: r.colour,
    archived: !!r.archived,
    sortOrder: r.sort_order,
    isLiability: isLiability(r.type),
    balance,
    transactionCount: r.txn_count,
    lastActivity: r.last_activity,
    wrapper: r.wrapper ?? null,
    syncProvider: r.sync_provider ?? null,
    lastSyncedAt: r.last_synced_at ?? null,
    syncError: r.sync_error ?? null,
    contributed,
    valuationDate,
    growth: contributed === null || valuationDate === null ? null : balance - contributed,
    };
  });
}

export interface CategoryView {
  id: number;
  name: string;
  kind: 'expense' | 'income';
  parentId: number | null;
  colour: string;
  icon: string | null;
  isFixed: boolean;
  rollForward: boolean;
  archived: boolean;
  sortOrder: number;
  transactionCount: number;
}

export function listCategories(db: DB): CategoryView[] {
  const rows = db
    .prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM postings p WHERE p.category_id = c.id) AS n
       FROM categories c LEFT JOIN categories top ON top.id = IFNULL(c.parent_id, c.id)
       ORDER BY c.kind DESC, top.sort_order, top.id, c.parent_id IS NOT NULL, c.sort_order, c.name`,
    )
    .all() as any[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    parentId: r.parent_id,
    colour: r.colour,
    icon: r.icon,
    isFixed: !!r.is_fixed,
    rollForward: !!r.roll_forward,
    archived: !!r.archived,
    sortOrder: r.sort_order,
    transactionCount: r.n,
  }));
}

export interface TransactionFilters {
  month?: string;
  from?: string;
  to?: string;
  accountId?: number;
  categoryId?: number;
  /** Any of these categories (used for "transactions in this budget"). */
  categoryIds?: number[];
  kind?: string;
  search?: string;
  /** A place, as Reports names it (see merchantKey): matches every description that cleans up to it. */
  merchant?: string;
  uncategorised?: boolean;
  limit?: number;
  offset?: number;
}

export interface TransactionView {
  id: number;
  date: string;
  period: string;
  description: string;
  merchant: string;
  kind: 'expense' | 'income' | 'transfer';
  notes: string | null;
  importBatchId: number | null;
  postings: {
    id: number;
    accountId: number;
    accountName: string;
    accountColour: string;
    accountIsLiability: boolean;
    accountType: string;
    amount: number;
    categoryId: number | null;
    categoryName: string | null;
    categoryColour: string | null;
    bankDescription: string | null;
  }[];
}

export interface MonthGroupTotals { month: string; count: number; in: number; out: number; saved: number }

/** Accounts where money counts as saved: savings, pots and investments (savings accounts, pots, ISAs). */
export const SAVINGS_TYPES = ['savings', 'pot', 'investment'];
const SAV = SAVINGS_TYPES.map((t) => `'${t}'`).join(',');
/**
 * Money saved by a transfer: what goes from an everyday account into savings counts as saved,
 * and what comes back out counts against it. Moving between two savings accounts (savings → ISA) is neither.
 */
export const SAVED_SQL = `(SELECT IFNULL(SUM(CASE WHEN a.type IN (${SAV}) THEN p.amount ELSE 0 END), 0)
  FROM postings p JOIN accounts a ON a.id = p.account_id WHERE p.transaction_id = t.id)
  * (t.kind = 'transfer' AND EXISTS (SELECT 1 FROM postings p2 JOIN accounts a2 ON a2.id = p2.account_id
       WHERE p2.transaction_id = t.id AND a2.type NOT IN (${SAV})))`;

/** Net amount saved in a month (by the month a transaction counts towards). */
export function savedIn(db: DB, month: string): number {
  return (db.prepare(`SELECT IFNULL(SUM(${SAVED_SQL}), 0) AS n FROM transactions t WHERE t.kind = 'transfer' AND t.period = ?`).get(month) as { n: number }).n;
}

export function listTransactions(db: DB, f: TransactionFilters): {
  items: TransactionView[]; total: number; totals: { in: number; out: number };
  byCategory: { categoryId: number | null; name: string; colour: string; amount: number }[];
  byMonth: MonthGroupTotals[];
} {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (f.month) {
    where.push('t.date >= ? AND t.date <= ?');
    params.push(`${f.month}-01`, `${f.month}-31`);
  }
  if (f.from) { where.push('t.date >= ?'); params.push(f.from); }
  if (f.to) { where.push('t.date <= ?'); params.push(f.to); }
  if (f.kind === 'saving') where.push(`t.kind = 'transfer' AND ${SAVED_SQL} != 0`);
  else if (f.kind) { where.push('t.kind = ?'); params.push(f.kind); }
  if (f.accountId) {
    where.push('EXISTS (SELECT 1 FROM postings p WHERE p.transaction_id = t.id AND p.account_id = ?)');
    params.push(f.accountId);
  }
  if (f.categoryId) {
    where.push(
      'EXISTS (SELECT 1 FROM postings p JOIN categories c ON c.id = p.category_id WHERE p.transaction_id = t.id AND (c.id = ? OR c.parent_id = ?))',
    );
    params.push(f.categoryId, f.categoryId);
  }
  if (f.categoryIds && f.categoryIds.length) {
    where.push(`EXISTS (SELECT 1 FROM postings p WHERE p.transaction_id = t.id AND p.category_id IN (${f.categoryIds.map(() => '?').join(',')}))`);
    params.push(...f.categoryIds);
  }
  if (f.merchant) {
    const ids = (db.prepare("SELECT id, IFNULL(NULLIF(merchant, ''), description) AS m FROM transactions").all() as { id: number; m: string }[])
      .filter((r) => merchantKey(r.m) === f.merchant).map((r) => r.id);
    where.push(ids.length ? `t.id IN (${ids.join(',')})` : '0');
  }
  if (f.uncategorised) {
    where.push("t.kind != 'transfer' AND EXISTS (SELECT 1 FROM postings p WHERE p.transaction_id = t.id AND p.category_id IS NULL)");
  }
  if (f.search && f.search.trim()) {
    const term = f.search.trim();
    const pence = parseMoney(term);
    const like = `%${term.replace(/[%_]/g, (m) => '\\' + m)}%`;
    const clauses = ["t.description LIKE ? ESCAPE '\\'", "IFNULL(t.notes,'') LIKE ? ESCAPE '\\'", "t.merchant LIKE ? ESCAPE '\\'"];
    params.push(like, like, like);
    if (pence !== null && /\d/.test(term)) {
      clauses.push('EXISTS (SELECT 1 FROM postings p WHERE p.transaction_id = t.id AND ABS(p.amount) = ?)');
      params.push(Math.abs(pence));
    }
    where.push(`(${clauses.join(' OR ')})`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM transactions t ${whereSql}`).get(...params) as { n: number }).n;

  // Totals of the filtered set (income/spending only — transfers excluded).
  const totalsRow = db
    .prepare(
      `SELECT IFNULL(SUM(CASE WHEN t.kind = 'income' THEN p.amount ELSE 0 END), 0) AS inn,
              IFNULL(SUM(CASE WHEN t.kind = 'expense' THEN -p.amount ELSE 0 END), 0) AS outt
       FROM transactions t JOIN postings p ON p.transaction_id = t.id ${whereSql}`,
    )
    .get(...params) as { inn: number; outt: number };

  // Spending by top-level category for the filtered set (side panel).
  const byCategory = (db.prepare(
    `SELECT top.id AS id, IFNULL(top.name, 'Uncategorised') AS name, IFNULL(top.colour, '#94a3b8') AS colour, SUM(-p.amount) AS amount
     FROM transactions t JOIN postings p ON p.transaction_id = t.id
     LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN categories top ON top.id = IFNULL(c.parent_id, c.id)
     ${whereSql ? whereSql + ' AND' : 'WHERE'} t.kind = 'expense'
     GROUP BY top.id ORDER BY amount DESC`,
  ).all(...params) as { id: number | null; name: string; colour: string; amount: number }[])
    .filter((r) => r.amount > 0)
    .map((r) => ({ categoryId: r.id, name: r.name, colour: r.colour, amount: r.amount }));

  // Count and totals per calendar month (by date) so month headers are right even when a month spans pages.
  const byMonth = (db.prepare(
    `SELECT substr(t.date, 1, 7) AS month, COUNT(DISTINCT t.id) AS n,
            IFNULL(SUM(CASE WHEN t.kind = 'income' THEN p.amount ELSE 0 END), 0) AS inn,
            IFNULL(SUM(CASE WHEN t.kind = 'expense' THEN -p.amount ELSE 0 END), 0) AS outt
     FROM transactions t JOIN postings p ON p.transaction_id = t.id ${whereSql}
     GROUP BY month ORDER BY month DESC`,
  ).all(...params) as { month: string; n: number; inn: number; outt: number }[])
    .map((r) => ({ month: r.month, count: r.n, in: r.inn, out: r.outt, saved: 0 }));
  const savedRows = db.prepare(
    `SELECT substr(t.date, 1, 7) AS month, SUM(${SAVED_SQL}) AS n FROM transactions t ${whereSql ? whereSql + " AND t.kind = 'transfer'" : "WHERE t.kind = 'transfer'"} GROUP BY month`,
  ).all(...params) as { month: string; n: number }[];
  for (const r of savedRows) { const m = byMonth.find((x) => x.month === r.month); if (m) m.saved = r.n; }

  const limit = Math.min(Math.max(f.limit ?? 100, 1), 100000);
  const offset = Math.max(f.offset ?? 0, 0);
  const txns = db
    .prepare(`SELECT t.* FROM transactions t ${whereSql} ORDER BY t.date DESC, t.id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as any[];
  return { items: hydrate(db, txns), total, totals: { in: totalsRow.inn, out: totalsRow.outt }, byCategory, byMonth };
}

export function getTransaction(db: DB, id: number): TransactionView | null {
  const t = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
  return t ? hydrate(db, [t])[0] : null;
}

function hydrate(db: DB, txns: any[]): TransactionView[] {
  if (txns.length === 0) return [];
  const ids = txns.map((t) => t.id);
  const postings = db
    .prepare(
      `SELECT p.*, a.name AS account_name, a.colour AS account_colour, a.type AS account_type,
              c.name AS category_name, c.colour AS category_colour
       FROM postings p JOIN accounts a ON a.id = p.account_id LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.transaction_id IN (${ids.map(() => '?').join(',')})
       ORDER BY p.amount ASC, p.id`,
    )
    .all(...ids) as any[];
  const byTxn = new Map<number, any[]>();
  for (const p of postings) {
    if (!byTxn.has(p.transaction_id)) byTxn.set(p.transaction_id, []);
    byTxn.get(p.transaction_id)!.push(p);
  }
  return txns.map((t) => ({
    id: t.id,
    date: t.date,
    period: t.period,
    description: t.description,
    merchant: t.merchant,
    kind: t.kind,
    notes: t.notes,
    importBatchId: t.import_batch_id,
    postings: (byTxn.get(t.id) ?? []).map((p) => ({
      id: p.id,
      accountId: p.account_id,
      accountName: p.account_name,
      accountColour: p.account_colour,
      accountIsLiability: isLiability(p.account_type),
      accountType: p.account_type,
      amount: p.amount,
      categoryId: p.category_id,
      categoryName: p.category_name,
      categoryColour: p.category_colour,
      bankDescription: p.bank_description,
    })),
  }));
}

export interface CategoryTotal {
  categoryId: number | null;
  name: string;
  colour: string;
  isFixed: boolean;
  amount: number;
}

/** Spending (positive = money spent) per top-level category for a period. */
export function spendingByCategory(db: DB, month: string): CategoryTotal[] {
  const rows = db
    .prepare(
      `SELECT top.id AS id, top.name AS name, top.colour AS colour, top.is_fixed AS is_fixed, SUM(-p.amount) AS amount
       FROM postings p
       JOIN transactions t ON t.id = p.transaction_id
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN categories top ON top.id = IFNULL(c.parent_id, c.id)
       WHERE t.kind = 'expense' AND t.period = ?
       GROUP BY top.id
       ORDER BY amount DESC`,
    )
    .all(month) as any[];
  return rows.map((r) => ({
    categoryId: r.id,
    name: r.name ?? 'Uncategorised',
    colour: r.colour ?? '#94a3b8',
    isFixed: !!r.is_fixed,
    amount: r.amount,
  }));
}

function incomeByCategory(db: DB, month: string): CategoryTotal[] {
  const rows = db
    .prepare(
      `SELECT top.id AS id, top.name AS name, top.colour AS colour, SUM(p.amount) AS amount
       FROM postings p JOIN transactions t ON t.id = p.transaction_id
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN categories top ON top.id = IFNULL(c.parent_id, c.id)
       WHERE t.kind = 'income' AND t.period = ?
       GROUP BY top.id ORDER BY amount DESC`,
    )
    .all(month) as any[];
  return rows.map((r) => ({ categoryId: r.id, name: r.name ?? 'Uncategorised', colour: r.colour ?? '#94a3b8', isFixed: false, amount: r.amount }));
}

export function monthTotals(db: DB, month: string): { income: number; spending: number } {
  const r = db
    .prepare(
      `SELECT IFNULL(SUM(CASE WHEN t.kind = 'income' THEN p.amount END), 0) AS income,
              IFNULL(SUM(CASE WHEN t.kind = 'expense' THEN -p.amount END), 0) AS spending
       FROM postings p JOIN transactions t ON t.id = p.transaction_id WHERE t.period = ?`,
    )
    .get(month) as { income: number; spending: number };
  return { income: r.income, spending: r.spending };
}

/** Spending for one month, for the category breakdown (which can step through months on its own). */
export function monthSpending(db: DB, month: string) {
  const byCategory = spendingByCategory(db, month);
  const daily = db
    .prepare(
      `SELECT t.date AS date, SUM(-p.amount) AS amount FROM postings p JOIN transactions t ON t.id = p.transaction_id
       WHERE t.kind = 'expense' AND t.period = ? GROUP BY t.date ORDER BY t.date`,
    )
    .all(month) as { date: string; amount: number }[];
  return { month, spending: byCategory.reduce((s, c) => s + c.amount, 0), byCategory, daily };
}

/** The largest single purchases of a month. */
function topSpends(db: DB, month: string, n = 3) {
  return db
    .prepare(
      `SELECT t.id AS id, t.date AS date, t.description AS description, SUM(-p.amount) AS amount,
              MAX(p.category_id) AS categoryId
       FROM transactions t JOIN postings p ON p.transaction_id = t.id
       WHERE t.kind = 'expense' AND t.period = ?
       GROUP BY t.id ORDER BY amount DESC, t.date DESC LIMIT ?`,
    )
    .all(month, n) as { id: number; date: string; description: string; amount: number; categoryId: number | null }[];
}

/** Spending so far this month against the same point last month. */
function pace(db: DB, month: string, today: string) {
  const dim = daysInMonth(month);
  const isCurrent = monthOf(today) === month;
  const day = isCurrent ? Number(today.slice(8, 10)) : dim;
  const prev = addMonths(month, -1);
  const prevDay = Math.min(day, daysInMonth(prev));
  const q = (m: string, upTo: number) => (db
    .prepare(
      `SELECT IFNULL(SUM(-p.amount), 0) AS v FROM postings p JOIN transactions t ON t.id = p.transaction_id
       WHERE t.kind = 'expense' AND t.period = ? AND t.date <= ?`,
    )
    .get(m, `${m}-${String(upTo).padStart(2, '0')}`) as { v: number }).v;
  return { day, daysInMonth: dim, isCurrent, spentToDate: q(month, day), lastMonthToDate: q(prev, prevDay), lastMonthTotal: monthTotals(db, prev).spending };
}

export function monthSummary(db: DB, month: string) {
  const { income, spending } = monthTotals(db, month);
  const byCategory = spendingByCategory(db, month);
  const incomeCats = incomeByCategory(db, month);
  const fixed = byCategory.filter((c) => c.isFixed).reduce((s, c) => s + c.amount, 0);
  const variable = spending - fixed;

  // Balances at the end of the month (or today, for the current month).
  const lastDay = `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;
  const today = todayIso();
  const asOf = lastDay < today ? lastDay : today;
  const accounts = listAccounts(db, { asOf });
  const assets = accounts.filter((a) => !a.isLiability).reduce((s, a) => s + a.balance, 0);
  const liabilities = accounts.filter((a) => a.isLiability).reduce((s, a) => s + a.balance, 0); // negative
  const savings = accounts.filter((a) => a.type === 'savings' || a.type === 'pot').reduce((s, a) => s + a.balance, 0);
  const investments = accounts.filter((a) => a.type === 'investment').reduce((s, a) => s + a.balance, 0);
  const cash = accounts.filter((a) => a.type === 'current' || a.type === 'cash').reduce((s, a) => s + a.balance, 0);

  const prevNetWorth = netWorthAt(db, `${addMonths(month, -1)}-${String(daysInMonth(addMonths(month, -1))).padStart(2, '0')}`);

  const history = [] as { month: string; income: number; spending: number; saved: number }[];
  for (let i = 5; i >= 0; i--) {
    const m = addMonths(month, -i);
    history.push({ month: m, ...monthTotals(db, m), saved: savedIn(db, m) });
  }

  const daily = db
    .prepare(
      `SELECT t.date AS date, SUM(-p.amount) AS amount FROM postings p JOIN transactions t ON t.id = p.transaction_id
       WHERE t.kind = 'expense' AND t.period = ? GROUP BY t.date ORDER BY t.date`,
    )
    .all(month) as { date: string; amount: number }[];

  const uncategorised = (
    db
      .prepare(
        `SELECT COUNT(DISTINCT t.id) AS n FROM transactions t JOIN postings p ON p.transaction_id = t.id
         WHERE t.kind != 'transfer' AND p.category_id IS NULL AND t.period = ?`,
      )
      .get(month) as { n: number }
  ).n;

  const recent = listTransactions(db, { limit: 6 }).items;

  return {
    month,
    income,
    spending,
    net: income - spending,
    savingsRate: income > 0 ? (income - spending) / income : null,
    fixed,
    variable,
    byCategory,
    incomeByCategory: incomeCats,
    assets,
    liabilities,
    savings,
    investments,
    cash,
    netWorth: assets + liabilities,
    netWorthChange: assets + liabilities - prevNetWorth,
    accounts,
    history,
    saved: history[history.length - 1].saved,
    daily,
    uncategorised,
    recent,
    topSpends: topSpends(db, month),
    pace: pace(db, month, today),
  };
}

export function netWorthAt(db: DB, date: string): number {
  return listAccounts(db, { asOf: date, includeArchived: true }).reduce((s, a) => s + a.balance, 0);
}

export function monthsWithData(db: DB): string[] {
  const rows = db.prepare('SELECT DISTINCT period FROM transactions ORDER BY period DESC').all() as { period: string }[];
  const months = new Set(rows.map((r) => r.period));
  months.add(monthOf(todayIso()));
  return [...months].sort().reverse();
}
