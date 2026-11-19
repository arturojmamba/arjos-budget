/**
 * Saved "Can I afford it?" simulations. A simulation is only its inputs (the purchase, the ways to pay
 * and any figures you changed): saving, editing or deleting one never touches your accounts. Only
 * confirming a purchase (confirmPurchase, below) creates real records, and it remembers what it made.
 */
import type { DB } from './db.ts';
import { tx } from './db.ts';
import { isIsoDate, todayIso } from './dates.ts';
import { ValidationError, assertPence } from './money.ts';
import { loadContext, simulate, buildOption, type OptionInput, type Overrides, type Priority, type Purchase, type SimInput, type ScheduleRow } from './afford.ts';
import { createRecurring, autoMatch } from './recurring.ts';
import { createAccount } from './admin.ts';
import { upsertDebt, type DebtType } from './debts.ts';
import { createGoal } from './goals.ts';
import { createTransaction, simpleToPostings } from './ledger.ts';
import { addDays } from './dates.ts';

export type PlanStatus = 'planned' | 'bought' | 'dropped';

interface PlanRow {
  id: number; name: string; price: number; purchase_date: string; category_id: number | null; description: string | null;
  priority: Priority; status: PlanStatus; inputs: string; chosen_option: string | null; bought_at: string | null;
  debt_account_id: number | null; goal_id: number | null; recurring_id: number | null; created_ids: string | null; schedule: string | null;
  created_at: string; updated_at: string;
}

export interface PlanInput { purchase: Purchase; options: OptionInput[]; overrides?: Overrides; chosen?: string | null }

const PRIORITIES: Priority[] = ['essential', 'important', 'non_essential'];
const KINDS = ['outright', 'bnpl', 'instalments', 'finance', 'card', 'save'];

/** Check what came from the page before simulating or saving it. */
export function validateInput(i: any): SimInput & { chosen: string | null } {
  const p = i?.purchase ?? {};
  if (typeof p.name !== 'string' || !p.name.trim()) throw new ValidationError('Give the purchase a name');
  const price = assertPence(p.price, 'Price');
  if (price <= 0) throw new ValidationError('Price must be more than £0');
  if (!isIsoDate(p.date)) throw new ValidationError('Choose a purchase date');
  const priority = p.priority ?? 'important';
  if (!PRIORITIES.includes(priority)) throw new ValidationError('Unknown priority');
  const options = Array.isArray(i.options) ? i.options : [];
  if (!options.length) throw new ValidationError('Add at least one way to pay');
  if (options.length > 8) throw new ValidationError('Compare up to 8 ways to pay at once');
  const ids = new Set<string>();
  for (const o of options) {
    if (typeof o?.id !== 'string' || !o.id || ids.has(o.id)) throw new ValidationError('Each way to pay needs its own id');
    ids.add(o.id);
    if (!KINDS.includes(o.kind)) throw new ValidationError('Unknown way to pay');
    for (const k of ['deposit', 'upfrontFee', 'paymentFee', 'balloon', 'cardMonthly', 'saveMonthly'] as const) if (o[k] != null) { assertPence(o[k], k); if (o[k] < 0) throw new ValidationError('Amounts can’t be negative'); }
    if (o.apr != null && (!Number.isInteger(o.apr) || o.apr < 0 || o.apr > 20000)) throw new ValidationError('APR must be between 0% and 200%');
    if (o.purchaseApr != null && (!Number.isInteger(o.purchaseApr) || o.purchaseApr < 0 || o.purchaseApr > 20000)) throw new ValidationError('APR must be between 0% and 200%');
    if (o.payments != null && (!Number.isInteger(o.payments) || o.payments < 1 || o.payments > 120)) throw new ValidationError('Number of payments must be between 1 and 120');
    for (const k of ['firstPayment', 'saveStart', 'purchasePromoEnd'] as const) if (o[k] != null && !isIsoDate(o[k])) throw new ValidationError('Check the dates');
  }
  const ov = i.overrides ?? {};
  for (const k of ['pay', 'everyday', 'saving', 'floorAmount'] as const) if (ov[k] != null) assertPence(ov[k], k);
  if (ov.floorPercent != null && (!Number.isInteger(ov.floorPercent) || ov.floorPercent < 0 || ov.floorPercent > 10000)) throw new ValidationError('The minimum must be between 0% and 100%');
  const chosen = typeof i.chosen === 'string' && ids.has(i.chosen) ? i.chosen : null;
  return {
    purchase: { name: p.name.trim().slice(0, 120), price, date: p.date, categoryId: p.categoryId ?? null, description: p.description ? String(p.description).slice(0, 500) : null, priority },
    options, overrides: ov, chosen,
  };
}

