import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, setSetting } from '../server/db.ts';
import { testDb } from './fixtures.ts';
import { createTransaction, simpleToPostings, updateTransaction, deleteTransaction, mergeIntoTransfer } from '../server/ledger.ts';
import { listAccounts, monthSummary, monthTotals, listTransactions, savedIn } from '../server/queries.ts';
import { parseMoney, formatPence } from '../server/money.ts';
import { createAccount, updateAccount, createCategory, deleteCategory } from '../server/admin.ts';

function setup() {
  const db = testDb();
  const acc = (name: string) => (db.prepare('SELECT id FROM accounts WHERE name = ?').get(name) as { id: number }).id;
  const cat = (name: string) => (db.prepare('SELECT id FROM categories WHERE name = ?').get(name) as { id: number }).id;
  // Anchor every account at £0 at the start of 2026 for predictable balances.
  db.exec("UPDATE accounts SET anchor_balance = 0, anchor_date = '2025-12-31'");
  return { db, acc, cat, bal: (id: number, asOf?: string) => listAccounts(db, { asOf }).find((a) => a.id === id)!.balance };
}

test('parseMoney handles bank formats without float drift', () => {
  assert.equal(parseMoney('£1,234.56'), 123456);
  assert.equal(parseMoney('-12.3'), -1230);
  assert.equal(parseMoney('(45.00)'), -4500);
  assert.equal(parseMoney('12.30 CR'), 1230);
  assert.equal(parseMoney('12.30 DR'), -1230);
  assert.equal(parseMoney('0.1'), 10);
  assert.equal(parseMoney('19.995'), 2000);
  assert.equal(parseMoney(0.1 + 0.2), 30);
  assert.equal(parseMoney('abc'), null);
  assert.equal(parseMoney(''), null);
  assert.equal(formatPence(-123456), '-£1,234.56');
  assert.equal(formatPence(5), '£0.05');
});

test('rule 1: transfers between own accounts are not income or spending', () => {
  const { db, acc, bal } = setup();
  createTransaction(db, simpleToPostings({ kind: 'transfer', date: '2026-03-02', description: 'To Harbour', accountId: acc('Northbank Current'), toAccountId: acc('Harbour Savings'), amount: 20000 }));
  assert.deepEqual(monthTotals(db, '2026-03'), { income: 0, spending: 0 });
  assert.equal(bal(acc('Northbank Current')), -20000);
  assert.equal(bal(acc('Harbour Savings')), 20000);
});

test('rules 2 & 3: card purchase raises debt once; repayment is not a second expense', () => {
  const { db, acc, cat, bal } = setup();
  const northbank = acc('Northbank Current');
  const crest = acc('Crest Card 1');
  createTransaction(db, simpleToPostings({ kind: 'income', date: '2026-03-10', description: 'Salary', accountId: northbank, categoryId: cat('Salary'), amount: 300000 }));
  createTransaction(db, simpleToPostings({ kind: 'expense', date: '2026-03-12', description: 'Basketco', accountId: crest, categoryId: cat('Groceries'), amount: 5432 }));
  assert.equal(bal(crest), -5432, 'card debt increases');
  assert.equal(bal(northbank), 300000, 'bank balance untouched by card purchase');

  createTransaction(db, simpleToPostings({ kind: 'transfer', date: '2026-03-20', description: 'Crest payment', accountId: northbank, toAccountId: crest, amount: 5432 }));
  assert.equal(bal(crest), 0, 'repayment clears the debt');
  assert.equal(bal(northbank), 300000 - 5432);
  assert.deepEqual(monthTotals(db, '2026-03'), { income: 300000, spending: 5432 }, 'spent once, not twice');
});

test('rule 4: savings contributions are transfers, not expenses', () => {
  const { db, acc, bal } = setup();
  const pot = createAccount(db, { name: 'Holiday pot', type: 'pot', parentId: acc('Lark'), balance: 0, balanceDate: '2025-12-31' });
  createTransaction(db, simpleToPostings({ kind: 'transfer', date: '2026-04-01', description: 'Holiday pot', accountId: acc('Lark'), toAccountId: pot, amount: 15000 }));
  assert.equal(monthTotals(db, '2026-04').spending, 0);
  assert.equal(bal(pot), 15000);
  const s = monthSummary(db, '2026-04');
  assert.equal(s.netWorth, 0, 'net worth unchanged by moving money');
});

test('transfers and categories cannot be mixed', () => {
  const { db, acc, cat } = setup();
  assert.throws(() =>
    createTransaction(db, { kind: 'transfer', date: '2026-01-01', description: 'x', postings: [
      { accountId: acc('Northbank Current'), amount: -100, categoryId: cat('Groceries') },
      { accountId: acc('Lark'), amount: 100 },
    ] }),
  /cannot have a category/);
  assert.throws(() =>
    createTransaction(db, { kind: 'transfer', date: '2026-01-01', description: 'x', postings: [
      { accountId: acc('Northbank Current'), amount: -100 },
      { accountId: acc('Lark'), amount: 99 },
    ] }),
  /balance/);
  assert.throws(() =>
    createTransaction(db, simpleToPostings({ kind: 'expense', date: '2026-01-01', description: 'x', accountId: acc('Lark'), categoryId: cat('Salary'), amount: 100 })),
  /income category/);
});

