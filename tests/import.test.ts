import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './fixtures.ts';
import { createTransaction, simpleToPostings } from '../server/ledger.ts';
import { previewImport, commitImport, undoImport, listSkipped, restoreSkipped, dismissSkipped } from '../server/importers/import.ts';
import { parseCsv } from '../server/importers/csv.ts';
import { listAccounts, monthTotals, listTransactions } from '../server/queries.ts';

function setup() {
  const db = testDb();
  db.exec("UPDATE accounts SET anchor_balance = 0, anchor_date = '2025-12-31'");
  const acc = (name: string) => (db.prepare('SELECT id FROM accounts WHERE name = ?').get(name) as { id: number }).id;
  const cat = (name: string) => (db.prepare('SELECT id FROM categories WHERE name = ?').get(name) as { id: number }).id;
  return { db, acc, cat };
}

/** Real bank export layouts (Lloyds current account, Amex) with made-up rows. */
const LLOYDS_FORMAT = `Transaction Date,Transaction Type,Sort Code,Account Number,Transaction Description,Debit Amount,Credit Amount,Balance
05/11/2026,DEB,'11-22-33,12345678,BASKETCO STORES 3297,23.45,,2476.55
05/11/2026,DEB,'11-22-33,12345678,CAFE LUMEN,3.20,,2500.00
05/11/2026,DEB,'11-22-33,12345678,CAFE LUMEN,3.20,,2503.20
03/11/2026,DD,'11-22-33,12345678,CREST CARD,120.00,,2506.40
31/10/2026,BGC,'11-22-33,12345678,ACME LTD SALARY,,2626.40,2626.40
`;

const AMEX_FORMAT = `Date,Description,Amount
04/11/2026,PAYMENT RECEIVED - THANK YOU,-120.00
02/11/2026,"MARKETFIELD S/MKTS, LONDON",45.10
01/11/2026,STREAMIX.COM,9.99
`;

const commitAll = (db: any, accountId: number, preview: any, overrides: Record<number, any> = {}) =>
  commitImport(db, {
    accountId,
    filename: 'test.csv',
    presetId: preview.presetId,
    anchor: preview.anchor,
    rows: preview.rows
      .filter((r: any) => r.status !== 'error')
      .map((r: any) => ({
        index: r.index, date: r.date, description: r.description, bankDescription: r.bankDescription, amount: r.amount, hash: r.hash,
        action: r.action, kind: r.kind, categoryId: r.categoryId, transferAccountId: r.transferAccountId,
        matchTransactionId: r.match?.transactionId, matchPostingId: r.match?.postingId, ...overrides[r.index],
      })),
  });

test('csv parser handles quotes, embedded commas and BOM', () => {
  const rows = parseCsv('﻿a,b,c\r\n1,"x, ""y""",3\r\n');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['1', 'x, "y"', '3']]);
});

test('detects the Lloyds and Amex CSV formats with correct signs', () => {
  const { db, acc } = setup();
  const l = previewImport(db, { accountId: acc('Northbank Current'), csv: LLOYDS_FORMAT });
  assert.equal(l.presetId, 'lloyds_current');
  assert.equal(l.rows[0].amount, -2345);
  assert.equal(l.rows[4].amount, 262640);
  assert.deepEqual(l.anchor, { date: '2026-11-05', balance: 247655 });

  const a = previewImport(db, { accountId: acc('Crest Card 1'), csv: AMEX_FORMAT });
  assert.equal(a.presetId, 'amex');
  assert.equal(a.rows[1].amount, -4510, 'purchase reduces (increases debt on) the card');
  assert.equal(a.rows[0].amount, 12000, 'payment reduces debt');
  assert.equal(a.rows[1].description, 'MARKETFIELD S/MKTS, LONDON');
});

test('identical same-day rows are kept; re-importing is a no-op', () => {
  const { db, acc } = setup();
  const id = acc('Northbank Current');
  const p1 = previewImport(db, { accountId: id, csv: LLOYDS_FORMAT });
  assert.equal(p1.summary.new, 5);
  const r1 = commitAll(db, id, p1, { 3: { kind: 'transfer', transferAccountId: acc('Crest Card 1') } });
  assert.equal(r1.created, 5);
  const cafe = listTransactions(db, { search: 'CAFE LUMEN' });
  assert.equal(cafe.total, 2, 'two identical coffees both imported');

  const p2 = previewImport(db, { accountId: id, csv: LLOYDS_FORMAT });
  assert.equal(p2.summary.duplicate, 5);
  const r2 = commitAll(db, id, p2);
  assert.equal(r2.created, 0);
  assert.equal(listTransactions(db, {}).total, 5);
});

test('card repayment imported from both sides becomes a single transfer', () => {
  const { db, acc, cat } = setup();
  const northbank = acc('Northbank Current');
  const crest = acc('Crest Card 1');

  // Import Northbank first, leaving the Crest payment as an uncategorised expense.
  const p1 = previewImport(db, { accountId: northbank, csv: LLOYDS_FORMAT });
  const crestRow = p1.rows.find((r) => r.description === 'CREST CARD')!;
  assert.equal(crestRow.kind, 'transfer', 'hinted as a transfer to the Crest card');
  commitAll(db, northbank, p1, { [crestRow.index]: { kind: 'expense', categoryId: null, transferAccountId: null } });

  // Importing Crest finds the other side and merges it.
  const p2 = previewImport(db, { accountId: crest, csv: AMEX_FORMAT });
  const pay = p2.rows.find((r) => r.amount === 12000)!;
  assert.equal(pay.status, 'transfer_match');
  commitAll(db, crest, p2, {
    1: { categoryId: cat('Groceries') },
    2: { categoryId: cat('Subscriptions') },
  });
  const nov = monthTotals(db, '2026-11');
  assert.equal(nov.spending, 2345 + 320 + 320 + 4510 + 999, '£120 repayment not counted as spending');
  const crestBal = listAccounts(db).find((a) => a.id === crest)!.balance;
  assert.equal(crestBal, 12000 - 4510 - 999);
});

