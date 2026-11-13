/**
 * Bills, subscriptions, regular savings and expected income.
 *
 * A recurring item never creates transactions by itself (so nothing can be
 * counted twice). Instead each due date is matched to the real transaction
 * when it appears — imported or entered by hand — and recorded in
 * recurring_payments. Due dates without a match are upcoming or overdue.
 */
import { type DB, tx, getSetting } from './db.ts';
import { ValidationError, assertPence } from './money.ts';
import { addDays, addMonths, daysBetween, daysInMonth, isIsoDate, monthOf, todayIso } from './dates.ts';
import { lastWorkingDay } from './calendar.ts';
import { createTransaction, normaliseMerchant, simpleToPostings, isLiability } from './ledger.ts';
import { monthTotals } from './queries.ts';
import { listShares, shareCycles } from './shares.ts';

export type RecurringType = 'bill' | 'subscription' | 'income' | 'saving';
export type Frequency = 'weekly' | 'fortnightly' | 'four_weekly' | 'monthly' | 'quarterly' | 'annually';
export const FREQUENCIES: Frequency[] = ['weekly', 'fortnightly', 'four_weekly', 'monthly', 'quarterly', 'annually'];

const DAY_STEP: Partial<Record<Frequency, number>> = { weekly: 7, fortnightly: 14, four_weekly: 28 };
const MONTH_STEP: Partial<Record<Frequency, number>> = { monthly: 1, quarterly: 3, annually: 12 };

/** Grace period before an unpaid item is called overdue (direct debits can take a day or two to show). */
const GRACE_DAYS = 3;
/** How far either side of the due date a payment can land and still be matched. */
const MATCH_BEFORE = 5;
const MATCH_AFTER = 7;

export interface RecurringRow {
  id: number;
  name: string;
  type: RecurringType;
  amount: number;
  variable: number;
  frequency: Frequency;
  start_date: string;
  schedule: 'fixed' | 'last_working_day';
  end_date: string | null;
  account_id: number;
  category_id: number | null;
  transfer_account_id: number | null;
  match_pattern: string | null;
  notes: string | null;
  active: number;
}

// ---------------------------------------------------------------------------
// Schedules

/** All due dates between from and to (inclusive). */
export function dueDates(r: Pick<RecurringRow, 'frequency' | 'start_date' | 'schedule' | 'end_date'>, from: string, to: string): string[] {
  const out: string[] = [];
  const end = r.end_date && r.end_date < to ? r.end_date : to;
  if (end < r.start_date) return out;
  const dayStep = DAY_STEP[r.frequency];
  if (dayStep) {
    let k = Math.max(0, Math.floor(daysBetween(r.start_date, from) / dayStep));
    for (let d = addDays(r.start_date, k * dayStep); d <= end; d = addDays(r.start_date, ++k * dayStep)) {
      if (d >= from) out.push(d);
    }
    return out;
  }
  const step = MONTH_STEP[r.frequency]!;
  const startMonth = monthOf(r.start_date);
  const startDay = Number(r.start_date.slice(8, 10));
  const monthsFrom = monthDiff(startMonth, monthOf(from));
  let k = Math.max(0, Math.floor(monthsFrom / step) - 1);
  for (;;) {
    const m = addMonths(startMonth, k * step);
    const d = r.schedule === 'last_working_day'
      ? lastWorkingDay(m)
      : `${m}-${String(Math.min(startDay, daysInMonth(m))).padStart(2, '0')}`;
    if (d > end) break;
    // "Last working day" starts in the start date's month, even if that day is earlier than the date picked.
    const started = r.schedule === 'last_working_day' ? monthOf(d) >= startMonth : d >= r.start_date;
    if (d >= from && started) out.push(d);
    k++;
  }
  return out;
}

function monthDiff(a: string, b: string): number {
  const [ay, am] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  return (by - ay) * 12 + (bm - am);
}

/** A one-off item (e.g. an expected bonus) is stored as yearly with the same start and end date. */
export function isOneOff(r: { frequency: string; start_date: string; end_date: string | null }): boolean {
  return r.frequency === 'annually' && r.end_date === r.start_date;
}

/** What a payment costs per month on average (annual £120 → £10/month). */
export function monthlyEquivalent(amount: number, frequency: Frequency): number {
  const perYear = { weekly: 52, fortnightly: 26, four_weekly: 13, monthly: 12, quarterly: 4, annually: 1 }[frequency];
  return Math.round((amount * perYear) / 12);
}