test('refunds reduce spending in their category', () => {
  const { db, acc, cat } = setup();
  const crest = acc('Crest Card 2');
  createTransaction(db, simpleToPostings({ kind: 'expense', date: '2026-05-03', description: 'THREADLY', accountId: crest, categoryId: cat('Shopping'), amount: 8000 }));
  createTransaction(db, simpleToPostings({ kind: 'expense', refund: true, date: '2026-05-09', description: 'THREADLY refund', accountId: crest, categoryId: cat('Shopping'), amount: 3000 }));
  assert.equal(monthTotals(db, '2026-05').spending, 5000);
});

test('salary paid on the last working day counts towards next month', () => {
  const { db, acc, cat } = setup();
  const id = createTransaction(db, simpleToPostings({ kind: 'income', date: '2026-10-30', description: 'ACME LTD SALARY', accountId: acc('Northbank Current'), categoryId: cat('Salary'), amount: 320000 }));
  assert.equal(monthTotals(db, '2026-11').income, 320000);
  assert.equal(monthTotals(db, '2026-10').income, 0);
  // Freelance income doesn't roll forward.
  createTransaction(db, simpleToPostings({ kind: 'income', date: '2026-10-30', description: 'Client', accountId: acc('Northbank Current'), categoryId: cat('Freelance'), amount: 10000 }));
  assert.equal(monthTotals(db, '2026-10').income, 10000);
  // Mid-month salary stays in its month; explicit override wins.
  updateTransaction(db, id, { ...simpleToPostings({ kind: 'income', date: '2026-10-30', description: 'ACME', accountId: acc('Northbank Current'), categoryId: cat('Salary'), amount: 320000 }), period: '2026-10' });
  assert.equal(monthTotals(db, '2026-10').income, 330000);
  setSetting(db, 'rollforward_days', '0');
  createTransaction(db, simpleToPostings({ kind: 'income', date: '2026-12-31', description: 'Salary', accountId: acc('Northbank Current'), categoryId: cat('Salary'), amount: 1 }));
  assert.equal(monthTotals(db, '2026-12').income, 1);
});

test('balances are anchored: importing older history does not change today’s balance', () => {
  const { db, acc, cat, bal } = setup();
  const northbank = acc('Northbank Current');
  updateAccount(db, northbank, { balance: 150000, balanceDate: '2026-06-30' });
  createTransaction(db, simpleToPostings({ kind: 'expense', date: '2026-06-15', description: 'Old', accountId: northbank, categoryId: cat('Groceries'), amount: 2000 }));
  assert.equal(bal(northbank), 150000, 'older transaction does not move the reconciled balance');
  assert.equal(bal(northbank, '2026-06-14'), 152000, 'but history before it is reconstructed');
  createTransaction(db, simpleToPostings({ kind: 'expense', date: '2026-07-02', description: 'New', accountId: northbank, categoryId: cat('Groceries'), amount: 500 }));
  assert.equal(bal(northbank), 149500);
});

test('merging two one-sided entries into a transfer removes double counting', () => {
  const { db, acc, cat } = setup();
  const out = createTransaction(db, simpleToPostings({ kind: 'expense', date: '2026-03-20', description: 'CREST CARD', accountId: acc('Northbank Current'), categoryId: cat('Miscellaneous'), amount: 9000 }));
  const inn = createTransaction(db, simpleToPostings({ kind: 'income', date: '2026-03-21', description: 'PAYMENT RECEIVED', accountId: acc('Crest Card 1'), categoryId: cat('Other Income'), amount: 9000 }));
  assert.deepEqual(monthTotals(db, '2026-03'), { income: 9000, spending: 9000 });
  mergeIntoTransfer(db, out, inn);
  assert.deepEqual(monthTotals(db, '2026-03'), { income: 0, spending: 0 });
  assert.equal(listTransactions(db, {}).total, 1);
});

test('search, filters and deletion', () => {
  const { db, acc, cat } = setup();
  const a = createTransaction(db, simpleToPostings({ kind: 'expense', date: '2026-02-01', description: 'Cafe Lumen', accountId: acc('Crest Card 1'), categoryId: cat('Eating Out'), amount: 650, notes: 'with Sam' }));
  createTransaction(db, simpleToPostings({ kind: 'expense', date: '2026-03-01', description: 'Basketco', accountId: acc('Northbank Credit Card'), categoryId: cat('Groceries'), amount: 4210 }));
  assert.equal(listTransactions(db, { search: 'lumen' }).total, 1);
  assert.equal(listTransactions(db, { search: 'sam' }).total, 1);
  assert.equal(listTransactions(db, { search: '42.10' }).total, 1);
  assert.equal(listTransactions(db, { month: '2026-03' }).total, 1);
  assert.equal(listTransactions(db, { accountId: acc('Crest Card 1') }).total, 1);
  assert.equal(listTransactions(db, { categoryId: cat('Groceries') }).total, 1);
  deleteTransaction(db, a);
  assert.equal(listTransactions(db, {}).total, 1);
});

