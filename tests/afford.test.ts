import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './fixtures.ts';
import { createRecurring } from '../server/recurring.ts';
import { createGoal } from '../server/goals.ts';
import { createAccount } from '../server/admin.ts';
import { createTransaction, simpleToPostings } from '../server/ledger.ts';
import { saveDebt } from '../server/debts.ts';
import {
  addMonthsToDate, buildOption, cardBaseline, instalmentSchedule, loadContext, paymentDates, periodicRate, pool, simulate,
  type CardInfo, type Context,
} from '../server/afford.ts';

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

// ---------------------------------------------------------------------------
// Finance maths

test('dates: month steps stay inside short months; weekly and fortnightly step by days', () => {
  assert.equal(addMonthsToDate('2027-01-31', 1), '2027-02-28');
  assert.equal(addMonthsToDate('2028-01-31', 1), '2028-02-29');
  assert.deepEqual(paymentDates('2027-01-31', 3, 'monthly'), ['2027-01-31', '2027-02-28', '2027-03-31']);
  assert.deepEqual(paymentDates('2027-01-01', 4, 'fortnightly'), ['2027-01-01', '2027-01-15', '2027-01-29', '2027-02-12']);
});

test('APR becomes a rate per payment the UK way: (1 + APR)^(1/n) − 1', () => {
  assert.equal(periodicRate(0, 12), 0);
  assert.ok(Math.abs(periodicRate(1200, 12) - (Math.pow(1.12, 1 / 12) - 1)) < 1e-12);
  assert.ok(periodicRate(1200, 12) < 0.01, 'less than APR/12');
});

test('interest-free plan: equal payments, odd pennies on the first, nothing extra', () => {
  const rows = instalmentSchedule({ financed: 100000, payments: 3, frequency: 'monthly', first: '2027-01-10', apr: 0 });
  assert.deepEqual(rows.map((r) => r.payment), [33334, 33333, 33333]);
  assert.equal(sum(rows.map((r) => r.interest)), 0);
  assert.equal(rows[2].remaining, 0);
});

test('interest-bearing plan: £1,200 over 12 months at 19.9% APR', () => {
  const rows = instalmentSchedule({ financed: 120000, payments: 12, frequency: 'monthly', first: '2027-01-10', apr: 1990 });
  const i = Math.pow(1.199, 1 / 12) - 1;
  const pmt = Math.round((120000 * i) / (1 - Math.pow(1 + i, -12)));
  assert.equal(rows[0].payment, pmt);
  assert.ok(pmt > 11000 && pmt < 11100, `about £110.50 a month, got ${pmt}`);
  assert.equal(rows[11].remaining, 0, 'cleared exactly');
  assert.equal(sum(rows.map((r) => r.principal)), 120000);
  const interest = sum(rows.map((r) => r.interest));
  assert.equal(sum(rows.map((r) => r.payment)), 120000 + interest);
  assert.ok(interest > 12000 && interest < 13000, `about £125 interest, got ${interest}`);
  for (let k = 1; k < rows.length; k++) assert.ok(rows[k].remaining < rows[k - 1].remaining);
});

test('balloon payment: smaller monthly payments, then the balloon one period after the last', () => {
  const plain = instalmentSchedule({ financed: 1000000, payments: 36, frequency: 'monthly', first: '2027-01-05', apr: 690 });
  const pcp = instalmentSchedule({ financed: 1000000, payments: 36, frequency: 'monthly', first: '2027-01-05', apr: 690, balloon: 400000 });
  assert.equal(pcp.length, 37);
  assert.ok(pcp[0].payment < plain[0].payment);
  assert.equal(pcp[35].remaining, 400000, 'down to the balloon');
  const last = pcp[36];
  assert.equal(last.label, 'Final (balloon) payment');
  assert.equal(last.date, '2030-01-05');
  assert.equal(last.remaining, 0);
  assert.equal(sum(pcp.map((r) => r.principal)), 1000000);
});