function view(r: PlanRow) {
  const inputs = JSON.parse(r.inputs) as PlanInput;
  return {
    id: r.id, name: r.name, price: r.price, purchaseDate: r.purchase_date, categoryId: r.category_id, description: r.description,
    priority: r.priority, status: r.status, chosen: r.chosen_option, boughtAt: r.bought_at,
    debtAccountId: r.debt_account_id, goalId: r.goal_id, recurringId: r.recurring_id,
    created: r.created_ids ? JSON.parse(r.created_ids) : null,
    inputs, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function getPlan(db: DB, id: number) {
  const r = db.prepare('SELECT * FROM purchase_plans WHERE id = ?').get(id) as PlanRow | undefined;
  if (!r) throw new ValidationError('That simulation no longer exists');
  return view(r);
}

/** Every saved simulation, with its chosen way to pay worked out against today's figures (for comparing). */
export function listPlans(db: DB, today = todayIso()) {
  const rows = db.prepare('SELECT * FROM purchase_plans ORDER BY status = \'planned\' DESC, purchase_date, id').all() as unknown as PlanRow[];
  const ctx = rows.some((r) => r.status === 'planned') ? loadContext(db, today) : null;
  return rows.map((r) => {
    const v = view(r);
    let summary = null;
    if (ctx && r.status === 'planned') {
      try {
        const opt = v.inputs.options.find((o) => o.id === v.chosen) ?? v.inputs.options[0];
        const res = simulate(ctx, { purchase: v.inputs.purchase, options: [opt], overrides: v.inputs.overrides });
        const o = res.options[0];
        summary = {
          option: o.label, classification: o.classificationLabel, level: o.assessment.level, title: o.assessment.title,
          upfront: o.upfront, regularPayment: o.regularPayment, frequency: o.frequency, totalPayable: o.totalPayable,
          lowest: o.forecast.lowest, minFreeToSpend: o.minFreeToSpend,
        };
      } catch { /* inputs that no longer work (e.g. a deleted card) show without a summary */ }
    }
    return { ...v, summary };
  });
}

export function createPlan(db: DB, body: unknown): number {
  const i = validateInput(body);
  const r = db.prepare(
    `INSERT INTO purchase_plans (name, price, purchase_date, category_id, description, priority, inputs, chosen_option)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(i.purchase.name, i.purchase.price, i.purchase.date, i.purchase.categoryId ?? null, i.purchase.description ?? null, i.purchase.priority ?? 'important',
    JSON.stringify({ purchase: i.purchase, options: i.options, overrides: i.overrides, chosen: i.chosen }), i.chosen);
  return Number(r.lastInsertRowid);
}

export function updatePlan(db: DB, id: number, body: unknown) {
  const existing = getPlan(db, id);
  if (existing.status === 'bought') throw new ValidationError('This purchase is already bought; its simulation is kept as it was.');
  const i = validateInput(body);
  db.prepare(
    `UPDATE purchase_plans SET name = ?, price = ?, purchase_date = ?, category_id = ?, description = ?, priority = ?, inputs = ?, chosen_option = ?,
       updated_at = datetime('now') WHERE id = ?`,
  ).run(i.purchase.name, i.purchase.price, i.purchase.date, i.purchase.categoryId ?? null, i.purchase.description ?? null, i.purchase.priority ?? 'important',
    JSON.stringify({ purchase: i.purchase, options: i.options, overrides: i.overrides, chosen: i.chosen }), i.chosen, id);
}

/** Planned or dropped (bought is set by confirming). */
export function setPlanStatus(db: DB, id: number, status: PlanStatus) {
  const p = getPlan(db, id);
  if (status === 'bought') throw new ValidationError('Use “I’ve bought it” to confirm a purchase');
  if (p.status === 'bought') throw new ValidationError('This purchase is already bought');
  db.prepare("UPDATE purchase_plans SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id);
}

/** Deleting a simulation never deletes what a confirmed purchase created (its debt, goal or bills stay). */
export function deletePlan(db: DB, id: number) {
  getPlan(db, id);
  tx(db, () => { db.prepare('DELETE FROM purchase_plans WHERE id = ?').run(id); });
}

// ---------------------------------------------------------------------------
// Confirming a purchase: the only step that creates real records.

export interface ConfirmInput {
  optionId: string;
  /** The day you bought it (defaults to the planned date, never later than today for financed purchases). */
  boughtOn?: string | null;
  /** Where payments come from (outright, deposits, repayments, extra card payments). */
  fromAccountId?: number | null;
  /** Save first: the account the goal saves into. */
  savingsAccountId?: number | null;
  /** Who a finance plan is with; also how its payments show on your statement. */
  provider?: string | null;
  /** How the shop shows on your statement (for matching the purchase or deposit). */
  shop?: string | null;
}

const DEBT_TYPE_FOR = (o: OptionInput): DebtType =>
  o.kind === 'bnpl' ? (o.preset === 'pay_in_30' ? 'bnpl' : 'pay_in_3')
    : o.kind === 'instalments' && !(o.apr ?? 0) ? 'bnpl' : 'personal_loan';

function interestCategory(db: DB): number | null {
  return (db.prepare("SELECT id FROM categories WHERE name = 'Interest & Fees' AND kind = 'expense'").get() as { id: number } | undefined)?.id ?? null;
}

/** Record a confirmed purchase. Returns what it created. */
export function confirmPurchase(db: DB, planId: number, c: ConfirmInput, today = todayIso()) {
  const plan = getPlan(db, planId);
  if (plan.status === 'bought') throw new ValidationError('This purchase is already recorded');
  const opt = plan.inputs.options.find((o) => o.id === c.optionId);
  if (!opt) throw new ValidationError('Choose a way to pay');
  const p0 = plan.inputs.purchase as Purchase;
  const financed = ['bnpl', 'instalments', 'finance'].includes(opt.kind);
  const boughtOn = c.boughtOn ?? (financed && p0.date > today ? today : p0.date);
  if (!isIsoDate(boughtOn)) throw new ValidationError('Check the date you bought it');
  if (financed && boughtOn > today) throw new ValidationError('A finance plan starts when you buy it: use today or an earlier date');
  // Work the option out again on the day you bought it.
  const p: Purchase = { ...p0, date: boughtOn };
  const ctx = loadContext(db, today, 6);
  const b = buildOption(ctx, p, opt);
  if (b.blockers.length) throw new ValidationError(b.blockers.join(' '));
  const from = c.fromAccountId ?? null;
  if (opt.kind !== 'save' && !from) throw new ValidationError('Choose the account you pay from');
  if (from && !db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(from)) throw new ValidationError('That account no longer exists');
  const shop = (c.shop?.trim() || p.name).slice(0, 60);
  const created = { recurring: [] as number[], accounts: [] as number[], transactions: [] as number[], goals: [] as number[] };
  const oneOff = (name: string, amount: number, date: string, accountId: number, categoryId: number | null, pattern: string, type: 'bill' | 'saving' = 'bill', to?: number) =>
    createRecurring(db, { name, type, amount, frequency: 'annually', startDate: date, endDate: date, accountId, categoryId, transferAccountId: to, matchPattern: pattern, notes: `From Can I afford it?: ${p.name}` });

  let debtAccountId: number | null = null, goalId: number | null = null, recurringId: number | null = null;
  let schedule: (ScheduleRow & { recurringId: number | null })[] | null = null;

  tx(db, () => {
    if (opt.kind === 'outright') {
      created.recurring.push(oneOff(p.name, p.price, boughtOn, from!, p.categoryId ?? null, shop));
    }

    if (opt.kind === 'card') {
      const card = ctx.cards.find((x) => x.accountId === opt.cardId)!;
      // The purchase goes on the card (matched when the card statement comes in)…
      created.recurring.push(oneOff(p.name, p.price, boughtOn, card.accountId, p.categoryId ?? null, shop));
      // …and, unless it's simply paid with your next full statement, extra payments until it's paid off.
      const fullAnyway = opt.cardPlan === 'full' && card.paysInFull;
      const pays = b.schedule;
      if (!fullAnyway && pays.length) {
        const first = pays[0], last = pays[pays.length - 1];
        const regular = pays.length > 1 ? pays[1].payment : first.payment;
        recurringId = createRecurring(db, {
          name: `Extra to ${card.name}: ${p.name}`, type: 'saving', amount: regular, variable: true, frequency: pays.length > 1 ? 'monthly' : 'annually',
          startDate: first.date, endDate: last.date, accountId: from!, transferAccountId: card.accountId, notes: `From Can I afford it?: ${p.name}`,
        });
        setAmounts(db, recurringId, pays.map((r) => ({ date: r.date, amount: r.payment })));
        created.recurring.push(recurringId);
      }
    }

    if (financed) {
      const regular = b.schedule.filter((r) => r.n > 0 && r.label.startsWith('Payment'));
      const deposit = b.schedule.find((r) => r.label === 'Deposit');
      const fee = b.schedule.find((r) => r.label === 'Arrangement fee');
      const balloon = b.schedule.find((r) => r.label.startsWith('Final'));
      const financedAmount = p.price - (deposit?.payment ?? 0);
      const provider = c.provider?.trim() || null;
      const debtType = DEBT_TYPE_FOR(opt);
      // The debt starts at £0 the day before, then the purchase is recorded against it once.
      debtAccountId = createAccount(db, { name: `${provider ? `${provider}: ` : ''}${p.name}`.slice(0, 60), type: 'loan', balance: 0, balanceDate: addDays(boughtOn, -1), colour: debtType === 'pay_in_3' ? '#ec4899' : '#dc2626', institution: provider ?? undefined });
      created.accounts.push(debtAccountId);
      const freq = b.frequency ?? 'monthly';
      upsertDebt(db, debtAccountId, {
        debtType, originalBalance: debtType === 'pay_in_3' ? financedAmount : financedAmount, apr: opt.apr ?? 0, minType: 'fixed',
        minFixed: regular.length > 1 ? regular[1].payment : regular[0]?.payment ?? financedAmount, frequency: freq,
        dueDay: freq === 'monthly' && regular[0] ? Number(regular[0].date.slice(8, 10)) : null, paysInFull: false, paymentAccountId: from,
        startDate: regular[0]?.date ?? null, instalments: debtType === 'pay_in_3' ? Math.max(2, regular.length) : null, provider,
        notes: `From Can I afford it?: ${p.name}`,
      });
      const t = createTransaction(db, simpleToPostings({ kind: 'expense', date: boughtOn, description: p.name, accountId: debtAccountId, categoryId: p.categoryId ?? null, amount: financedAmount } as any));
      created.transactions.push(t);
      // Deposit and arrangement fee: one-off payments from your account, matched when they come in.
      if (deposit) created.recurring.push(oneOff(`${p.name} deposit`, deposit.payment, boughtOn, from!, p.categoryId ?? null, shop));
      if (fee) created.recurring.push(oneOff(`${p.name} arrangement fee`, fee.payment, boughtOn, from!, interestCategory(db), provider ?? shop));
      // Repayments: in Bills and income until the last one.
      if (regular.length) {
        recurringId = createRecurring(db, {
          name: `${p.name} repayment`, type: 'saving', amount: regular.length > 1 ? regular[1].payment : regular[0].payment, variable: true,
          frequency: regular.length > 1 ? freq : 'annually', startDate: regular[0].date, endDate: regular[regular.length - 1].date,
          accountId: from!, transferAccountId: debtAccountId, matchPattern: provider ?? undefined, notes: `From Can I afford it?: ${p.name}`,
        });
        setAmounts(db, recurringId, regular.map((r) => ({ date: r.date, amount: r.payment })));
        created.recurring.push(recurringId);
      }
      let balloonId: number | null = null;
      if (balloon) { balloonId = oneOff(`${p.name} final payment`, balloon.payment, balloon.date, from!, null, provider ?? shop, 'saving', debtAccountId); created.recurring.push(balloonId); }
      // Interest and fees are split out of each payment when it's matched (see recordPlanInterest).
      schedule = b.schedule.filter((r) => r.n > 0).map((r) => ({ ...r, recurringId: r.label.startsWith('Final') ? balloonId : recurringId }));
    }

    if (opt.kind === 'save') {
      const acc = c.savingsAccountId ?? null;
      if (!acc) throw new ValidationError('Choose the account to save into');
      goalId = createGoal(db, { name: p.name, accountId: acc, mode: 'share', target: p.price, monthlyTarget: b.save!.monthly, deadline: b.save!.reached, notes: `From Can I afford it?` }, today);
      created.goals.push(goalId);
    }

    db.prepare(
      `UPDATE purchase_plans SET status = 'bought', bought_at = ?, chosen_option = ?, debt_account_id = ?, goal_id = ?, recurring_id = ?, created_ids = ?, schedule = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(opt.kind === 'save' ? today : boughtOn, opt.id, debtAccountId, goalId, recurringId, JSON.stringify(created), schedule ? JSON.stringify(schedule) : null, planId);
  });
  // Link anything already imported (e.g. you bought it last week).
  for (const id of created.recurring) autoMatch(db, id);
  return { ...getPlan(db, planId), created };
}

/** A schedule where amounts change (first or last payment, or interest): record each change in the amount history. */
function setAmounts(db: DB, recurringId: number, rows: { date: string; amount: number }[]) {
  db.prepare('DELETE FROM recurring_amounts WHERE recurring_id = ?').run(recurringId);
  let last: number | null = null;
  for (const r of rows) {
    if (r.amount === last) continue;
    db.prepare('INSERT INTO recurring_amounts (recurring_id, effective_date, amount, detected) VALUES (?, ?, ?, 0)').run(recurringId, r.date, r.amount);
    last = r.amount;
  }
}
