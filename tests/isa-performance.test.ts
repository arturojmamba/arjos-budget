import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flexibleUse, matchDeposits } from '../server/isa.ts';
import { xirr, periodReturn, startFrom } from '../server/performance.ts';

test('flexible ISA: deposits after a withdrawal replace it first', () => {
  const r = flexibleUse([
    { date: '2026-05-01', amount: 100000 },
    { date: '2026-06-01', amount: -40000 },
    { date: '2026-07-01', amount: 30000 },
    { date: '2026-08-01', amount: 20000 },
  ]);
  assert.equal(r.paidIn, 150000);
  assert.equal(r.withdrawn, 40000);
  assert.equal(r.replaced, 40000);
  assert.equal(r.replaceable, 0);
  assert.equal(r.used, 150000 - 40000);
});

test('flexible ISA: an unreplaced withdrawal can still go back in', () => {
  const r = flexibleUse([{ date: '2026-05-01', amount: 50000 }, { date: '2026-06-01', amount: -20000 }, { date: '2026-06-10', amount: 5000 }]);
  assert.equal(r.replaceable, 15000);
  assert.equal(r.used, 50000);
});

test('matching pairs deposits with bank transfers and flags savings', () => {
  const m = matchDeposits(
    [
      { date: '2026-10-01', type: 'DEPOSIT', amount: 5000, reference: 'a' },
      { date: '2026-11-10', type: 'DEPOSIT', amount: 10000, reference: 'b' },
      { date: '2026-05-20', type: 'TRANSFER', amount: 2500, reference: 'c' },
    ],
    [
      { transactionId: 1, date: '2026-09-30', amount: 5000, account: 'Northbank', accountType: 'current', description: 'T212' },
      { transactionId: 2, date: '2026-11-10', amount: 10000, account: 'Harbour', accountType: 'savings', description: 'T212' },
      { transactionId: 3, date: '2026-03-01', amount: 7000, account: 'Northbank', accountType: 'current', description: 'T212' },
    ],
  );
  assert.equal(m.matched.length, 2);
  assert.equal(m.fromSavings, 10000);
  assert.equal(m.fromPay, 5000);
  assert.ok(m.matched.find((x) => x.from === 'Harbour')?.fromSavings);
  assert.equal(m.t212Only.length, 1);
  assert.equal(m.bankOnly.length, 1);
});

test('returns: a year at +10% gives about 10%', () => {
  const flows = [{ date: '2025-01-01', amount: 100000 }];
  const x = xirr(flows, 110000, '2026-01-01')!;
  assert.ok(Math.abs(x - 0.1) < 0.002, String(x));
  const p = periodReturn(flows, 110000, '2026-01-01')!;
  assert.ok(Math.abs(p - 0.1) < 0.001, String(p));
});

test('returns: late money is weighted less', () => {
  // £100 for a year making nothing, then £1,000 added the day before: value £1,100 → ~0%
  const flows = [{ date: '2025-01-01', amount: 10000 }, { date: '2025-12-31', amount: 100000 }];
  const p = periodReturn(flows, 110000, '2026-01-01')!;
  assert.ok(Math.abs(p) < 0.01, String(p));
});

test('startFrom drops a tiny early deposit before a long gap', () => {
  const flows = [{ date: '2024-03-01', amount: 100 }, { date: '2026-05-02', amount: 50000 }, { date: '2026-06-01', amount: 20000 }];
  assert.equal(startFrom(flows)[0].date, '2026-05-02');
});
