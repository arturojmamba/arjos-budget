import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './fixtures.ts';
import { createTransaction, simpleToPostings } from '../server/ledger.ts';
import { createRecurring } from '../server/recurring.ts';
import { createGoal } from '../server/goals.ts';
import { createBudget } from '../server/budgets.ts';
import { payday, paydayStatus, setCheck, setPaydayBudgets, completePayday, paydayLogs, addPaydayItem, currentCycle } from '../server/payday.ts';

function setup() {
  const db = testDb();
  db.exec("UPDATE accounts SET anchor_balance = 0, anchor_date = '2025-12-31'");
  const acc = (n: string) => (db.prepare('SELECT id FROM accounts WHERE name = ?').get(n) as { id: number }).id;
  const cat = (n: string, kind = 'expense') => (db.prepare('SELECT id FROM categories WHERE name = ? AND kind = ?').get(n, kind) as { id: number }).id;
  const northbank = acc('Northbank Current'), harbour = acc('Harbour Savings');
  createRecurring(db, { name: 'Salary', type: 'income', amount: 240000, frequency: 'monthly', startDate: '2026-01-30', schedule: 'last_working_day', accountId: northbank, categoryId: cat('Salary', 'income') });
  createRecurring(db, { name: 'Rent', type: 'bill', amount: 30000, frequency: 'monthly', startDate: '2026-01-30', schedule: 'last_working_day', accountId: northbank, categoryId: cat('Rent / Housing') });
  createRecurring(db, { name: 'Gym', type: 'bill', amount: 3000, frequency: 'monthly', startDate: '2026-01-06', accountId: northbank, categoryId: cat('Health & Fitness') });
  createGoal(db, { name: 'Emergency fund', accountId: harbour, mode: 'rest', monthlyTarget: 10000 } as any);
  createBudget(db, { name: 'Eating Out', period: 'monthly', amount: 35000, categoryIds: [cat('Eating Out')] } as any, '2026-09-01');
  createBudget(db, { name: 'Housing', period: 'monthly', amount: 30000, categoryIds: [cat('Rent / Housing')] } as any, '2026-09-01');
  return { db, northbank, harbour, cat };
}

test('the cycle is the last payday, and it funds the next month', () => {
  const { db } = setup();
  assert.equal(currentCycle(db, '2026-11-13'), '2026-10-30');
  assert.equal(currentCycle(db, '2026-11-30'), '2026-11-30');
  const r = payday(db, null, '2026-11-13');
  assert.equal(r.period, '2026-11');
  assert.equal(r.closing, '2026-10');
  assert.equal(r.next, '2026-11-30');
  assert.equal(payday(db, '2026-12-05', '2026-11-13').cycle, '2026-12-31', 'any date snaps to that month\'s payday');
});

test('pay check, plan arithmetic, and bills covered by a budget are not counted twice', () => {
  const { db, northbank, cat } = setup();
  createTransaction(db, simpleToPostings({ kind: 'income', date: '2026-10-30', description: 'ACME LTD', accountId: northbank, amount: 230000, categoryId: cat('Salary', 'income') }));
  const r = payday(db, '2026-10-30', '2026-11-02');
  assert.equal(r.pay.arrived, true);
  assert.equal(r.pay.diff, 230000 - 240000);
  const rent = r.plan.bills.items.find((b) => b.name === 'Rent')!;
  assert.equal(rent.date, '2026-10-30', 'rent on payday comes out of this pay');
  assert.equal(rent.coveredBy, 'Housing');
  const gym = r.plan.bills.items.find((b) => b.name === 'Gym')!;
  assert.equal(gym.coveredBy, null);
  assert.equal(r.plan.savings.total, 10000);
  assert.equal(r.plan.budgets.total, 65000);
  assert.equal(r.plan.buffer, 230000 - r.plan.bills.total - r.plan.debts.total - 10000 - 65000);
  const nov = payday(db, '2026-11-30', '2026-11-30');
  assert.equal(nov.plan.bills.items.find((b) => b.name === 'Rent')!.coveredBy, 'Housing');
  assert.equal(nov.plan.bills.total, 3000, 'rent sits inside the Housing budget');
});

test('moves tick themselves off when the transfer is imported; skip and checks', () => {
  const { db, northbank, harbour } = setup();
  let r = payday(db, '2026-10-30', '2026-11-02');
  assert.equal(r.moves.find((m) => m.key.startsWith('goal'))!.status, 'waiting');
  createTransaction(db, simpleToPostings({ kind: 'transfer', date: '2026-10-31', description: 'To Harbour', accountId: northbank, toAccountId: harbour, amount: 10000 }));
  r = payday(db, '2026-10-30', '2026-11-02');
  const m = r.moves.find((x) => x.key.startsWith('goal'))!;
  assert.equal(m.status, 'done');
  assert.equal(r.steps.moves, true, 'all moves done completes the step');
  setCheck(db, r.cycle, 'pay', true);
  assert.equal(payday(db, '2026-10-30', '2026-11-02').steps.pay, true);
  assert.equal(paydayStatus(db, '2026-11-02').stepsDone, 1);
  assert.throws(() => setCheck(db, r.cycle, 'bad key!', true), /Unknown step/);
});

test('budgets set on payday apply from the month the pay funds', () => {
  const { db } = setup();
  const id = (db.prepare("SELECT id FROM budgets WHERE name = 'Eating Out'").get() as { id: number }).id;
  setPaydayBudgets(db, '2026-10-30', { [id]: 49000 });
  assert.equal(payday(db, '2026-10-30', '2026-11-02').budgets.find((b) => b.id === id)!.setLimit, 49000);
  const amounts = db.prepare('SELECT effective_date, amount FROM budget_amounts WHERE budget_id = ? ORDER BY effective_date').all(id) as any[];
  assert.deepEqual(amounts.map((a) => [a.effective_date, a.amount]), [['2026-09-01', 35000], ['2026-11-01', 49000]]);
  assert.throws(() => setPaydayBudgets(db, '2026-10-30', { [id]: 0 }), /more than £0/);
});

test('your own steps, finishing, and the log', () => {
  const { db } = setup();
  const itemId = addPaydayItem(db, 'Pay church');
  let r = payday(db, '2026-10-30', '2026-11-02');
  assert.deepEqual(r.items, [{ id: itemId, text: 'Pay church', done: false }]);
  setCheck(db, r.cycle, `item:${itemId}`, true);
  assert.equal(payday(db, '2026-10-30', '2026-11-02').items[0].done, true);
  completePayday(db, '2026-10-30', '2026-11-02');
  r = payday(db, '2026-10-30', '2026-11-02');
  assert.ok(r.completedAt);
  const logs = paydayLogs(db, '2026-11-02');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].period, '2026-11');
  assert.equal(logs[0].planned.plan.budgets, 65000);
  assert.equal(paydayStatus(db, '2026-11-02').show, false);
});
