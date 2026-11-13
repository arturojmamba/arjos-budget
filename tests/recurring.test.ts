import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './fixtures.ts';
import { createTransaction, simpleToPostings, deleteTransaction } from '../server/ledger.ts';
import { lastWorkingDay, bankHolidays, isWorkingDay } from '../server/calendar.ts';
import { createRecurring, dueDates, monthlyEquivalent, listRecurring, monthPlan, setPayment, suggestRecurring, autoMatch, occurrences } from '../server/recurring.ts';
import { addDays, todayIso, monthOf } from '../server/dates.ts';

function setup() {
  const db = testDb();
  db.exec("UPDATE accounts SET anchor_balance = 0, anchor_date = '2025-12-31'");
  const acc = (n: string) => (db.prepare('SELECT id FROM accounts WHERE name = ?').get(n) as { id: number }).id;
  const cat = (n: string) => (db.prepare('SELECT id FROM categories WHERE name = ?').get(n) as { id: number }).id;
  const spend = (date: string, description: string, account: string, amount: number, category?: string) =>
    createTransaction(db, simpleToPostings({ kind: 'expense', date, description, accountId: acc(account), amount, categoryId: category ? cat(category) : null }));
  return { db, acc, cat, spend };
}

test('UK bank holidays and last working day', () => {
  assert.equal(lastWorkingDay('2026-08'), '2026-08-28', 'summer bank holiday Monday 31st');
  assert.equal(lastWorkingDay('2026-10'), '2026-10-30', '31st is a Saturday');
  assert.equal(lastWorkingDay('2026-05'), '2026-05-29');
  assert.equal(lastWorkingDay('2026-12'), '2026-12-31');
  const h2027 = bankHolidays(2027);
  assert.ok(h2027.has('2027-12-27') && h2027.has('2027-12-28'), 'Christmas on a Saturday is substituted');
  assert.ok(h2027.has('2027-03-26') && h2027.has('2027-03-29'), 'Easter 2027');
  assert.ok(bankHolidays(2022).has('2022-12-26') && bankHolidays(2022).has('2022-12-27'), 'Christmas on a Sunday');
  assert.equal(isWorkingDay('2026-12-25'), false);
});