test('fees: an upfront fee and a fee on each payment count in the total', () => {
  const ctx = { today: '2026-11-19', end: '2031-12-31', cards: [] };
  const b = buildOption(ctx, { name: 'Sofa', price: 120000, date: '2026-12-01' }, { id: 'a', kind: 'instalments', payments: 6, apr: 0, deposit: 20000, upfrontFee: 1500, paymentFee: 100 });
  assert.equal(b.classification, 'zero_percent');
  assert.equal(b.totalFees, 1500 + 6 * 100);
  assert.equal(b.totalPayable, 120000 + 2100);
  assert.equal(sum(b.flows.map((f) => f.amount)), b.totalPayable, 'cash out adds up to the total');
  assert.equal(b.schedule[0].label, 'Deposit');
  assert.equal(b.firstDate, '2026-12-01');
  assert.equal(b.schedule.find((r) => r.n === 1)!.date, '2027-01-01', 'first payment a month later by default');
});

test('BNPL presets: Pay in 3 monthly from today, Pay in 4 fortnightly, Pay in 30 days', () => {
  const ctx = { today: '2026-11-19', end: '2031-12-31', cards: [] };
  const p = { name: 'Boots', price: 15000, date: '2026-11-20' };
  const three = buildOption(ctx, p, { id: '3', kind: 'bnpl', preset: 'pay_in_3' });
  assert.deepEqual(three.flows.map((f) => f.date), ['2026-11-20', '2026-12-20', '2027-01-20']);
  assert.equal(three.classification, 'bnpl');
  assert.ok(three.warnings.some((w) => /not regulated/.test(w)));
  const four = buildOption(ctx, p, { id: '4', kind: 'bnpl', preset: 'pay_in_4' });
  assert.deepEqual(four.flows.map((f) => f.date), ['2026-11-20', '2026-12-04', '2026-12-18', '2027-01-01']);
  assert.deepEqual(four.flows.map((f) => f.amount), [3750, 3750, 3750, 3750]);
  const thirty = buildOption(ctx, p, { id: '30', kind: 'bnpl', preset: 'pay_in_30' });
  assert.deepEqual(thirty.flows, [{ date: '2026-12-20', amount: 15000, label: 'Payment 1' }]);
  // A BNPL plan with interest is really credit.
  assert.equal(buildOption(ctx, p, { id: 'x', kind: 'bnpl', preset: 'pay_in_3', apr: 1990 }).classification, 'credit');
});

// ---------------------------------------------------------------------------
// Credit cards

const card = (over: Partial<CardInfo> = {}): CardInfo => ({
  accountId: 9, name: 'Test Card', owed: 0, apr: 2490, promoApr: null, promoEnd: null,
  minType: 'card', minFixed: 0, minPercent: 100, minFloor: 2500, dueDay: 15, statementDay: 20, paysInFull: true, creditLimit: 300000,
  repayments: [], hasDetails: true, ...over,
});

test('card, paid in full: one extra payment on the due date after the statement it lands on, no interest', () => {
  const ctx = { today: '2026-11-19', end: '2031-12-31', cards: [card()] };
  const b = buildOption(ctx, { name: 'TV', price: 80000, date: '2026-11-22' }, { id: 'c', kind: 'card', cardId: 9, cardPlan: 'full' });
  // Statement closes 20 Dec (after the 22 Nov purchase), so it's due 15 Jan.
  assert.deepEqual(b.flows, [{ date: '2027-01-15', amount: 80000, label: 'Extra to Test Card' }]);
  assert.equal(b.totalInterest, 0);
  assert.equal(b.card!.available, 300000 - 80000);
  assert.equal(b.blockers.length, 0);
});

test('card: over the credit limit is blocked; near it is a warning', () => {
  const ctx = { today: '2026-11-19', end: '2031-12-31', cards: [card({ owed: 250000 })] };
  const over = buildOption(ctx, { name: 'TV', price: 80000, date: '2026-11-22' }, { id: 'c', kind: 'card', cardId: 9, cardPlan: 'full' });
  assert.match(over.blockers[0], /more than the £500.00 of credit left/);
  const near = buildOption(ctx, { name: 'TV', price: 46000, date: '2026-11-22' }, { id: 'c', kind: 'card', cardId: 9, cardPlan: 'full' });
  assert.equal(near.blockers.length, 0);
  assert.ok(near.warnings.some((w) => /most of the credit/.test(w)));
});