test('transfer created from one side is linked (not duplicated) when the other side is imported', () => {
  const { db, acc, cat } = setup();
  const northbank = acc('Northbank Current');
  const crest = acc('Crest Card 1');
  const p1 = previewImport(db, { accountId: northbank, csv: LLOYDS_FORMAT });
  commitAll(db, northbank, p1, { 3: { kind: 'transfer', transferAccountId: crest } });
  const p2 = previewImport(db, { accountId: crest, csv: AMEX_FORMAT });
  const pay = p2.rows.find((r) => r.amount === 12000)!;
  assert.equal(pay.status, 'possible_duplicate');
  assert.equal(pay.action, 'link');
  commitAll(db, crest, p2, { 1: { categoryId: cat('Groceries') }, 2: { categoryId: cat('Subscriptions') } });
  assert.equal(listTransactions(db, { accountId: crest }).total, 3);
});

test('manual entries are linked, not duplicated', () => {
  const { db, acc, cat } = setup();
  const crest = acc('Crest Card 1');
  createTransaction(db, simpleToPostings({ kind: 'expense', date: '2026-11-01', description: 'Streamix', accountId: crest, categoryId: cat('Subscriptions'), amount: 999 }));
  const p = previewImport(db, { accountId: crest, csv: AMEX_FORMAT });
  assert.equal(p.rows[2].status, 'possible_duplicate');
  commitAll(db, crest, p, { 0: { action: 'skip' } });
  assert.equal(listTransactions(db, { search: 'streamix' }).total, 1);
});

test('remembered categories become rules applied to the next import', () => {
  const { db, acc, cat } = setup();
  const crest = acc('Crest Card 1');
  const p = previewImport(db, { accountId: crest, csv: AMEX_FORMAT });
  commitAll(db, crest, p, { 0: { action: 'skip' }, 1: { categoryId: cat('Groceries'), remember: true }, 2: { categoryId: cat('Subscriptions') } });
  const next = `Date,Description,Amount\n20/11/2026,"MARKETFIELD S/MKTS, CROYDON 0441",12.00\n21/11/2026,STREAMIX.COM,9.99\n`;
  const p2 = previewImport(db, { accountId: crest, csv: next });
  assert.equal(p2.rows[0].categoryId, cat('Groceries'));
  assert.equal(p2.rows[0].suggestionSource, 'rule');
  assert.equal(p2.rows[1].categoryId, cat('Subscriptions'));
  assert.equal(p2.rows[1].suggestionSource, 'history');
});

test('import sets the reconciled balance from the bank, and undo removes created rows', () => {
  const { db, acc } = setup();
  const id = acc('Northbank Current');
  const p = previewImport(db, { accountId: id, csv: LLOYDS_FORMAT });
  const res = commitAll(db, id, p, { 3: { kind: 'transfer', transferAccountId: acc('Crest Card 1') } });
  assert.equal(listAccounts(db).find((a) => a.id === id)!.balance, 247655);
  assert.equal(listAccounts(db, { asOf: '2026-10-31' }).find((a) => a.id === id)!.balance, 262640, 'history reconstructs');
  undoImport(db, res.batchId);
  assert.equal(listTransactions(db, {}).total, 0);
});

test('unknown layouts fall back to guessed columns', () => {
  const { db, acc } = setup();
  const csv = 'Account: 1234\nPosted Date,Payee,Paid out,Paid in\n2026-11-01,Gym,30.00,\n2026-11-02,Refund,,5.00\n';
  const p = previewImport(db, { accountId: acc('Lark'), csv });
  assert.equal(p.rows.length, 2);
  assert.equal(p.rows[0].amount, -3000);
  assert.equal(p.rows[1].amount, 500);
});

test('skipped rows are kept and can be restored or dismissed', () => {
  const db = testDb();
  const acc = (db.prepare("SELECT id FROM accounts WHERE name = 'Northbank Current'").get() as { id: number }).id;
  const row = (index: number, date: string, desc: string, amount: number, action: 'create' | 'skip', status = 'new') => ({
    index, date, description: desc, bankDescription: desc, amount, hash: `h${index}`, action, kind: 'expense' as const, categoryId: null, transferAccountId: null, status: status as any,
  });
  const res = commitImport(db, { accountId: acc, rows: [
    row(0, '2026-05-01', 'Basketco', -1000, 'create'),
    row(1, '2026-05-02', 'PAYPAL *PAYIN3', -7933, 'skip'),
    row(2, '2026-05-03', 'Beanery', -350, 'skip', 'possible_duplicate'),
    row(3, '2026-05-04', 'Exact dupe', -100, 'skip', 'duplicate'),
  ] });
  assert.equal(res.skipped, 3);
  const skipped = listSkipped(db);
  assert.deepEqual(skipped.map((s) => [s.description, s.reason]), [['Beanery', 'possible_duplicate'], ['PAYPAL *PAYIN3', 'skipped']]);
  const txId = restoreSkipped(db, skipped[1].id, {});
  const t = listTransactions(db, { month: '2026-05' }).items.find((x) => x.id === txId)!;
  assert.equal(t.kind, 'expense');
  assert.equal(t.postings[0].amount, -7933);
  assert.equal(listSkipped(db).length, 1);
  dismissSkipped(db, listSkipped(db)[0].id);
  assert.equal(listSkipped(db).length, 0);
  // Undoing the import removes the restored row too.
  undoImport(db, res.batchId);
  assert.equal(listTransactions(db, { month: '2026-05' }).total, 0);
});