test('subcategories roll up and deleting a category reassigns its transactions', () => {
  const { db, acc, cat } = setup();
  const coffee = createCategory(db, { name: 'Coffee', kind: 'expense', parentId: cat('Eating Out') });
  createTransaction(db, simpleToPostings({ kind: 'expense', date: '2026-02-01', description: 'Flat white', accountId: acc('Crest Card 1'), categoryId: coffee, amount: 380 }));
  const eo = monthSummary(db, '2026-02').byCategory.find((c) => c.name === 'Eating Out');
  assert.equal(eo?.amount, 380);
  assert.equal(listTransactions(db, { categoryId: cat('Eating Out') }).total, 1);
  deleteCategory(db, cat('Eating Out'), cat('Miscellaneous'));
  assert.equal(monthSummary(db, '2026-02').byCategory[0].name, 'Miscellaneous');
});

test('net worth counts card debt as negative', () => {
  const { db, acc } = setup();
  updateAccount(db, acc('Northbank Current'), { balance: 250000, balanceDate: '2026-01-31' });
  updateAccount(db, acc('Crest Card 1'), { balance: -40000, balanceDate: '2026-01-31' });
  const s = monthSummary(db, '2026-02');
  assert.equal(s.assets, 250000);
  assert.equal(s.liabilities, -40000);
  assert.equal(s.netWorth, 210000);
});

test('transaction list pages and reports per-month totals for the whole filtered set', () => {
  const { db, acc, cat } = setup();
  const northbank = acc('Northbank Current');
  for (let d = 1; d <= 30; d++) {
    const date = `2026-${d <= 12 ? '04' : '05'}-${String(d <= 12 ? d : d - 12).padStart(2, '0')}`;
    createTransaction(db, simpleToPostings({ kind: 'expense', date, description: `Shop ${d}`, accountId: northbank, categoryId: cat('Groceries'), amount: 100 }));
  }
  createTransaction(db, simpleToPostings({ kind: 'transfer', date: '2026-05-03', description: 'To Harbour', accountId: northbank, toAccountId: acc('Harbour Savings'), amount: 5000 }));
  const page1 = listTransactions(db, { limit: 25, offset: 0 });
  assert.equal(page1.items.length, 25);
  assert.equal(page1.total, 31);
  assert.deepEqual(page1.byMonth, [
    { month: '2026-05', count: 19, in: 0, out: 1800, saved: 5000 },
    { month: '2026-04', count: 12, in: 0, out: 1200, saved: 0 },
  ]);
  assert.equal(listTransactions(db, { limit: 25, offset: 25 }).items.length, 6);
  assert.equal(listTransactions(db, { limit: 100000 }).items.length, 31);
});

test('money moved into savings and investments counts as saved; moves between them do not', () => {
  const { db, acc } = setup();
  const northbank = acc('Northbank Current'), harbour = acc('Harbour Savings'), t212 = acc('Trading 212 ISA');
  const move = (date: string, amount: number, from: number, to: number) =>
    createTransaction(db, simpleToPostings({ kind: 'transfer', date, description: 'Move', accountId: from, toAccountId: to, amount }));
  move('2026-06-02', 30000, northbank, harbour);
  move('2026-06-03', 7500, northbank, t212);
  move('2026-06-04', 10000, harbour, t212); // savings to savings: not new saving
  move('2026-06-05', 2500, harbour, northbank); // taken back out
  move('2026-06-06', 4000, northbank, acc('Northbank Credit Card')); // card repayment: not saving
  assert.equal(savedIn(db, '2026-06'), 35000);
  const r = listTransactions(db, { month: '2026-06', kind: 'saving' });
  assert.equal(r.total, 3);
  assert.equal(r.byMonth[0].saved, 35000);
});

test('place filter matches every description that cleans up to the same place, as Reports groups them', () => {
  const { db, acc, cat } = setup();
  const card = acc('Crest Card 1');
  const buy = (date: string, description: string) =>
    createTransaction(db, simpleToPostings({ kind: 'expense', date, description, accountId: card, categoryId: cat('Groceries'), amount: 1500 }));
  buy('2026-08-02', 'BASKETCO STORES 3297');
  buy('2026-08-09', 'BASKETCO STORES 1180');
  buy('2026-08-10', 'BASKETCO EXPRESS');
  buy('2026-09-01', 'BASKETCO STORES 3297');
  const aug = listTransactions(db, { month: '2026-08', merchant: 'Basketco Stores' });
  assert.equal(aug.total, 2);
  assert.equal(listTransactions(db, { merchant: 'Basketco Stores' }).total, 3);
  assert.equal(listTransactions(db, { merchant: 'Nowhere' }).total, 0);
});
