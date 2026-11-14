import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './fixtures.ts';
import { createTransaction, simpleToPostings } from '../server/ledger.ts';
import { createRecurring } from '../server/recurring.ts';
import { createGoal } from '../server/goals.ts';
import { createBudget, listBudgets } from '../server/budgets.ts';
import { createAccount } from '../server/admin.ts';
import { saveShares } from '../server/shares.ts';
import { plan, monthPlan } from '../server/plan.ts';
import { payday } from '../server/payday.ts';
import { perMonth } from '../server/money.ts';

/** One month with every kind of commitment: shared subscription, goal, debt repayment, weekly budget, bill covered by a budget. */
function setup() {
  const db = testDb();
  db.exec("UPDATE accounts SET anchor_balance = 0, anchor_date = '2025-12-31'");
  const acc = (n: string) => (db.prepare('SELECT id FROM accounts WHERE name = ?').get(n) as { id: number }).id;
  const cat = (n: string, kind = 'expense') => (db.prepare('SELECT id FROM categories WHERE name = ? AND kind = ?').get(n, kind) as { id: number }).id;
  const northbank = acc('Northbank Current'), harbour = acc('Harbour Savings');
  const loan = createAccount(db, { name: 'Car loan', type: 'loan', balance: -500000, balanceDate: '2025-12-31' });
  createRecurring(db, { name: 'Salary', type: 'income', amount: 300000, frequency: 'monthly', startDate: '2026-01-30', schedule: 'last_working_day', accountId: northbank, categoryId: cat('Salary', 'income') });
  createRecurring(db, { name: 'Rent', type: 'bill', amount: 100000, frequency: 'monthly', startDate: '2026-01-01', accountId: northbank, categoryId: cat('Rent / Housing') });
  const music = createRecurring(db, { name: 'Family music', type: 'subscription', amount: 2199, frequency: 'monthly', startDate: '2026-01-15', accountId: northbank, categoryId: cat('Subscriptions') });
  saveShares(db, music, [{ name: 'Sam Rivers', amount: 600 }]);
  createRecurring(db, { name: 'Car loan', type: 'saving', amount: 28500, frequency: 'monthly', startDate: '2026-01-20', accountId: northbank, transferAccountId: loan });
  createGoal(db, { name: 'Emergency fund', accountId: harbour, mode: 'rest', monthlyTarget: 20000 } as any);
  createBudget(db, { name: 'Housing', period: 'monthly', amount: 100000, categoryIds: [cat('Rent / Housing')] } as any, '2026-01-01');
  createBudget(db, { name: 'Lunches', period: 'weekly', amount: 3500, categoryIds: [cat('Eating Out')] } as any, '2026-01-01');
  return { db, northbank, harbour, loan, cat };
}

test('shared bills count your share; savings include goals; debts are their own series', () => {
  const { db } = setup();
  const p = plan(db, '2026-11', '2026-11-14');
  assert.equal(p.bills.items.find((b) => b.name === 'Family music')!.amount, 2199 - 600, 'your share');
  assert.equal(p.bills.planned, 100000 + 1599);
  assert.equal(p.debts.planned, 28500);
  assert.equal(p.savings.items.find((s) => s.name === 'Emergency fund')!.amount, 20000);
  assert.equal(p.savings.planned, 20000);
  assert.equal(p.committed, 100000 + 1599 + 28500 + 20000);
  assert.equal(p.bills.items.find((b) => b.name === 'Rent')!.coveredBy, 'Housing');
});

test('a saving is done when the money arrives, including just after the payday that funds the month', () => {
  const { db, northbank, harbour } = setup();
  assert.equal(plan(db, '2026-11', '2026-11-14').savings.done, 0);
  createTransaction(db, simpleToPostings({ kind: 'transfer', date: '2026-10-31', description: 'To Harbour', accountId: northbank, toAccountId: harbour, amount: 20000 }));
  const p = plan(db, '2026-11', '2026-11-14');
  assert.equal(p.savings.done, 20000, 'moved the day after the 30 October payday, for November');
  assert.equal(plan(db, '2026-10', '2026-11-14').savings.done, 0, 'not October’s');
});

test('Overview, Bills and Payday agree on what November is committed to', () => {
  const { db } = setup();
  const overview = monthPlan(db, '2026-11', '2026-11-14');
  const day = payday(db, '2026-10-30', '2026-11-14');
  assert.equal(day.period, '2026-11');
  assert.equal(day.plan.debts.total, overview.debtTotal);
  assert.equal(day.plan.savings.total, overview.savingsTotal);
  // Payday counts rent inside the Housing budget; Overview counts it as a bill. Same items either way.
  assert.equal(day.plan.bills.total + 100000, overview.billsTotal);
  assert.equal(day.plan.bills.items.length, plan(db, '2026-11', '2026-11-14').bills.items.length);
});

test('weekly and yearly amounts become a month the same way everywhere', () => {
  const { db } = setup();
  assert.equal(perMonth(3500, 'weekly'), Math.round((3500 * 52) / 12));
  assert.equal(perMonth(12000, 'annual'), 1000);
  const lunches = payday(db, '2026-10-30', '2026-11-14').plan.budgets.items.find((b) => b.name === 'Lunches')!;
  assert.equal(lunches.limit, perMonth(3500, 'weekly'));
  const summary = listBudgets(db, '2026-11', '2026-11-14').summary;
  assert.equal(summary.total, 100000 + perMonth(3500, 'weekly'));
});

test('the Bills page monthly figures come from the plan, with savings and debts apart', () => {
  const { db } = setup();
  const m = monthPlan(db, '2026-11', '2026-11-14').monthly;
  assert.equal(m.subscriptions, 1599);
  assert.equal(m.debts, 28500);
  assert.equal(m.savings, 0, 'goals aren’t regular items in Bills and income');
});
