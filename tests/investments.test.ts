import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './fixtures.ts';
import { createTransaction, simpleToPostings } from '../server/ledger.ts';
import { listAccounts, monthSummary, monthTotals } from '../server/queries.ts';
import { setValuation, isaAllowance, taxYear, parseSummary, syncTrading212, investmentHistory } from '../server/investments.ts';
import { todayIso, addDays } from '../server/dates.ts';
import { previewImport } from '../server/importers/import.ts';

function setup() {
  const db = testDb();
  db.exec("UPDATE accounts SET anchor_balance = 0, anchor_date = '2025-12-31'");
  const acc = (n: string) => (db.prepare('SELECT id FROM accounts WHERE name = ?').get(n) as { id: number }).id;
  const isa = acc('Trading 212 ISA');
  const northbank = acc('Northbank Current');
  const pay = (date: string, amount: number) => createTransaction(db, simpleToPostings({ kind: 'transfer', date, description: 'Trading 212', accountId: northbank, toAccountId: isa, amount }));
  return { db, isa, northbank, pay, bal: (id: number, asOf?: string) => listAccounts(db, { asOf }).find((a) => a.id === id)! };
}

test('ISA contributions are transfers, valuations give market value, growth is not income', () => {
  const { db, isa, pay, bal } = setup();
  pay('2026-04-10', 50000);
  pay('2026-05-10', 50000);
  assert.deepEqual(monthTotals(db, '2026-05'), { income: 0, spending: 0 });
  assert.equal(bal(isa).balance, 100000, 'no valuation yet: value = contributions');

  setValuation(db, isa, '2026-05-31', 108000);
  pay('2026-06-10', 50000);
  const a = bal(isa, '2026-06-30');
  assert.equal(a.contributed, 150000);
  assert.equal(a.balance, 158000, 'last valuation plus money paid in since');
  assert.equal(a.growth, 8000);
  assert.equal(bal(isa, '2026-05-15').balance, 100000, 'before the first valuation');
  assert.equal(monthTotals(db, '2026-05').income, 0, 'growth is never income');
  assert.equal(monthSummary(db, '2026-06').investments, 158000);
});

test('ISA allowance counts paid-in money in the 6 April – 5 April tax year', () => {
  const { db, pay } = setup();
  assert.deepEqual(taxYear('2026-04-05'), { start: '2025-04-06', end: '2026-04-05', label: '2025/26' });
  assert.equal(taxYear('2026-04-06').label, '2026/27');
  pay('2026-04-05', 70000); // previous tax year
  pay('2026-04-06', 30000);
  pay('2026-11-01', 50000);
  const a = isaAllowance(db, '2026-11-12');
  assert.equal(a.taxYear, '2026/27');
  assert.equal(a.used, 80000);
  assert.equal(a.remaining, 2_000_000 - 80000);
});

test('Trading 212 summary parsing', () => {
  const p = parseSummary({
    cash: { availableToTrade: 12.34, inPies: 1.5, reservedForOrders: 0 },
    currency: 'GBP', id: 1,
    investments: { currentValue: 9876.54, realizedProfitLoss: 10, totalCost: 9000, unrealizedProfitLoss: 876.54 },
    totalValue: 9890.38,
  });
  assert.ok('value' in p);
  if ('value' in p) {
    assert.equal(p.value, 987654 + 1234 + 150);
    assert.equal(p.details.totalCost, 900000);
  }
  assert.deepEqual(parseSummary({ currency: 'EUR', totalValue: 1 }), { error: 'This Trading 212 account is in EUR; only GBP is supported.' });
  assert.ok('value' in parseSummary({ totalValue: 100.1 }));
});

test('Trading 212 sync stores a valuation and reports errors without leaking the key', async () => {
  const { db, isa, bal } = setup();
  const config = { key: 'KEY123', secret: 'SECRET456', baseUrl: 'https://live.trading212.com/api/v0' };
  let seen: any = null;
  const ok = async (url: string, init: any) => {
    seen = { url, auth: init.headers.Authorization };
    return { ok: true, status: 200, json: async () => ({ currency: 'GBP', cash: { availableToTrade: 0, inPies: 0, reservedForOrders: 0 }, investments: { currentValue: 1234.56 }, totalValue: 1234.56 }) };
  };
  await syncTrading212(db, isa, config, ok);
  assert.equal(seen.url, 'https://live.trading212.com/api/v0/equity/account/summary');
  assert.equal(seen.auth, 'Basic ' + Buffer.from('KEY123:SECRET456').toString('base64'));
  assert.equal(bal(isa).balance, 123456);
  assert.equal(investmentHistory(db, isa)[0].source, 'trading212');
  assert.ok(bal(isa).lastSyncedAt);

  await assert.rejects(syncTrading212(db, isa, config, ok), /moment ago/, 'rate limited locally');

  const { db: db2, isa: isa2 } = setup();
  const denied = async () => ({ ok: false, status: 401, json: async () => ({}) });
  await assert.rejects(syncTrading212(db2, isa2, config, denied), (e: Error) => /rejected the API key/.test(e.message) && !e.message.includes('KEY123') && !e.message.includes('SECRET456'));
  const err = (db2.prepare('SELECT sync_error FROM accounts WHERE id = ?').get(isa2) as any).sync_error;
  assert.match(err, /rejected/);
  await assert.rejects(syncTrading212(db2, isa2, null), /\.env/);
});

test('payments to Trading 212 are suggested as ISA transfers on import', () => {
  const { db, northbank, isa } = setup();
  const csv = `Transaction Date,Transaction Type,Sort Code,Account Number,Transaction Description,Debit Amount,Credit Amount,Balance
03/11/2026,FPO,'11-22-33,12345678,TRADING 212 UK LTD,500.00,,1000.00
`;
  const p = previewImport(db, { accountId: northbank, csv });
  assert.equal(p.rows[0].kind, 'transfer');
  assert.equal(p.rows[0].transferAccountId, isa);
});

test('valuations cannot be in the future or on non-investment accounts', () => {
  const { db, isa, northbank } = setup();
  assert.throws(() => setValuation(db, isa, addDays(todayIso(), 1), 100), /future/);
  assert.throws(() => setValuation(db, northbank, todayIso(), 100), /only for investment/);
});