test('card at a fixed amount a month: interest is charged, and payments add up to price plus interest', () => {
  const ctx = { today: '2026-11-19', end: '2031-12-31', cards: [card({ paysInFull: false })] };
  const b = buildOption(ctx, { name: 'Laptop', price: 120000, date: '2026-11-22' }, { id: 'c', kind: 'card', cardId: 9, cardPlan: 'fixed', cardMonthly: 20000 });
  assert.ok(b.payments >= 7 && b.payments <= 8, `about 7 payments, got ${b.payments}`);
  assert.ok(b.totalInterest > 0);
  assert.equal(sum(b.flows.map((f) => f.amount)), 120000 + b.totalInterest);
  assert.ok(b.flows.slice(0, -1).every((f) => f.amount === 20000));
});

test('card with a 0% offer: clearing it before the offer ends costs no interest', () => {
  const ctx = { today: '2026-11-19', end: '2031-12-31', cards: [card({ paysInFull: false, promoApr: 0, promoEnd: '2027-08-01' })] };
  const b = buildOption(ctx, { name: 'Laptop', price: 120000, date: '2026-11-22' }, { id: 'c', kind: 'card', cardId: 9, cardPlan: 'promo' });
  assert.equal(b.blockers.length, 0);
  assert.equal(b.totalInterest, 0);
  assert.ok(b.lastDate! < '2027-08-01');
  // Minimum payments run past the offer and cost interest.
  const min = buildOption(ctx, { name: 'Laptop', price: 120000, date: '2026-11-22' }, { id: 'm', kind: 'card', cardId: 9, cardPlan: 'minimum' });
  assert.ok(min.totalInterest > 0);
  assert.ok(min.warnings.some((w) => /0% offer ends/.test(w)));
});

