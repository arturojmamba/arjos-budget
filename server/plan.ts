/**
 * Plan: what a funded month's money is committed to (see GLOSSARY.md: Plan, Committed,
 * Free to spend, Buffer). Overview, Bills and income, Payday and notifications all read it.
 *
 * The rules live here and nowhere else:
 *   - Shared bills count your share only (other people's payments are refunds against the bill).
 *   - Savings are your recurring savings plus your goals' monthly amounts, with no goal counted
 *     twice; a saving is done when new money arrives in its account (from an everyday account,
 *     not moved from another savings account).
 *   - Debt repayments are their own series.
 *   - The window is the funded month; money moved just after the payday that funds it counts.
 *   - Each bill knows which budget covers it (Payday counts it inside that budget).
 */
import { type DB } from './db.ts';
import { addDays, addMonths, daysInMonth, todayIso } from './dates.ts';
import { occurrences, monthlyEquivalent, type Occurrence, type RecurringType, type Frequency } from './recurring.ts';
import { monthTotals, SAVINGS_TYPES } from './queries.ts';

const SAV = SAVINGS_TYPES.map((t) => `'${t}'`).join(',');
import { isLiability } from './ledger.ts';
import { listGoals } from './goals.ts';
import { listBudgets } from './budgets.ts';
import { yourPay, paydayIn, fundedMonth } from './paycycle.ts';

export type SeriesKey = 'bills' | 'savings' | 'debts' | 'spending' | 'income';

export interface PlanItem {
  key: string; name: string; icon: string | null; date: string | null;
  /** Your share, planned for the month. */
  amount: number;
  /** How much of it is done (paid, or arrived in the account). */
  done: number;
  paid: boolean;
  recurringId: number | null; goalId: number | null;
  accountId: number | null; accountName: string | null;
  /** Debts: where the money goes from and to. */
  from: string | null; to: string | null;
  /** Bills: the budget that covers it, if any. */
  coveredBy: string | null;
}
export interface PlanSeries { planned: number; done: number; remaining: number; items: PlanItem[] }

/**
 * New money saved into an account between two dates: transfers in from everyday accounts (current,
 * cash, cards) less transfers back out to them. Moving between your own savings and investment
 * accounts (say Chase to Trading 212) is neither, the same rule as SAVED_SQL everywhere else.
 */
export function savedInto(db: DB, accountId: number, from: string, to: string): number {
  const r = db.prepare(
    `SELECT IFNULL(SUM(p.amount), 0) AS n FROM postings p JOIN transactions t ON t.id = p.transaction_id
     WHERE p.account_id = ? AND t.kind = 'transfer' AND t.date BETWEEN ? AND ?
       AND EXISTS (SELECT 1 FROM postings p2 JOIN accounts a2 ON a2.id = p2.account_id
                   WHERE p2.transaction_id = t.id AND p2.account_id != p.account_id AND a2.type NOT IN (${SAV}))`,
  ).get(accountId, from, to) as { n: number };
  return Math.max(0, r.n);
}

/** Money moved into an account (from any other account) between two dates: for debts and cards, where any source counts. */
export function movedInto(db: DB, accountId: number, from: string, to: string) {
  return db.prepare(
    `SELECT IFNULL(SUM(p.amount), 0) AS amount, MAX(t.date) AS last FROM postings p JOIN transactions t ON t.id = p.transaction_id
     WHERE p.account_id = ? AND t.kind = 'transfer' AND p.amount > 0 AND t.date BETWEEN ? AND ?`,
  ).get(accountId, from, to) as { amount: number; last: string | null };
}

