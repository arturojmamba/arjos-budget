import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './fixtures.ts';
import { createTransaction, simpleToPostings } from '../server/ledger.ts';
import { listAccounts } from '../server/queries.ts';
import { setValuation, investmentHistory } from '../server/investments.ts';
import { portfolio, valueHistory } from '../server/investing.ts';
import { performance } from '../server/performance.ts';
import { isaStatus } from '../server/isa.ts';
import { contributions, setEarlierYearTransfer } from '../server/contributions.ts';
import { ukDate } from '../server/dates.ts';

function setup() {
  const db = testDb();
  db.exec("UPDATE accounts SET anchor_balance = 0, anchor_date = '2025-12-31'");
  const acc = (n: string) => (db.prepare('SELECT id FROM accounts WHERE name = ?').get(n) as { id: number }).id;
  const isa = acc('Trading 212 ISA');
  const northbank = acc('Northbank Current');
  const transfer = (date: string, amount: number) => createTransaction(db, simpleToPostings({ kind: 'transfer', date, description: 'Trading 212', accountId: northbank, toAccountId: isa, amount }));
  const cash = (reference: string, type: string, amount: number, dateTime: string) =>
    db.prepare('INSERT INTO t212_cash (reference, account_id, type, amount, currency, date_time) VALUES (?, ?, ?, ?, ?, ?)').run(reference, isa, type, amount, 'GBP', dateTime);
  return { db, isa, transfer, cash };
}

test('UK dates: a Trading 212 timestamp just after midnight in summer time is the next UK day', () => {
  assert.equal(ukDate('2026-04-05T23:30:00Z'), '2026-04-06');
  assert.equal(ukDate('2026-01-05T23:30:00Z'), '2026-01-05');
  assert.equal(ukDate('2026-04-06'), '2026-04-06');
});

test('without Trading 212 history, money put in is the matched bank transfers', () => {
  const { db, isa, transfer } = setup();
  transfer('2026-05-01', 50000);
  transfer('2026-06-01', 25000);
  const c = contributions(db, isa);
  assert.equal(c.source, 'bank');
  assert.equal(c.putIn('2026-05-31'), 50000);
  assert.equal(c.putIn('2026-06-30'), 75000);
  assert.deepEqual(c.flows('2026-06-01', '2026-06-30').map((f) => f.amount), [25000]);
});

test('Trading 212 history wins, counts deposits and transfers less withdrawals, and never interest or fees', () => {
  const { db, isa, transfer, cash } = setup();
  transfer('2026-05-01', 50000); // only one deposit matched on a bank statement
  cash('d1', 'DEPOSIT', 50000, '2026-05-01T09:00:00Z');
  cash('d2', 'DEPOSIT', 70000, '2026-06-02T09:00:00Z'); // paid from another bank
  cash('t1', 'TRANSFER', 100000, '2026-07-01T09:00:00Z'); // ISA transferred in
  cash('w1', 'WITHDRAW', -20000, '2026-08-01T09:00:00Z');
  cash('i1', 'INTEREST', 300, '2026-08-31T09:00:00Z');
  cash('f1', 'FEE', -150, '2026-08-31T09:00:00Z');
  const c = contributions(db, isa);
  assert.equal(c.source, 'trading212');
  assert.equal(c.putIn('2026-09-30'), 200000);
  assert.equal(c.putIn('2026-06-30'), 120000);
});

test('a failed sync does not switch the source back to bank transfers', () => {
  const { db, isa, cash } = setup();
  cash('d1', 'DEPOSIT', 50000, '2026-05-01T09:00:00Z');
  db.prepare("INSERT INTO t212_sync (endpoint, status) VALUES ('cash', 'error') ON CONFLICT(endpoint) DO UPDATE SET status = 'error'").run();
  assert.equal(contributions(db, isa).source, 'trading212');
  assert.equal(isaStatus(db, '2026-11-12').source, 'trading212');
});

test('every screen agrees on money put in', () => {
  const { db, isa, transfer, cash } = setup();
  transfer('2026-05-01', 50000);
  cash('d1', 'DEPOSIT', 50000, '2026-05-01T09:00:00Z');
  cash('d2', 'DEPOSIT', 70000, '2026-06-02T09:00:00Z');
  cash('w1', 'WITHDRAW', -20000, '2026-08-01T09:00:00Z');
  setValuation(db, isa, '2026-09-30', 110000);
  const expected = 100000;
  const account = listAccounts(db, { asOf: '2026-09-30' }).find((a) => a.id === isa)!;
  assert.equal(account.contributed, expected, 'Accounts row');
  assert.equal(account.contributionSource, 'trading212');
  assert.equal(investmentHistory(db, isa).at(-1)!.contributed, expected, 'Accounts chart line');
  assert.equal(valueHistory(db, isa).at(-1)!.contributed, expected, 'Investing value over time');
  const p = portfolio(db, isa) as any;
  assert.equal(p.summary.netDeposited, expected, 'Investing summary');
  assert.equal(p.summary.gainOnDeposits, 110000 - expected);
  const perf = performance(db, '2026-09-30') as any;
  if (perf.available) assert.equal(perf.deposited - perf.withdrawn, expected, 'Performance');
});

test('ISA allowance: UK dates set the tax year, and earlier-year transfers are money put in but not paid in', () => {
  const { db, isa, cash } = setup();
  cash('d0', 'DEPOSIT', 30000, '2026-04-05T23:30:00Z'); // 6 April UK time: this tax year
  cash('t1', 'TRANSFER', 100000, '2026-07-01T09:00:00Z');
  let s = isaStatus(db, '2026-11-12');
  assert.equal(s.used, 130000, 'a transfer counts against the allowance by default');
  setEarlierYearTransfer(db, 't1', true);
  s = isaStatus(db, '2026-11-12');
  assert.equal(s.used, 30000);
  assert.equal(contributions(db, isa).putIn('2026-11-12'), 130000, 'still money put in');
  assert.equal(s.matching!.t212Only.find((x) => x.reference === 't1')!.earlierYear, true);
  setEarlierYearTransfer(db, 't1', false);
  assert.equal(isaStatus(db, '2026-11-12').used, 130000);
});
