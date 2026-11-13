/**
 * Debts: extra details on credit card, loan and other liability accounts.
 *
 * The balance always comes from the ledger (imports keep it current):
 * purchases and interest add to it, repayments (transfers from your bank)
 * reduce it. Repayments are transfers, so they're never counted as spending.
 *
 * Projections work month by month: interest is added at the APR (or a promo
 * rate until it ends), then payments are made. Snowball pays the smallest
 * balance off first; avalanche pays the highest rate first.
 */
import { type DB, tx, getSetting, setSetting } from './db.ts';
import { ValidationError, assertPence } from './money.ts';
import { addMonths, daysInMonth, isIsoDate, monthOf, todayIso } from './dates.ts';
import { isLiability } from './ledger.ts';
import { createAccount, updateAccount } from './admin.ts';
import { createRecurring, dueDates } from './recurring.ts';
import { listAccounts } from './queries.ts';

export const DEBT_TYPES = ['credit_card', 'pay_in_3', 'personal_loan', 'student_loan', 'bnpl', 'car_finance', 'overdraft', 'personal', 'other'] as const;
export type DebtType = (typeof DEBT_TYPES)[number];
export type Strategy = 'minimum' | 'snowball' | 'avalanche';

const ACCOUNT_TYPE_FOR: Record<DebtType, string> = {
  credit_card: 'credit_card', pay_in_3: 'loan', personal_loan: 'loan', student_loan: 'loan', bnpl: 'loan', car_finance: 'loan',
  overdraft: 'other_liability', personal: 'other_liability', other: 'other_liability',
};

interface DebtRow {
  account_id: number; debt_type: DebtType; original_balance: number; apr: number; promo_apr: number | null; promo_end: string | null;
  min_type: 'fixed' | 'card'; min_fixed: number; min_percent: number; min_floor: number; due_day: number | null;
  frequency: 'weekly' | 'fortnightly' | 'four_weekly' | 'monthly'; pays_in_full: number; payment_account_id: number | null; notes: string | null;
  start_date: string | null; instalments: number | null; provider: string | null; statement_day: number | null;
}

export interface DebtInput {
  debtType: DebtType;
  originalBalance: number;
  /** APR in basis points: 24.9% = 2490. */
  apr: number;
  promoApr?: number | null;
  promoEnd?: string | null;
  minType: 'fixed' | 'card';
  minFixed?: number;
  minPercent?: number;
  minFloor?: number;
  dueDay?: number | null;
  frequency?: DebtRow['frequency'];
  paysInFull?: boolean;
  paymentAccountId?: number | null;
  notes?: string | null;
  /** Pay in 3 (and other split payments): first payment date, number of payments, and who it's with. */
  startDate?: string | null;
  instalments?: number | null;
  provider?: string | null;
  /** Credit cards: the day of the month each statement closes (its "to" date). */
  statementDay?: number | null;
}

export const PAY_IN_PROVIDERS = ['Klarna', 'PayPal', 'Clearpay', 'Monzo Flex', 'Zilch', 'Other'];

/** Split a total into equal instalments; the first absorbs any odd pennies (as Klarna and PayPal do). */
export function instalmentAmounts(total: number, n: number): number[] {
  const base = Math.floor(total / n);
  return Array.from({ length: n }, (_, i) => (i === 0 ? total - base * (n - 1) : base));
}

/** Due dates and amounts for a split payment, ticking off what's been paid so far. */
export function payInSchedule(d: Pick<DebtRow, 'original_balance' | 'instalments' | 'start_date' | 'frequency'>, owed: number) {
  const n = d.instalments ?? 3;
  const start = d.start_date ?? todayIso();
  const amounts = instalmentAmounts(d.original_balance, n);
  let paid = Math.max(0, d.original_balance - owed);
  return amounts.map((amount, i) => {
    const date = d.frequency === 'fortnightly' ? addDaysIso(start, 14 * i) : d.frequency === 'weekly' ? addDaysIso(start, 7 * i) : addMonthsKeepDay(start, i);
    const covered = Math.min(amount, paid);
    paid -= covered;
    return { n: i + 1, date, amount, paid: covered >= amount, outstanding: amount - covered };
  });
}

