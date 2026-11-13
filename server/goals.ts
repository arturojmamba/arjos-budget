/**
 * Goals: what your savings are for.
 *
 * A goal lives in one account (a savings account, a pot, an ISA). An account
 * can hold several goals:
 *   - "share" goals have money set aside for them (goal_moves). Setting money
 *     aside doesn't move real money; it earmarks part of the balance.
 *   - at most one "rest" goal per account gets whatever is left after the
 *     shares. A single goal on an account is usually a "rest" goal, so it simply
 *     follows the account's balance (or market value, for investments).
 *
 * Money added in a month: for a rest goal, transfers into the account (minus
 * withdrawals) less what was set aside for shares; for a share goal, what was
 * set aside. Market growth and interest never count as money added.
 */
import { type DB, tx } from './db.ts';
import { ValidationError, assertPence } from './money.ts';
import { addMonths, daysInMonth, isIsoDate, monthOf, todayIso } from './dates.ts';
import { isLiability } from './ledger.ts';
import { listAccounts, type AccountView } from './queries.ts';
import { takeHome } from './budgets.ts';

export type GoalMode = 'rest' | 'share';

interface GoalRow {
  id: number; name: string; icon: string | null; colour: string; account_id: number; mode: GoalMode;
  target: number | null; deadline: string | null; monthly_target: number | null; monthly_percent: number | null;
  is_emergency: number; notes: string | null; sort_order: number; archived: number; completed_at: string | null;
}

export interface GoalInput {
  name: string;
  icon?: string | null;
  colour?: string;
  accountId: number;
  mode?: GoalMode;
  target?: number | null;
  deadline?: string | null;
  monthlyTarget?: number | null;
  /** Basis points of take-home pay a month (1000 = 10%). */
  monthlyPercent?: number | null;
  isEmergency?: boolean;
  notes?: string | null;
  /** For a new "share" goal: money to set aside straight away. */
  startWith?: number | null;
}

const GOAL_COLOURS = ['#0ea5e9', '#16a34a', '#8b5cf6', '#f97316', '#ec4899', '#14b8a6', '#eab308', '#6366f1'];

const monthEnd = (m: string) => `${m}-${String(daysInMonth(m)).padStart(2, '0')}`;

/** Net money moved into an account per month (transfers only), keyed by month. */
function transfersIn(db: DB, accountId: number, from: string, to: string): Map<string, number> {
  const rows = db.prepare(
    `SELECT t.period AS m, SUM(p.amount) AS n FROM postings p JOIN transactions t ON t.id = p.transaction_id
     WHERE p.account_id = ? AND t.kind = 'transfer' AND t.period BETWEEN ? AND ? GROUP BY t.period`,
  ).all(accountId, from, to) as { m: string; n: number }[];
  return new Map(rows.map((r) => [r.m, r.n]));
}

/** Money set aside per goal per month, keyed `${goalId}:${month}`, plus all-time totals up to a date. */
function movesByMonth(db: DB, goalIds: number[], from: string, to: string) {
  const out = new Map<string, number>();
  if (!goalIds.length) return out;
  const rows = db.prepare(
    `SELECT goal_id AS g, substr(date, 1, 7) AS m, SUM(amount) AS n FROM goal_moves
     WHERE goal_id IN (${goalIds.map(() => '?').join(',')}) AND opening = 0 AND substr(date, 1, 7) BETWEEN ? AND ? GROUP BY g, m`,
  ).all(...goalIds, from, to) as { g: number; m: string; n: number }[];
  for (const r of rows) out.set(`${r.g}:${r.m}`, r.n);
  return out;
}

function setAsideBy(db: DB, goalId: number, date: string): number {
  return (db.prepare('SELECT IFNULL(SUM(amount), 0) AS n FROM goal_moves WHERE goal_id = ? AND date <= ?').get(goalId, date) as { n: number }).n;
}