test('card with an existing balance: the purchase is added to it and payments clear the highest rate first', () => {
  // Existing £1,000 at 0% (balance transfer) and a purchase at 24.9%: extra payments go to the purchase first,
  // so it costs less interest than if they went to the 0% balance.
  const c = card({ owed: 100000, paysInFull: false, apr: 2490, promoApr: 0, promoEnd: '2028-01-01' });
  const ctx = { today: '2026-11-19', end: '2031-12-31', cards: [c] };
  const b = buildOption(ctx, { name: 'Bike', price: 60000, date: '2026-11-22' }, { id: 'c', kind: 'card', cardId: 9, cardPlan: 'fixed', cardMonthly: 15000, purchaseApr: 2490, purchasePromoEnd: null });
  assert.ok(b.totalInterest > 0 && b.totalInterest < 3000, `small interest, got ${b.totalInterest}`);
  assert.ok(b.warnings.length === 0 || !b.warnings.some((w) => /doesn't clear/.test(w)));
});

test('existing card balances are paid off on the due dates as you normally would', () => {
  const full = cardBaseline(card({ owed: 50000 }), '2026-11-19', '2027-03-31');
  assert.deepEqual(full, [{ date: '2026-12-15', amount: 50000 }]);
  const minimum = cardBaseline(card({ owed: 50000, paysInFull: false }), '2026-11-19', '2027-03-31');
  assert.equal(minimum[0].amount, 2500 + 0 > 0 ? Math.max(2500, minimum[0].amount) : 0);
  assert.equal(minimum.length, 4);
});

test('save first: months to save, the date you would have it, and other amounts', () => {
  const ctx = { today: '2026-11-19', end: '2031-12-31', cards: [] };
  const b = buildOption(ctx, { name: 'Holiday', price: 120000, date: '2026-11-19' }, { id: 's', kind: 'save', saveMonthly: 25000, saveStart: '2026-12-01' });
  assert.equal(b.save!.months, 5);
  assert.equal(b.save!.reached, '2027-04-01');
  assert.equal(sum(b.flows.map((f) => f.amount)), 120000, 'never saves more than the price');
  assert.ok(b.save!.alternatives.some((a) => a.months === 12 && a.monthly === 10000));
});

// ---------------------------------------------------------------------------
// Reading your data and the assessment

/** Paid on the last working day; rent, a card with a balance, an emergency fund and a holiday goal. */
function world(opts: { balance?: number; everyday?: number } = {}) {
  const db = testDb();
  const acc = (n: string) => (db.prepare('SELECT id FROM accounts WHERE name = ?').get(n) as { id: number }).id;
  const cat = (n: string, kind = 'expense') => (db.prepare('SELECT id FROM categories WHERE name = ? AND kind = ?').get(n, kind) as { id: number }).id;
  const current = acc('Northbank Current'), savings = acc('Harbour Savings'), cardId = acc('Northbank Credit Card');
  db.prepare("UPDATE accounts SET anchor_balance = 0, anchor_date = '2026-06-30'").run();
  db.prepare("UPDATE accounts SET anchor_balance = ?, anchor_date = '2026-11-18' WHERE id = ?").run(opts.balance ?? 150000, current);
  db.prepare("UPDATE accounts SET anchor_balance = 500000, anchor_date = '2026-11-18' WHERE id = ?").run(savings);
  db.prepare("UPDATE accounts SET anchor_balance = -40000, anchor_date = '2026-11-18' WHERE id = ?").run(cardId);
  createRecurring(db, { name: 'Salary', type: 'income', amount: 280000, frequency: 'monthly', startDate: '2026-01-30', schedule: 'last_working_day', accountId: current, categoryId: cat('Salary', 'income') });
  createRecurring(db, { name: 'Rent', type: 'bill', amount: 95000, frequency: 'monthly', startDate: '2026-01-01', accountId: current, categoryId: cat('Rent / Housing') });
  createRecurring(db, { name: 'Phone', type: 'subscription', amount: 2000, frequency: 'monthly', startDate: '2026-01-12', accountId: current, categoryId: cat('Subscriptions') });
  saveDebt(db, cardId, { debtType: 'credit_card', originalBalance: 40000, apr: 2490, minType: 'card', minPercent: 100, minFloor: 2500, dueDay: 15, statementDay: 20, paysInFull: true });
  db.prepare('UPDATE debts SET credit_limit = 400000 WHERE account_id = ?').run(cardId);
  createGoal(db, { name: 'Emergency fund', accountId: savings, mode: 'share', isEmergency: true, monthlyTarget: 10000 } as any);
  // £3,000 of the £5,000 savings set aside for the emergency fund.
  db.prepare("INSERT INTO goal_moves (goal_id, date, amount) SELECT id, '2026-10-01', 300000 FROM goals WHERE name = 'Emergency fund'").run();
  // Three months of everyday spending.
  const spend = opts.everyday ?? 90000;
  for (const m of ['2026-08', '2026-09', '2026-10']) {
    createTransaction(db, simpleToPostings({ kind: 'expense', date: `${m}-10`, description: 'Groceries and things', accountId: current, categoryId: cat('Groceries'), amount: spend } as any));
  }
  return { db, current, savings, cardId };
}

const TODAY = '2026-11-19';

test('context: available cash is current plus savings less goal money; investments are left out', () => {
  const { db, current, savings } = world();
  createAccount(db, { name: 'Shares ISA', type: 'investment', balance: 1000000, balanceDate: '2026-11-18' });
  const ctx = loadContext(db, TODAY, 24);
  const cur = ctx.accounts.find((a) => a.id === current)!;
  const sav = ctx.accounts.find((a) => a.id === savings)!;
  assert.equal(sav.emergency, 300000);
  assert.equal(sav.defaultAmount, 200000);
  assert.equal(ctx.accounts.find((a) => a.name === 'Shares ISA')!.defaultIncluded, false);
  const pl = pool(ctx);
  assert.equal(pl.start, cur.balance + 200000);
  assert.deepEqual(pl.protectedIncluded, { emergency: 0, goals: 0, investments: 0 });
  // Counting the whole savings account uses the emergency fund.
  const all = pool(ctx, { accounts: { [String(savings)]: { include: true, amount: 500000 } } });
  assert.equal(all.protectedIncluded.emergency, 300000);
});

test('context: pay lands on the last working day; card repayments are left to the card; goals go out after payday', () => {
  const { db } = world();
  const ctx = loadContext(db, TODAY, 3);
  const pays = ctx.events.filter((e) => e.isPay).map((e) => e.date);
  assert.deepEqual(pays.slice(0, 3), ['2026-11-30', '2026-12-31', '2027-01-29'], 'Jan 2027: the 29th is a Friday');
  assert.equal(ctx.events.find((e) => e.isPay && e.date === '2026-11-30')!.period, '2026-12', 'counts towards December');
  assert.ok(ctx.events.some((e) => e.kind === 'saving' && e.label === 'Emergency fund (goal)' && e.date === '2026-12-01'));
  assert.equal(ctx.everyday.average, 90000);
  assert.equal(ctx.cards[0].creditLimit, 400000);
  assert.deepEqual(ctx.missing, []);
});

test('missing data is named, not guessed', () => {
  const db = testDb();
  db.prepare("UPDATE accounts SET anchor_balance = -12000 WHERE name = 'Crest Card 1'").run();
  const ctx = loadContext(db, TODAY, 3);
  assert.ok(ctx.missing.some((m) => /No regular pay/.test(m.what)));
  assert.ok(!ctx.missing.some((m) => /Crest Card 2/.test(m.what)), 'a card you owe nothing on doesn\'t matter');
  assert.ok(ctx.missing.some((m) => /No day-to-day spending/.test(m.what)));
  assert.ok(ctx.missing.some((m) => /no card details/.test(m.what)));
});

test('a small purchase paid outright is comfortably affordable', () => {
  const { db } = world();
  const r = simulate(loadContext(db, TODAY, 24), { purchase: { name: 'Headphones', price: 15000, date: '2026-12-02' }, options: [{ id: 'o', kind: 'outright' }] });
  const o = r.options[0];
  assert.equal(o.assessment.level, 'comfortable', o.assessment.reasons.join(' '));
  assert.ok(o.forecast.lowest.balance >= 0);
  // The purchase is the only difference from the baseline.
  const day = (f: typeof o.forecast, d: string) => f.days.find((x) => x.date === d)!.balance;
  assert.equal(day(r.baseline, '2026-12-31') - day(o.forecast, '2026-12-31'), 15000);
  // 1 Dec: rent, the emergency fund's monthly amount (the day after payday) and a day's spending.
  assert.equal(day(r.baseline, '2026-12-01') - day(r.baseline, '2026-11-30'), -95000 - 10000 - 2904);
});

test('a big purchase that would empty the account is not affordable, with the date and why', () => {
  const { db } = world({ balance: 30000 });
  const r = simulate(loadContext(db, TODAY, 24), { purchase: { name: 'Laptop', price: 220000, date: '2026-11-20' }, options: [{ id: 'o', kind: 'outright' }] });
  const a = r.options[0].assessment;
  assert.equal(a.level, 'not_affordable');
  assert.match(a.reasons[0], /run out/);
  assert.equal(a.checks.find((c) => c.key === 'balance')!.ok, false);
});

test('spreading the cost can turn not affordable into affordable; the best option is explained', () => {
  const { db } = world({ balance: 30000 });
  const r = simulate(loadContext(db, TODAY, 24), {
    purchase: { name: 'Laptop', price: 240000, date: '2026-11-20' },
    options: [
      { id: 'out', kind: 'outright' },
      { id: '12', kind: 'instalments', payments: 12, apr: 0 },
      { id: '12i', kind: 'finance', payments: 12, apr: 1990 },
    ],
  });
  const by = (id: string) => r.options.find((o) => o.id === id)!;
  assert.equal(by('out').assessment.level, 'not_affordable');
  assert.notEqual(by('12').assessment.level, 'not_affordable');
  assert.equal(r.best!.id, '12', 'interest-free beats the same plan with interest');
  assert.ok(by('12i').totalPayable > by('12').totalPayable);
});

test('using the emergency fund makes it stretching at best', () => {
  const { db, savings } = world({ balance: 30000 });
  const ctx = loadContext(db, TODAY, 24);
  const r = simulate(ctx, {
    purchase: { name: 'Laptop', price: 220000, date: '2026-11-20' },
    options: [{ id: 'o', kind: 'outright' }],
    overrides: { accounts: { [String(savings)]: { include: true, amount: 500000 } } },
  });
  const a = r.options[0].assessment;
  assert.equal(a.level, 'stretching', a.reasons.join(' '));
  assert.match(a.reasons[0], /emergency fund/);
});

test('a tight month is "with adjustments", and the adjustments name amounts', () => {
  const { db } = world({ balance: 300000, everyday: 160000 });
  const r = simulate(loadContext(db, TODAY, 24), { purchase: { name: 'Chair', price: 10000, date: '2027-01-05' }, options: [{ id: 'o', kind: 'outright' }] });
  const a = r.options[0].assessment;
  // Pay 2,800 − rent 950 − phone 20 − emergency 100 − everyday 1,600 = 130 (under the 280 minimum) in most months.
  assert.ok(['adjust', 'stretching'].includes(a.level), a.level);
  assert.ok(r.options[0].forecast.months.some((m) => m.freeToSpend < m.floor));
});

test('overrides change only what you change, and are marked as changed', () => {
  const { db } = world();
  const ctx = loadContext(db, TODAY, 24);
  const base = simulate(ctx, { purchase: { name: 'X', price: 10000, date: '2026-12-02' }, options: [{ id: 'o', kind: 'outright' }] });
  const more = simulate(ctx, { purchase: { name: 'X', price: 10000, date: '2026-12-02' }, options: [{ id: 'o', kind: 'outright' }], overrides: { everyday: 120000, floorPercent: 2000 } });
  const dec = (r: typeof base) => r.options[0].forecast.months.find((m) => m.month === '2026-12')!;
  assert.equal(dec(more).everyday - dec(base).everyday, 30000);
  assert.equal(dec(more).floor, 2 * dec(base).floor);
  assert.equal(more.assumptions.find((a) => a.label === 'Day-to-day spending')!.changed, true);
  assert.equal(base.assumptions.every((a) => !a.changed), true);
});

test('simulating changes nothing in the database', () => {
  const { db } = world();
  const snap = () => JSON.stringify(['accounts', 'transactions', 'postings', 'recurring', 'goals', 'goal_moves', 'debts', 'budgets'].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()));
  const before = snap();
  simulate(loadContext(db, TODAY, 24), {
    purchase: { name: 'Laptop', price: 120000, date: '2026-11-20' },
    options: [{ id: 'a', kind: 'outright' }, { id: 'b', kind: 'card', cardId: (db.prepare("SELECT id FROM accounts WHERE name = 'Northbank Credit Card'").get() as any).id, cardPlan: 'fixed', cardMonthly: 20000 }, { id: 'c', kind: 'save', saveMonthly: 20000 }],
  });
  assert.equal(snap(), before);
});

test('card spending leaves your account on the card\'s due date, once: what you owe today, then each statement', () => {
  const charges = new Map<string, number>();
  for (let d = 20; d <= 30; d++) charges.set(`2026-11-${d}`, 1000); // £10 a day from 20 Nov
  for (let d = 1; d <= 31; d++) charges.set(`2026-12-${String(d).padStart(2, '0')}`, 1000);
  const flows = cardBaseline(card({ owed: 40000 }), '2026-11-19', '2027-02-28', charges);
  // 15 Dec pays the statement that closed 20 Nov: what you owe today plus 20 Nov's spending.
  assert.deepEqual(flows[0], { date: '2026-12-15', amount: 41000 });
  // 15 Jan pays 21 Nov – 20 Dec.
  assert.deepEqual(flows[1], { date: '2027-01-15', amount: 30000 });
  // 15 Feb pays 21 Dec – 31 Dec; everything owed and charged is paid exactly once.
  assert.equal(sum(flows.map((f) => f.amount)), 40000 + sum([...charges.values()]));
});

test('bills set up after the fact are left out of the day-to-day average', () => {
  const { db, current } = world();
  // Rent paid in August, before the bill was linked: it's a bill, not day-to-day spending.
  db.prepare("DELETE FROM recurring_payments").run();
  const cat = (db.prepare("SELECT id FROM categories WHERE name = 'Rent / Housing' AND kind = 'expense'").get() as { id: number }).id;
  createTransaction(db, simpleToPostings({ kind: 'expense', date: '2026-08-01', description: 'LANDLORD LTD', accountId: current, categoryId: cat, amount: 95000 } as any));
  const ctx = loadContext(db, TODAY, 3);
  assert.equal(ctx.everyday.average, 90000);
});

test('this month\'s figures match the This month card', async () => {
  const { db } = world();
  const { plan } = await import('../server/plan.ts');
  const p = plan(db, '2026-11', TODAY);
  const r = simulate(loadContext(db, TODAY, 3), { purchase: { name: 'X', price: 100, date: '2026-12-02' }, options: [{ id: 'o', kind: 'outright' }] });
  const nov = r.baseline.months[0];
  assert.equal(nov.income, p.income.planned);
  assert.equal(nov.bills, p.bills.planned);
});

// ---------------------------------------------------------------------------
// Saving and confirming

import { createPlan, confirmPurchase, listPlans, getPlan, setPlanStatus, deletePlan, updatePlan } from '../server/purchases.ts';
import { autoMatch, setPayment } from '../server/recurring.ts';
import { listAccounts } from '../server/queries.ts';

const laptop = (options: any[], extra: any = {}) => ({ purchase: { name: 'Laptop', price: 120000, date: '2026-11-19', priority: 'important', ...extra }, options });

test('saved simulations: create, edit, compare, drop and delete without touching your money', () => {
  const { db } = world();
  const snap = () => JSON.stringify(['accounts', 'transactions', 'postings', 'recurring', 'goals', 'debts'].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()));
  const before = snap();
  const id = createPlan(db, laptop([{ id: 'a', kind: 'outright' }, { id: 'b', kind: 'bnpl', preset: 'pay_in_3' }]));
  updatePlan(db, id, { ...laptop([{ id: 'a', kind: 'outright' }, { id: 'b', kind: 'bnpl', preset: 'pay_in_3' }]), chosen: 'b' });
  const list = listPlans(db, TODAY);
  assert.equal(list[0].chosen, 'b');
  assert.equal(list[0].summary!.option, 'Pay in 3 (Klarna-style)');
  setPlanStatus(db, id, 'dropped');
  assert.equal(getPlan(db, id).status, 'dropped');
  assert.throws(() => setPlanStatus(db, id, 'bought' as any), /I’ve bought it/);
  deletePlan(db, id);
  assert.equal(listPlans(db, TODAY).length, 0);
  assert.equal(snap(), before);
});