test('schedules: month-end clamping, quarterly, weekly, end dates', () => {
  assert.deepEqual(dueDates({ frequency: 'monthly', start_date: '2026-01-31', schedule: 'fixed', end_date: null }, '2026-01-01', '2026-04-30'),
    ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']);
  assert.deepEqual(dueDates({ frequency: 'quarterly', start_date: '2026-02-15', schedule: 'fixed', end_date: null }, '2026-06-01', '2027-01-01'),
    ['2026-08-15', '2026-11-15']);
  assert.deepEqual(dueDates({ frequency: 'weekly', start_date: '2026-11-02', schedule: 'fixed', end_date: '2026-11-20' }, '2026-11-05', '2026-12-31'),
    ['2026-11-09', '2026-11-16']);
  assert.deepEqual(dueDates({ frequency: 'monthly', start_date: '2026-09-30', schedule: 'last_working_day', end_date: null }, '2026-08-01', '2026-12-31'),
    ['2026-09-30', '2026-10-30', '2026-11-30', '2026-12-31']);
  assert.deepEqual(dueDates({ frequency: 'annually', start_date: '2024-02-29', schedule: 'fixed', end_date: null }, '2025-01-01', '2028-12-31'),
    ['2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29']);
});

test('monthly equivalents for annual and quarterly bills', () => {
  assert.equal(monthlyEquivalent(12000, 'annually'), 1000);
  assert.equal(monthlyEquivalent(30000, 'quarterly'), 10000);
  assert.equal(monthlyEquivalent(1000, 'weekly'), 4333);
  assert.equal(monthlyEquivalent(2000, 'four_weekly'), 2167);
});

test('subscriptions match imported transactions and detect price rises', () => {
  const { db, acc, cat, spend } = setup();
  spend('2026-07-03', 'STREAMIX.COM', 'Crest Card 1', 999, 'Subscriptions');
  spend('2026-08-04', 'STREAMIX.COM', 'Crest Card 1', 999, 'Subscriptions');
  spend('2026-09-03', 'STREAMIX.COM', 'Crest Card 1', 1199, 'Subscriptions');
  spend('2026-09-05', 'BASKETCO', 'Crest Card 1', 1199, 'Groceries'); // same amount, different merchant: must not match
  const id = createRecurring(db, { name: 'Streamix', type: 'subscription', amount: 999, frequency: 'monthly', startDate: '2026-07-03', accountId: acc('Crest Card 1'), categoryId: cat('Subscriptions') });
  const r = listRecurring(db).find((x) => x.id === id)!;
  const paid = r.history.filter((h) => h.status === 'paid').map((h) => `${h.dueDate}:${h.amount}`).sort();
  assert.deepEqual(paid, ['2026-07-03:999', '2026-08-03:999', '2026-09-03:1199']);
  assert.equal(r.amount, 1199, 'expected amount follows the latest real price');
  assert.deepEqual(r.lastChange, { date: '2026-09-03', from: 999, to: 1199 });
});

test('variable bills match any amount; fixed ones ignore wildly different amounts', () => {
  const { db, acc, cat, spend } = setup();
  spend('2026-10-05', 'BRIGHTWATT ENERGY', 'Northbank Current', 9500, 'Bills & Utilities');
  spend('2026-10-06', 'FITHUB', 'Northbank Current', 50000, 'Health & Fitness');
  const energy = createRecurring(db, { name: 'Brightwatt', matchPattern: 'brightwatt', type: 'bill', amount: 8600, variable: true, frequency: 'monthly', startDate: '2026-10-05', accountId: acc('Northbank Current'), categoryId: cat('Bills & Utilities') });
  const gym = createRecurring(db, { name: 'FitHub', type: 'bill', amount: 2500, frequency: 'monthly', startDate: '2026-10-06', accountId: acc('Northbank Current'), categoryId: cat('Health & Fitness') });
  const list = listRecurring(db);
  assert.equal(list.find((r) => r.id === energy)!.history[0].amount, 9500);
  assert.equal(list.find((r) => r.id === energy)!.amount, 8600, 'variable bills keep their typical amount');
  assert.equal(list.find((r) => r.id === gym)!.history.length, 0, '£500 is not the £29.99 gym fee');
});

test('salary on the last working day funds next month; plan shows committed and free to spend', () => {
  const { db, acc, cat, spend } = setup();
  const northbank = acc('Northbank Current');
  createTransaction(db, simpleToPostings({ kind: 'income', date: '2026-10-30', description: 'ACME LTD SALARY', accountId: northbank, categoryId: cat('Salary'), amount: 300000 }));
  createRecurring(db, { name: 'Salary', matchPattern: 'acme', type: 'income', amount: 300000, frequency: 'monthly', schedule: 'last_working_day', startDate: '2026-09-30', accountId: northbank, categoryId: cat('Salary') });
  createRecurring(db, { name: 'Rent', type: 'bill', amount: 95000, frequency: 'monthly', startDate: '2026-11-01', accountId: northbank, categoryId: cat('Rent / Housing') });
  createRecurring(db, { name: 'Car insurance', type: 'bill', amount: 48000, frequency: 'annually', startDate: '2027-03-10', accountId: northbank, categoryId: cat('Bills & Utilities') });
  createRecurring(db, { name: 'Holiday savings', type: 'saving', amount: 20000, frequency: 'monthly', startDate: '2026-11-02', accountId: northbank, transferAccountId: acc('Harbour Savings') });
  spend('2026-11-01', 'OAKLET RENT', 'Northbank Current', 95000, 'Rent / Housing');
  spend('2026-11-04', 'Basketco', 'Crest Card 1', 5000, 'Groceries');
  createTransaction(db, simpleToPostings({ kind: 'transfer', date: '2026-11-02', description: 'To Harbour', accountId: northbank, toAccountId: acc('Harbour Savings'), amount: 20000 }));
  autoMatch(db);

  const plan = monthPlan(db, '2026-11');
  assert.equal(plan.incomeExpected, 300000, 'Oct 30 salary counts in November');
  assert.equal(plan.incomeReceived, 300000);
  assert.equal(plan.billsTotal, 95000, 'annual bill not due this month');
  assert.equal(plan.billsPaid, 95000);
  assert.equal(plan.savingsTotal, 20000);
  assert.equal(plan.savingsDone, 20000);
  assert.equal(plan.otherSpending, 5000, 'rent is not double counted as other spending');
  assert.equal(plan.freeToSpend, 300000 - 95000 - 20000 - 5000);
  assert.equal(plan.monthly.bills, 95000 + 4000, 'annual insurance spread monthly');
  const oct = monthPlan(db, '2026-10');
  assert.equal(oct.incomeExpected, 300000, 'October is funded by the 30 Sept payday');
  assert.equal(oct.incomeReceived, 0, 'which was never recorded in this test');
});

test('marking paid manually records one transaction; deleting it reopens the bill', () => {
  const { db, acc, cat } = setup();
  const today = todayIso();
  const id = createRecurring(db, { name: 'Window cleaner', type: 'bill', amount: 1500, frequency: 'monthly', startDate: today, accountId: acc('Lark'), categoryId: cat('Miscellaneous') });
  setPayment(db, id, { dueDate: today, status: 'paid', record: {} });
  let occ = occurrences(db, today, today).find((o) => o.recurringId === id)!;
  assert.equal(occ.status, 'paid');
  const txnId = occ.transactionId!;
  const txn = db.prepare('SELECT kind, description FROM transactions WHERE id = ?').get(txnId) as any;
  assert.equal(txn.kind, 'expense');
  deleteTransaction(db, txnId);
  occ = occurrences(db, today, today).find((o) => o.recurringId === id)!;
  assert.notEqual(occ.status, 'paid');
  setPayment(db, id, { dueDate: today, status: 'skipped' });
  assert.equal(occurrences(db, today, today).find((o) => o.recurringId === id)!.status, 'skipped');
});

test('overdue only after a grace period', () => {
  const { db, acc, cat } = setup();
  const today = todayIso();
  const id = createRecurring(db, { name: 'Council tax', type: 'bill', amount: 16200, frequency: 'weekly', startDate: addDays(today, -14), accountId: acc('Northbank Current'), categoryId: cat('Bills & Utilities') });
  const statuses = occurrences(db, addDays(today, -14), addDays(today, 7)).filter((o) => o.recurringId === id).map((o) => o.status);
  assert.deepEqual(statuses, ['overdue', 'overdue', 'due', 'upcoming']);
});

test('suggests regular payments found in history', () => {
  const { db, spend } = setup();
  const base = addDays(todayIso(), -100);
  for (let i = 0; i < 4; i++) spend(addDays(base, i * 30), 'TUNEBOX UK', 'Crest Card 1', 1199, 'Subscriptions');
  for (let i = 0; i < 12; i++) spend(addDays(base, i * 8), 'BASKETCO STORES', 'Crest Card 1', 1500 + i * 700, 'Groceries');
  const s = suggestRecurring(db);
  assert.equal(s.length, 1);
  assert.equal(s[0].name, 'Tunebox');
  assert.equal(s[0].type, 'subscription');
  assert.equal(s[0].frequency, 'monthly');
  assert.equal(s[0].startDate, base, 'starts at the first payment so history is matched');
});

test('bonuses: inside the salary payment, paid separately, or expected as a one-off', async () => {
  const { db, acc, cat } = setup();
  const { takeHome } = await import('../server/budgets.ts');
  const northbank = acc('Northbank Current');
  const pay = (date: string, amount: number, desc = 'ACME SALARY', category = 'Salary') =>
    createTransaction(db, simpleToPostings({ kind: 'income', date, description: desc, accountId: northbank, categoryId: cat(category), amount }));
  pay('2026-08-28', 240000);
  pay('2026-09-30', 240000);
  pay('2026-10-30', 365000); // bonus included in October's pay
  pay('2026-10-30', 50000, 'ACME BONUS', 'Bonuses'); // and a separate bonus payment the same day
  const id = createRecurring(db, { name: 'Acme Salary', matchPattern: 'acme salary', type: 'income', amount: 240000, frequency: 'monthly', schedule: 'last_working_day', startDate: '2026-08-31', accountId: northbank, categoryId: cat('Salary') });
  const r = listRecurring(db).find((x) => x.id === id)!;
  assert.equal(r.history.filter((h) => h.status === 'paid').length, 3, 'the bigger payment still matches (and 28 Aug counts from a 31 Aug start)');
  assert.equal(r.amount, 240000, 'one bonus month is not a pay rise');
  assert.equal(r.priceChanges.length, 0, 'pay changes are not flagged as price rises');
  assert.deepEqual(r.extras.map((e) => e.extra), [365000 - 240000]);
  assert.equal(takeHome(db, '2026-11-12').amount, 240000, 'budgets use base pay');

  const nov = monthPlan(db, '2026-11');
  assert.equal(nov.incomeExpected, 365000 + 50000, 'Oct 30 pay (bonus included) and the separate bonus both fund November');
  assert.equal(nov.incomeExtra, 365000 - 240000 + 50000);

  // An expected one-off bonus shows up once, and isn't regular monthly income or take-home pay.
  createRecurring(db, { name: 'Annual bonus', type: 'income', amount: 300000, frequency: 'annually', startDate: '2027-03-31', endDate: '2027-03-31', accountId: northbank, categoryId: cat('Bonuses') });
  const b = listRecurring(db).find((x) => x.name === 'Annual bonus')!;
  assert.equal(b.oneOff, true);
  assert.equal(b.monthly, 0);
  assert.equal(b.next!.dueDate, '2027-03-31');
  assert.equal(monthPlan(db, '2026-12').monthly.income, 240000);
  assert.equal(takeHome(db, '2026-11-12').amount, 240000);
  assert.equal(monthPlan(db, '2027-04').incomeExpected, 240000 + 300000, 'a March payday bonus funds April with the salary');
});

test('two months in a row at a new amount is a pay rise', () => {
  const { db, acc, cat } = setup();
  const northbank = acc('Northbank Current');
  for (const [d, a] of [['2026-07-31', 240000], ['2026-08-28', 240000], ['2026-09-30', 250000], ['2026-10-30', 250000]] as [string, number][])
    createTransaction(db, simpleToPostings({ kind: 'income', date: d, description: 'ACME SALARY', accountId: northbank, categoryId: cat('Salary'), amount: a }));
  const id = createRecurring(db, { name: 'Salary', matchPattern: 'acme', type: 'income', amount: 240000, frequency: 'monthly', schedule: 'last_working_day', startDate: '2026-07-31', accountId: northbank, categoryId: cat('Salary') });
  assert.equal(listRecurring(db).find((x) => x.id === id)!.amount, 250000);
});

test('an untracked salary month is income, not "above usual pay"', () => {
  const { db, acc, cat } = setup();
  const northbank = acc('Northbank Current');
  createTransaction(db, simpleToPostings({ kind: 'income', date: '2026-10-30', description: 'ACME SALARY', accountId: northbank, categoryId: cat('Salary'), amount: 255000 }));
  createRecurring(db, { name: 'Acme Salary', type: 'income', amount: 240000, frequency: 'monthly', schedule: 'last_working_day', startDate: '2026-11-30', accountId: northbank, categoryId: cat('Salary') });
  const p = monthPlan(db, '2026-11');
  assert.equal(p.incomeExpected, 255000);
  assert.equal(p.incomeExtra, 0);
});