/** When money for this funded month moves: from just before the payday that funds it, to just before the next one. */
export function fundingWindow(db: DB, month: string): { from: string; to: string } {
  const first = `${month}-01`;
  const last = `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;
  const pay = yourPay(db);
  if (!pay) return { from: first, to: last };
  const before = paydayIn(addMonths(month, -1), pay);
  const inMonth = paydayIn(month, pay);
  // From the day before the payday that funds it (pay sometimes lands a day early) to two days before the next.
  const from = fundedMonth(db, before) === month ? addDays(before, -1) : first;
  const to = fundedMonth(db, inMonth) !== month ? addDays(inMonth, -2) : last;
  return { from, to };
}

const series = (items: PlanItem[]): PlanSeries => {
  const planned = items.reduce((n, i) => n + i.amount, 0);
  const done = items.reduce((n, i) => n + Math.min(i.amount, i.done), 0);
  return { planned, done, remaining: planned - done, items };
};

export function plan(db: DB, month: string, today = todayIso()) {
  const first = `${month}-01`;
  const last = `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;
  // Income is looked up by the month it counts towards, so include the end of the previous month.
  const occ = occurrences(db, addDays(first, -10), last);
  const inMonth = occ.filter((o) => o.type !== 'income' && o.dueDate >= first && o.status !== 'skipped');
  const income = occ.filter((o) => o.type === 'income' && o.period === month);

  const rec = new Map((db.prepare(
    `SELECT r.id, r.category_id, r.transfer_account_id, ta.name AS transfer_name, a.name AS from_name,
            IFNULL((SELECT SUM(s.amount) FROM recurring_shares s WHERE s.recurring_id = r.id), 0) AS shared
     FROM recurring r JOIN accounts a ON a.id = r.account_id LEFT JOIN accounts ta ON ta.id = r.transfer_account_id`,
  ).all() as { id: number; category_id: number | null; transfer_account_id: number | null; transfer_name: string | null; from_name: string; shared: number }[]).map((r) => [r.id, r]));
  const gross = (o: Occurrence) => (o.status === 'paid' && o.paidAmount != null ? o.paidAmount : o.status === 'skipped' ? 0 : o.expected);
  const yours = (o: Occurrence) => Math.max(0, gross(o) - (rec.get(o.recurringId)?.shared ?? 0));

  // Which budget covers each bill's category (Payday counts those bills inside the budget).
  const coveredBy = new Map<number, string>();
  for (const b of listBudgets(db, month, today).budgets.filter((x: any) => x.kind === 'spending') as any[]) {
    const ids = db.prepare('SELECT DISTINCT c.id FROM budget_categories bc JOIN categories c ON c.id = bc.category_id OR c.parent_id = bc.category_id WHERE bc.budget_id = ?').all(b.id) as { id: number }[];
    for (const { id } of ids) if (!coveredBy.has(id)) coveredBy.set(id, b.name);
  }
  const base = (o: Occurrence): PlanItem => ({
    key: `${o.recurringId}:${o.dueDate}`, name: o.name, icon: o.categoryIcon, date: o.dueDate, amount: yours(o), done: o.status === 'paid' ? yours(o) : 0,
    paid: o.status === 'paid', recurringId: o.recurringId, goalId: null, accountId: null, accountName: o.accountName, from: null, to: null, coveredBy: null,
  });

  const bills = series(inMonth.filter((o) => o.type === 'bill' || o.type === 'subscription').map((o) => {
    const cat = rec.get(o.recurringId)?.category_id;
    return { ...base(o), coveredBy: cat != null ? coveredBy.get(cat) ?? null : null };
  }));
  const debts = series(inMonth.filter((o) => o.isDebt).map((o) => {
    const r = rec.get(o.recurringId);
    return { ...base(o), accountId: r?.transfer_account_id ?? null, to: r?.transfer_name ?? null, from: r?.from_name ?? null };
  }));

  // Savings: recurring savings, plus goals' monthly amounts into accounts no recurring saving already covers.
  const savingOcc = inMonth.filter((o) => o.type === 'saving' && !o.isDebt);
  const savingAccounts = new Set(savingOcc.map((o) => rec.get(o.recurringId)?.transfer_account_id).filter((x): x is number => x != null));
  const goals = ((listGoals(db, today) as any).goals ?? []).filter((g: any) => !g.archived && !g.completedAt && g.monthlyTarget && g.account && !savingAccounts.has(g.account.id));
  const savingItems: PlanItem[] = [
    ...savingOcc.map((o) => { const r = rec.get(o.recurringId); return { ...base(o), key: `saving:${o.recurringId}:${o.dueDate}`, accountId: r?.transfer_account_id ?? null, accountName: r?.transfer_name ?? o.accountName, done: 0 }; }),
    ...goals.map((g: any): PlanItem => ({ key: `goal:${g.id}`, name: g.name, icon: g.icon, date: null, amount: g.monthlyTarget, done: 0, paid: false, recurringId: null, goalId: g.id, accountId: g.account.id, accountName: g.account.name, from: null, to: g.account.name, coveredBy: null })),
  ];
  // Done when it arrives: share what reached each account across that account's savings, in order.
  const win = fundingWindow(db, month);
  const arrived = new Map<number, number>();
  for (const s of savingItems) {
    if (s.accountId == null) continue;
    if (!arrived.has(s.accountId)) arrived.set(s.accountId, savedInto(db, s.accountId, win.from, win.to));
    const left = arrived.get(s.accountId)!;
    s.done = Math.min(s.amount, left);
    s.paid = s.done >= s.amount && s.amount > 0;
    arrived.set(s.accountId, left - s.done);
  }
  const savings = series(savingItems);

  // Income: expected pay plus anything unplanned that arrived.
  const incomeExpected = income.reduce((n, o) => n + gross(o), 0);
  const incomeReceived = income.filter((o) => o.status === 'paid').reduce((n, o) => n + gross(o), 0);
  const { spending, income: actualIncome } = monthTotals(db, month);
  const unplannedIncome = Math.max(0, actualIncome - incomeReceived);
  const totalIncome = incomeExpected + unplannedIncome;
  const aboveUsual = income.filter((o) => o.status === 'paid' && o.paidAmount != null).reduce((s, o) => s + Math.max(0, o.paidAmount! - o.expected), 0);
  const bonusUnplanned = (db.prepare(
    `SELECT IFNULL(SUM(p.amount), 0) AS n FROM postings p JOIN transactions t ON t.id = p.transaction_id
     JOIN categories c ON c.id = p.category_id LEFT JOIN categories top ON top.id = IFNULL(c.parent_id, c.id)
     WHERE t.kind = 'income' AND t.period = ? AND top.name = 'Bonuses'
       AND NOT EXISTS (SELECT 1 FROM recurring_payments rp WHERE rp.transaction_id = t.id)`,
  ).get(month) as { n: number }).n;

  // Everyday spending: what you spent that wasn't a planned bill.
  const billSpending = (db.prepare(
    `SELECT IFNULL(SUM(-p.amount), 0) AS n FROM recurring_payments rp
     JOIN recurring r ON r.id = rp.recurring_id
     JOIN transactions t ON t.id = rp.transaction_id
     JOIN postings p ON p.transaction_id = t.id
     WHERE r.type IN ('bill','subscription') AND t.kind = 'expense' AND t.period = ?`,
  ).get(month) as { n: number }).n;
  const everyday = spending - billSpending;

  const committed = bills.planned + savings.planned + debts.planned;
  return {
    month,
    income: { planned: totalIncome, expected: incomeExpected, received: incomeReceived + unplannedIncome, extra: aboveUsual + Math.max(0, bonusUnplanned) },
    bills, savings, debts,
    spending: { everyday },
    committed,
    committedShare: totalIncome > 0 ? committed / totalIncome : null,
    freeToSpend: totalIncome - committed - everyday,
    monthly: monthlyAverages(db),
  };
}

