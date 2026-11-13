import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './fixtures.ts';
import { createTransaction, simpleToPostings } from '../server/ledger.ts';
import { createRule } from '../server/admin.ts';
import { suggestRules, createRules } from '../server/rulesuggest.ts';
import { listTransactions } from '../server/queries.ts';

test('frequent places with a consistent category become suggested rules', () => {
  const db = testDb();
  const acc = (db.prepare("SELECT id FROM accounts WHERE name = 'Crest Card 1'").get() as { id: number }).id;
  const cat = (n: string) => (db.prepare('SELECT id FROM categories WHERE name = ? AND parent_id IS NULL').get(n) as { id: number }).id;
  const buy = (date: string, description: string, category: string | null) =>
    createTransaction(db, simpleToPostings({ kind: 'expense', date, description, accountId: acc, categoryId: category ? cat(category) : null, amount: 1000 }));
  buy('2026-09-01', 'CAFE LUMEN 0412', 'Eating Out');
  buy('2026-09-08', 'CAFE LUMEN 0412', 'Eating Out');
  buy('2026-09-15', 'CAFE LUMEN 1180', 'Eating Out');
  buy('2026-09-22', 'CAFE LUMEN 0412', null); // not categorised yet
  buy('2026-09-02', 'SHOPZONE MARKETPLACE', 'Shopping');
  buy('2026-09-09', 'SHOPZONE MARKETPLACE', 'Groceries'); // mixed: not consistent enough
  buy('2026-09-16', 'SHOPZONE MARKETPLACE', 'Entertainment');
  buy('2026-09-03', 'METRO TRAVEL CHARGE', 'Transport');
  buy('2026-09-10', 'METRO TRAVEL CHARGE', 'Transport');
  buy('2026-09-17', 'METRO TRAVEL CHARGE', 'Transport');
  createRule(db, { pattern: 'metro', categoryId: cat('Transport') }); // already covered
  const s = suggestRules(db, { today: '2026-10-01' });
  assert.deepEqual(s.map((x) => [x.pattern, x.categoryName, x.visits, x.uncategorised]), [['cafe lumen', 'Eating Out', 4, 1]]);
  const r = createRules(db, [{ pattern: s[0].pattern, categoryId: s[0].categoryId }], true);
  assert.deepEqual(r, { created: 1, filled: 1 });
  assert.equal(listTransactions(db, { uncategorised: true }).total, 0);
  assert.equal(suggestRules(db, { today: '2026-10-01' }).length, 0, 'no longer suggested once the rule exists');
});
