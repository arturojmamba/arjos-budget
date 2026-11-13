import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './fixtures.ts';
import { createTransaction, simpleToPostings } from '../server/ledger.ts';
import { trends, merchants, explore, compare, netWorthHistory, yearReview, yearRange } from '../server/reports.ts';

function setup() {
  const db = testDb();
  db.exec("UPDATE accounts SET anchor_balance = 0, anchor_date = '2024-12-31'");
  const acc = (n: string) => (db.prepare('SELECT id FROM accounts WHERE name = ?').get(n) as { id: number }).id;
  const cat = (n: string) => (db.prepare('SELECT id FROM categories WHERE name = ? AND parent_id IS NULL').get(n) as { id: number }).id;
  const northbank = acc('Northbank Current');
  const spend = (date: string, amount: number, category: string, description = category) =>
    createTransaction(db, simpleToPostings({ kind: 'expense', date, description, accountId: northbank, categoryId: cat(category), amount }));
  const earn = (date: string, amount: number) => createTransaction(db, simpleToPostings({ kind: 'income', date, description: 'Salary', accountId: northbank, categoryId: cat('Salary'), amount }));
  const move = (date: string, amount: number, to: string) => createTransaction(db, simpleToPostings({ kind: 'transfer', date, description: 'Move', accountId: northbank, toAccountId: acc(to), amount }));
  return { db, acc, cat, spend, earn, move };
}

test('trends: per-category months, averages and what stood out', () => {
  const { db, spend, earn } = setup();
  for (const m of ['2026-03', '2026-04', '2026-05']) { spend(`${m}-05`, 10000, 'Eating Out'); spend(`${m}-06`, 115000, 'Rent / Housing'); earn(`${m}-02`, 300000); }
  spend('2026-06-05', 30000, 'Eating Out');
  spend('2026-06-06', 115000, 'Rent / Housing');
  const t = trends(db, 4, '2026-07-10');
  assert.deepEqual(t.months, ['2026-04', '2026-05', '2026-06', '2026-07']);
  const eat = t.categories.find((c) => c.name === 'Eating Out')!;
  assert.deepEqual(eat.series, [10000, 10000, 30000, 0]);
  assert.equal(eat.average, 16667);
  assert.equal(t.insights[0].name, 'Eating Out');
  assert.equal(t.flow.find((f) => f.month === '2026-05')!.fixed, 115000);
  assert.equal(t.flow.find((f) => f.month === '2026-05')!.flexible, 10000);
});

test('merchants group store numbers; explore answers "how much on X"', () => {
  const { db, spend } = setup();
  spend('2026-05-01', 2500, 'Groceries', 'BASKETCO STORES 3297');
  spend('2026-05-08', 3500, 'Groceries', 'BASKETCO STORES 1180');
  spend('2026-06-01', 1200, 'Transport', 'RIDENOW *TRIP');
  const m = merchants(db, { from: '2026-05-01', to: '2026-06-30' });
  assert.equal(m.merchants[0].merchant, 'Basketco Stores');
  assert.equal(m.merchants[0].total, 6000);
  assert.equal(m.merchants[0].count, 2);
  const e = explore(db, { from: '2026-01-01', to: '2026-12-31', search: 'basketco' });
  assert.equal(e.total, 6000);
  assert.equal(e.count, 2);
  assert.equal(e.monthly.length, 12);
  assert.equal(e.perMonth, 500);
  assert.equal(explore(db, { from: '2026-01-01', to: '2026-12-31', categoryId: (db.prepare("SELECT id FROM categories WHERE name='Transport'").get() as any).id }).total, 1200);
});

test('compare two periods and the year in review (calendar and tax year)', () => {
  const { db, spend, earn, move } = setup();
  earn('2026-03-31', 300000); // paid on the last working day: counts towards April
  spend('2026-04-03', 5000, 'Eating Out');
  spend('2026-04-10', 20000, 'Shopping');
  earn('2026-04-30', 300000);
  spend('2026-05-03', 8000, 'Eating Out');
  move('2026-05-04', 50000, 'Trading 212 ISA');
  const c = compare(db, { from: '2026-05-01', to: '2026-05-31' }, { from: '2026-04-01', to: '2026-04-30' });
  assert.equal(c.categories.find((x) => x.name === 'Eating Out')!.diff, 3000);
  assert.equal(c.a.saved, 50000);
  assert.deepEqual(yearRange('tax', 2026), { from: '2026-04-06', to: '2027-04-05', label: 'Tax year 2026/27' });
  const cal = yearReview(db, 'calendar', 2026, '2026-06-01');
  assert.equal(cal.spending, 33000);
  assert.equal(cal.income, 600000);
  assert.equal(cal.saved, 50000);
  assert.equal(cal.isa.paidIn, 50000);
  assert.equal(cal.biggest[0].amount, 20000);
  assert.equal(cal.partial, true);
  const tax = yearReview(db, 'tax', 2026, '2026-06-01');
  assert.equal(tax.spending, 28000, 'tax year starts 6 April');
  assert.equal(tax.income, 300000);
});

test('net worth history splits by account type and explains changes', () => {
  const { db, spend, earn, move } = setup();
  earn('2026-04-02', 300000);
  move('2026-04-03', 100000, 'Harbour Savings');
  spend('2026-05-02', 20000, 'Shopping');
  db.prepare("INSERT INTO valuations (account_id, date, value) VALUES ((SELECT id FROM accounts WHERE name = 'Trading 212 ISA'), '2026-05-20', 5000)").run();
  const h = netWorthHistory(db, 3, '2026-05-25');
  assert.deepEqual(h.points.map((p) => p.month), ['2026-04', '2026-05']);
  assert.equal(h.points[0].savings, 100000);
  assert.equal(h.points[0].netWorth, 300000);
  assert.equal(h.points[1].netWorth, 285000);
  assert.equal(h.changes[0].growth, 5000);
  assert.equal(h.milestones[0]?.label, undefined);
});
