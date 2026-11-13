import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './fixtures.ts';
import { smartCategory } from '../server/importers/smart.ts';
import { createCategory } from '../server/admin.ts';
import { previewImport } from '../server/importers/import.ts';
import { createTransaction, simpleToPostings } from '../server/ledger.ts';

// Brand names below come from the built-in merchant directory (the feature itself);
// people and amounts are made up.
function setup() {
  const db = testDb();
  const name = (id: number | null | undefined) => (id ? (db.prepare('SELECT name FROM categories WHERE id = ?').get(id) as { name: string }).name : null);
  const guess = (d: string, amount = -500) => name(smartCategory(db, d, amount)?.categoryId);
  return { db, guess };
}

test('well-known merchants and tell-tale words get a sensible category', () => {
  const { guess } = setup();
  assert.equal(guess("McDONALD'S 1234 LONDON"), 'Eating Out');
  assert.equal(guess('TFL TRAVEL CH'), 'Transport');
  assert.equal(guess('UBER *TRIP HELP.UBER.COM'), 'Transport');
  assert.equal(guess('UBER EATS'), 'Eating Out', 'specific entry beats the broad one');
  assert.equal(guess('TESCO STORES 3297'), 'Groceries');
  assert.equal(guess('AMZN MKTP UK'), 'Shopping');
  assert.equal(guess('AMAZON PRIME*AB12'), 'Subscriptions');
  assert.equal(guess('NETFLIX.COM'), 'Subscriptions');
  assert.equal(guess('THE CORNER CAFE'), 'Eating Out', 'generic word');
  assert.equal(guess('SHELL ENERGY'), 'Bills & Utilities');
});

test('your own categories are preferred when they exist', () => {
  const { db, guess } = setup();
  assert.equal(guess('ZARA UK'), 'Shopping');
  assert.equal(guess('SHELL 0412'), 'Transport');
  createCategory(db, { name: 'Clothing', kind: 'expense' } as any);
  createCategory(db, { name: 'Car', kind: 'expense' } as any);
  assert.equal(guess('ZARA UK'), 'Clothing');
  assert.equal(guess('SHELL 0412'), 'Car');
  assert.equal(guess('TESCO PETROL'), 'Car');
});

test('no guess for people, banks that share a shop name, or partial words', () => {
  const { guess } = setup();
  assert.equal(guess('PRIYA SHAH'), null);
  assert.equal(guess('TESCO BANK'), null);
  assert.equal(guess('SPARKLE LTD'), null, 'spar only as a whole word');
});

test('money in: pay is income; a refund from a shop stays with the shop', () => {
  const { guess } = setup();
  assert.equal(guess('ACME LTD SALARY', 250000), 'Salary');
  assert.equal(guess('ZARA REFUND', 2999), 'Shopping');
});

test('import uses smart suggestions only when nothing better is known', () => {
  const { db } = setup();
  const acc = (n: string) => (db.prepare('SELECT id FROM accounts WHERE name = ?').get(n) as { id: number }).id;
  const card = acc('Crest Card 1');
  const csv = `Date,Description,Amount\n05/11/2026,GREGGS 101,3.20\n06/11/2026,PRIYA SHAH,12.00\n`;
  let p = previewImport(db, { accountId: card, csv, presetId: 'amex' } as any);
  const greggs = p.rows.find((r) => r.description.startsWith('GREGGS'))!;
  assert.equal(greggs.suggestionSource, 'smart');
  assert.equal(greggs.smartMatch, 'greggs');
  assert.equal(p.rows.find((r) => r.description === 'PRIYA SHAH')!.suggestionSource, 'none');

  // Once you've categorised it yourself, "like last time" wins.
  const groceries = (db.prepare("SELECT id FROM categories WHERE name = 'Groceries'").get() as { id: number }).id;
  createTransaction(db, simpleToPostings({ kind: 'expense', date: '2026-10-01', description: 'GREGGS 101', accountId: card, amount: 320, categoryId: groceries }));
  p = previewImport(db, { accountId: card, csv, presetId: 'amex' } as any);
  const again = p.rows.find((r) => r.description.startsWith('GREGGS'))!;
  assert.equal(again.suggestionSource, 'history');
  assert.equal(again.categoryId, groceries);
});
