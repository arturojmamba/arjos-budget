import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './fixtures.ts';
import { createTransaction, simpleToPostings } from '../server/ledger.ts';
import { createRecurring, listRecurring, monthPlan } from '../server/recurring.ts';
import { saveShares, shareMatches, shareCategoryFor } from '../server/shares.ts';
import { monthSpending } from '../server/queries.ts';
import { previewImport } from '../server/importers/import.ts';

function setup() {
  const db = testDb();
  db.exec("UPDATE accounts SET anchor_balance = 0, anchor_date = '2025-12-31'");
  const acc = (n: string) => (db.prepare('SELECT id FROM accounts WHERE name = ?').get(n) as { id: number }).id;
  const cat = (n: string) => (db.prepare('SELECT id FROM categories WHERE name = ?').get(n) as { id: number }).id;
  const lark = acc('Lark');
  const card = acc('Crest Card 1');
  const tunebox = createRecurring(db, { name: 'Tunebox', type: 'subscription', amount: 2400, frequency: 'monthly', startDate: '2026-06-15', accountId: card, categoryId: cat('Subscriptions'), matchPattern: 'tunebox' });
  const charge = (date: string) => createTransaction(db, simpleToPostings({ kind: 'expense', date, description: 'TUNEBOX LONDON', accountId: card, amount: 2400, categoryId: cat('Subscriptions') }));
  const payBack = (date: string, who: string, amount = 400, account = lark) =>
    createTransaction(db, simpleToPostings({ kind: 'expense', refund: true, date, description: who, accountId: account, amount, categoryId: cat('Entertainment') }));
  return { db, acc, cat, lark, card, tunebox, charge, payBack };
}

const people = (lark: number) => ['Alex Brown', 'Priya Shah', 'Rob M', 'Max Reed', 'Sam Patel'].map((name) => ({ name, amount: 400, accountId: lark }));

test('names match in any order and case, whole words only', () => {
  assert.ok(shareMatches('Sam Patel', 'PATEL SAM'));
  assert.ok(shareMatches('Rob M', 'ROB M'));
  assert.ok(!shareMatches('Rob M', 'ROBERTS M'));
  assert.ok(!shareMatches('Max Reed', 'MAX'));
});

test('sharing a subscription shows your share and who has paid', () => {
  const { db, cat, lark, tunebox, charge, payBack } = setup();
  charge('2026-10-15');
  payBack('2026-10-01', 'Alex Brown');
  for (const p of ['Sam Patel', 'MAX REED', 'Priya Shah']) payBack('2026-10-15', p);
  payBack('2026-10-15', 'Sam Patel', 500, (db.prepare("SELECT id FROM accounts WHERE name = 'Northbank Current'").get() as any).id); // different account: not Tunebox

  const r = saveShares(db, tunebox, people(lark), { applyToPast: true });
  assert.equal(r.recategorised, 4);
  const item = listRecurring(db).find((i) => i.id === tunebox)!;
  assert.equal(item.sharedBack, 2000);
  assert.equal(item.yourShare, 400);
  assert.equal(item.monthlyNet, 400);
  const oct = item.shareCycles.find((c) => c.dueDate === '2026-10-15')!;
  assert.equal(oct.paidCount, 4);
  assert.equal(oct.received, 1600);
  assert.deepEqual(oct.people.filter((p) => !p.paid).map((p) => p.name), ['Rob M']);

  // Spending shows only your share; the Northbank payment is untouched.
  const subs = monthSpending(db, '2026-10').byCategory.find((c: any) => c.categoryId === cat('Subscriptions'));
  assert.equal(subs!.amount, 2400 - 1600);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM postings WHERE category_id = ?").get(cat('Entertainment')) as any).n, 1);
  assert.equal(monthPlan(db, '2026-11').monthly.subscriptions, 400);
});

test('new imports from those people are categorised against the subscription', () => {
  const { db, cat, lark, tunebox } = setup();
  saveShares(db, tunebox, people(lark));
  assert.equal(shareCategoryFor(db, lark, 'PRIYA SHAH', 400), cat('Subscriptions'));
  assert.equal(shareCategoryFor(db, lark, 'PRIYA SHAH', -400), null, 'paying them is not a refund');
  const p = previewImport(db, { accountId: lark, csv: 'Date,Counter Party,Reference,Type,Amount (GBP),Balance (GBP)\n15/11/2026,Priya Shah,Tunebox,FASTER PAYMENT,4.00,100.00\n', presetId: 'lark' } as any);
  const row = p.rows.find((x: any) => x.description.includes('Priya'))!;
  assert.equal(row.categoryId, cat('Subscriptions'));
  assert.equal(row.kind, 'expense');
});

test('validation', () => {
  const { db, lark, tunebox } = setup();
  assert.throws(() => saveShares(db, tunebox, [{ name: 'A', amount: 2500, accountId: lark }]), /more than the bill/);
  assert.throws(() => saveShares(db, tunebox, [{ name: ' ', amount: 100 }]), /name/);
  saveShares(db, tunebox, []);
  assert.equal(listRecurring(db).find((i) => i.id === tunebox)!.yourShare, 2400);
});
