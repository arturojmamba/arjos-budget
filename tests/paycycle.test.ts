import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './fixtures.ts';
import { createTransaction, simpleToPostings } from '../server/ledger.ts';
import { createRecurring, occurrences } from '../server/recurring.ts';
import { payCycle, paydayIn, fundedMonth, yourPay } from '../server/paycycle.ts';
import { payday } from '../server/payday.ts';

function setup() {
  const db = testDb();
  const acc = (n: string) => (db.prepare('SELECT id FROM accounts WHERE name = ?').get(n) as { id: number }).id;
  const cat = (n: string, kind = 'expense') => (db.prepare('SELECT id FROM categories WHERE name = ? AND kind = ?').get(n, kind) as { id: number }).id;
  const northbank = acc('Northbank Current');
  const salary = (schedule: 'last_working_day' | 'fixed', startDate: string, categoryId = cat('Salary', 'income')) =>
    createRecurring(db, { name: 'Salary', type: 'income', amount: 240000, frequency: 'monthly', startDate, schedule, accountId: northbank, categoryId });
  return { db, northbank, cat, salary };
}

test('paydays on the last working day skip weekends and bank holidays (Easter, Christmas)', () => {
  const { db, salary } = setup();
  salary('last_working_day', '2024-01-31');
  const pay = yourPay(db);
  assert.equal(paydayIn('2024-03', pay), '2024-03-28', 'Good Friday 29 March 2024');
  assert.equal(paydayIn('2026-05', pay), '2026-05-29', 'Sunday 31st, Friday the 29th');
  assert.equal(paydayIn('2022-12', pay), '2022-12-30');
});

test('your pay on the last working day funds the next month; the cycle runs payday to payday', () => {
  const { db, salary } = setup();
  salary('last_working_day', '2026-01-30');
  const c = payCycle(db, '2026-11-14');
  assert.deepEqual([c.hasPay, c.start, c.end, c.previous, c.fundedMonth], [true, '2026-10-30', '2026-11-30', '2026-09-30', '2026-11']);
  assert.equal(c.daysLeft, 16);
  assert.equal(c.progress, 15.5 / 31, "15 days in, today counted as half");
});

test('a fixed mid-month salary funds the month it lands in', () => {
  const { db, salary } = setup();
  salary('fixed', '2026-01-15');
  const c = payCycle(db, '2026-11-20');
  assert.deepEqual([c.start, c.end, c.fundedMonth], ['2026-11-15', '2026-12-15', '2026-11']);
  assert.equal(fundedMonth(db, '2026-11-15'), '2026-11');
  assert.equal(payday(db, null, '2026-11-20').period, '2026-11', 'Payday agrees');
});

test('with no pay set up, the cycle is the calendar month', () => {
  const { db } = setup();
  const c = payCycle(db, '2026-11-14');
  assert.deepEqual([c.hasPay, c.start, c.end, c.fundedMonth], [false, '2026-11-01', '2026-11-30', '2026-11']);
  assert.equal(c.daysLeft, 17, 'counting today');
});

test('your pay rolls forward even if its category is unticked; other income follows its tick', () => {
  const { db, northbank, cat, salary } = setup();
  const salaryCat = cat('Salary', 'income');
  db.prepare('UPDATE categories SET roll_forward = 0 WHERE id = ?').run(salaryCat);
  salary('last_working_day', '2026-01-30', salaryCat);
  const income = (date: string, categoryId: number) =>
    createTransaction(db, simpleToPostings({ kind: 'income', date, description: 'x', accountId: northbank, amount: 1000, categoryId }));
  const period = (id: number) => (db.prepare('SELECT period FROM transactions WHERE id = ?').get(id) as { period: string }).period;
  assert.equal(period(income('2026-11-30', salaryCat)), '2026-12', 'your pay');
  db.prepare("UPDATE categories SET roll_forward = 1 WHERE name = 'Bonuses' AND kind = 'income'").run();
  assert.equal(period(income('2026-11-29', cat('Bonuses', 'income'))), '2026-12', 'a bonus whose category is ticked');
  assert.equal(period(income('2026-11-29', cat('Interest', 'income'))), '2026-11', 'other income without the tick');
  assert.equal(period(income('2026-11-10', salaryCat)), '2026-11', 'early in the month stays put');
  const occ = occurrences(db, '2026-11-01', '2026-11-30').find((o) => o.type === 'income')!;
  assert.equal(occ.period, '2026-12', 'Bills agrees on the expected pay');
});

test('Overview and Payday get the same cycle', () => {
  const { db, salary } = setup();
  salary('last_working_day', '2026-01-30');
  const c = payCycle(db, '2026-11-14');
  const p = payday(db, null, '2026-11-14');
  assert.deepEqual([p.cycle, p.next, p.previous, p.period, p.progress], [c.start, c.end, c.previous, c.fundedMonth, c.progress]);
});
