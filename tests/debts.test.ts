import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './fixtures.ts';
import { createTransaction, simpleToPostings } from '../server/ledger.ts';
import { simulate, minimumDue, monthlyInterest, upsertDebt, createDebt, listDebts, debtPlan, addRepaymentToBills, linkCandidates, linkToDebt, uncountedRepayments, reviewRepayments, debtTimeline, archiveDebt, type SimDebt } from '../server/debts.ts';
import { monthPlan } from '../server/recurring.ts';
import { monthTotals } from '../server/queries.ts';
import { updateAccount } from '../server/admin.ts';

const card = (over: Partial<SimDebt> = {}): SimDebt => ({
  id: 1, name: 'Card', balance: 100000, apr: 2400, promoApr: null, promoEnd: null,
  minType: 'card', minFixed: 0, minPercent: 100, minFloor: 2500, frequency: 'monthly', ...over,
});

test('interest and card minimum payments', () => {
  assert.equal(monthlyInterest(100000, 2400), 2000, '£1,000 at 24% APR = £20 a month');
  // Card minimum: greater of £25 or 1% of balance + interest.
  assert.equal(minimumDue({ min_type: 'card', min_fixed: 0, min_percent: 100, min_floor: 2500, frequency: 'monthly' }, 102000, 2000), 3000);
  assert.equal(minimumDue({ min_type: 'card', min_fixed: 0, min_percent: 100, min_floor: 2500, frequency: 'monthly' }, 1000, 0), 1000, 'never more than the balance');
  assert.equal(minimumDue({ min_type: 'fixed', min_fixed: 1000, min_percent: 0, min_floor: 0, frequency: 'weekly' }, 99999, 0), 4333, 'weekly payments as a monthly amount');
});

test('a fixed loan pays off on schedule with the expected interest', () => {
  // £1,200 at 0% with £100/month = 12 months, no interest.
  const r = simulate([card({ balance: 120000, apr: 0, minType: 'fixed', minFixed: 10000 })], 0, 'minimum', '2026-12');
  assert.equal(r.months, 12);
  assert.equal(r.debtFree, '2027-11');
  assert.equal(r.totalInterest, 0);
  assert.equal(r.totalPaid, 120000);
});

test('payments below the interest never clear the debt', () => {
  const r = simulate([card({ balance: 500000, apr: 3000, minType: 'fixed', minFixed: 5000 })], 0, 'minimum', '2026-12');
  assert.equal(r.never, true);
  assert.equal(r.months, null);
});

test('avalanche saves interest; snowball clears the smallest first', () => {
  const debts = [
    card({ id: 1, name: 'Small, low rate', balance: 50000, apr: 1000 }),
    card({ id: 2, name: 'Large, high rate', balance: 300000, apr: 3000 }),
  ];
  const snow = simulate(debts, 30000, 'snowball', '2026-12');
  const aval = simulate(debts, 30000, 'avalanche', '2026-12');
  const min = simulate(debts, 0, 'minimum', '2026-12');
  assert.equal(snow.order[0].name, 'Small, low rate');
  assert.equal(aval.order[0].name, 'Large, high rate');
  assert.ok(aval.totalInterest < snow.totalInterest, 'avalanche pays less interest');
  assert.ok(snow.months! < min.months!, 'paying more than the minimum is faster');
  assert.ok(min.totalInterest > aval.totalInterest);
  // Everything paid: balances + interest
  assert.equal(aval.totalPaid, 350000 + aval.totalInterest);
});

test('promotional 0% until a date', () => {
  const r = simulate([card({ balance: 60000, apr: 2000, promoApr: 0, promoEnd: '2027-06-01', minType: 'fixed', minFixed: 10000 })], 0, 'minimum', '2026-12');
  assert.equal(r.totalInterest, 0, 'cleared within the 0% period');
  const later = simulate([card({ balance: 120000, apr: 2400, promoApr: 0, promoEnd: '2027-03-01', minType: 'fixed', minFixed: 10000 })], 0, 'minimum', '2026-12');
  assert.ok(later.totalInterest > 0, 'interest starts after the promo ends');
});

test('shortfall when the budget is below the minimums', () => {
  const r = simulate([card({ balance: 200000 })], 1000, 'avalanche', '2026-12');
  assert.equal(r.shortfall, true);
});

function setup() {
  const db = testDb();
  db.exec("UPDATE accounts SET anchor_balance = 0, anchor_date = '2025-12-31'");
  const acc = (n: string) => (db.prepare('SELECT id FROM accounts WHERE name = ?').get(n) as { id: number }).id;
  const cat = (n: string) => (db.prepare('SELECT id FROM categories WHERE name = ?').get(n) as { id: number }).id;
  return { db, acc, cat };
}