test('confirming an outright purchase adds one expected payment, matched once when the transaction comes in', () => {
  const { db, current } = world();
  const id = createPlan(db, laptop([{ id: 'a', kind: 'outright' }]));
  const r = confirmPurchase(db, id, { optionId: 'a', fromAccountId: current, shop: 'TECHSTORE' }, TODAY);
  assert.equal(r.status, 'bought');
  const rec = db.prepare('SELECT * FROM recurring WHERE id = ?').get(r.created.recurring[0]) as any;
  assert.equal(rec.amount, 120000);
  assert.equal(rec.start_date, '2026-11-19');
  assert.equal(rec.end_date, '2026-11-19');
  // The bank import brings it in: matched to the expected payment, so it's a bill paid, not extra spending.
  createTransaction(db, simpleToPostings({ kind: 'expense', date: '2026-11-19', description: 'TECHSTORE LONDON', accountId: current, amount: 120000 } as any));
  autoMatch(db, rec.id);
  assert.ok(db.prepare("SELECT 1 FROM recurring_payments WHERE recurring_id = ? AND status = 'paid' AND transaction_id IS NOT NULL").get(rec.id));
  assert.throws(() => confirmPurchase(db, id, { optionId: 'a', fromAccountId: current }, TODAY), /already recorded/);
});