function addDaysIso(iso: string, days: number): string {
  const t = new Date(`${iso}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}
function addMonthsKeepDay(iso: string, n: number): string {
  const m = addMonths(iso.slice(0, 7), n);
  return `${m}-${String(Math.min(Number(iso.slice(8, 10)), daysInMonth(m))).padStart(2, '0')}`;
}

function validate(db: DB, i: DebtInput) {
  if (!DEBT_TYPES.includes(i.debtType)) throw new ValidationError('Choose the type of debt');
  if (i.debtType === 'pay_in_3') {
    // A split payment: interest-free, fixed instalments from a start date.
    if (!(assertPence(i.originalBalance, 'Total') > 0)) throw new ValidationError('Enter the total you are paying');
    const n = i.instalments ?? 3;
    if (!Number.isInteger(n) || n < 2 || n > 60) throw new ValidationError('Number of payments must be between 2 and 60');
    if (!i.startDate || !isIsoDate(i.startDate)) throw new ValidationError('Add the date of the first payment');
    if (i.frequency && !['monthly', 'fortnightly', 'weekly'].includes(i.frequency)) throw new ValidationError('Payments are monthly, fortnightly or weekly');
    i.instalments = n;
    i.apr = 0; i.promoApr = null; i.promoEnd = null; i.minType = 'fixed'; i.paysInFull = false;
    i.minFixed = instalmentAmounts(i.originalBalance, n)[n - 1];
    i.dueDay = Number(i.startDate.slice(8, 10));
    i.frequency = i.frequency ?? 'monthly';
  }
  if (assertPence(i.originalBalance, 'Original balance') < 0) throw new ValidationError('Original balance cannot be negative');
  const bp = (v: unknown, name: string) => {
    if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 20000) throw new ValidationError(`${name} must be between 0% and 200%`);
  };
  bp(i.apr, 'APR');
  if (i.promoApr != null) {
    bp(i.promoApr, 'Promotional rate');
    if (!i.promoEnd || !isIsoDate(i.promoEnd)) throw new ValidationError('Add the date the promotional rate ends');
  }
  if (!['fixed', 'card'].includes(i.minType)) throw new ValidationError('Choose how the minimum payment works');
  // Student loans (repaid via payroll) and money owed to people may have no fixed payment.
  if (i.minType === 'fixed' && !(i.minFixed! > 0) && !i.paysInFull && !['student_loan', 'personal'].includes(i.debtType)) throw new ValidationError('Enter the monthly payment');
  if (i.minFixed !== undefined) assertPence(i.minFixed, 'Payment');
  if (i.minFloor !== undefined) assertPence(i.minFloor, 'Minimum floor');
  if (i.minPercent !== undefined && (!Number.isInteger(i.minPercent) || i.minPercent < 0 || i.minPercent > 10000)) throw new ValidationError('Minimum percentage must be between 0 and 100');
  if (i.dueDay != null && (!Number.isInteger(i.dueDay) || i.dueDay < 1 || i.dueDay > 31)) throw new ValidationError('Due day must be 1–31');
  if (i.statementDay != null && (!Number.isInteger(i.statementDay) || i.statementDay < 1 || i.statementDay > 31)) throw new ValidationError('Statement end day must be 1–31');
  if (i.paymentAccountId != null) {
    const a = db.prepare('SELECT type FROM accounts WHERE id = ?').get(i.paymentAccountId) as { type: string } | undefined;
    if (!a) throw new ValidationError('Payment account not found');
    if (isLiability(a.type)) throw new ValidationError('Choose the bank account you pay from');
  }
}

export function upsertDebt(db: DB, accountId: number, i: DebtInput) {
  const acc = db.prepare('SELECT type FROM accounts WHERE id = ?').get(accountId) as { type: string } | undefined;
  if (!acc) throw new ValidationError('Account not found');
  if (!isLiability(acc.type)) throw new ValidationError('Debt details are for credit cards, loans and other debts');
  validate(db, i);
  db.prepare(
    `INSERT INTO debts (account_id, debt_type, original_balance, apr, promo_apr, promo_end, min_type, min_fixed, min_percent, min_floor, due_day, frequency, pays_in_full, payment_account_id, notes, start_date, instalments, provider, statement_day)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET debt_type = excluded.debt_type, original_balance = excluded.original_balance, apr = excluded.apr,
       promo_apr = excluded.promo_apr, promo_end = excluded.promo_end, min_type = excluded.min_type, min_fixed = excluded.min_fixed,
       min_percent = excluded.min_percent, min_floor = excluded.min_floor, due_day = excluded.due_day, frequency = excluded.frequency,
       pays_in_full = excluded.pays_in_full, payment_account_id = excluded.payment_account_id, notes = excluded.notes,
       start_date = excluded.start_date, instalments = excluded.instalments, provider = excluded.provider, statement_day = excluded.statement_day`,
  ).run(
    accountId, i.debtType, i.originalBalance, i.apr, i.promoApr ?? null, i.promoApr != null ? i.promoEnd ?? null : null, i.minType,
    i.minFixed ?? 0, i.minPercent ?? 100, i.minFloor ?? 2500, i.dueDay ?? null, i.frequency ?? 'monthly', i.paysInFull ? 1 : 0,
    i.paymentAccountId ?? null, i.notes?.trim() || null,
    i.debtType === 'pay_in_3' ? i.startDate! : null, i.debtType === 'pay_in_3' ? i.instalments! : null, i.provider?.trim() || null,
    i.debtType === 'credit_card' ? i.statementDay ?? null : null,
  );
}

/** Save details; for a split payment, `paidSoFar` resets the balance to total minus what's been paid. */
export function saveDebt(db: DB, accountId: number, i: DebtInput & { paidSoFar?: number | null }) {
  tx(db, () => {
    upsertDebt(db, accountId, i);
    if (i.debtType === 'pay_in_3' && i.paidSoFar != null) {
      assertPence(i.paidSoFar, 'Paid so far');
      if (i.paidSoFar < 0 || i.paidSoFar > i.originalBalance) throw new ValidationError('Paid so far must be between £0 and the total');
      if (owedNow(db, accountId) !== i.originalBalance - i.paidSoFar) updateAccount(db, accountId, { balance: -(i.originalBalance - i.paidSoFar) });
    }
  });
}

/** Add a new debt (e.g. a loan, BNPL, or money owed to a friend): creates the account and its details. */
export function createDebt(db: DB, i: DebtInput & { name: string; owed?: number; paidSoFar?: number; addRepayment?: boolean; colour?: string }) {
  if (typeof i.name !== 'string' || !i.name.trim()) throw new ValidationError('Give the debt a name');
  if (i.debtType === 'pay_in_3') {
    const paid = assertPence(i.paidSoFar ?? 0, 'Paid so far');
    if (paid < 0 || paid > (i.originalBalance ?? 0)) throw new ValidationError('Paid so far must be between £0 and the total');
    i.owed = (i.originalBalance ?? 0) - paid;
  }
  const owedNowIn = assertPence(i.owed, 'Amount owed');
  if (owedNowIn < 0) throw new ValidationError('Amount owed cannot be negative');
  validate(db, i);
  return tx(db, () => {
    const id = createAccount(db, { name: i.name, type: ACCOUNT_TYPE_FOR[i.debtType], balance: -i.owed!, colour: i.colour ?? (i.debtType === 'pay_in_3' ? '#ec4899' : '#dc2626'), institution: i.provider ?? undefined });
    upsertDebt(db, id, i);
    if (i.addRepayment) addRepaymentToBills(db, id);
    return id;
  });
}

/** Put the monthly repayment on the Bills page so it shows as committed and is matched when paid. */
export function addRepaymentToBills(db: DB, accountId: number, today = todayIso()) {
  const d = db.prepare('SELECT * FROM debts WHERE account_id = ?').get(accountId) as DebtRow | undefined;
  const acc = db.prepare('SELECT name FROM accounts WHERE id = ?').get(accountId) as { name: string };
  if (!d) throw new ValidationError('Add the debt details first');
  if (!d.payment_account_id) throw new ValidationError('Choose which account you pay it from');
  const owed = owedNow(db, accountId);
  if (d.debt_type === 'pay_in_3') {
    const left = payInSchedule(d, owed).filter((s) => !s.paid);
    if (!left.length) throw new ValidationError('Everything is paid on this one');
    return createRecurring(db, {
      name: `${acc.name} instalment`, type: 'saving', amount: left[left.length - 1].amount, frequency: d.frequency,
      startDate: left[0].date, endDate: left[left.length - 1].date, accountId: d.payment_account_id, transferAccountId: accountId,
    });
  }
  const amount = d.pays_in_full ? Math.max(owed, 100) : currentMinimum(d, owed, today);
  if (amount <= 0) throw new ValidationError('Nothing to pay on this debt');
  const day = d.due_day ?? Number(today.slice(8, 10));
  let m = monthOf(today);
  if (day < Number(today.slice(8, 10))) m = addMonths(m, 1);
  const start = `${m}-${String(Math.min(day, daysInMonth(m))).padStart(2, '0')}`;
  return createRecurring(db, {
    name: `${acc.name} repayment`, type: 'saving', amount, variable: d.min_type === 'card' || !!d.pays_in_full, frequency: d.frequency,
    startDate: start, accountId: d.payment_account_id, transferAccountId: accountId,
  });
}

/**
 * Payments that might be repayments of this debt but were recorded as spending (e.g. "PAYPAL *PAYIN3"),
 * or as a transfer to a different debt account. Closest amounts first.
 */
export function linkCandidates(db: DB, debtId: number, search = '', today = todayIso()) {
  const d = db.prepare('SELECT * FROM debts WHERE account_id = ?').get(debtId) as DebtRow | undefined;
  const target = d?.debt_type === 'pay_in_3' ? payInSchedule(d, 0)[1]?.amount ?? 0 : d?.min_fixed ?? 0;
  const since = d?.start_date ? addDaysIso(d.start_date, -45) : addDaysIso(today, -180);
  const like = `%${search.trim().toLowerCase()}%`;
  const rows = db.prepare(
    `SELECT t.id, t.date, t.description, t.kind, -p.amount AS amount, a.name AS account_name, c.name AS category_name,
            (SELECT la.name FROM postings p2 JOIN accounts la ON la.id = p2.account_id WHERE p2.transaction_id = t.id AND p2.amount > 0) AS linked_to
     FROM transactions t JOIN postings p ON p.transaction_id = t.id AND p.amount < 0
     JOIN accounts a ON a.id = p.account_id LEFT JOIN categories c ON c.id = p.category_id
     WHERE a.type NOT IN ('credit_card','loan','other_liability') AND t.date >= ?
       AND (t.kind = 'expense' OR (t.kind = 'transfer' AND EXISTS (SELECT 1 FROM postings p3 JOIN accounts a3 ON a3.id = p3.account_id
            WHERE p3.transaction_id = t.id AND p3.amount > 0 AND a3.type IN ('loan','other_liability') AND a3.id != ?)))
       AND (SELECT COUNT(*) FROM postings px WHERE px.transaction_id = t.id) <= 2
       AND (? = '%%' OR lower(t.description) LIKE ? OR lower(IFNULL(p.bank_description, '')) LIKE ?)
     ORDER BY t.date DESC LIMIT 400`,
  ).all(since, debtId, like, like, like) as any[];
  return rows
    .map((r) => ({ id: r.id, date: r.date, description: r.description, kind: r.kind, amount: r.amount, accountName: r.account_name, categoryName: r.category_name, linkedTo: r.linked_to }))
    .sort((a, b) => (target ? Math.abs(a.amount - target) - Math.abs(b.amount - target) : 0) || b.date.localeCompare(a.date))
    .slice(0, 40);
}

/**
 * Repayments dated on or before the day the balance was confirmed, but added or linked after it was set.
 * The balance treats them as already included; you decide whether they should come off.
 * Cards are left out: their balance comes from statements, which already include payments.
 */
export function uncountedRepayments(db: DB, debtId: number) {
  const a = db.prepare('SELECT type, anchor_date, anchor_set_at FROM accounts WHERE id = ?').get(debtId) as { type: string; anchor_date: string; anchor_set_at: string | null } | undefined;
  if (!a || !['loan', 'other_liability'].includes(a.type) || !a.anchor_set_at) return [];
  return (db.prepare(
    `SELECT p.id AS posting_id, t.id AS transaction_id, t.date, t.description, p.amount FROM postings p JOIN transactions t ON t.id = p.transaction_id
     WHERE p.account_id = ? AND t.kind = 'transfer' AND p.amount > 0 AND t.date <= ? AND t.updated_at > ?
       AND NOT EXISTS (SELECT 1 FROM debt_reviewed r WHERE r.posting_id = p.id)
     ORDER BY t.date`,
  ).all(debtId, a.anchor_date, a.anchor_set_at) as any[]).map((r) => ({ postingId: r.posting_id, transactionId: r.transaction_id, date: r.date, description: r.description, amount: r.amount }));
}

/** Take repayments off the confirmed balance (apply) or mark them as already included. */
export function reviewRepayments(db: DB, debtId: number, postingIds: number[], apply: boolean) {
  if (!Array.isArray(postingIds) || !postingIds.length) throw new ValidationError('Choose a repayment');
  tx(db, () => {
    const a = db.prepare('SELECT anchor_balance, anchor_set_at FROM accounts WHERE id = ?').get(debtId) as { anchor_balance: number; anchor_set_at: string } | undefined;
    if (!a) throw new ValidationError('Debt not found');
    let total = 0;
    for (const pid of postingIds) {
      const p = db.prepare('SELECT amount FROM postings WHERE id = ? AND account_id = ?').get(pid, debtId) as { amount: number } | undefined;
      if (!p) throw new ValidationError('Repayment not found');
      if (db.prepare('SELECT 1 FROM debt_reviewed WHERE posting_id = ?').get(pid)) continue;
      db.prepare('INSERT INTO debt_reviewed (posting_id, applied) VALUES (?, ?)').run(pid, apply ? 1 : 0);
      total += p.amount;
    }
    if (apply && total) {
      db.prepare('UPDATE accounts SET anchor_balance = ? WHERE id = ?').run(Math.min(0, a.anchor_balance + total), debtId);
      // Keep the original "confirmed at" time so other repayments still show up for review.
      db.prepare('UPDATE accounts SET anchor_set_at = ? WHERE id = ?').run(a.anchor_set_at, debtId);
    }
  });
}

/** Turn payments into repayments of this debt: they become transfers, so they're no longer counted as spending. */
export function linkToDebt(db: DB, debtId: number, transactionIds: number[], opts: { takeOff?: boolean } = {}) {
  const debt = db.prepare('SELECT type FROM accounts WHERE id = ?').get(debtId) as { type: string } | undefined;
  if (!debt || !isLiability(debt.type)) throw new ValidationError('Debt not found');
  if (!Array.isArray(transactionIds) || transactionIds.length === 0) throw new ValidationError('Choose at least one payment');
  tx(db, () => {
    for (const id of transactionIds) {
      const t = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as any;
      if (!t) throw new ValidationError('Transaction not found');
      const ps = db.prepare('SELECT p.*, a.type FROM postings p JOIN accounts a ON a.id = p.account_id WHERE p.transaction_id = ?').all(id) as any[];
      const out = ps.find((p) => p.amount < 0 && !isLiability(p.type));
      if (!out) throw new ValidationError(`"${t.description}" isn't a payment out of a bank account`);
      if (t.kind === 'expense' && ps.length === 1) {
        db.prepare('UPDATE postings SET category_id = NULL WHERE id = ?').run(out.id);
        db.prepare('INSERT INTO postings (transaction_id, account_id, amount) VALUES (?, ?, ?)').run(id, debtId, -out.amount);
      } else if (t.kind === 'transfer' && ps.length === 2) {
        const other = ps.find((p) => p.id !== out.id)!;
        if (!isLiability(other.type)) throw new ValidationError(`"${t.description}" is a transfer between your own accounts`);
        if (other.account_id === debtId) throw new ValidationError(`"${t.description}" is already linked to this debt`);
        db.prepare('UPDATE postings SET account_id = ? WHERE id = ?').run(debtId, other.id);
      } else throw new ValidationError(`"${t.description}" can't be linked (it's split or not a payment)`);
      db.prepare("UPDATE transactions SET kind = 'transfer', period = substr(date, 1, 7), updated_at = datetime('now') WHERE id = ?").run(id);
    }
    // Payments from before the confirmed balance: take them off now if asked, otherwise they're offered for review.
    if (opts.takeOff !== undefined) {
      const ids = uncountedRepayments(db, debtId).filter((u) => transactionIds.includes(u.transactionId)).map((u) => u.postingId);
      if (ids.length) reviewRepayments(db, debtId, ids, opts.takeOff);
    }
  });
}