/** Month an expected income counts towards (late-month salary funds next month). */
function incomePeriod(db: DB, r: RecurringRow, due: string): string {
  const month = monthOf(due);
  if (r.type !== 'income' || !r.category_id) return month;
  const cat = db.prepare('SELECT roll_forward FROM categories WHERE id = ?').get(r.category_id) as { roll_forward: number } | undefined;
  const days = parseInt(getSetting(db, 'rollforward_days', '5'), 10);
  if (!cat?.roll_forward || !days) return month;
  return Number(due.slice(8, 10)) > daysInMonth(month) - days ? addMonths(month, 1) : month;
}

// ---------------------------------------------------------------------------
// CRUD

export interface RecurringInput {
  name: string;
  type: RecurringType;
  amount: number;
  variable?: boolean;
  frequency: Frequency;
  startDate: string;
  schedule?: 'fixed' | 'last_working_day';
  endDate?: string | null;
  accountId: number;
  categoryId?: number | null;
  transferAccountId?: number | null;
  matchPattern?: string | null;
  notes?: string | null;
  active?: boolean;
}

function validate(db: DB, i: RecurringInput) {
  if (typeof i.name !== 'string' || !i.name.trim()) throw new ValidationError('Name is required');
  if (!['bill', 'subscription', 'income', 'saving'].includes(i.type)) throw new ValidationError('Unknown type');
  const amount = assertPence(i.amount, 'Amount');
  if (amount <= 0) throw new ValidationError('Amount must be more than £0');
  if (!FREQUENCIES.includes(i.frequency)) throw new ValidationError('Unknown frequency');
  if (!isIsoDate(i.startDate)) throw new ValidationError('Choose the first (or next) due date');
  if (i.endDate && (!isIsoDate(i.endDate) || i.endDate < i.startDate)) throw new ValidationError('End date must be after the start date');
  if (i.schedule === 'last_working_day' && i.frequency !== 'monthly') throw new ValidationError('“Last working day” only works for monthly payments');
  const acc = db.prepare('SELECT id FROM accounts WHERE id = ?').get(i.accountId);
  if (!acc) throw new ValidationError('Choose an account');
  if (i.type === 'saving') {
    if (!i.transferAccountId || i.transferAccountId === i.accountId) throw new ValidationError('Choose the savings or investment account the money goes to');
    if (i.categoryId) throw new ValidationError('Savings are transfers, so they have no category');
  } else if (i.categoryId) {
    const cat = db.prepare('SELECT kind FROM categories WHERE id = ?').get(i.categoryId) as { kind: string } | undefined;
    if (!cat) throw new ValidationError('Category not found');
    if ((i.type === 'income') !== (cat.kind === 'income')) throw new ValidationError(i.type === 'income' ? 'Choose an income category' : 'Choose a spending category');
  }
}