test('debt view: progress, repayments, interest paid, projection', () => {
  const { db, acc, cat } = setup();
  const northbank = acc('Northbank Current');
  const cc = acc('Northbank Credit Card');
  updateAccount(db, cc, { balance: -150000, balanceDate: '2026-08-31' });
  upsertDebt(db, cc, { debtType: 'credit_card', originalBalance: 200000, apr: 2490, minType: 'card', minPercent: 100, minFloor: 2500, dueDay: 25, paymentAccountId: northbank });
  createTransaction(db, simpleToPostings({ kind: 'transfer', date: '2026-10-25', description: 'Northbank CC payment', accountId: northbank, toAccountId: cc, amount: 50000 }));
  createTransaction(db, simpleToPostings({ kind: 'expense', date: '2026-10-20', description: 'Interest', accountId: cc, categoryId: cat('Interest & Fees'), amount: 3100 }));
  const r = listDebts(db, '2026-11-12');
  const d = r.items.find((i) => i.accountId === cc)!;
  assert.equal(d.owed, 103100);
  assert.equal(d.details!.paidOff, 200000 - 103100);
  assert.equal(d.repayments[0].amount, 50000);
  assert.equal(d.repayments[0].from, 'Northbank Current');
  assert.equal(d.interestPaidYear, 3100);
  assert.equal(d.details!.nextDue, '2026-11-25');
  assert.ok(d.details!.atMinimum!.months! > 12);
  assert.equal(d.history[d.history.length - 1].owed, 103100);
  assert.equal(d.history[d.history.length - 2].owed, 103100, 'end of October');
  assert.equal(d.history[d.history.length - 3].owed, 150000, 'end of September');
  assert.deepEqual(monthTotals(db, '2026-10'), { income: 0, spending: 3100 }, 'repayment is not spending; interest is');
});

test('cards paid in full each month are left out of payoff plans', () => {
  const { db, acc } = setup();
  const crest = acc('Crest Card 1');
  updateAccount(db, crest, { balance: -40000, balanceDate: '2026-11-01' });
  upsertDebt(db, crest, { debtType: 'credit_card', originalBalance: 40000, apr: 3090, minType: 'card', paysInFull: true, paymentAccountId: acc('Northbank Current') });
  const r = listDebts(db, '2026-11-12');
  assert.equal(r.totals.statements, 40000);
  assert.equal(r.totals.minimums, 0);
  assert.equal(debtPlan(db, null, '2026-11-12').debts.length, 0);
});

test('new debts create a liability account; repayment goes on the bills plan as a debt payment', () => {
  const { db, acc } = setup();
  const id = createDebt(db, {
    name: 'Klarna sofa', debtType: 'bnpl', owed: 60000, originalBalance: 90000, apr: 0, minType: 'fixed', minFixed: 30000,
    dueDay: 20, paymentAccountId: acc('Northbank Current'), addRepayment: true,
  });
  const a = db.prepare('SELECT type, anchor_balance FROM accounts WHERE id = ?').get(id) as any;
  assert.equal(a.type, 'loan');
  assert.equal(a.anchor_balance, -60000);
  const rec = db.prepare("SELECT type, amount, transfer_account_id FROM recurring WHERE transfer_account_id = ?").get(id) as any;
  assert.equal(rec.type, 'saving');
  assert.equal(rec.amount, 30000);
  const today = new Date().toISOString().slice(0, 7);
  const plan = monthPlan(db, today);
  assert.equal(plan.monthly.debts, 30000);
  assert.equal(plan.monthly.savings, 0);
  assert.throws(() => addRepaymentToBills(db, acc('Crest Card 2')), /details first/);
});

test('debt details only on liability accounts', () => {
  const { db, acc } = setup();
  assert.throws(() => upsertDebt(db, acc('Lark'), { debtType: 'other', originalBalance: 0, apr: 0, minType: 'fixed', minFixed: 100 }), /credit cards, loans/);
  assert.throws(() => upsertDebt(db, acc('Crest Card 2'), { debtType: 'credit_card', originalBalance: 0, apr: 0, promoApr: 0, minType: 'card' }), /promotional rate ends/);
});