/** Each kind of regular cost as a typical month (yearly ones spread out, one-offs left out, your share only). */
export function monthlyAverages(db: DB) {
  const rows = (db.prepare(
    `SELECT r.type, r.amount - IFNULL((SELECT SUM(s.amount) FROM recurring_shares s WHERE s.recurring_id = r.id), 0) AS amount,
            r.frequency, ta.type AS transfer_type FROM recurring r LEFT JOIN accounts ta ON ta.id = r.transfer_account_id
     WHERE r.active = 1 AND NOT (r.frequency = 'annually' AND IFNULL(r.end_date, '') = r.start_date)`,
  ).all() as { type: RecurringType; amount: number; frequency: Frequency; transfer_type: string | null }[]);
  const monthly = { bills: 0, subscriptions: 0, savings: 0, debts: 0, income: 0 };
  for (const r of rows) {
    const isDebt = r.type === 'saving' && !!r.transfer_type && isLiability(r.transfer_type);
    const key = r.type === 'bill' ? 'bills' : r.type === 'subscription' ? 'subscriptions' : r.type === 'saving' ? (isDebt ? 'debts' : 'savings') : 'income';
    monthly[key] += monthlyEquivalent(r.amount, r.frequency);
  }
  return monthly;
}

/** The shape Overview and Bills and income have always read (/api/plan). */
export function monthPlan(db: DB, month: string, today = todayIso()) {
  const p = plan(db, month, today);
  return {
    month,
    incomeExpected: p.income.planned,
    incomeReceived: p.income.received,
    incomeExtra: p.income.extra,
    billsTotal: p.bills.planned,
    billsPaid: p.bills.done,
    billsRemaining: p.bills.remaining,
    savingsTotal: p.savings.planned,
    savingsDone: p.savings.done,
    debtTotal: p.debts.planned,
    debtDone: p.debts.done,
    committed: p.committed,
    committedShare: p.committedShare,
    otherSpending: p.spending.everyday,
    freeToSpend: p.freeToSpend,
    monthly: p.monthly,
  };
}
