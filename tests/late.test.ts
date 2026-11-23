import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './fixtures.ts';
import { createTransaction, simpleToPostings } from '../server/ledger.ts';
import { listAccounts } from '../server/queries.ts';
import { lateArrivals, reviewRepayments, allLateArrivals } from '../server/debts.ts';
import { previewImport, commitImport } from '../server/importers/import.ts';

function setup() {
  const db = testDb();
  const acc = (name: string) => (db.prepare('SELECT id FROM accounts WHERE name = ?').get(name) as { id: number }).id;
  const card = acc('Crest Card 2'), bank = acc('Northbank Current');
  // You copied the card's balance from the app on 12 Nov; two TfL charges were still pending.
  db.prepare("UPDATE accounts SET anchor_balance = -58153, anchor_date = '2026-11-12' WHERE id = ?").run(card);
  db.prepare("UPDATE accounts SET anchor_balance = 100000, anchor_date = '2026-11-12' WHERE id = ?").run(bank);
  db.prepare("UPDATE accounts SET anchor_set_at = '2026-11-12 10:00:00'").run();
  const spend = (date: string, amount: number, accountId = card) =>
    createTransaction(db, simpleToPostings({ kind: 'expense', date, description: 'TFL TRAVEL CHARGE', accountId, amount } as any));
  return { db, card, bank, spend };
}
const owed = (db: any, id: number) => 0 - listAccounts(db).find((a) => a.id === id)!.balance + 0;

test('charges that turn up after you confirmed a balance, dated before it, are asked about', () => {
  const { db, card, spend } = setup();
  spend('2026-11-11', 1050);
  spend('2026-11-11', 1400);
  assert.equal(owed(db, card), 58153, 'not counted yet: assumed to be in the balance you gave');
  const late = lateArrivals(db, card);
  assert.equal(late.length, 2);
  assert.equal(allLateArrivals(db)[0].name, 'Crest Card 2');
  // "No, count them": the confirmed balance moves by their amount.
  reviewRepayments(db, card, late.map((l) => l.postingId), true);
  assert.equal(owed(db, card), 58153 + 2450);
  assert.equal(lateArrivals(db, card).length, 0);
  // Something else arriving late later is still asked about.
  spend('2026-11-12', 500);
  assert.equal(lateArrivals(db, card).length, 1);
});

test('"already included" leaves the balance alone', () => {
  const { db, card, spend } = setup();
  spend('2026-11-11', 1050);
  reviewRepayments(db, card, lateArrivals(db, card).map((l) => l.postingId), false);
  assert.equal(owed(db, card), 58153);
  assert.equal(lateArrivals(db, card).length, 0);
});

test('older history imported after setting a balance is not asked about, and later dates count anyway', () => {
  const { db, card, spend } = setup();
  spend('2026-10-01', 9999); // history, well before the confirmed date
  spend('2026-11-13', 700);  // after it: simply counted
  assert.equal(lateArrivals(db, card).length, 0);
  assert.equal(owed(db, card), 58153 + 700);
});

test('works for bank accounts too, but not for an import that set the balance itself', () => {
  const { db, bank, spend } = setup();
  spend('2026-11-10', 2000, bank);
  assert.equal(lateArrivals(db, bank).length, 1);
  const db2 = testDb();
  const id = (db2.prepare("SELECT id FROM accounts WHERE name = 'Lark'").get() as { id: number }).id;
  const csv = `Transaction Date,Transaction Type,Sort Code,Account Number,Transaction Description,Debit Amount,Credit Amount,Balance
10/11/2026,DEB,'11-22-33,12345678,CAFE LUMEN,3.20,,996.80
09/11/2026,DEB,'11-22-33,12345678,CAFE LUMEN,3.20,,1000.00
`;
  const p = previewImport(db2, { accountId: id, csv });
  const res = commitImport(db2, {
    accountId: id, anchor: p.anchor, presetId: p.presetId,
    rows: p.rows.map((r: any) => ({ index: r.index, date: r.date, description: r.description, bankDescription: r.bankDescription, amount: r.amount, hash: r.hash, action: r.action, kind: r.kind, categoryId: r.categoryId, transferAccountId: r.transferAccountId })),
  });
  assert.equal(res.late, 0);
  assert.equal(lateArrivals(db2, id).length, 0);
});

test('statements imported the same day you set a balance are what that balance is made of: not asked about', () => {
  const { db, card, spend } = setup();
  db.prepare("UPDATE accounts SET anchor_set_at = datetime('now') WHERE id = ?").run(card);
  spend('2026-11-11', 1050);
  assert.equal(lateArrivals(db, card).length, 0);
});
