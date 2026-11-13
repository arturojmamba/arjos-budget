import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './fixtures.ts';
import { createTransaction, simpleToPostings } from '../server/ledger.ts';
import { createCategory } from '../server/admin.ts';
import { periodFor, createBudget, updateBudget, listBudgets, suggestBudgets } from '../server/budgets.ts';
import { listTransactions } from '../server/queries.ts';
import { budgetCategoryIds } from '../server/budgets.ts';

function setup() {
  const db = testDb();
  const acc = (n: string) => (db.prepare('SELECT id FROM accounts WHERE name = ?').get(n) as { id: number }).id;
  const cat = (n: string) => (db.prepare('SELECT id FROM categories WHERE name = ?').get(n) as { id: number }).id;
  const spend = (date: string, amount: number, category: string, refund = false) =>
    createTransaction(db, simpleToPostings({ kind: 'expense', date, description: category, accountId: acc('Crest Card 1'), amount, categoryId: cat(category), refund }));
  const view = (month: string, today: string, name: string) => listBudgets(db, month, today).budgets.find((b) => b.name === name)!;
  return { db, acc, cat, spend, view };
}

test('periods: months, Monday–Sunday weeks, years', () => {
  assert.deepEqual(periodFor('monthly', '2026-11-12'), { key: '2026-11', start: '2026-11-01', end: '2026-11-30', label: 'November 2026', short: 'Nov' });
  const w = periodFor('weekly', '2026-11-12'); // Thursday
  assert.equal(w.start, '2026-11-09');
  assert.equal(w.end, '2026-11-15');
  assert.equal(periodFor('weekly', '2026-11-15').start, '2026-11-09', 'Sunday belongs to the week before');
  assert.equal(periodFor('weekly', '2026-11-16').start, '2026-11-16');
  assert.equal(periodFor('annual', '2026-11-12').end, '2026-12-31');
});

test('spending, refunds, subcategories and warnings', () => {
  const { db, cat, spend, view } = setup();
  const coffee = createCategory(db, { name: 'Coffee', kind: 'expense', parentId: cat('Eating Out') });
  createBudget(db, { name: 'Eating out', period: 'monthly', amount: 10000, categoryIds: [cat('Eating Out')] }, '2026-11-01');
  spend('2026-11-02', 6000, 'Eating Out');
  createTransaction(db, simpleToPostings({ kind: 'expense', date: '2026-11-03', description: 'Flat white', accountId: (db.prepare("SELECT id FROM accounts WHERE name = 'Crest Card 1'").get() as { id: number }).id, amount: 400, categoryId: coffee }));
  let b = view('2026-11', '2026-11-12', 'Eating out');
  assert.equal(b.spent, 6400, 'subcategory spending counts');
  assert.equal(b.status, 'ok');
  spend('2026-11-10', 2500, 'Eating Out');
  b = view('2026-11', '2026-11-12', 'Eating out');
  assert.equal(b.status, 'warn', '89% used');
  spend('2026-11-11', 2000, 'Eating Out');
  b = view('2026-11', '2026-11-12', 'Eating out');
  assert.equal(b.status, 'over');
  assert.equal(b.remaining, -900);
  spend('2026-11-12', 2000, 'Eating Out', true);
  b = view('2026-11', '2026-11-12', 'Eating out');
  assert.equal(b.spent, 8900, 'refund reduces spending');
  assert.equal(b.status, 'warn');
});

test('transfers and card repayments never touch budgets', () => {
  const { db, acc, cat, view } = setup();
  createBudget(db, { name: 'Shopping', period: 'monthly', amount: 15000, categoryIds: [cat('Shopping')] }, '2026-11-01');
  createTransaction(db, simpleToPostings({ kind: 'transfer', date: '2026-11-05', description: 'Crest payment', accountId: acc('Northbank Current'), toAccountId: acc('Crest Card 1'), amount: 50000 }));
  assert.equal(view('2026-11', '2026-11-12', 'Shopping').spent, 0);
});