test('confirming finance: the purchase is spending once, repayments are transfers, and interest is split out as each is paid', () => {
  const { db, current } = world();
  const id = createPlan(db, laptop([{ id: 'f', kind: 'finance', payments: 12, apr: 1990, deposit: 20000 }]));
  const r = confirmPurchase(db, id, { optionId: 'f', fromAccountId: current, provider: 'Lendco', shop: 'TECHSTORE' }, TODAY);
  const debt = r.debtAccountId!;
  const owed = () => -(listAccounts(db, { includeArchived: true }).find((a) => a.id === debt)!.balance);
  assert.equal(owed(), 100000, 'only the financed part is owed');
  // Spending: the financed £1,000 on the debt now; the £200 deposit arrives from the bank later.
  const spent = (db.prepare("SELECT SUM(-p.amount) AS n FROM postings p JOIN transactions t ON t.id = p.transaction_id WHERE t.kind = 'expense'").get() as any).n;
  const before = spent;
  const rep = db.prepare('SELECT * FROM recurring WHERE id = ?').get(r.recurringId) as any;
  assert.equal(rep.type, 'saving');
  assert.equal(rep.transfer_account_id, debt);
  assert.equal(rep.end_date, addMonthsToDate('2026-12-19', 11));
  const sched = JSON.parse((db.prepare('SELECT schedule FROM purchase_plans WHERE id = ?').get(id) as any).schedule);
  const first = sched[0];
  assert.ok(first.interest > 0);
  // Pay the first instalment.
  setPayment(db, rep.id, { dueDate: first.date, status: 'paid', record: { amount: first.payment, date: first.date } });
  assert.equal(owed(), 100000 - first.principal, 'the debt goes down by the part that repays it');
  const after = (db.prepare("SELECT SUM(-p.amount) AS n FROM postings p JOIN transactions t ON t.id = p.transaction_id WHERE t.kind = 'expense'").get() as any).n;
  assert.equal(after - before, first.interest + first.fees, 'interest counted as spending, once');
  // Matching it again doesn't add the interest twice.
  autoMatch(db, rep.id);
  assert.equal((db.prepare("SELECT SUM(-p.amount) AS n FROM postings p JOIN transactions t ON t.id = p.transaction_id WHERE t.kind = 'expense'").get() as any).n, after);
  // Paying everything clears the debt exactly.
  for (const row of sched.slice(1)) setPayment(db, rep.id, { dueDate: row.date, status: 'paid', record: { amount: row.payment, date: row.date } });
  assert.equal(owed() + 0, 0, 'cleared exactly');
});