test('pay in 3: schedule, what is left, next payment and bills', () => {
  const { db, acc } = setup();
  const id = createDebt(db, {
    name: 'Klarna TV', debtType: 'pay_in_3', originalBalance: 45001, paidSoFar: 15001, instalments: 3, startDate: '2026-10-20',
    provider: 'Klarna', apr: 0, minType: 'fixed', paymentAccountId: acc('Northbank Current'),
  } as any);
  const d = listDebts(db, '2026-11-12').items.find((i) => i.accountId === id)!;
  assert.equal(d.owed, 30000);
  assert.equal(d.group, 'bnpl');
  assert.deepEqual(d.details!.schedule!.map((s) => [s.date, s.amount, s.paid]), [
    ['2026-10-20', 15001, true], ['2026-11-20', 15000, false], ['2026-12-20', 15000, false],
  ]);
  assert.equal(d.details!.nextDue, '2026-11-20');
  assert.equal(d.details!.minimum, 15000);
  assert.equal(d.details!.finalDate, '2026-12-20');
  assert.equal(d.details!.apr, 0);
  assert.ok(!debtPlan(db, null, '2026-11-12').debts.some((x) => x.id === id), 'fixed schedules are not in payoff plans');
  const rid = addRepaymentToBills(db, id, '2026-11-12');
  const r = db.prepare('SELECT amount, start_date, end_date, frequency FROM recurring WHERE id = ?').get(rid) as any;
  assert.deepEqual({ ...r }, { amount: 15000, start_date: '2026-11-20', end_date: '2026-12-20', frequency: 'monthly' });
  assert.throws(() => createDebt(db, { name: 'x', debtType: 'pay_in_3', originalBalance: 100, paidSoFar: 200, startDate: '2026-10-01', apr: 0, minType: 'fixed' } as any), /between £0 and the total/);
});

test('credit cards paid in full still get a due date', () => {
  const { db, acc } = setup();
  const crest = acc('Crest Card 1');
  upsertDebt(db, crest, { debtType: 'credit_card', originalBalance: 0, apr: 0, minType: 'card', paysInFull: true, dueDay: 7 });
  const d = listDebts(db, '2026-11-12').items.find((i) => i.accountId === crest)!;
  assert.equal(d.group, 'card');
  assert.equal(d.details!.nextDue, '2026-12-07');
});

test('card statements: periods, totals and what is due from the last statement', () => {
  const { db, acc, cat } = setup();
  const crest = acc('Crest Card 1');
  const northbank = acc('Northbank Current');
  upsertDebt(db, crest, { debtType: 'credit_card', originalBalance: 0, apr: 0, minType: 'card', paysInFull: true, dueDay: 7, statementDay: 14 });
  const buy = (date: string, amount: number) => createTransaction(db, simpleToPostings({ kind: 'expense', date, description: 'Shop', accountId: crest, categoryId: cat('Shopping'), amount }));
  buy('2026-10-10', 5000);  // previous statement (15 Sep – 14 Oct)
  buy('2026-10-20', 12000); // last statement (15 Oct – 14 Nov)
  buy('2026-11-14', 3000);  // closing day is included
  buy('2026-11-15', 2000);  // next statement
  createTransaction(db, simpleToPostings({ kind: 'transfer', date: '2026-11-07', description: 'Pay Crest', accountId: northbank, toAccountId: crest, amount: 5000 }));
  createTransaction(db, simpleToPostings({ kind: 'transfer', date: '2026-11-18', description: 'Pay Crest', accountId: northbank, toAccountId: crest, amount: 4000 }));
  const d = listDebts(db, '2026-11-20').items.find((i) => i.accountId === crest)!.details!;
  const [open, last, prev] = d.statements!;
  assert.deepEqual([open.from, open.to, open.current], ['2026-11-15', '2026-12-14', true]);
  assert.deepEqual([last.from, last.to, last.purchases, last.payments, last.closing], ['2026-10-15', '2026-11-14', 15000, 5000, 15000]);
  assert.deepEqual([prev.from, prev.to, prev.purchases], ['2026-09-15', '2026-10-14', 5000]);
  assert.equal(d.statementDue, 11000, 'statement balance less what has been paid since it closed');
  assert.equal(d.minimum, 11000);
  assert.equal(d.statements!.length, 7);
});

test('linking payments to a debt turns spending into repayments', () => {
  const { db, acc, cat } = setup();
  const northbank = acc('Northbank Current');
  const id = createDebt(db, { name: 'PayPal raincoat', debtType: 'pay_in_3', originalBalance: 23800, paidSoFar: 0, instalments: 3, startDate: '2026-10-21', apr: 0, minType: 'fixed' } as any);
  const other = createDebt(db, { name: 'Old duplicate', debtType: 'personal_loan', originalBalance: 23800, owed: 23800, apr: 0, minType: 'fixed', minFixed: 7933 } as any);
  const spend = createTransaction(db, simpleToPostings({ kind: 'expense', date: '2026-11-21', description: 'PAYPAL *PAYIN3', accountId: northbank, categoryId: cat('Shopping'), amount: 7934 }));
  const wrong = createTransaction(db, simpleToPostings({ kind: 'transfer', date: '2026-12-21', description: 'PAYPAL', accountId: northbank, toAccountId: other, amount: 7933 }));
  const cands = linkCandidates(db, id, 'paypal', '2026-12-30');
  assert.deepEqual(cands.map((c) => c.id).sort(), [spend, wrong].sort());
  linkToDebt(db, id, [spend, wrong]);
  const v = listDebts(db, '2026-12-30').items.find((i) => i.accountId === id)!;
  assert.equal(v.repayments.length, 2);
  assert.equal(v.owed, 23800 - 7934 - 7933);
  assert.equal(monthTotals(db, '2026-11').spending, 0, 'no longer counted as spending');
  assert.equal(listDebts(db, '2026-12-30').items.find((i) => i.accountId === other)!.repayments.length, 0);
  assert.throws(() => linkToDebt(db, id, [spend]), /already linked/);
});