test('pace: expected spend so far, projection and daily allowance', () => {
  const { db, cat, spend, view } = setup();
  createBudget(db, { name: 'Groceries', period: 'monthly', amount: 30000, categoryIds: [cat('Groceries')] }, '2026-11-01');
  spend('2026-11-05', 15000, 'Groceries');
  const b = view('2026-11', '2026-11-15', 'Groceries'); // half-way through a 30-day month
  assert.equal(b.pace!.expected, 15000);
  assert.equal(b.pace!.projected, 30000);
  assert.equal(b.pace!.daysLeft, 16);
  assert.equal(b.pace!.perDayLeft, Math.floor(15000 / 16));
  assert.equal(b.pace!.onTrack, true);
  assert.equal(view('2026-10', '2026-11-15', 'Groceries').pace, null, 'past months have no pace');
});

test('rollover carries unused money forward, never overspending', () => {
  const { db, cat, spend, view } = setup();
  createBudget(db, { name: 'Fun', period: 'monthly', amount: 10000, categoryIds: [cat('Entertainment')], rollover: true }, '2026-08-15');
  spend('2026-08-10', 4000, 'Entertainment'); // £60 unused
  spend('2026-09-10', 15000, 'Entertainment'); // £160 available, £10 unused
  spend('2026-10-10', 30000, 'Entertainment'); // £110 available, overspent by £190 → carry 0
  assert.equal(view('2026-09', '2026-09-20', 'Fun').carried, 6000);
  assert.equal(view('2026-10', '2026-10-20', 'Fun').carried, 1000);
  const nov = view('2026-11', '2026-11-12', 'Fun');
  assert.equal(nov.carried, 0);
  assert.equal(nov.available, 10000);
});

test('changing the limit keeps past months as they were (unless asked)', () => {
  const { db, cat, spend, view } = setup();
  const id = createBudget(db, { name: 'Transport', period: 'monthly', amount: 10000, categoryIds: [cat('Transport')] }, '2026-09-01');
  spend('2026-10-10', 9000, 'Transport');
  updateBudget(db, id, { name: 'Transport', period: 'monthly', amount: 12000, categoryIds: [cat('Transport')] }, '2026-11-03');
  assert.equal(view('2026-10', '2026-11-12', 'Transport').limit, 10000);
  assert.equal(view('2026-11', '2026-11-12', 'Transport').limit, 12000);
  const hist = view('2026-11', '2026-11-12', 'Transport').history;
  assert.deepEqual(hist.slice(-3).map((h) => [h.short, h.limit, h.spent]), [['Sep', 10000, 0], ['Oct', 10000, 9000], ['Nov', 12000, 0]]);
  updateBudget(db, id, { name: 'Transport', period: 'monthly', amount: 11000, categoryIds: [cat('Transport')], applyFrom: 'all' }, '2026-11-03');
  assert.equal(view('2026-10', '2026-11-12', 'Transport').limit, 11000);
});

test('weekly budgets and the month summary', () => {
  const { db, cat, spend } = setup();
  createBudget(db, { name: 'Lunches', period: 'weekly', amount: 3500, categoryIds: [cat('Eating Out')] }, '2026-11-02');
  createBudget(db, { name: 'Groceries', period: 'monthly', amount: 25000, categoryIds: [cat('Groceries')] }, '2026-11-01');
  spend('2026-11-03', 1200, 'Eating Out'); // last week
  spend('2026-11-10', 900, 'Eating Out'); // this week
  spend('2026-11-11', 8000, 'Groceries');
  spend('2026-11-11', 3000, 'Shopping'); // not budgeted
  spend('2026-11-01', 95000, 'Rent / Housing'); // fixed: planned as a bill, not "unbudgeted"
  const r = listBudgets(db, '2026-11', '2026-11-12');
  const lunches = r.budgets.find((b) => b.name === 'Lunches')!;
  assert.equal(lunches.spent, 900, 'only this week');
  assert.equal(lunches.current.label, '9 Nov – 15 Nov');
  assert.equal(r.summary.total, 25000 + Math.round((3500 * 30) / 7));
  assert.equal(r.summary.spent, 8000 + 2100);
  assert.equal(r.summary.unbudgeted, 3000);
  assert.equal(r.summary.unbudgetedCategories[0].name, 'Shopping');
});

