/**
 * Shared bills and subscriptions: people who pay you back for their part
 * (a family streaming plan, a shared phone contract…).
 *
 * - Each person has an amount they pay you per cycle and the text their
 *   payment shows on your statement (defaults to their name, in any word order).
 * - Their payments are refunds against the subscription's category, so your
 *   spending shows only your share.
 * - For each due date we look for their payment around it: from halfway
 *   since the previous due date up to halfway to the next.
 */
import { type DB, tx } from './db.ts';
import { ValidationError, assertPence } from './money.ts';
import { addDays, daysBetween, todayIso } from './dates.ts';
import { dueDates, type RecurringRow } from './recurring.ts';

export interface ShareRow { id: number; recurring_id: number; name: string; match_pattern: string | null; amount: number; account_id: number | null; sort_order: number }
export interface ShareInput { name: string; matchPattern?: string | null; amount: number; accountId?: number | null }

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** Every word of the pattern appears in the description, in any order ("Sam Patel" matches "PATEL SAM"). */
export function shareMatches(pattern: string, description: string): boolean {
  const want = words(pattern);
  if (!want.length) return false;
  const have = new Set(words(description));
  return want.every((w) => have.has(w));
}

export function listShares(db: DB, recurringId: number): ShareRow[] {
  return db.prepare('SELECT * FROM recurring_shares WHERE recurring_id = ? ORDER BY sort_order, id').all(recurringId) as unknown as ShareRow[];
}

/** Incoming money (not transfers) that could be someone paying you back. */
function incoming(db: DB, from: string, to: string) {
  return db.prepare(
    `SELECT t.id, t.date, t.description, p.id AS posting_id, p.amount, p.account_id, p.category_id
     FROM transactions t JOIN postings p ON p.transaction_id = t.id
     WHERE t.kind != 'transfer' AND p.amount > 0 AND t.date BETWEEN ? AND ? ORDER BY t.date`,
  ).all(from, to) as { id: number; date: string; description: string; posting_id: number; amount: number; account_id: number; category_id: number | null }[];
}

const isTheirs = (s: ShareRow, t: { description: string; account_id: number }) =>
  (s.account_id == null || s.account_id === t.account_id) && shareMatches(s.match_pattern || s.name, t.description);

/**
 * Replace the people sharing a bill. With applyToPast, their earlier payments
 * are recategorised to the bill's category (as refunds), so past months show
 * your share too.
 */
export function saveShares(db: DB, recurringId: number, input: ShareInput[], opts: { applyToPast?: boolean } = {}) {
  const r = db.prepare('SELECT * FROM recurring WHERE id = ?').get(recurringId) as RecurringRow | undefined;
  if (!r) throw new ValidationError('Not found');
  if (!Array.isArray(input)) throw new ValidationError('Invalid list');
  if (input.length && r.type !== 'bill' && r.type !== 'subscription') throw new ValidationError('Only bills and subscriptions can be shared');
  const clean = input.map((s, i) => {
    if (typeof s?.name !== 'string' || !s.name.trim()) throw new ValidationError('Each person needs a name');
    const amount = assertPence(s.amount, 'Amount');
    if (amount <= 0) throw new ValidationError(`Enter how much ${s.name.trim()} pays you`);
    if (s.accountId != null && !db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(s.accountId)) throw new ValidationError('Account not found');
    return { name: s.name.trim(), match_pattern: s.matchPattern?.trim() || null, amount, account_id: s.accountId ?? null, sort_order: i };
  });
  const total = clean.reduce((n, s) => n + s.amount, 0);
  if (total > r.amount) throw new ValidationError('Other people pay back more than the bill costs. Check the amounts.');

  return tx(db, () => {
    db.prepare('DELETE FROM recurring_shares WHERE recurring_id = ?').run(recurringId);
    const ins = db.prepare('INSERT INTO recurring_shares (recurring_id, name, match_pattern, amount, account_id, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
    for (const s of clean) ins.run(recurringId, s.name, s.match_pattern, s.amount, s.account_id, s.sort_order);
    let recategorised = 0;
    if (opts.applyToPast && r.category_id && clean.length) {
      const shares = listShares(db, recurringId);
      const upd = db.prepare('UPDATE postings SET category_id = ? WHERE id = ?');
      const kind = db.prepare("UPDATE transactions SET kind = 'expense' WHERE id = ? AND kind = 'income'");
      for (const t of incoming(db, '0000-01-01', '9999-12-31')) {
        if (t.category_id === r.category_id || !shares.some((s) => isTheirs(s, t))) continue;
        upd.run(r.category_id, t.posting_id);
        kind.run(t.id);
        recategorised++;
      }
    }
    return { recategorised };
  });
}

/** The category to give a newly imported payment if it's someone paying you back. */
export function shareCategoryFor(db: DB, accountId: number, description: string, amount: number): number | null {
  if (amount <= 0) return null;
  const rows = db.prepare(
    `SELECT s.*, r.category_id AS cat FROM recurring_shares s JOIN recurring r ON r.id = s.recurring_id
     WHERE r.active = 1 AND r.category_id IS NOT NULL ORDER BY s.id`,
  ).all() as unknown as (ShareRow & { cat: number })[];
  const hit = rows.find((s) => isTheirs(s, { description, account_id: accountId }));
  return hit ? hit.cat : null;
}

export interface ShareCycle {
  dueDate: string;
  people: { shareId: number; name: string; expected: number; paid: number; paidDate: string | null }[];
  paidCount: number;
  received: number;
}

/** Who paid you back for each of the last few due dates (newest first). */
export function shareCycles(db: DB, r: RecurringRow, count = 6, today = todayIso()): ShareCycle[] {
  const shares = listShares(db, r.id);
  if (!shares.length) return [];
  // Due dates up to a little ahead (people sometimes pay before the bill).
  const dues = dueDates(r, addDays(today, -400), addDays(today, 16)).slice(-count).reverse();
  if (!dues.length) return [];
  const windowOf = (due: string) => {
    const next = dueDates(r, addDays(due, 1), addDays(due, 400))[0];
    const prev = dueDates(r, addDays(due, -400), addDays(due, -1)).pop();
    const before = Math.floor(daysBetween(prev ?? addDays(due, -30), due) / 2);
    const after = Math.ceil(daysBetween(due, next ?? addDays(due, 30)) / 2);
    return { from: addDays(due, -before), to: addDays(due, after - 1) };
  };
  const span = { from: windowOf(dues[dues.length - 1]).from, to: windowOf(dues[0]).to };
  const money = incoming(db, span.from, span.to);
  return dues.map((due) => {
    const w = windowOf(due);
    const people = shares.map((s) => {
      const theirs = money.filter((t) => t.date >= w.from && t.date <= w.to && isTheirs(s, t));
      return { shareId: s.id, name: s.name, expected: s.amount, paid: theirs.reduce((n, t) => n + t.amount, 0), paidDate: theirs.length ? theirs[theirs.length - 1].date : null };
    });
    return { dueDate: due, people, paidCount: people.filter((p) => p.paid > 0).length, received: people.reduce((n, p) => n + p.paid, 0) };
  });
}