export function createRecurring(db: DB, i: RecurringInput): number {
  validate(db, i);
  const id = tx(db, () => {
    const res = db.prepare(
      `INSERT INTO recurring (name, type, amount, variable, frequency, start_date, schedule, end_date, account_id, category_id, transfer_account_id, match_pattern, notes, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      i.name.trim(), i.type, i.amount, i.variable ? 1 : 0, i.frequency, i.startDate, i.schedule ?? 'fixed', i.endDate ?? null,
      i.accountId, i.type === 'saving' ? null : i.categoryId ?? null, i.type === 'saving' ? i.transferAccountId ?? null : null,
      i.matchPattern?.trim() || null, i.notes?.trim() || null, i.active === false ? 0 : 1,
    );
    const rid = Number(res.lastInsertRowid);
    db.prepare('INSERT INTO recurring_amounts (recurring_id, effective_date, amount, detected) VALUES (?, ?, ?, 0)').run(rid, i.startDate, i.amount);
    return rid;
  });
  autoMatch(db, id);
  return id;
}

export function updateRecurring(db: DB, id: number, i: RecurringInput) {
  validate(db, i);
  const old = db.prepare('SELECT * FROM recurring WHERE id = ?').get(id) as RecurringRow | undefined;
  if (!old) throw new ValidationError('Not found');
  tx(db, () => {
    db.prepare(
      `UPDATE recurring SET name = ?, type = ?, amount = ?, variable = ?, frequency = ?, start_date = ?, schedule = ?, end_date = ?, account_id = ?,
         category_id = ?, transfer_account_id = ?, match_pattern = ?, notes = ?, active = ? WHERE id = ?`,
    ).run(
      i.name.trim(), i.type, i.amount, i.variable ? 1 : 0, i.frequency, i.startDate, i.schedule ?? 'fixed', i.endDate ?? null, i.accountId,
      i.type === 'saving' ? null : i.categoryId ?? null, i.type === 'saving' ? i.transferAccountId ?? null : null,
      i.matchPattern?.trim() || null, i.notes?.trim() || null, i.active === false ? 0 : 1, id,
    );
    if (old.amount !== i.amount) {
      db.prepare('INSERT INTO recurring_amounts (recurring_id, effective_date, amount, detected) VALUES (?, ?, ?, 0)').run(id, todayIso(), i.amount);
    }
    // Schedule or matching rules changed: drop automatic matches and match again.
    if (old.start_date !== i.startDate || old.frequency !== i.frequency || old.schedule !== (i.schedule ?? 'fixed') ||
        old.account_id !== i.accountId || (old.match_pattern ?? '') !== (i.matchPattern?.trim() ?? '')) {
      db.prepare("DELETE FROM recurring_payments WHERE recurring_id = ? AND status = 'paid' AND transaction_id IS NOT NULL").run(id);
    }
  });
  autoMatch(db, id);
}

export function deleteRecurring(db: DB, id: number) {
  db.prepare('DELETE FROM recurring WHERE id = ?').run(id);
}

// ---------------------------------------------------------------------------
// Matching

interface Candidate { id: number; date: string; amount: number; description: string; merchant: string }

function matchesPattern(r: RecurringRow, c: Candidate): boolean {
  const pattern = (r.match_pattern || r.name).toLowerCase().trim();
  if (!pattern) return true;
  const desc = c.description.toLowerCase();
  const norm = normaliseMerchant(pattern).toLowerCase();
  return desc.includes(pattern) || (norm !== '' && c.merchant.toLowerCase().includes(norm));
}

function candidates(db: DB, r: RecurringRow, due: string): Candidate[] {
  const from = addDays(due, -MATCH_BEFORE);
  const to = addDays(due, MATCH_AFTER);
  const linked = 'NOT EXISTS (SELECT 1 FROM recurring_payments rp WHERE rp.transaction_id = t.id)';
  if (r.type === 'saving') {
    return db.prepare(
      `SELECT t.id, t.date, t.description, t.merchant, pin.amount AS amount
       FROM transactions t
       JOIN postings pout ON pout.transaction_id = t.id AND pout.account_id = ? AND pout.amount < 0
       JOIN postings pin ON pin.transaction_id = t.id AND pin.account_id = ? AND pin.amount > 0
       WHERE t.kind = 'transfer' AND t.date BETWEEN ? AND ? AND ${linked}`,
    ).all(r.account_id, r.transfer_account_id, from, to) as unknown as Candidate[];
  }
  const kind = r.type === 'income' ? 'income' : 'expense';
  const sign = r.type === 'income' ? '> 0' : '< 0';
  return db.prepare(
    `SELECT t.id, t.date, t.description, t.merchant, ABS(SUM(p.amount)) AS amount
     FROM transactions t JOIN postings p ON p.transaction_id = t.id
     WHERE t.kind = ? AND p.account_id = ? AND p.amount ${sign} AND t.date BETWEEN ? AND ? AND ${linked}
     GROUP BY t.id`,
  ).all(kind, r.account_id, from, to) as unknown as Candidate[];
}

/**
 * Link due dates to real transactions. Runs after imports and edits, and
 * whenever bills are viewed. Also keeps the expected amount in line with
 * what you actually paid most recently, so price rises are picked up.
 */
export function autoMatch(db: DB, onlyId?: number) {
  const today = todayIso();
  const items = (onlyId
    ? db.prepare('SELECT * FROM recurring WHERE id = ? AND active = 1').all(onlyId)
    : db.prepare('SELECT * FROM recurring WHERE active = 1').all()) as unknown as RecurringRow[];
  for (const r of items) {
    tx(db, () => {
      // dueDates() enforces the start itself; look back a month so a last-working-day date before the picked day is included.
      const earliest = addDays(r.start_date, -31);
      const from = earliest > addDays(today, -400) ? earliest : addDays(today, -400);
      const done = new Set((db.prepare('SELECT due_date FROM recurring_payments WHERE recurring_id = ?').all(r.id) as { due_date: string }[]).map((x) => x.due_date));
      for (const due of dueDates(r, from, addDays(today, MATCH_BEFORE))) {
        if (done.has(due)) continue;
        const expected = expectedAmount(db, r.id, due) ?? r.amount;
        const list = candidates(db, r, due)
          .filter((c) => (r.type === 'saving' && !r.match_pattern) || matchesPattern(r, c))
          // A fixed-price item must be roughly the expected amount (allows for price changes up to +/-50%).
          // Pay can be much higher than usual when a bonus is included, so income has no upper limit.
          .filter((c) => r.variable || (r.type === 'income'
            ? c.amount >= expected * 0.5
            : Math.abs(c.amount - expected) <= Math.max(expected * 0.5, 100)))
          .sort((a, b) => Math.abs(daysBetween(due, a.date)) - Math.abs(daysBetween(due, b.date)) || Math.abs(a.amount - expected) - Math.abs(b.amount - expected));
        const best = list[0];
        if (!best) continue;
        db.prepare("INSERT INTO recurring_payments (recurring_id, due_date, status, transaction_id, amount, paid_date) VALUES (?, ?, 'paid', ?, ?, ?)")
          .run(r.id, due, best.id, best.amount, best.date);
      }
      syncAmountFromPayments(db, r);
    });
  }
}

/** Expected amount on a date, from the amount history. */
function expectedAmount(db: DB, recurringId: number, date: string): number | null {
  const row = db.prepare('SELECT amount FROM recurring_amounts WHERE recurring_id = ? AND effective_date <= ? ORDER BY effective_date DESC, id DESC LIMIT 1')
    .get(recurringId, date) as { amount: number } | undefined;
  return row?.amount ?? null;
}

/** When the latest real payment differs from the expected amount, the price has changed. */
function syncAmountFromPayments(db: DB, r: RecurringRow) {
  if (r.variable || isOneOff(r)) return;
  const recent = db.prepare("SELECT due_date, amount FROM recurring_payments WHERE recurring_id = ? AND status = 'paid' AND amount IS NOT NULL ORDER BY due_date DESC LIMIT 2")
    .all(r.id) as { due_date: string; amount: number }[];
  const latest = recent[0];
  if (!latest) return;
  const current = (db.prepare('SELECT amount FROM recurring WHERE id = ?').get(r.id) as { amount: number }).amount;
  if (latest.amount === current) return;
  // Pay: one bigger month is a bonus, not a pay rise. Only a change seen twice in a row is a new salary.
  if (r.type === 'income' && (recent.length < 2 || recent[1].amount !== latest.amount)) return;
  db.prepare('UPDATE recurring SET amount = ? WHERE id = ?').run(latest.amount, r.id);
  db.prepare('INSERT INTO recurring_amounts (recurring_id, effective_date, amount, detected) VALUES (?, ?, ?, 1)').run(r.id, latest.due_date, latest.amount);
}

/** Price changes worked out from the payments actually made (fixed-price items only). */
export function priceChanges(db: DB, r: RecurringRow) {
  if (r.variable || r.type === 'income') return [];
  const pays = db.prepare("SELECT due_date, amount FROM recurring_payments WHERE recurring_id = ? AND status = 'paid' AND amount IS NOT NULL ORDER BY due_date")
    .all(r.id) as { due_date: string; amount: number }[];
  const out: { date: string; from: number; to: number }[] = [];
  for (let i = 1; i < pays.length; i++) {
    if (pays[i].amount !== pays[i - 1].amount) out.push({ date: pays[i].due_date, from: pays[i - 1].amount, to: pays[i].amount });
  }
  return out;
}

/** Income payments that were more than expected (bonuses, overtime). */
export function incomeExtras(db: DB, r: RecurringRow) {
  if (r.type !== 'income') return [];
  const pays = db.prepare("SELECT due_date, amount, paid_date FROM recurring_payments WHERE recurring_id = ? AND status = 'paid' AND amount IS NOT NULL ORDER BY due_date DESC")
    .all(r.id) as { due_date: string; amount: number; paid_date: string | null }[];
  return pays
    .map((p) => ({ date: p.paid_date ?? p.due_date, expected: expectedAmount(db, r.id, p.due_date) ?? r.amount, amount: p.amount }))
    .filter((p) => p.amount > p.expected)
    .map((p) => ({ ...p, extra: p.amount - p.expected }));
}

// ---------------------------------------------------------------------------
// Manual status changes

export interface PaymentInput {
  dueDate: string;
  status: 'paid' | 'skipped' | 'unpaid';
  /** Link to an existing transaction. */
  transactionId?: number | null;
  /** Or record a new transaction now (date defaults to the due date). */
  record?: { date?: string; amount?: number } | null;
}

export function setPayment(db: DB, recurringId: number, i: PaymentInput) {
  const r = db.prepare('SELECT * FROM recurring WHERE id = ?').get(recurringId) as RecurringRow | undefined;
  if (!r) throw new ValidationError('Not found');
  if (!isIsoDate(i.dueDate)) throw new ValidationError('Invalid due date');
  tx(db, () => {
    db.prepare('DELETE FROM recurring_payments WHERE recurring_id = ? AND due_date = ?').run(recurringId, i.dueDate);
    if (i.status === 'unpaid') return;
    if (i.status === 'skipped') {
      db.prepare("INSERT INTO recurring_payments (recurring_id, due_date, status) VALUES (?, ?, 'skipped')").run(recurringId, i.dueDate);
      return;
    }
    let txnId: number | null = null;
    let amount = r.amount;
    let paidDate = i.dueDate;
    if (i.transactionId) {
      const t = db.prepare('SELECT t.id, t.date, ABS(SUM(p.amount)) AS amount FROM transactions t JOIN postings p ON p.transaction_id = t.id WHERE t.id = ? AND p.account_id = ? GROUP BY t.id')
        .get(i.transactionId, r.account_id) as { id: number; date: string; amount: number } | undefined;
      if (!t) throw new ValidationError('That transaction is not on the account this payment comes from');
      const taken = db.prepare('SELECT 1 FROM recurring_payments WHERE transaction_id = ?').get(t.id);
      if (taken) throw new ValidationError('That transaction is already linked to another payment');
      txnId = t.id; amount = t.amount; paidDate = t.date;
    } else if (i.record) {
      amount = i.record.amount ?? r.amount;
      paidDate = i.record.date ?? i.dueDate;
      if (!isIsoDate(paidDate)) throw new ValidationError('Invalid date');
      const base = { date: paidDate, description: r.name, accountId: r.account_id, amount };
      txnId = createTransaction(db, simpleToPostings(
        r.type === 'saving' ? { ...base, kind: 'transfer', toAccountId: r.transfer_account_id }
          : r.type === 'income' ? { ...base, kind: 'income', categoryId: r.category_id }
          : { ...base, kind: 'expense', categoryId: r.category_id },
      ));
    }
    db.prepare("INSERT INTO recurring_payments (recurring_id, due_date, status, transaction_id, amount, paid_date) VALUES (?, ?, 'paid', ?, ?, ?)")
      .run(recurringId, i.dueDate, txnId, amount, paidDate);
    syncAmountFromPayments(db, r);
  });
}

// ---------------------------------------------------------------------------
// Views

export type OccurrenceStatus = 'paid' | 'skipped' | 'upcoming' | 'due' | 'overdue';

export interface Occurrence {
  recurringId: number;
  name: string;
  type: RecurringType;
  dueDate: string;
  period: string;
  expected: number;
  status: OccurrenceStatus;
  paidAmount: number | null;
  paidDate: string | null;
  transactionId: number | null;
  accountName: string;
  categoryColour: string | null;
  categoryIcon: string | null;
  /** A regular payment towards a card or loan (a 'saving' item paying a debt account). */
  isDebt: boolean;
}

function statusFor(due: string, today: string): OccurrenceStatus {
  if (due > today) return 'upcoming';
  return daysBetween(due, today) <= GRACE_DAYS ? 'due' : 'overdue';
}

/** Every due date in [from, to] across active items, with its status. */
export function occurrences(db: DB, from: string, to: string): Occurrence[] {
  const today = todayIso();
  const items = db.prepare(
    `SELECT r.*, a.name AS account_name, c.colour AS category_colour, c.icon AS category_icon, ta.type AS transfer_type
     FROM recurring r JOIN accounts a ON a.id = r.account_id LEFT JOIN categories c ON c.id = r.category_id
     LEFT JOIN accounts ta ON ta.id = r.transfer_account_id
     WHERE r.active = 1`,
  ).all() as any[];
  const out: Occurrence[] = [];
  for (const r of items) {
    const pays = new Map((db.prepare('SELECT * FROM recurring_payments WHERE recurring_id = ? AND due_date BETWEEN ? AND ?').all(r.id, from, to) as any[]).map((p) => [p.due_date, p]));
    for (const due of dueDates(r, from, to)) {
      const p = pays.get(due);
      out.push({
        recurringId: r.id,
        name: r.name,
        type: r.type,
        dueDate: due,
        period: incomePeriod(db, r, due),
        expected: expectedAmount(db, r.id, due) ?? r.amount,
        status: p ? p.status : statusFor(due, today),
        paidAmount: p?.amount ?? null,
        paidDate: p?.paid_date ?? null,
        transactionId: p?.transaction_id ?? null,
        accountName: r.account_name,
        categoryColour: r.category_colour,
        categoryIcon: r.category_icon,
        isDebt: r.type === 'saving' && !!r.transfer_type && isLiability(r.transfer_type),
      });
    }
  }
  return out.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.name.localeCompare(b.name));
}

export function listRecurring(db: DB) {
  const today = todayIso();
  const rows = db.prepare(
    `SELECT r.*, a.name AS account_name, ta.name AS transfer_account_name, c.name AS category_name, c.colour AS category_colour, c.icon AS category_icon
     FROM recurring r JOIN accounts a ON a.id = r.account_id
     LEFT JOIN accounts ta ON ta.id = r.transfer_account_id LEFT JOIN categories c ON c.id = r.category_id
     ORDER BY r.active DESC, r.type, r.name`,
  ).all() as any[];
  const allOcc = occurrences(db, addDays(today, -40), addDays(today, 400));
  return rows.map((r) => {
    const upcoming = r.active ? allOcc.filter((o) => o.recurringId === r.id) : [];
    const next = upcoming.find((o) => o.status !== 'paid' && o.status !== 'skipped') ?? null;
    const history = db.prepare(
      `SELECT rp.*, t.description FROM recurring_payments rp LEFT JOIN transactions t ON t.id = rp.transaction_id
       WHERE rp.recurring_id = ? ORDER BY rp.due_date DESC LIMIT 24`,
    ).all(r.id) as any[];
    const changes = priceChanges(db, r);
    const oneOff = isOneOff(r);
    const extras = incomeExtras(db, r);
    const shares = listShares(db, r.id);
    const sharedBack = shares.reduce((n, x) => n + x.amount, 0);
    const cycles = shareCycles(db, r);
    return {
      id: r.id,
      name: r.name,
      type: r.type as RecurringType,
      amount: r.amount,
      variable: !!r.variable,
      frequency: r.frequency as Frequency,
      startDate: r.start_date,
      schedule: r.schedule,
      endDate: r.end_date,
      accountId: r.account_id,
      accountName: r.account_name,
      transferAccountId: r.transfer_account_id,
      transferAccountName: r.transfer_account_name,
      categoryId: r.category_id,
      categoryName: r.category_name,
      categoryColour: r.category_colour,
      categoryIcon: r.category_icon,
      matchPattern: r.match_pattern,
      notes: r.notes,
      active: !!r.active,
      monthly: oneOff ? 0 : monthlyEquivalent(r.amount, r.frequency),
      shares: shares.map((x) => ({ id: x.id, name: x.name, matchPattern: x.match_pattern, amount: x.amount, accountId: x.account_id })),
      sharedBack,
      yourShare: r.amount - sharedBack,
      monthlyNet: oneOff ? 0 : monthlyEquivalent(r.amount - sharedBack, r.frequency),
      shareCycles: cycles,
      oneOff,
      extras: extras.slice(0, 12),
      extrasThisYear: extras.filter((e) => e.date.slice(0, 4) === today.slice(0, 4)).reduce((s, e) => s + e.extra, 0),
      next: next ? { dueDate: next.dueDate, status: next.status, expected: next.expected } : null,
      history: history.map((h) => ({ dueDate: h.due_date, status: h.status, amount: h.amount, paidDate: h.paid_date, transactionId: h.transaction_id, description: h.description })),
      priceChanges: changes,
      lastChange: changes.length ? changes[changes.length - 1] : null,
    };
  });
}

/**
 * The month at a glance: what's coming in, what's already committed to bills
 * and savings, and what's genuinely free to spend.
 */
export function monthPlan(db: DB, month: string) {
  const first = `${month}-01`;
  const last = `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;
  // Income is looked up by the month it counts towards, so include the end of the previous month.
  const occ = occurrences(db, addDays(first, -10), last);
  const inMonth = occ.filter((o) => o.type !== 'income' && o.dueDate >= first);
  const income = occ.filter((o) => o.type === 'income' && o.period === month);

  const amountOf = (o: Occurrence) => (o.status === 'paid' && o.paidAmount != null ? o.paidAmount : o.status === 'skipped' ? 0 : o.expected);
  const sum = (list: Occurrence[], f: (o: Occurrence) => number) => list.reduce((s, o) => s + f(o), 0);

  const bills = inMonth.filter((o) => o.type === 'bill' || o.type === 'subscription');
  const savings = inMonth.filter((o) => o.type === 'saving' && !o.isDebt);
  const debts = inMonth.filter((o) => o.isDebt);
  const debtTotal = sum(debts, amountOf);
  const debtDone = sum(debts.filter((o) => o.status === 'paid'), amountOf);
  const billsTotal = sum(bills, amountOf);
  const billsPaid = sum(bills.filter((o) => o.status === 'paid'), amountOf);
  const savingsTotal = sum(savings, amountOf);
  const savingsDone = sum(savings.filter((o) => o.status === 'paid'), amountOf);
  const incomeExpected = sum(income, amountOf);
  const incomeReceived = sum(income.filter((o) => o.status === 'paid'), amountOf);

  // Spending this month that wasn't a planned bill (groceries, eating out…).
  const { spending, income: actualIncome } = monthTotals(db, month);
  const billSpending = (db.prepare(
    `SELECT IFNULL(SUM(-p.amount), 0) AS n FROM recurring_payments rp
     JOIN recurring r ON r.id = rp.recurring_id
     JOIN transactions t ON t.id = rp.transaction_id
     JOIN postings p ON p.transaction_id = t.id
     WHERE r.type IN ('bill','subscription') AND t.kind = 'expense' AND t.period = ?`,
  ).get(month) as { n: number }).n;
  const otherSpending = spending - billSpending;
  // Income that arrived but wasn't planned (a refund from HMRC, a bonus…) still counts.
  const unplannedIncome = Math.max(0, actualIncome - incomeReceived);
  const totalIncome = incomeExpected + unplannedIncome;
  // Money above your usual pay this month: payments bigger than expected, plus anything categorised as a bonus
  // that isn't already a planned item. (Other unplanned income, e.g. a salary month you don't track, isn't "extra".)
  const aboveUsual = income.filter((o) => o.status === 'paid' && o.paidAmount != null).reduce((s, o) => s + Math.max(0, o.paidAmount! - o.expected), 0);
  const bonusUnplanned = (db.prepare(
    `SELECT IFNULL(SUM(p.amount), 0) AS n FROM postings p JOIN transactions t ON t.id = p.transaction_id
     JOIN categories c ON c.id = p.category_id LEFT JOIN categories top ON top.id = IFNULL(c.parent_id, c.id)
     WHERE t.kind = 'income' AND t.period = ? AND top.name = 'Bonuses'
       AND NOT EXISTS (SELECT 1 FROM recurring_payments rp WHERE rp.transaction_id = t.id)`,
  ).get(month) as { n: number }).n;
  const incomeExtra = aboveUsual + Math.max(0, bonusUnplanned);

  const monthlyRows = (db.prepare(
    `SELECT r.type, r.amount - IFNULL((SELECT SUM(s.amount) FROM recurring_shares s WHERE s.recurring_id = r.id), 0) AS amount,
            r.frequency, ta.type AS transfer_type FROM recurring r LEFT JOIN accounts ta ON ta.id = r.transfer_account_id
     WHERE r.active = 1 AND NOT (r.frequency = 'annually' AND IFNULL(r.end_date, '') = r.start_date)`,
  ).all() as { type: RecurringType; amount: number; frequency: Frequency; transfer_type: string | null }[])
    .map((r) => ({ ...r, isDebt: r.type === 'saving' && !!r.transfer_type && isLiability(r.transfer_type) }));
  const monthly = { bills: 0, subscriptions: 0, savings: 0, debts: 0, income: 0 };
  for (const r of monthlyRows) {
    const key = r.type === 'bill' ? 'bills' : r.type === 'subscription' ? 'subscriptions' : r.type === 'saving' ? (r.isDebt ? 'debts' : 'savings') : 'income';
    monthly[key] += monthlyEquivalent(r.amount, r.frequency);
  }

  return {
    month,
    incomeExpected: totalIncome,
    incomeReceived: incomeReceived + unplannedIncome,
    incomeExtra,
    billsTotal,
    billsPaid,
    billsRemaining: billsTotal - billsPaid,
    savingsTotal,
    savingsDone,
    debtTotal,
    debtDone,
    committed: billsTotal + savingsTotal + debtTotal,
    committedShare: totalIncome > 0 ? (billsTotal + savingsTotal + debtTotal) / totalIncome : null,
    otherSpending,
    freeToSpend: totalIncome - billsTotal - savingsTotal - debtTotal - otherSpending,
    monthly,
  };
}

// ---------------------------------------------------------------------------
// Suggestions: spot regular payments in your history

export function suggestRecurring(db: DB) {
  const since = addDays(todayIso(), -200);
  const rows = db.prepare(
    `SELECT t.id, t.date, t.description, t.merchant, t.kind, p.account_id, p.category_id, p.amount
     FROM transactions t JOIN postings p ON p.transaction_id = t.id
     WHERE t.kind IN ('expense','income') AND t.date >= ? AND t.merchant != ''
     ORDER BY t.date`,
  ).all(since) as any[];
  const existing = db.prepare('SELECT * FROM recurring').all() as unknown as RecurringRow[];
  const groups = new Map<string, any[]>();
  for (const r of rows) {
    const key = `${r.account_id}|${r.kind}|${r.merchant}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
  const out = [];
  for (const list of groups.values()) {
    if (list.length < 3) continue;
    const months = new Set(list.map((r) => monthOf(r.date)));
    const gaps = list.slice(1).map((r, i) => daysBetween(list[i].date, r.date)).sort((a, b) => a - b);
    const gap = gaps[Math.floor(gaps.length / 2)];
    let frequency: Frequency | null = null;
    if (gap >= 26 && gap <= 35 && months.size >= 3) frequency = 'monthly';
    else if (gap >= 6 && gap <= 8 && list.length >= 4) frequency = 'weekly';
    else if (gap >= 13 && gap <= 15 && list.length >= 4) frequency = 'fortnightly';
    if (!frequency) continue;
    // Regular payments have stable amounts; groceries don't.
    const amounts = list.map((r) => Math.abs(r.amount));
    const lastAmount = amounts[amounts.length - 1];
    const spread = (Math.max(...amounts) - Math.min(...amounts)) / Math.max(1, lastAmount);
    const variable = spread > 0.25;
    if (variable && frequency !== 'monthly') continue;
    if (variable && list.length > months.size + 1) continue; // several per month at varying amounts = everyday spending
    const lastRow = list[list.length - 1];
    if (existing.some((e) => e.account_id === lastRow.account_id && matchesPattern(e, lastRow))) continue;
    const accType = (db.prepare('SELECT type FROM accounts WHERE id = ?').get(lastRow.account_id) as { type: string }).type;
    const cat = lastRow.category_id ? (db.prepare('SELECT name, is_fixed FROM categories WHERE id = ?').get(lastRow.category_id) as any) : null;
    out.push({
      name: titleCase(lastRow.merchant),
      matchPattern: lastRow.merchant.toLowerCase(),
      type: (lastRow.kind === 'income' ? 'income' : cat?.name === 'Subscriptions' ? 'subscription' : 'bill') as RecurringType,
      amount: lastAmount,
      variable,
      frequency,
      // Start from the first payment seen so its history is matched straight away.
      startDate: list[0].date,
      accountId: lastRow.account_id,
      accountIsCard: isLiability(accType),
      categoryId: lastRow.category_id,
      categoryName: cat?.name ?? null,
      count: list.length,
      lastDate: lastRow.date,
    });
  }
  return out.sort((a, b) => b.amount - a.amount);
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\bLtd\b/, 'Ltd').trim();
}
