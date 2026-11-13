import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './fixtures.ts';
import { createTransaction, simpleToPostings } from '../server/ledger.ts';
import { createAccount } from '../server/admin.ts';
import { healthChecks } from '../server/health.ts';

test('health checks find duplicate accounts, hand-typed duplicates and uncategorised spending', () => {
  const db = testDb();
  const northbank = (db.prepare("SELECT id FROM accounts WHERE name = 'Northbank Current'").get() as { id: number }).id;
  const ids = () => healthChecks(db, '2026-06-20').map((h) => h.id);
  assert.ok(!ids().includes('uncategorised'));
  createAccount(db, { name: 'Wool jumper', type: 'loan', balance: -6466 });
  createAccount(db, { name: 'wool jumper', type: 'loan', balance: -6466 });
  createTransaction(db, simpleToPostings({ kind: 'expense', date: '2026-06-01', description: 'Beanery', accountId: northbank, categoryId: null, amount: 350 }));
  createTransaction(db, simpleToPostings({ kind: 'expense', date: '2026-06-02', description: 'Beanery', accountId: northbank, categoryId: null, amount: 350 }));
  const found = ids();
  assert.ok(found.includes('dup-acct-wool jumper'));
  assert.ok(found.includes('dup-tx'));
  assert.ok(found.includes('uncategorised'));
  assert.ok(found.includes('debt-details'));
});
