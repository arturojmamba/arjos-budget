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

test('a saving is done when new money arrives in the calendar month', () => {
  const { db, northbank, harbour } = setup();
  assert.equal(plan(db, '2026-11', '2026-11-14').savings.done, 0);
  createTransaction(db, simpleToPostings({ kind: 'transfer', date: '2026-10-31', description: 'To Harbour', accountId: northbank, toAccountId: harbour, amount: 5000 }));
  createTransaction(db, simpleToPostings({ kind: 'transfer', date: '2026-11-03', description: 'To Harbour', accountId: northbank, toAccountId: harbour, amount: 20000 }));
  const p = plan(db, '2026-11', '2026-11-14');
  assert.equal(p.savings.done, 20000, '3 November counts for November');
  assert.equal(p.savings.saved, 20000);
  assert.equal(plan(db, '2026-10', '2026-11-14').savings.saved, 5000, '31 October counts for October, like Transactions and Reports');
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

test('savings count new money only: moving between your own savings accounts is not saving, and payday-day money stays in its calendar month', () => {
  const { db, northbank, harbour, cat } = setup();
  const acc = (n: string) => (db.prepare('SELECT id FROM accounts WHERE name = ?').get(n) as { id: number }).id;
  const isa = acc('Trading 212 ISA');
  createGoal(db, { name: 'ISA', accountId: isa, mode: 'rest', monthlyTarget: 7500 } as any);
  const move = (date: string, from: number, to: number, amount: number) =>
    createTransaction(db, simpleToPostings({ kind: 'transfer', date, description: 'Move', accountId: from, toAccountId: to, amount }));
  move('2026-10-30', northbank, harbour, 25000); // payday: counts for October, by calendar month
  move('2026-11-02', northbank, isa, 7500);       // £75 put in
  move('2026-11-08', harbour, isa, 10000);        // £100 moved from savings to the ISA: not new saving
  const p = plan(db, '2026-11', '2026-11-14');
  assert.equal(p.savings.saved, 7500, 'only the £75 of new money, the same as Transactions and Reports');
  assert.equal(p.savings.done, 7500);
  assert.equal(p.savings.items.find((s) => s.name === 'ISA')!.done, 7500);
  assert.equal(p.savings.items.find((s) => s.name === 'Emergency fund')!.done, 0, 'moving £100 out of it to the ISA isn’t saving into it either');
  void cat;
});

test('saving more than planned still counts against Free to spend', () => {
  const { db, northbank, harbour } = setup();
  createTransaction(db, simpleToPostings({ kind: 'transfer', date: '2026-11-03', description: 'To Harbour', accountId: northbank, toAccountId: harbour, amount: 50000 }));
  const p = plan(db, '2026-11', '2026-11-14');
  assert.equal(p.savings.planned, 20000);
  assert.equal(p.savings.saved, 50000);
  assert.equal(p.committed, p.bills.planned + 50000 + p.debts.planned);
});

test('every This month figure equals the transactions its link opens', async () => {
  const { db, northbank, cat } = setup();
  const { listTransactions } = await import('../server/queries.ts');
  const { autoMatch } = await import('../server/recurring.ts');
  createTransaction(db, simpleToPostings({ kind: 'expense', date: '2026-11-15', description: 'FAMILY MUSIC', accountId: northbank, amount: 2199, categoryId: cat('Subscriptions') }));
  createTransaction(db, simpleToPostings({ kind: 'expense', date: '2026-11-05', description: 'Corner shop', accountId: northbank, amount: 1250, categoryId: cat('Groceries') }));
  autoMatch(db);
  const p = monthPlan(db, '2026-11', '2026-11-20');
  const L = (f: any) => listTransactions(db, { period: '2026-11', limit: 1000, ...f });
  assert.equal(L({ linked: 'bills' }).totals.out, 2199, 'bill payments linked');
  assert.equal(L({ kind: 'expense', linked: 'not-bills' }).totals.out, p.otherSpending, 'everyday spending');
  assert.equal(L({ kind: 'expense' }).totals.out, p.otherSpending + 2199, 'everyday + bills = all spending');
});

test('a bill marked paid by hand gets linked to its transaction, even on another account', async () => {
  const db = testDb();
  const acc = (n: string) => (db.prepare('SELECT id FROM accounts WHERE name = ?').get(n) as { id: number }).id;
  const cat = (n: string) => (db.prepare("SELECT id FROM categories WHERE name = ? AND kind = 'expense'").get(n) as { id: number }).id;
  const { setPayment, autoMatch } = await import('../server/recurring.ts');
  const card = (db.prepare("SELECT id FROM accounts WHERE type = 'credit_card' ORDER BY id").get() as { id: number }).id;
  const apple = createRecurring(db, { name: 'APPLE.COM/BILL', type: 'subscription', amount: 899, frequency: 'monthly', startDate: '2026-11-07', accountId: acc('Northbank Current'), categoryId: cat('Subscriptions') });
  setPayment(db, apple, { dueDate: '2026-11-07', status: 'paid' } as any);
  const t = createTransaction(db, simpleToPostings({ kind: 'expense', date: '2026-11-07', description: 'APPLE.COM/BILL HOLLYHILL', accountId: card, amount: 899, categoryId: cat('Subscriptions') }));
  autoMatch(db);
  const row = db.prepare('SELECT transaction_id FROM recurring_payments WHERE recurring_id = ? AND due_date = ?').get(apple, '2026-11-07') as { transaction_id: number };
  assert.equal(row.transaction_id, t, 'linked, so it isn’t counted twice');
  assert.equal(monthPlan(db, '2026-11', '2026-11-14').otherSpending, 0, 'not in everyday spending');
});