test('confirming pay in 3 makes a Pay in 3 debt with its schedule', () => {
  const { db, current } = world();
  const id = createPlan(db, laptop([{ id: 'k', kind: 'bnpl', preset: 'pay_in_3' }]));
  const r = confirmPurchase(db, id, { optionId: 'k', fromAccountId: current, provider: 'Klarna' }, TODAY);
  const d = db.prepare('SELECT * FROM debts WHERE account_id = ?').get(r.debtAccountId) as any;
  assert.equal(d.debt_type, 'pay_in_3');
  assert.equal(d.instalments, 3);
  assert.equal(d.start_date, '2026-11-19');
  assert.equal(d.provider, 'Klarna');
});

test('confirming a card purchase paid in full adds the spend on the card and nothing extra', () => {
  const { db, current, cardId } = world();
  const id = createPlan(db, laptop([{ id: 'c', kind: 'card', cardId, cardPlan: 'full' }]));
  const r = confirmPurchase(db, id, { optionId: 'c', fromAccountId: current }, TODAY);
  assert.equal(r.created.recurring.length, 1);
  const rec = db.prepare('SELECT * FROM recurring WHERE id = ?').get(r.created.recurring[0]) as any;
  assert.equal(rec.account_id, cardId);
  // Spread over months instead: extra payments to the card until it's paid off.
  const id2 = createPlan(db, laptop([{ id: 'c', kind: 'card', cardId, cardPlan: 'fixed', cardMonthly: 30000 }]));
  const r2 = confirmPurchase(db, id2, { optionId: 'c', fromAccountId: current }, TODAY);
  const extra = db.prepare('SELECT * FROM recurring WHERE id = ?').get(r2.recurringId) as any;
  assert.equal(extra.transfer_account_id, cardId);
  assert.equal(extra.amount, 30000);
});

test('saving first creates a goal and keeps the simulation', () => {
  const { db, savings } = world();
  const id = createPlan(db, laptop([{ id: 's', kind: 'save', saveMonthly: 20000, saveStart: '2026-12-01' }]));
  const r = confirmPurchase(db, id, { optionId: 's', savingsAccountId: savings }, TODAY);
  const g = db.prepare('SELECT * FROM goals WHERE id = ?').get(r.goalId) as any;
  assert.equal(g.target, 120000);
  assert.equal(g.monthly_target, 20000);
  assert.equal(g.deadline, '2027-05-01');
  assert.equal(getPlan(db, id).status, 'bought');
});

test('a credit limit is saved with card details', () => {
  const { db, cardId } = world();
  saveDebt(db, cardId, { debtType: 'credit_card', originalBalance: 0, apr: 2490, minType: 'card', paysInFull: true, creditLimit: 500000 });
  assert.equal(loadContext(db, TODAY, 2).cards.find((c) => c.accountId === cardId)!.creditLimit, 500000);
});
