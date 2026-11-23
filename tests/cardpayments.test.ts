import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './fixtures.ts';
import { previewImport, commitImport } from '../server/importers/import.ts';
import { listAccounts } from '../server/queries.ts';
import { saveDebt, statements } from '../server/debts.ts';
import { findDoubledPayments, mergeDoubledPayment, notOnCardStatement } from '../server/cardpayments.ts';

/** Two cards from the same provider that look identical on a bank statement ("CREST CARD"). */
function setup() {
  const db = testDb();
  db.exec("UPDATE accounts SET anchor_balance = 0, anchor_date = '2026-08-31'");
  const acc = (name: string) => (db.prepare('SELECT id FROM accounts WHERE name = ?').get(name) as { id: number }).id;
  const bank = acc('Northbank Current'), one = acc('Crest Card 1'), two = acc('Crest Card 2');
  saveDebt(db, one, { debtType: 'credit_card', originalBalance: 0, apr: 0, minType: 'card', paysInFull: true, dueDay: 8, statementDay: 3 } as any);
  saveDebt(db, two, { debtType: 'credit_card', originalBalance: 0, apr: 0, minType: 'card', paysInFull: true, dueDay: 15, statementDay: 3 } as any);
  return { db, bank, one, two };
}

const lloyds = (rows: [string, string, string][]) => `Transaction Date,Transaction Type,Sort Code,Account Number,Transaction Description,Debit Amount,Credit Amount,Balance
${rows.map(([d, desc, amt]) => `${d},DD,'11-22-33,12345678,${desc},${amt},,1000.00`).join('\n')}
`;
const amex = (rows: [string, string, string][]) => `Date,Description,Amount
${rows.map(([d, desc, amt]) => `${d},${desc},${amt}`).join('\n')}
`;

const commitAll = (db: any, accountId: number, preview: any, overrides: Record<number, any> = {}) =>
  commitImport(db, {
    accountId, filename: 'test.csv', presetId: preview.presetId, anchor: null,
    rows: preview.rows.filter((r: any) => r.status !== 'error').map((r: any) => ({
      index: r.index, date: r.date, description: r.description, bankDescription: r.bankDescription, amount: r.amount, hash: r.hash,
      action: r.action, kind: r.kind, categoryId: r.categoryId, transferAccountId: r.transferAccountId,
      matchTransactionId: r.match?.transactionId, matchPostingId: r.match?.postingId, ...overrides[r.index],
    })),
  });

const owed = (db: any, id: number) => 0 - listAccounts(db).find((a) => a.id === id)!.balance + 0;

/** History: card 1 paid by direct debit on the 8th, card 2 on the 15th, both "CREST CARD" at the bank. */
function history(db: any, bank: number, one: number, two: number) {
  const p = previewImport(db, { accountId: bank, csv: lloyds([['08/09/2026', 'CREST CARD', '90.00'], ['15/09/2026', 'CREST CARD', '28.59']]) });
  commitAll(db, bank, p, { 0: { kind: 'transfer', transferAccountId: one }, 1: { kind: 'transfer', transferAccountId: two } });
}

test('a payment filed to the wrong card on import is found, and fixing it moves it and removes the copy', () => {
  const { db, bank, one, two } = setup();
  // The bank row is filed to card 1 by mistake…
  const b = previewImport(db, { accountId: bank, csv: lloyds([['17/11/2026', 'CREST CARD', '49.47']]) });
  commitAll(db, bank, b, { 0: { kind: 'transfer', transferAccountId: one } });
  // …and card 2's statement is then imported as a separate payment (as before this fix).
  const c = previewImport(db, { accountId: two, csv: amex([['15/11/2026', 'PAYMENT RECEIVED - THANK YOU', '-49.47']]) });
  commitAll(db, two, c, { 0: { action: 'create', kind: 'transfer', transferAccountId: bank } });
  assert.equal(owed(db, one), -4947, 'card 1 looks paid when it wasn\'t');
  assert.equal(owed(db, two), -4947);
  const bankBefore = listAccounts(db).find((a) => a.id === bank)!.balance;
  assert.equal(bankBefore, -9894, 'and the bank paid twice');

  const found = findDoubledPayments(db);
  assert.equal(found.length, 1);
  assert.equal(found[0].filedTo, 'Crest Card 1');
  assert.equal(found[0].paidTo, 'Crest Card 2');
  assert.equal(notOnCardStatement(db).length, 0, 'counted once, as doubled');

  mergeDoubledPayment(db, found[0].keepId, found[0].dropId);
  assert.equal(owed(db, one), 0);
  assert.equal(owed(db, two), -4947);
  assert.equal(listAccounts(db).find((a) => a.id === bank)!.balance, -4947, 'the bank paid once');
  assert.equal(findDoubledPayments(db).length, 0);
  // Importing card 2's statement again doesn't bring the copy back.
  const again = previewImport(db, { accountId: two, csv: amex([['15/11/2026', 'PAYMENT RECEIVED - THANK YOU', '-49.47']]) });
  assert.equal(again.rows[0].status, 'duplicate');
  assert.throws(() => mergeDoubledPayment(db, found[0].keepId, found[0].dropId), /already been sorted out/);
});

test('importing a card statement offers to move a payment filed to the other card, instead of recording it twice', () => {
  const { db, bank, one, two } = setup();
  const b = previewImport(db, { accountId: bank, csv: lloyds([['17/11/2026', 'CREST CARD', '49.47']]) });
  commitAll(db, bank, b, { 0: { kind: 'transfer', transferAccountId: one } });
  const c = previewImport(db, { accountId: two, csv: amex([['15/11/2026', 'PAYMENT RECEIVED - THANK YOU', '-49.47']]) });
  const row = c.rows[0];
  assert.equal(row.action, 'move');
  assert.equal(row.match!.accountName, 'Crest Card 1');
  assert.equal(row.match!.fromAccountName, 'Northbank Current');
  commitAll(db, two, c);
  assert.equal(owed(db, one), 0);
  assert.equal(owed(db, two), -4947);
  assert.equal(listAccounts(db).find((a) => a.id === bank)!.balance, -4947);
  assert.equal(previewImport(db, { accountId: two, csv: amex([['15/11/2026', 'PAYMENT RECEIVED - THANK YOU', '-49.47']]) }).rows[0].status, 'duplicate');
});

test('a description that has paid two cards picks the card due around that date, or asks', () => {
  const { db, bank, one, two } = setup();
  history(db, bank, one, two);
  const p = previewImport(db, { accountId: bank, csv: lloyds([['17/11/2026', 'CREST CARD', '49.47'], ['09/11/2026', 'CREST CARD', '12.00'], ['28/11/2026', 'CREST CARD', '5.00']]) });
  const by = (d: string) => p.rows.find((r) => r.date === d)!;
  assert.equal(by('2026-11-17').transferAccountId, two, 'due on the 15th');
  assert.equal(by('2026-11-09').transferAccountId, one, 'due on the 8th');
  assert.equal(by('2026-11-28').transferAccountId, null, 'neither: ask');
  assert.equal(by('2026-11-28').kind, 'transfer');
});

test('a payment filed to a card whose statement doesn\'t show it is flagged', () => {
  const { db, bank, one } = setup();
  const b = previewImport(db, { accountId: bank, csv: lloyds([['17/11/2026', 'CREST CARD', '49.47']]) });
  commitAll(db, bank, b, { 0: { kind: 'transfer', transferAccountId: one } });
  // Card 1's statement covers 1–30 Nov, with no payment on it.
  commitAll(db, one, previewImport(db, { accountId: one, csv: amex([['01/11/2026', 'STREAMIX.COM', '9.99'], ['30/11/2026', 'MARKETFIELD', '20.00']]) }));
  const flagged = notOnCardStatement(db);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].card, 'Crest Card 1');
});

test('a payment made by the due date pays the last statement, not this one', () => {
  const { db, bank, two } = setup();
  commitAll(db, two, previewImport(db, { accountId: two, csv: amex([['20/10/2026', 'MARKETFIELD', '49.47']]) }));
  const b = previewImport(db, { accountId: bank, csv: lloyds([['15/11/2026', 'CREST CARD', '49.47']]) });
  commitAll(db, bank, b, { 0: { kind: 'transfer', transferAccountId: two } });
  const s = statements(db, two, 3, '2026-11-23', 2, 15);
  assert.equal(s[0].current, true);
  assert.equal(s[0].payments, 4947);
  assert.equal(s[0].paidForPrevious, 4947, 'paid on the due date for the 3 Nov statement');
  // Paid after the due date: it counts towards the open statement.
  // A direct debit a couple of days late (a weekend) still pays it.
  assert.equal(statements(db, two, 3, '2026-11-23', 2, 13)[0].paidForPrevious, 4947);
  // Well after the due date: it counts towards the open statement.
  assert.equal(statements(db, two, 3, '2026-11-23', 2, 8)[0].paidForPrevious, 0);
});