test('suggestions average the last three months and skip fixed costs', () => {
  const { db, cat, spend } = setup();
  for (const m of ['08', '09', '10']) {
    spend(`2026-${m}-05`, 21000 + Number(m) * 100, 'Groceries');
    spend(`2026-${m}-06`, 115000, 'Rent / Housing');
  }
  spend('2026-09-07', 4500, 'Entertainment');
  createBudget(db, { name: 'Shopping', period: 'monthly', amount: 1000, categoryIds: [cat('Shopping')] }, '2026-11-01');
  const s = suggestBudgets(db, '2026-11-12');
  assert.deepEqual(s.map((x) => x.name), ['Groceries', 'Entertainment']);
  assert.equal(s[0].average, 21900);
  assert.equal(s[0].suggested, 22500, 'rounded up to £25');
  assert.equal(s[1].suggested, 2000, '£15 average → £20');
});

test('transactions can be filtered by budget', () => {
  const { db, cat, spend } = setup();
  const id = createBudget(db, { name: 'Going out', period: 'monthly', amount: 20000, categoryIds: [cat('Eating Out'), cat('Entertainment')] }, '2026-11-01');
  spend('2026-11-02', 1000, 'Eating Out');
  spend('2026-11-03', 1000, 'Entertainment');
  spend('2026-11-04', 1000, 'Groceries');
  assert.equal(listTransactions(db, { categoryIds: budgetCategoryIds(db, id) }).total, 2);
});

test('overlapping budgets are not double counted in the month total', () => {
  const { db, cat, spend } = setup();
  createBudget(db, { name: 'Eating out', period: 'monthly', amount: 20000, categoryIds: [cat('Eating Out')] }, '2026-11-01');
  createBudget(db, { name: 'Lunches', period: 'weekly', amount: 2500, categoryIds: [cat('Eating Out')] }, '2026-11-02');
  spend('2026-11-10', 3000, 'Eating Out');
  const r = listBudgets(db, '2026-11', '2026-11-12');
  assert.equal(r.summary.total, 20000, 'weekly sub-limit not added');
  assert.equal(r.summary.spent, 3000, 'spending counted once');
  assert.equal(r.budgets.find((b) => b.name === 'Lunches')!.status, 'over');
});