test('repayments dated on the day the balance was confirmed can be taken off', () => {
  const { db, acc } = setup();
  const northbank = acc('Northbank Current');
  const today = new Date().toISOString().slice(0, 10);
  const glasses = createDebt(db, { name: 'Desk lamp', debtType: 'personal', originalBalance: 17500, owed: 17500, apr: 0, minType: 'fixed' } as any);
  db.prepare("UPDATE accounts SET anchor_set_at = datetime('now', '-5 minutes') WHERE id = ?").run(glasses);
  const owed = () => listDebts(db).items.find((i) => i.accountId === glasses)!;
  // A repayment added today (same day as the confirmed balance) doesn't move it on its own...
  createTransaction(db, simpleToPostings({ kind: 'transfer', date: today, description: 'Desk lamp repayment', accountId: northbank, toAccountId: glasses, amount: 7500 }));
  assert.equal(owed().owed, 17500);
  assert.equal(owed().uncounted.length, 1);
  // ...until you say it should come off.
  reviewRepayments(db, glasses, [owed().uncounted[0].postingId], true);
  assert.equal(owed().owed, 10000);
  assert.equal(owed().details!.paidOff, 7500);
  assert.equal(owed().uncounted.length, 0);
  // Marking one as already included leaves the balance alone.
  createTransaction(db, simpleToPostings({ kind: 'transfer', date: today, description: 'Another', accountId: northbank, toAccountId: glasses, amount: 1000 }));
  reviewRepayments(db, glasses, uncountedRepayments(db, glasses).map((u) => u.postingId), false);
  assert.equal(owed().owed, 10000);
  assert.equal(uncountedRepayments(db, glasses).length, 0);
  // Linking with "take it off" applies straight away.
  const spend = createTransaction(db, simpleToPostings({ kind: 'expense', date: today, description: 'Bank transfer', accountId: northbank, categoryId: (db.prepare("SELECT id FROM categories WHERE name='Miscellaneous'").get() as any).id, amount: 2500 }));
  linkToDebt(db, glasses, [spend], { takeOff: true });
  assert.equal(owed().owed, 7500);
});

test('timeline: when each debt is cleared, debt-free date and archiving', () => {
  const { db, acc } = setup();
  const northbank = acc('Northbank Current');
  const ticket = createDebt(db, { name: 'Concert ticket', debtType: 'personal', originalBalance: 78358, owed: 26246, apr: 0, minType: 'fixed', minFixed: 20000, paymentAccountId: northbank } as any);
  db.prepare("INSERT INTO recurring (name, type, amount, frequency, start_date, end_date, account_id, transfer_account_id) VALUES ('Ticket', 'saving', 20000, 'monthly', '2026-11-30', '2026-11-30', ?, ?)").run(northbank, ticket);
  db.prepare("INSERT INTO recurring (name, type, amount, frequency, start_date, end_date, account_id, transfer_account_id) VALUES ('Ticket final', 'saving', 6246, 'annually', '2026-12-30', '2026-12-30', ?, ?)").run(northbank, ticket);
  const jacket = createDebt(db, { name: 'Raincoat', debtType: 'pay_in_3', originalBalance: 23800, paidSoFar: 7934, instalments: 3, startDate: '2026-10-21', apr: 0, minType: 'fixed' } as any);
  const t = debtTimeline(db, '2026-11-12');
  const byName = Object.fromEntries(t.debts.map((d) => [d.name, d]));
  assert.equal(byName['Concert ticket'].source, 'bills');
  assert.equal(byName['Concert ticket'].finalDate, '2026-12-30');
  assert.equal(byName['Raincoat'].source, 'schedule');
  assert.equal(byName['Raincoat'].finalDate, '2026-12-21');
  assert.equal(t.debtFree, '2026-12-30');
  assert.deepEqual(t.byMonth, [{ month: '2026-11', total: 27933 }, { month: '2026-12', total: 14179 }]);
  assert.equal(t.interestBearing, false);
  assert.throws(() => archiveDebt(db, ticket), /still/);
  createTransaction(db, simpleToPostings({ kind: 'transfer', date: '2026-11-20', description: 'Pay', accountId: northbank, toAccountId: jacket, amount: 15866 }));
  archiveDebt(db, jacket);
  assert.ok(!listDebts(db, '2026-11-25').items.some((i) => i.accountId === jacket));
});
