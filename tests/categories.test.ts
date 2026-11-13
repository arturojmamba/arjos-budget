import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './fixtures.ts';
import { createCategory, reorderCategories, updateCategory } from '../server/admin.ts';
import { listCategories } from '../server/queries.ts';

test('categories use emojis and can be put in any order', () => {
  const db = testDb();
  const top = () => listCategories(db).filter((c) => c.kind === 'expense' && c.parentId === null);
  assert.equal(top()[0].icon, '🛒');
  const ids = top().map((c) => c.id);
  const reversed = [...ids].reverse();
  reorderCategories(db, reversed);
  assert.deepEqual(top().map((c) => c.id), reversed);
  // Subcategories stay under their parent, in their own order.
  const parent = reversed[0];
  const a = createCategory(db, { name: 'Zeta', kind: 'expense', parentId: parent });
  const b = createCategory(db, { name: 'Alpha', kind: 'expense', parentId: parent });
  const subs = () => listCategories(db).filter((c) => c.parentId === parent).map((c) => c.id);
  assert.deepEqual(subs(), [a, b], 'new ones go at the end');
  reorderCategories(db, [b, a]);
  assert.deepEqual(subs(), [b, a]);
  const all = listCategories(db).filter((c) => c.kind === 'expense').map((c) => c.id);
  assert.deepEqual(all.slice(0, 3), [parent, b, a]);
  assert.throws(() => reorderCategories(db, [a, ids[1]]), /same list/);
  updateCategory(db, a, { icon: '🍕' });
  assert.equal(listCategories(db).find((c) => c.id === a)!.icon, '🍕');
  assert.throws(() => updateCategory(db, a, { icon: 'this is far too long' }), /emoji/);
});


test('rules: edit, test a description, and usage counts', async () => {
  const { openDb } = await import('../server/db.ts');
  const { createRule, updateRule, testRules, listRules } = await import('../server/admin.ts');
  const { createTransaction, simpleToPostings } = await import('../server/ledger.ts');
  const db = testDb();
  const acc = (db.prepare("SELECT id FROM accounts WHERE name = 'Lark'").get() as { id: number }).id;
  const cat = (n: string) => (db.prepare('SELECT id FROM categories WHERE name = ?').get(n) as { id: number }).id;
  createTransaction(db, simpleToPostings({ kind: 'expense', date: '2026-10-01', description: 'METRO TRAVEL CHARGE METRO.GOV.UK/CP', accountId: acc, amount: 280, categoryId: cat('Transport') }));
  createTransaction(db, simpleToPostings({ kind: 'expense', date: '2026-10-03', description: 'METRO TRAVEL CHARGE', accountId: acc, amount: 280, categoryId: cat('Transport') }));
  const short = createRule(db, { pattern: 'metro', categoryId: cat('Transport') });
  const long = createRule(db, { pattern: 'metro travel charge', categoryId: cat('Eating Out') });
  const unused = createRule(db, { pattern: 'nothing like this', categoryId: cat('Shopping') });
  const t = testRules(db, 'METRO TRAVEL CHARGE METRO.GOV.UK/CP');
  assert.equal(t.winner, long, 'longer text wins, same as imports');
  assert.deepEqual(t.matches, [long, short]);
  updateRule(db, long, { pattern: 'metro travel charge', categoryId: cat('Transport'), matchType: 'starts_with' });
  const rules = listRules(db);
  assert.equal(rules.find((r: any) => r.id === long)!.categoryId, cat('Transport'));
  assert.equal(rules.find((r: any) => r.id === long)!.matchType, 'starts_with');
  assert.equal(rules.find((r: any) => r.id === short)!.matches, 2);
  assert.equal(rules.find((r: any) => r.id === short)!.lastMatch, '2026-10-03');
  assert.equal(rules.find((r: any) => r.id === unused)!.matches, 0);
  assert.throws(() => updateRule(db, 9999, { pattern: 'x', categoryId: cat('Shopping') }), /not found/);
  assert.throws(() => updateRule(db, short, { pattern: '(', matchType: 'regex', categoryId: cat('Shopping') }), /regular expression/);
});