test('budgets as a % of take-home pay follow pay changes without rewriting the past', async () => {
  const { db, acc, cat, view } = setup();
  const { createRecurring } = await import('../server/recurring.ts');
  const { takeHome, updateGuide, budgetGuide } = await import('../server/budgets.ts');
  assert.equal(takeHome(db, '2026-11-12').source, 'none');
  assert.throws(() => createBudget(db, { name: 'Food', period: 'monthly', percent: 1000, categoryIds: [cat('Groceries')] }, '2026-10-01'), /take-home pay/);

  createRecurring(db, { name: 'Salary', type: 'income', amount: 300000, frequency: 'monthly', schedule: 'last_working_day', startDate: '2026-09-30', accountId: acc('Northbank Current'), categoryId: cat('Salary') });
  assert.deepEqual([takeHome(db, '2026-11-12').amount, takeHome(db, '2026-11-12').source], [300000, 'salary']);
  createBudget(db, { name: 'Food', period: 'monthly', percent: 1000, categoryIds: [cat('Groceries')] }, '2026-10-01');
  createBudget(db, { name: 'Lunch', period: 'weekly', percent: 250, categoryIds: [cat('Eating Out')] }, '2026-10-01');
  assert.equal(view('2026-10', '2026-10-15', 'Food').limit, 30000, '10% of £3,000');
  assert.equal(view('2026-10', '2026-10-15', 'Lunch').limit, Math.round((7500 * 12) / 52), '2.5% of monthly pay, per week');
  assert.equal(view('2026-10', '2026-10-15', 'Food').percent, 1000);

  // Pay rise in November: new limit from November, October unchanged.
  db.exec("UPDATE recurring SET amount = 350000 WHERE name = 'Salary'");
  assert.equal(view('2026-11', '2026-11-12', 'Food').limit, 35000);
  assert.equal(view('2026-10', '2026-11-12', 'Food').limit, 30000);

  // Manual take-home overrides the salary entry.
  updateGuide(db, { takeHome: 400000 });
  assert.equal(takeHome(db).source, 'manual');
  assert.equal(view('2026-11', new Date().toISOString().slice(0, 10) > '2026-11-30' ? '2026-11-12' : '2026-11-12', 'Food').limit >= 35000, true);

  // Guide: default and custom percentages
  const g = budgetGuide(db, '2026-11', '2026-11-12');
  const groceries = g.categories.find((c) => c.name === 'Groceries')!;
  assert.equal(groceries.percent, 1000);
  assert.equal(groceries.budgetName, 'Food');
  assert.ok(!g.categories.some((c) => c.name === 'Rent / Housing'), 'fixed costs are not in the day-to-day guide');
  updateGuide(db, { percents: { [cat('Groceries')]: 1200 } });
  assert.equal(budgetGuide(db, '2026-11', '2026-11-12').categories.find((c) => c.name === 'Groceries')!.percent, 1200);
  assert.throws(() => updateGuide(db, { split: { needs: 5000, wants: 3000, savings: 1000 } }), /100%/);
  updateGuide(db, { reset: true });
  assert.equal(budgetGuide(db, '2026-11', '2026-11-12').categories.find((c) => c.name === 'Groceries')!.percent, 1000);
});

test('savings goals count money moved into the account, not spending', () => {
  const { db, acc, spend, view } = setup();
  const harbour = acc('Harbour Savings');
  const northbank = acc('Northbank Current');
  createBudget(db, { name: 'Emergency fund', period: 'monthly', amount: 50000, kind: 'saving', accountId: harbour, categoryIds: [] }, '2026-03-01');
  createBudget(db, { name: 'Food', period: 'monthly', amount: 30000, categoryIds: [(db.prepare("SELECT id FROM categories WHERE name='Groceries'").get() as any).id] }, '2026-03-01');
  const move = (date: string, amount: number, from = northbank, to = harbour) =>
    createTransaction(db, simpleToPostings({ kind: 'transfer', date, description: 'Save', accountId: from, toAccountId: to, amount }));
  move('2026-03-02', 30000);
  move('2026-03-10', 5000, harbour, northbank); // a withdrawal takes it back off
  spend('2026-03-05', 4000, 'Groceries');
  const g = view('2026-03', '2026-03-12', 'Emergency fund');
  assert.equal(g.kind, 'saving');
  assert.equal(g.account?.id, harbour);
  assert.equal(g.spent, 25000);
  assert.equal(g.remaining, 25000);
  assert.notEqual(g.status, 'over');
  const list = listBudgets(db, '2026-03', '2026-03-12');
  assert.equal(list.summary.total, 30000, 'goals are not part of the spending total');
  assert.equal(list.summary.spent, 4000);
  assert.deepEqual(list.savings, { target: 50000, saved: 25000, count: 1 });
  move('2026-03-20', 30000);
  assert.equal(view('2026-03', '2026-03-21', 'Emergency fund').status, 'ok');
  assert.throws(() => createBudget(db, { name: 'Card', period: 'monthly', amount: 100, kind: 'saving', accountId: acc('Crest Card 1'), categoryIds: [] }), /savings, pots and investment/);
});