export function deleteDebtDetails(db: DB, accountId: number) {
  db.prepare('DELETE FROM debts WHERE account_id = ?').run(accountId);
}

// ---------------------------------------------------------------------------
// Statements

export interface Statement {
  from: string; to: string; current: boolean;
  purchases: number; refunds: number; interest: number; payments: number;
  /** Owed when the statement closed (or now, for the open one). */
  closing: number;
}

/** The date a statement closes in a month (short months close on their last day). */
function closeIn(month: string, day: number): string {
  return `${month}-${String(Math.min(day, daysInMonth(month))).padStart(2, '0')}`;
}
function dayAfter(iso: string): string {
  const t = new Date(`${iso}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}

/** The open statement plus the last `count` closed ones, newest first. */
export function statements(db: DB, accountId: number, day: number, today = todayIso(), count = 6): Statement[] {
  let m = monthOf(today);
  if (closeIn(m, day) >= today) m = addMonths(m, -1); // latest close strictly before today
  const closes = Array.from({ length: count + 1 }, (_, i) => closeIn(addMonths(m, -i), day)); // newest first
  const periods = [
    { from: dayAfter(closes[0]), to: closeIn(addMonths(m, 1), day), current: true },
    ...closes.slice(0, count).map((to, i) => ({ from: dayAfter(closes[i + 1]), to, current: false })),
  ];
  const sums = db.prepare(
    `SELECT
       IFNULL(SUM(CASE WHEN t.kind = 'expense' AND p.amount < 0 AND IFNULL(c.name, '') != 'Interest & Fees' AND IFNULL(pc.name, '') != 'Interest & Fees' THEN -p.amount ELSE 0 END), 0) AS purchases,
       IFNULL(SUM(CASE WHEN t.kind = 'expense' AND p.amount > 0 THEN p.amount ELSE 0 END), 0) AS refunds,
       IFNULL(SUM(CASE WHEN t.kind = 'expense' AND (c.name = 'Interest & Fees' OR pc.name = 'Interest & Fees') THEN -p.amount ELSE 0 END), 0) AS interest,
       IFNULL(SUM(CASE WHEN t.kind = 'transfer' AND p.amount > 0 THEN p.amount ELSE 0 END), 0) AS payments
     FROM postings p JOIN transactions t ON t.id = p.transaction_id
     LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN categories pc ON pc.id = c.parent_id
     WHERE p.account_id = ? AND t.date BETWEEN ? AND ?`,
  );
  return periods.map((p) => {
    const r = sums.get(accountId, p.from, p.to) as { purchases: number; refunds: number; interest: number; payments: number };
    const asOf = p.current ? today : p.to;
    const acc = listAccounts(db, { asOf, includeArchived: true }).find((a) => a.id === accountId);
    return { ...p, ...r, closing: acc ? Math.max(0, -acc.balance) : 0 };
  });
}

// ---------------------------------------------------------------------------
// Maths

function rateOn(d: Pick<DebtRow, 'apr' | 'promo_apr' | 'promo_end'>, date: string): number {
  return d.promo_apr != null && d.promo_end && date < d.promo_end ? d.promo_apr : d.apr;
}

export function monthlyInterest(balance: number, aprBp: number): number {
  return balance > 0 ? Math.round((balance * aprBp) / 10000 / 12) : 0;
}

const PER_MONTH: Record<string, number> = { weekly: 52 / 12, fortnightly: 26 / 12, four_weekly: 13 / 12, monthly: 1 };

/**
 * Minimum due on a balance (after this month's interest was added).
 * Cards: the greater of the floor or a % of the balance plus interest.
 */
export function minimumDue(d: Pick<DebtRow, 'min_type' | 'min_fixed' | 'min_percent' | 'min_floor' | 'frequency'>, balance: number, interest: number): number {
  if (balance <= 0) return 0;
  let due = d.min_type === 'card'
    ? Math.max(d.min_floor, Math.round(((balance - interest) * d.min_percent) / 10000) + interest)
    : Math.round(d.min_fixed * PER_MONTH[d.frequency]);
  return Math.min(due, balance);
}

function currentMinimum(d: DebtRow, owed: number, today: string): number {
  const interest = monthlyInterest(owed, rateOn(d, today));
  return minimumDue(d, owed + interest, interest);
}

function owedNow(db: DB, accountId: number): number {
  const acc = listAccounts(db, { includeArchived: true }).find((a) => a.id === accountId);
  return acc ? Math.max(0, -acc.balance) : 0;
}

export interface SimDebt {
  id: number; name: string; balance: number; apr: number; promoApr: number | null; promoEnd: string | null;
  minType: 'fixed' | 'card'; minFixed: number; minPercent: number; minFloor: number; frequency: DebtRow['frequency'];
}

export interface SimResult {
  strategy: Strategy;
  months: number | null;
  debtFree: string | null;
  totalInterest: number;
  totalPaid: number;
  order: { id: number; name: string; month: string; months: number }[];
  series: { month: string; total: number }[];
  shortfall: boolean;
  never: boolean;
}

/**
 * Month-by-month payoff. `budget` is the total you put towards these debts each
 * month; it must at least cover the minimums (otherwise minimums are paid and
 * `shortfall` is set). With 'minimum', only minimums are paid.
 */
export function simulate(debts: SimDebt[], budget: number, strategy: Strategy, startMonth: string): SimResult {
  const state = debts.filter((d) => d.balance > 0).map((d) => ({ ...d, bal: d.balance, paidOff: null as string | null, months: 0 }));
  const series: { month: string; total: number }[] = [{ month: addMonths(startMonth, -1), total: state.reduce((s, d) => s + d.bal, 0) }];
  const order: SimResult['order'] = [];
  let totalInterest = 0, totalPaid = 0, shortfall = false, m = 0, month = startMonth;
  const MAX = 600;
  while (state.some((d) => d.bal > 0) && m < MAX) {
    const date = `${month}-15`;
    let spent = 0;
    for (const d of state) {
      if (d.bal <= 0) continue;
      const rate = d.promoApr != null && d.promoEnd && date < d.promoEnd ? d.promoApr : d.apr;
      const interest = monthlyInterest(d.bal, rate);
      d.bal += interest;
      totalInterest += interest;
      const due = minimumDue({ min_type: d.minType, min_fixed: d.minFixed, min_percent: d.minPercent, min_floor: d.minFloor, frequency: d.frequency }, d.bal, interest);
      d.bal -= due;
      spent += due;
    }
    if (strategy !== 'minimum') {
      let extra = budget - spent;
      if (extra < 0) shortfall = true;
      const targets = state.filter((d) => d.bal > 0).sort((a, b) =>
        strategy === 'snowball' ? a.bal - b.bal || b.apr - a.apr : b.apr - a.apr || a.bal - b.bal);
      for (const d of targets) {
        if (extra <= 0) break;
        const pay = Math.min(extra, d.bal);
        d.bal -= pay;
        extra -= pay;
        spent += pay;
      }
    }
    totalPaid += spent;
    m++;
    for (const d of state) {
      if (d.bal <= 0 && d.paidOff === null) {
        d.paidOff = month;
        d.months = m;
        order.push({ id: d.id, name: d.name, month, months: m });
      }
    }
    series.push({ month, total: state.reduce((s, d) => s + Math.max(0, d.bal), 0) });
    month = addMonths(month, 1);
  }
  const never = state.some((d) => d.bal > 0);
  return {
    strategy,
    months: never ? null : m,
    debtFree: never ? null : order.length ? order[order.length - 1].month : null,
    totalInterest, totalPaid, order, series, shortfall, never,
  };
}

// ---------------------------------------------------------------------------
// Views

export function listDebts(db: DB, today = todayIso()) {
  const accounts = listAccounts(db).filter((a) => a.isLiability);
  const details = new Map((db.prepare('SELECT * FROM debts').all() as unknown as DebtRow[]).map((d) => [d.account_id, d]));
  const startMonth = addMonths(monthOf(today), 1);
  const yearAgo = `${addMonths(monthOf(today), -11)}-01`;

  // Month-end balances for the last 12 months (one lookup per month, shared by all debts).
  const monthEnds: { month: string; balances: Map<number, number> }[] = [];
  for (let i = 11; i >= 0; i--) {
    const mo = addMonths(monthOf(today), -i);
    const end = i === 0 ? today : `${mo}-${String(daysInMonth(mo)).padStart(2, '0')}`;
    monthEnds.push({ month: mo, balances: new Map(listAccounts(db, { asOf: end, includeArchived: true }).map((x) => [x.id, x.balance])) });
  }

  const items = accounts.map((a) => {
    const d = details.get(a.id) ?? null;
    const owed = Math.max(0, -a.balance);
    const repayments = db.prepare(
      `SELECT t.id, t.date, p.amount, (SELECT acc.name FROM postings p2 JOIN accounts acc ON acc.id = p2.account_id WHERE p2.transaction_id = t.id AND p2.account_id != ? LIMIT 1) AS from_name
       FROM postings p JOIN transactions t ON t.id = p.transaction_id
       WHERE p.account_id = ? AND t.kind = 'transfer' AND p.amount > 0 ORDER BY t.date DESC LIMIT 12`,
    ).all(a.id, a.id) as { id: number; date: string; amount: number; from_name: string | null }[];
    const interestPaid = (db.prepare(
      `SELECT IFNULL(SUM(-p.amount), 0) AS n FROM postings p JOIN transactions t ON t.id = p.transaction_id JOIN categories c ON c.id = p.category_id
       WHERE p.account_id = ? AND t.kind = 'expense' AND (c.name = 'Interest & Fees' OR c.parent_id IN (SELECT id FROM categories WHERE name = 'Interest & Fees')) AND t.date >= ?`,
    ).get(a.id, yearAgo) as { n: number }).n;
    const repaidYear = (db.prepare(
      `SELECT IFNULL(SUM(p.amount), 0) AS n FROM postings p JOIN transactions t ON t.id = p.transaction_id
       WHERE p.account_id = ? AND t.kind = 'transfer' AND p.amount > 0 AND t.date >= ?`,
    ).get(a.id, yearAgo) as { n: number }).n;
    // Only months where the balance is actually known: from the first transaction or confirmed balance onwards.
    const first = (db.prepare('SELECT MIN(t.date) AS d FROM postings p JOIN transactions t ON t.id = p.transaction_id WHERE p.account_id = ?').get(a.id) as { d: string | null }).d;
    const known = [first, a.anchorDate].filter(Boolean).sort()[0] ?? today;
    const history = monthEnds
      .filter((m) => m.month >= monthOf(known))
      .map((m) => ({ month: m.month, owed: Math.max(0, -(m.balances.get(a.id) ?? 0)) }));

    let view = null;
    if (d) {
      const rate = rateOn(d, today);
      const interestNext = monthlyInterest(owed, rate);
      const schedule = d.debt_type === 'pay_in_3' ? payInSchedule(d, owed) : null;
      const nextInstalment = schedule?.find((s) => !s.paid) ?? null;
      // Cards with a statement date: what's due is the last statement's balance less what you've paid since it closed.
      const stmts = d.statement_day && d.debt_type === 'credit_card' ? statements(db, a.id, d.statement_day, today) : null;
      const lastStatement = stmts?.find((x) => !x.current) ?? null;
      const statementDue = lastStatement ? Math.max(0, lastStatement.closing - stmts![0].payments) : null;
      const minimum = schedule ? nextInstalment?.outstanding ?? 0
        : d.pays_in_full ? statementDue ?? owed
        : statementDue != null ? Math.min(statementDue, minimumDue(d, lastStatement!.closing + interestNext, interestNext))
        : minimumDue(d, owed + interestNext, interestNext);
      const plannable = !schedule && (d.min_type === 'card' || d.min_fixed > 0);
      const sim = d.pays_in_full || !plannable ? null : simulate([toSim(a.id, a.name, owed, d)], 0, 'minimum', startMonth);
      let nextDue: string | null = null;
      if (schedule) nextDue = nextInstalment?.date ?? null;
      else if (d.due_day && (owed > 0 || d.debt_type === 'credit_card')) {
        let mo = monthOf(today);
        if (d.due_day < Number(today.slice(8, 10))) mo = addMonths(mo, 1);
        nextDue = `${mo}-${String(Math.min(d.due_day, daysInMonth(mo))).padStart(2, '0')}`;
      }
      const original = Math.max(d.original_balance, owed);
      view = {
        debtType: d.debt_type, originalBalance: d.original_balance, apr: d.apr, promoApr: d.promo_apr, promoEnd: d.promo_end,
        rateNow: rate, minType: d.min_type, minFixed: d.min_fixed, minPercent: d.min_percent, minFloor: d.min_floor,
        dueDay: d.due_day, frequency: d.frequency, paysInFull: !!d.pays_in_full, paymentAccountId: d.payment_account_id, notes: d.notes,
        paidOff: Math.max(0, original - owed), progress: original > 0 ? Math.max(0, original - owed) / original : 1,
        interestNext, minimum, nextDue,
        startDate: d.start_date, instalments: d.instalments, provider: d.provider,
        schedule, overdue: !!nextInstalment && nextInstalment.date < today,
        statementDay: d.statement_day, statements: stmts, statementDue,
        finalDate: schedule ? schedule[schedule.length - 1].date : null,
        atMinimum: sim ? { months: sim.months, debtFree: sim.debtFree, totalInterest: sim.totalInterest, never: sim.never } : null,
      };
    }
    const hasRepayment = !!db.prepare("SELECT 1 FROM recurring WHERE type = 'saving' AND transfer_account_id = ? AND active = 1").get(a.id);
    const group = a.type === 'credit_card' || d?.debt_type === 'credit_card' ? 'card' : d && ['pay_in_3', 'bnpl'].includes(d.debt_type) ? 'bnpl' : 'loan';
    // How the balance is worked out: the last balance you confirmed, plus what's happened since.
    const since = db.prepare(
      `SELECT IFNULL(SUM(CASE WHEN p.amount < 0 THEN -p.amount ELSE 0 END), 0) AS added, IFNULL(SUM(CASE WHEN p.amount > 0 THEN p.amount ELSE 0 END), 0) AS paid,
              COUNT(*) AS n
       FROM postings p JOIN transactions t ON t.id = p.transaction_id WHERE p.account_id = ? AND t.date > ?`,
    ).get(a.id, a.anchorDate) as { added: number; paid: number; n: number };
    const before = (db.prepare(
      `SELECT COUNT(*) AS n FROM postings p JOIN transactions t ON t.id = p.transaction_id WHERE p.account_id = ? AND t.date <= ?`,
    ).get(a.id, a.anchorDate) as { n: number }).n;
    const balanceCheck = { confirmedOn: a.anchorDate, confirmedOwed: Math.max(0, -a.anchorBalance), addedSince: since.added, paidSince: since.paid, countSince: since.n, countBefore: before };
    return {
      accountId: a.id, name: a.name, colour: a.colour, accountType: a.type, institution: a.institution, owed, group, balanceCheck,
      uncounted: uncountedRepayments(db, a.id),
      inCredit: a.balance > 0 ? a.balance : 0, details: view, repayments: repayments.map((r) => ({ id: r.id, date: r.date, amount: r.amount, from: r.from_name })),
      interestPaidYear: interestPaid, repaidYear, history, hasRepayment,
    };
  });

  const active = items.filter((i) => i.owed > 0);
  const planned = active.filter((i) => i.details && !i.details.paysInFull);
  const minimums = planned.reduce((s, i) => s + i.details!.minimum, 0);
  const inFull = active.filter((i) => i.details?.paysInFull).reduce((s, i) => s + i.details!.minimum, 0);
  const original = items.reduce((s, i) => s + (i.details ? Math.max(i.details.originalBalance, i.owed) : 0), 0);
  const owedWithDetails = items.filter((i) => i.details).reduce((s, i) => s + i.owed, 0);
  return {
    items,
    totals: {
      owed: active.reduce((s, i) => s + i.owed, 0),
      minimums,
      statements: inFull,
      monthlyCommitment: minimums + inFull,
      paidOff: Math.max(0, original - owedWithDetails),
      progress: original > 0 ? Math.max(0, original - owedWithDetails) / original : null,
      interestNext: planned.reduce((s, i) => s + i.details!.interestNext, 0),
      interestPaidYear: items.reduce((s, i) => s + i.interestPaidYear, 0),
      missingDetails: active.filter((i) => !i.details).length,
    },
    history: monthEnds.map((m) => ({ month: m.month, owed: items.reduce((s, i) => s + (i.history.find((h) => h.month === m.month)?.owed ?? 0), 0) })),
  };
}

function toSim(id: number, name: string, owed: number, d: DebtRow): SimDebt {
  return { id, name, balance: owed, apr: d.apr, promoApr: d.promo_apr, promoEnd: d.promo_end, minType: d.min_type, minFixed: d.min_fixed, minPercent: d.min_percent, minFloor: d.min_floor, frequency: d.frequency };
}

/** Compare minimum-only, snowball and avalanche for the debts you're paying off over time. */
export function debtPlan(db: DB, budget: number | null, today = todayIso()) {
  // Debts with no payment schedule (e.g. a student loan you only track) can't be planned.
  const details = (db.prepare("SELECT * FROM debts WHERE pays_in_full = 0 AND debt_type != 'pay_in_3'").all() as unknown as DebtRow[])
    .filter((d) => d.min_type === 'card' || d.min_fixed > 0);
  const accounts = listAccounts(db).filter((a) => a.isLiability);
  const sims = details
    .map((d) => {
      const a = accounts.find((x) => x.id === d.account_id);
      return a ? toSim(a.id, a.name, Math.max(0, -a.balance), d) : null;
    })
    .filter((x): x is SimDebt => !!x && x.balance > 0);
  const startMonth = addMonths(monthOf(today), 1);
  const minimum = simulate(sims, 0, 'minimum', startMonth);
  // First month's minimums: the least you can put in.
  const minFirst = sims.reduce((s, d) => {
    const rate = d.promoApr != null && d.promoEnd && `${startMonth}-15` < d.promoEnd ? d.promoApr : d.apr;
    const i = monthlyInterest(d.balance, rate);
    return s + minimumDue({ min_type: d.minType, min_fixed: d.minFixed, min_percent: d.minPercent, min_floor: d.minFloor, frequency: d.frequency }, d.balance + i, i);
  }, 0);
  const saved = Number(getSetting(db, 'debt_budget', '0'));
  const monthly = budget ?? (saved > 0 ? saved : minFirst);
  const strategies = {
    minimum,
    snowball: simulate(sims, monthly, 'snowball', startMonth),
    avalanche: simulate(sims, monthly, 'avalanche', startMonth),
  };
  const preferred = (getSetting(db, 'debt_strategy', 'avalanche') as Strategy);
  return {
    debts: sims.map((d) => ({ id: d.id, name: d.name, balance: d.balance, apr: d.apr })),
    minimumPayment: minFirst,
    monthly,
    preferred,
    strategies,
  };
}

export function saveDebtPlan(db: DB, body: { monthly?: number; strategy?: Strategy }) {
  if (body.monthly !== undefined) {
    assertPence(body.monthly, 'Monthly amount');
    if (body.monthly < 0) throw new ValidationError('Monthly amount cannot be negative');
    setSetting(db, 'debt_budget', String(body.monthly));
  }
  if (body.strategy !== undefined) {
    if (!['snowball', 'avalanche', 'minimum'].includes(body.strategy)) throw new ValidationError('Unknown strategy');
    setSetting(db, 'debt_strategy', body.strategy);
  }
}

// ---------------------------------------------------------------------------
// Timeline: when each debt finishes, from what's actually scheduled.

/**
 * When each debt is cleared, using (in order) its repayments on Bills and income, its pay-in-3
 * schedule, or its fixed monthly payment. Cards paid in full each month aren't debts to clear.
 */
export function debtTimeline(db: DB, today = todayIso()) {
  const { items } = listDebts(db, today);
  const horizon = `${addMonths(monthOf(today), 60)}-28`;
  const debts = items
    .filter((d) => d.owed > 0 && !(d.details?.paysInFull))
    .map((d) => {
      let payments: { date: string; amount: number }[] = [];
      let source: 'bills' | 'schedule' | 'minimum' | 'none' = 'none';
      const recs = db.prepare("SELECT * FROM recurring WHERE type = 'saving' AND active = 1 AND transfer_account_id = ?").all(d.accountId) as any[];
      if (recs.length) {
        source = 'bills';
        for (const r of recs) {
          const paid = new Set((db.prepare("SELECT due_date FROM recurring_payments WHERE recurring_id = ? AND status IN ('paid','skipped')").all(r.id) as { due_date: string }[]).map((x) => x.due_date));
          // From a month back, so a payment that's due but not made yet still counts.
          for (const date of dueDates(r, addDaysIso(today, -31), horizon)) if (!paid.has(date) && (date >= today || date >= addDaysIso(today, -31))) payments.push({ date, amount: r.amount });
        }
      } else if (d.details?.schedule) {
        source = 'schedule';
        payments = d.details.schedule.filter((s) => !s.paid).map((s) => ({ date: s.date, amount: s.outstanding }));
      } else if (d.details && d.details.minimum > 0 && d.details.apr === 0) {
        source = 'minimum';
        const day = d.details.dueDay ?? Number(today.slice(8, 10));
        for (let i = 0; i < 60; i++) {
          const m = addMonths(monthOf(today), i);
          const date = `${m}-${String(Math.min(day, daysInMonth(m))).padStart(2, '0')}`;
          if (date >= today) payments.push({ date, amount: d.details.minimum });
        }
      }
      payments.sort((a, b) => a.date.localeCompare(b.date));
      // Walk the payments until the balance is cleared.
      let left = d.owed;
      const used: { date: string; amount: number }[] = [];
      for (const p of payments) {
        if (left <= 0) break;
        const amt = Math.min(p.amount, left);
        used.push({ date: p.date, amount: amt });
        left -= amt;
      }
      let finalDate = left <= 0 && used.length ? used[used.length - 1].date : null;
      // Interest-bearing debts: use the payoff projection (which adds interest) for the finish date.
      const sim = d.details?.atMinimum;
      if (d.details && d.details.apr > 0 && sim && !sim.never && sim.debtFree) {
        finalDate = `${sim.debtFree}-${String(daysInMonth(sim.debtFree)).padStart(2, '0')}`;
        left = 0;
      }
      return {
        accountId: d.accountId, name: d.name, colour: d.colour, group: d.group, owed: d.owed,
        apr: d.details?.apr ?? null, source, payments: used, finalDate, unscheduled: Math.max(0, left),
      };
    });
  const months = new Map<string, number>();
  for (const d of debts) for (const p of d.payments) months.set(p.date.slice(0, 7), (months.get(p.date.slice(0, 7)) ?? 0) + p.amount);
  const byMonth = [...months.entries()].sort().map(([month, total]) => ({ month, total }));
  const allScheduled = debts.every((d) => d.finalDate);
  const scheduledEnd = debts.filter((d) => d.finalDate).map((d) => d.finalDate!).sort().pop() ?? null;
  const debtFree = debts.length === 0 ? today : allScheduled ? scheduledEnd : null;
  const thisMonth = monthOf(today);
  return {
    debts: debts.sort((a, b) => (a.finalDate ?? '9999').localeCompare(b.finalDate ?? '9999')),
    byMonth,
    debtFree,
    /** Last finish date among debts that are scheduled (when some aren't). */
    scheduledEnd,
    /** Paid towards these debts each month now; freed up once they're cleared. */
    monthlyNow: Math.max(months.get(thisMonth) ?? 0, months.get(addMonths(thisMonth, 1)) ?? 0),
    unscheduled: debts.filter((d) => !d.finalDate).map((d) => d.name),
    /** Whether a payoff strategy (snowball/avalanche) can save anything: some debt charges interest and isn't paid in full. */
    interestBearing: items.some((d) => d.owed > 0 && d.details && !d.details.paysInFull && (d.details.apr > 0 || (d.details.promoApr ?? 0) > 0)),
  };
}

/** Archive a cleared debt: it leaves the Debts page and its repayments stop showing on Bills and income. */
export function archiveDebt(db: DB, accountId: number) {
  const a = listAccounts(db).find((x) => x.id === accountId);
  if (!a || !a.isLiability) throw new ValidationError('Debt not found');
  if (a.balance < 0) throw new ValidationError(`There's still ${(-a.balance / 100).toLocaleString('en-GB', { style: 'currency', currency: 'GBP' })} owed on ${a.name}`);
  tx(db, () => {
    db.prepare('UPDATE accounts SET archived = 1 WHERE id = ?').run(accountId);
    db.prepare('UPDATE recurring SET active = 0 WHERE transfer_account_id = ?').run(accountId);
  });
}