/** Essential spending a month (fixed costs, groceries, transport), averaged over the last 3 full months. */
export function essentialsPerMonth(db: DB, today = todayIso()): number {
  const months = [1, 2, 3].map((n) => addMonths(monthOf(today), -n));
  const r = db.prepare(
    `SELECT t.period AS m, SUM(-p.amount) AS n FROM postings p JOIN transactions t ON t.id = p.transaction_id
     JOIN categories c ON c.id = p.category_id JOIN categories top ON top.id = IFNULL(c.parent_id, c.id)
     WHERE t.kind = 'expense' AND t.period IN (?, ?, ?) AND (top.is_fixed = 1 OR top.name IN ('Groceries', 'Transport'))
     GROUP BY t.period`,
  ).all(...months) as { m: string; n: number }[];
  const withData = r.filter((x) => x.n > 0);
  return withData.length ? Math.round(withData.reduce((s, x) => s + x.n, 0) / withData.length) : 0;
}

function monthsBetween(fromMonth: string, toMonth: string): number {
  const [y1, m1] = fromMonth.split('-').map(Number);
  const [y2, m2] = toMonth.split('-').map(Number);
  return (y2 - y1) * 12 + (m2 - m1);
}

export function listGoals(db: DB, today = todayIso(), opts: { includeArchived?: boolean } = {}) {
  const thisMonth = monthOf(today);
  const rows = db.prepare(`SELECT * FROM goals ${opts.includeArchived ? '' : 'WHERE archived = 0'} ORDER BY sort_order, id`).all() as unknown as GoalRow[];
  const accounts = listAccounts(db, { includeArchived: true });
  const accById = new Map(accounts.map((a) => [a.id, a]));
  const pay = takeHome(db, today).amount;
  const essentials = essentialsPerMonth(db, today);

  const histMonths = Array.from({ length: 12 }, (_, i) => addMonths(thisMonth, i - 11));
  const moves = movesByMonth(db, rows.map((r) => r.id), histMonths[0], thisMonth);
  // Month-end balances for the accounts goals use (one lookup per month).
  const usedAccounts = new Set(rows.map((r) => r.account_id));
  const balanceAt = new Map<string, number>();
  for (const m of histMonths) {
    const asOf = m === thisMonth ? today : monthEnd(m);
    for (const a of listAccounts(db, { asOf, includeArchived: true })) if (usedAccounts.has(a.id)) balanceAt.set(`${a.id}:${m}`, a.balance);
  }

  const active = rows.filter((r) => !r.archived);
  const views = rows.map((g) => {
    const acc = accById.get(g.account_id);
    const balance = acc?.balance ?? 0;
    const siblings = active.filter((o) => o.account_id === g.account_id && o.mode === 'share' && o.id !== g.id);
    const flows = transfersIn(db, g.account_id, histMonths[0], thisMonth);

    // Saved (now and at each month end) and money added each month.
    const sharesAt = (m: string) => siblings.reduce((s, o) => s + setAsideBy(db, o.id, monthEnd(m)), 0);
    const history = histMonths.map((m) => {
      const end = m === thisMonth ? today : monthEnd(m);
      if (g.mode === 'share') return { month: m, saved: setAsideBy(db, g.id, end), added: moves.get(`${g.id}:${m}`) ?? 0 };
      const sharesAdded = siblings.reduce((s, o) => s + (moves.get(`${o.id}:${m}`) ?? 0), 0);
      return { month: m, saved: Math.max(0, (balanceAt.get(`${g.account_id}:${m}`) ?? 0) - sharesAt(m)), added: (flows.get(m) ?? 0) - sharesAdded };
    });
    const saved = history[history.length - 1].saved;
    const thisMonthAdded = history[history.length - 1].added;
    const full = history.slice(-4, -1);
    const avg3 = Math.round(full.reduce((s, h) => s + h.added, 0) / Math.max(1, full.length));

    const monthlyTarget = g.monthly_percent != null && pay ? Math.round((pay * g.monthly_percent) / 10000) : g.monthly_target;
    const remaining = g.target != null ? Math.max(0, g.target - saved) : null;
    const done = g.target != null && saved >= g.target;
    const monthsLeft = g.deadline ? Math.max(1, monthsBetween(thisMonth, monthOf(g.deadline)) + 1) : null;
    const neededPerMonth = remaining != null && monthsLeft ? Math.ceil(remaining / monthsLeft) : null;
    // Pace uses the monthly target if you've set one, otherwise what you've actually been adding.
    const rate = Math.max(avg3, 0) || monthlyTarget || 0;
    const eta = remaining != null && remaining > 0 && rate > 0 ? addMonths(thisMonth, Math.ceil(remaining / rate)) : done ? thisMonth : null;
    let status: 'done' | 'on_track' | 'behind' | 'no_target' = 'no_target';
    if (g.target != null) {
      status = done ? 'done' : g.deadline && neededPerMonth != null ? (rate >= neededPerMonth * 0.95 ? 'on_track' : 'behind') : 'on_track';
    }
    if (done && !g.completed_at) db.prepare("UPDATE goals SET completed_at = date('now') WHERE id = ?").run(g.id);
    if (!done && g.completed_at) db.prepare('UPDATE goals SET completed_at = NULL WHERE id = ?').run(g.id);

    // Investments followed in full: split into what you paid in and growth.
    const isInvestment = acc?.type === 'investment';
    const soleGoal = g.mode === 'rest' && siblings.length === 0;
    const growth = isInvestment && soleGoal && acc?.growth != null ? acc.growth : null;

    return {
      id: g.id, name: g.name, icon: g.icon, colour: g.colour, mode: g.mode, archived: !!g.archived, notes: g.notes,
      account: acc ? { id: acc.id, name: acc.name, type: acc.type, colour: acc.colour } : null,
      target: g.target, deadline: g.deadline, monthlyTarget, monthlyPercent: g.monthly_percent, monthlyFixed: g.monthly_target,
      isEmergency: !!g.is_emergency, completedAt: done ? g.completed_at ?? today : null,
      saved, balance, progress: g.target ? Math.min(1, Math.max(0, saved) / g.target) : null,
      thisMonth: thisMonthAdded, avg3, remaining, monthsLeft, neededPerMonth, eta, status,
      contributed: growth != null ? acc!.contributed : null, growth,
      coverMonths: g.is_emergency && essentials > 0 ? saved / essentials : null,
      history,
    };
  });

  // Each account that holds goals: how its balance is shared out.
  const accountsWithGoals = [...new Set(active.map((r) => r.account_id))].map((id) => {
    const a = accById.get(id)!;
    const shares = views.filter((v) => !v.archived && v.account?.id === id && v.mode === 'share').reduce((s, v) => s + v.saved, 0);
    const hasRest = active.some((r) => r.account_id === id && r.mode === 'rest');
    return {
      id, name: a.name, type: a.type, colour: a.colour, balance: a.balance, setAside: shares,
      unassigned: hasRest ? 0 : a.balance - shares, overAssigned: Math.max(0, shares - a.balance), hasRest,
    };
  });

  // Savings, pots and investment accounts with no goal yet.
  const free = accounts.filter((a) => !a.archived && ['savings', 'pot', 'investment'].includes(a.type) && !usedAccounts.has(a.id))
    .map((a) => ({ id: a.id, name: a.name, type: a.type, colour: a.colour, balance: a.balance }));

  const live = views.filter((v) => !v.archived);
  return {
    goals: views,
    accounts: accountsWithGoals,
    withoutGoals: free,
    essentials,
    takeHome: pay,
    totals: {
      saved: live.reduce((s, v) => s + Math.max(0, v.saved), 0),
      target: live.reduce((s, v) => s + (v.target ?? 0), 0),
      thisMonth: live.reduce((s, v) => s + v.thisMonth, 0),
      monthlyTarget: live.reduce((s, v) => s + (v.monthlyTarget ?? 0), 0),
      done: live.filter((v) => v.status === 'done').length,
      count: live.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Changes

function validate(db: DB, i: GoalInput) {
  if (typeof i.name !== 'string' || !i.name.trim()) throw new ValidationError('Give the goal a name');
  const a = db.prepare('SELECT type FROM accounts WHERE id = ?').get(i.accountId ?? -1) as { type: string } | undefined;
  if (!a) throw new ValidationError('Choose the account the money is in');
  if (isLiability(a.type)) throw new ValidationError("Goals are for money you've saved. Debts are on the Debts page.");
  if (i.mode && !['rest', 'share'].includes(i.mode)) throw new ValidationError('Unknown goal type');
  if (i.target != null && !(assertPence(i.target, 'Target') > 0)) throw new ValidationError('The target must be more than £0');
  if (i.deadline != null && i.deadline !== '' && !isIsoDate(i.deadline)) throw new ValidationError('The date is invalid');
  if (i.monthlyTarget != null && !(assertPence(i.monthlyTarget, 'Monthly amount') > 0)) throw new ValidationError('The monthly amount must be more than £0');
  if (i.monthlyPercent != null && (!Number.isInteger(i.monthlyPercent) || i.monthlyPercent <= 0 || i.monthlyPercent > 10000)) throw new ValidationError('Percentage must be between 0.01% and 100%');
  if (i.colour && !/^#[0-9a-fA-F]{6}$/.test(i.colour)) throw new ValidationError('Colour must be a hex value');
  if (i.icon != null && (typeof i.icon !== 'string' || [...i.icon].length > 8)) throw new ValidationError('Choose an emoji');
}

/** What's free in an account to set aside: the balance less what's already set aside for other goals. */
function freeIn(db: DB, accountId: number, exceptGoal?: number): number {
  const a = listAccounts(db, { includeArchived: true }).find((x) => x.id === accountId);
  const shares = (db.prepare(
    `SELECT IFNULL(SUM(m.amount), 0) AS n FROM goal_moves m JOIN goals g ON g.id = m.goal_id
     WHERE g.account_id = ? AND g.mode = 'share' AND g.archived = 0 AND g.id != ?`,
  ).get(accountId, exceptGoal ?? -1) as { n: number }).n;
  return (a?.balance ?? 0) - shares;
}

export function createGoal(db: DB, i: GoalInput, today = todayIso()): number {
  validate(db, i);
  return tx(db, () => {
    const hasRest = !!db.prepare("SELECT 1 FROM goals WHERE account_id = ? AND mode = 'rest' AND archived = 0").get(i.accountId);
    // First goal on an account follows the whole balance unless you say otherwise.
    const mode: GoalMode = i.mode ?? (hasRest ? 'share' : 'rest');
    if (mode === 'rest' && hasRest) throw new ValidationError('Another goal already uses what is left in this account. Set money aside for this one instead.');
    const order = (db.prepare('SELECT IFNULL(MAX(sort_order), -1) + 1 AS n FROM goals').get() as { n: number }).n;
    const colour = i.colour ?? GOAL_COLOURS[order % GOAL_COLOURS.length];
    const id = Number(db.prepare(
      `INSERT INTO goals (name, icon, colour, account_id, mode, target, deadline, monthly_target, monthly_percent, is_emergency, notes, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(i.name.trim(), i.icon ?? '🎯', colour, i.accountId, mode, i.target ?? null, i.deadline || null,
      i.monthlyPercent != null ? null : i.monthlyTarget ?? null, i.monthlyPercent ?? null, i.isEmergency ? 1 : 0, i.notes?.trim() || null, order).lastInsertRowid);
    if (mode === 'share' && i.startWith) moveMoney(db, id, { amount: i.startWith, date: today, note: 'Starting amount', opening: true });
    return id;
  });
}

export function updateGoal(db: DB, id: number, i: GoalInput) {
  const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(id) as GoalRow | undefined;
  if (!g) throw new ValidationError('Goal not found');
  validate(db, i);
  tx(db, () => {
    let mode = i.mode ?? g.mode;
    if (i.accountId !== g.account_id && g.mode === 'share') {
      // Money set aside belongs to the old account.
      db.prepare('DELETE FROM goal_moves WHERE goal_id = ?').run(id);
    }
    if (mode === 'rest' && db.prepare("SELECT 1 FROM goals WHERE account_id = ? AND mode = 'rest' AND archived = 0 AND id != ?").get(i.accountId, id)) {
      throw new ValidationError('Another goal already uses what is left in this account.');
    }
    if (mode === 'share' && g.mode === 'rest' && i.accountId === g.account_id) {
      // Switching to "set aside": start with what it had.
      const had = freeIn(db, g.account_id, id);
      if (had > 0) db.prepare('INSERT INTO goal_moves (goal_id, date, amount, note, opening) VALUES (?, ?, ?, ?, 1)').run(id, todayIso(), had, 'Already in the account');
    }
    if (mode === 'rest') db.prepare('DELETE FROM goal_moves WHERE goal_id = ?').run(id);
    db.prepare(
      `UPDATE goals SET name = ?, icon = ?, colour = ?, account_id = ?, mode = ?, target = ?, deadline = ?, monthly_target = ?, monthly_percent = ?,
         is_emergency = ?, notes = ? WHERE id = ?`,
    ).run(i.name.trim(), i.icon !== undefined ? i.icon : g.icon, i.colour ?? g.colour, i.accountId, mode, i.target ?? null, i.deadline || null,
      i.monthlyPercent != null ? null : i.monthlyTarget ?? null, i.monthlyPercent ?? null, i.isEmergency ? 1 : 0, i.notes?.trim() || null, id);
  });
}

export function archiveGoal(db: DB, id: number, archived: boolean) {
  const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(id) as GoalRow | undefined;
  if (!g) throw new ValidationError('Goal not found');
  if (!archived && g.mode === 'rest' && db.prepare("SELECT 1 FROM goals WHERE account_id = ? AND mode = 'rest' AND archived = 0 AND id != ?").get(g.account_id, id)) {
    throw new ValidationError('Another goal now uses the rest of this account. Change that one first.');
  }
  db.prepare('UPDATE goals SET archived = ? WHERE id = ?').run(archived ? 1 : 0, id);
}

/** Delete a goal. Money set aside for it goes back to the rest of the account; no real money moves. */
export function deleteGoal(db: DB, id: number) {
  db.prepare('DELETE FROM goals WHERE id = ?').run(id);
}

export function reorderGoals(db: DB, ids: number[]) {
  if (!Array.isArray(ids)) throw new ValidationError('Send a list of goal ids');
  tx(db, () => ids.forEach((id, i) => db.prepare('UPDATE goals SET sort_order = ? WHERE id = ?').run(i, id)));
}

/**
 * Set money aside for a "share" goal (positive) or release it (negative). With `fromGoalId`,
 * it moves between two share goals in the same account.
 */
export function moveMoney(db: DB, goalId: number, m: { amount: number; date?: string; note?: string | null; fromGoalId?: number | null; opening?: boolean }) {
  const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(goalId) as GoalRow | undefined;
  if (!g) throw new ValidationError('Goal not found');
  if (g.mode !== 'share') throw new ValidationError('This goal follows the rest of the account. Its amount changes when money goes in or out of the account.');
  const amount = assertPence(m.amount, 'Amount');
  if (amount === 0) throw new ValidationError('Enter an amount');
  const date = m.date ?? todayIso();
  if (!isIsoDate(date)) throw new ValidationError('The date is invalid');
  tx(db, () => {
    if (m.fromGoalId) {
      const from = db.prepare('SELECT * FROM goals WHERE id = ?').get(m.fromGoalId) as GoalRow | undefined;
      if (!from || from.mode !== 'share' || from.account_id !== g.account_id) throw new ValidationError('You can only move money between goals in the same account');
      if (amount > setAsideBy(db, from.id, '9999-12-31')) throw new ValidationError(`${from.name} doesn't have that much set aside`);
      db.prepare('INSERT INTO goal_moves (goal_id, date, amount, note) VALUES (?, ?, ?, ?)').run(from.id, date, -amount, `To ${g.name}`);
      db.prepare('INSERT INTO goal_moves (goal_id, date, amount, note) VALUES (?, ?, ?, ?)').run(g.id, date, amount, `From ${from.name}`);
      return;
    }
    if (amount > 0) {
      const free = freeIn(db, g.account_id, g.id) - setAsideBy(db, g.id, '9999-12-31');
      if (amount > free) throw new ValidationError(`Only ${(Math.max(0, free) / 100).toLocaleString('en-GB', { style: 'currency', currency: 'GBP' })} in the account isn't set aside yet`);
    } else if (-amount > setAsideBy(db, g.id, '9999-12-31')) {
      throw new ValidationError("That's more than is set aside for this goal");
    }
    db.prepare('INSERT INTO goal_moves (goal_id, date, amount, note, opening) VALUES (?, ?, ?, ?, ?)').run(g.id, date, amount, m.note?.trim() || null, m.opening ? 1 : 0);
  });
}

export function goalMoves(db: DB, goalId: number) {
  return (db.prepare('SELECT id, date, amount, note FROM goal_moves WHERE goal_id = ? ORDER BY date DESC, id DESC LIMIT 50').all(goalId) as any[])
    .map((r) => ({ id: r.id, date: r.date, amount: r.amount, note: r.note }));
}

export type { AccountView };
