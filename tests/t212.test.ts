import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './fixtures.ts';
import { syncTrading212Full, syncStatus, uninvestedCash, parseOrder, parsePosition, T212Client, type T212Fetch } from '../server/t212.ts';
import { setValuation } from '../server/investments.ts';
import { healthChecks } from '../server/health.ts';
import { addDays, todayIso } from '../server/dates.ts';

const config = { key: 'KEY123', secret: 'SECRET456', baseUrl: 'https://live.trading212.com/api/v0' };

function setup() {
  const db = testDb();
  const isa = (db.prepare("SELECT id FROM accounts WHERE name = 'Trading 212 ISA'").get() as { id: number }).id;
  db.prepare("UPDATE accounts SET sync_provider = 'trading212' WHERE id = ?").run(isa);
  return { db, isa };
}

const summary = { currency: 'GBP', cash: { availableToTrade: 120.5, inPies: 0, reservedForOrders: 0 }, investments: { currentValue: 5000, totalCost: 4500, unrealizedProfitLoss: 500 }, totalValue: 5120.5 };
const orders1 = {
  items: [
    { order: { id: 1, side: 'BUY', ticker: 'EXSP_EQ', instrument: { ticker: 'EXSP_EQ', name: 'S&P 500 Acc', isin: 'XX0000000001', currency: 'GBP' }, status: 'FILLED', type: 'MARKET', createdAt: '2026-10-01T09:00:00Z', currency: 'GBP' },
      fill: { id: 11, filledAt: '2026-10-01T09:00:01Z', price: 90.1, quantity: 1.5, walletImpact: { currency: 'GBP', netValue: -135.15, fxRate: 1, realisedProfitLoss: 0, taxes: [{ name: 'STAMP', quantity: 0.5 }] } } },
  ],
  nextPagePath: '/api/v0/equity/history/orders?limit=50&cursor=abc',
};
const orders2 = { items: [{ order: { id: 2, side: 'BUY', ticker: 'EXSP_EQ', status: 'CANCELLED', createdAt: '2026-09-01T09:00:00Z' } }], nextPagePath: null };
const dividends = { items: [{ amount: 3.21, currency: 'GBP', paidOn: '2026-09-20T00:00:00Z', reference: 'D1', ticker: 'EXSP_EQ', quantity: 10, grossAmountPerShare: 0.32, type: 'ORDINARY', instrument: { name: 'S&P 500 Acc' } }], nextPagePath: null };
const cash = { items: [{ amount: 150, currency: 'GBP', dateTime: '2026-10-28T08:00:00Z', reference: 'C1', type: 'DEPOSIT' }, { amount: 0.42, dateTime: '2026-10-31T08:00:00Z', reference: 'C2', type: 'INTEREST_ON_FREE_CASH' }], nextPagePath: null };
const positions = [{ instrument: { ticker: 'EXSP_EQ', name: 'S&P 500 Acc', isin: 'XX0000000001', currency: 'GBP' }, quantity: 55.2, quantityInPies: 0, averagePricePaid: 81.5, currentPrice: 90.58, createdAt: '2025-05-01T10:00:00Z', walletImpact: { currency: 'GBP', currentValue: 5000, totalCost: 4500, unrealizedProfitLoss: 500, fxImpact: null } }];

function fakeApi(overrides: Record<string, (url: string) => any> = {}) {
  const calls: { url: string; method: string; auth: string }[] = [];
  const routes: Record<string, any> = {
    '/equity/account/summary': summary,
    '/equity/positions': positions,
    '/equity/orders': [{ id: 77, ticker: 'EXSP_EQ', type: 'LIMIT', side: 'BUY', quantity: 2, limitPrice: 85, status: 'NEW', createdAt: '2026-11-10T10:00:00Z' }],
    '/equity/history/orders?limit=50': orders1,
    '/equity/history/orders?limit=50&cursor=abc': orders2,
    '/equity/history/dividends?limit=50': dividends,
    '/equity/history/transactions?limit=50': cash,
    '/equity/metadata/instruments': [{ ticker: 'EXSP_EQ', type: 'ETF', isin: 'XX0000000001', currencyCode: 'GBP', name: 'Example S&P 500 (Acc)', shortName: 'EXSP' }],
    '/equity/pies': [{ id: 5, cash: 1.2, dividendDetails: { gained: 2 }, result: { priceAvgInvestedValue: 100, priceAvgValue: 110, priceAvgResult: 10 }, status: 'AHEAD' }],
    '/equity/pies/5': { settings: { name: 'Core', goal: 10000 }, instruments: [{ ticker: 'EXSP_EQ', ownedQuantity: 1.2, expectedShare: 1, currentShare: 1, result: { priceAvgInvestedValue: 100, priceAvgValue: 110, priceAvgResult: 10 } }] },
  };
  const f: T212Fetch = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.Authorization });
    const path = url.replace('https://live.trading212.com/api/v0', '');
    for (const [k, fn] of Object.entries(overrides)) if (path === k) return fn(url);
    if (!(path in routes)) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => structuredClone(routes[path]) };
  };
  return { f, calls };
}
const noSleep = async () => {};

test('full sync stores everything and only ever uses GET', async () => {
  const { db, isa } = setup();
  const api = fakeApi();
  const r = await syncTrading212Full(db, isa, config, { fetch: api.f, sleep: noSleep });
  assert.equal(r.value, 512050);
  assert.ok(r.steps.every((s) => s.status === 'ok'), JSON.stringify(r.steps));
  assert.ok(api.calls.every((c) => c.method === 'GET'));
  assert.ok(api.calls.every((c) => c.url.startsWith('https://live.trading212.com/api/v0/equity/')));
  assert.ok(api.calls.every((c) => c.auth === 'Basic ' + Buffer.from('KEY123:SECRET456').toString('base64')));

  const pos = db.prepare('SELECT * FROM t212_positions').all() as any[];
  assert.equal(pos.length, 1);
  assert.equal(pos[0].value, 500000);
  assert.equal(pos[0].quantity, 55.2);
  const ord = db.prepare('SELECT * FROM t212_orders ORDER BY id').all() as any[];
  assert.deepEqual(ord.map((o) => o.id), ['fill:11', 'order:2'], 'followed nextPagePath');
  assert.equal(ord[0].net_value, -13515);
  assert.equal(ord[0].taxes, 50);
  assert.equal((db.prepare('SELECT amount FROM t212_dividends').get() as any).amount, 321);
  assert.deepEqual((db.prepare('SELECT type, amount FROM t212_cash ORDER BY reference').all() as any[]).map((c) => [c.type, c.amount]), [['DEPOSIT', 15000], ['INTEREST_ON_FREE_CASH', 42]]);
  assert.equal((db.prepare('SELECT quantity FROM t212_pending').get() as any).quantity, 2);
  assert.equal((db.prepare('SELECT type FROM t212_instruments').get() as any).type, 'ETF');
  assert.deepEqual({ ...(db.prepare('SELECT name, value, goal FROM t212_pies').get() as any) }, { name: 'Core', value: 11000, goal: 1000000 });

  assert.deepEqual({ ...(db.prepare('SELECT ticker, expected_share, value FROM t212_pie_instruments').get() as any) }, { ticker: 'EXSP_EQ', expected_share: 1, value: 11000 });
  const st = syncStatus(db, config);
  assert.equal(st.endpoints.find((e) => e.key === 'orders')!.items, 2);
  assert.ok(st.endpoints.every((e) => e.status === 'ok'));
  assert.equal(st.cash!.amount, 12050);
  assert.ok(!JSON.stringify(st).includes('KEY123') && !JSON.stringify(st).includes('SECRET456'));
});

test('second sync is incremental and does not re-page history', async () => {
  const { db, isa } = setup();
  await syncTrading212Full(db, isa, config, { fetch: fakeApi().f, sleep: noSleep });
  const api = fakeApi();
  await syncTrading212Full(db, isa, config, { fetch: api.f, sleep: noSleep });
  assert.ok(!api.calls.some((c) => c.url.includes('cursor=abc')), 'stopped after a page with nothing new');
  assert.ok(!api.calls.some((c) => c.url.includes('/metadata/instruments')), 'instruments only weekly');
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM t212_orders').get() as any).n, 2);
});

test('a missing permission marks that part and the rest carries on', async () => {
  const { db, isa } = setup();
  const denied = () => ({ ok: false, status: 403, json: async () => ({}) });
  const api = fakeApi({ '/equity/history/dividends?limit=50': denied, '/equity/pies': () => ({ ok: false, status: 404, json: async () => ({}) }) });
  const r = await syncTrading212Full(db, isa, config, { fetch: api.f, sleep: noSleep });
  assert.equal(r.steps.find((s) => s.key === 'dividends')!.status, 'denied');
  assert.equal(r.steps.find((s) => s.key === 'cash')!.status, 'ok');
  const st = syncStatus(db, config);
  assert.equal(st.endpoints.find((e) => e.key === 'pies')!.status, 'unavailable');
  // Deprecated pies aren't asked for again.
  const again = fakeApi();
  await syncTrading212Full(db, isa, config, { fetch: again.f, sleep: noSleep });
  assert.ok(!again.calls.some((c) => c.url.endsWith('/equity/pies')));
});

test('a rejected key stops the run and is reported without the key', async () => {
  const { db, isa } = setup();
  const api = fakeApi({ '/equity/account/summary': () => ({ ok: false, status: 401, json: async () => ({}) }) });
  await assert.rejects(() => syncTrading212Full(db, isa, config, { fetch: api.f, sleep: noSleep }), /rejected the API key/);
  assert.equal(api.calls.length, 1);
  const acc = db.prepare('SELECT sync_error FROM accounts WHERE id = ?').get(isa) as any;
  assert.match(acc.sync_error, /rejected/);
  assert.ok(!acc.sync_error.includes('KEY123'));
});

test('rate limits: spaced calls and waiting for the reset on 429', async () => {
  let now = 1_000_000;
  const slept: number[] = [];
  let first = true;
  const f: T212Fetch = async () => {
    if (first) { first = false; return { ok: false, status: 429, json: async () => ({}), headers: { get: (h: string) => (h === 'x-ratelimit-reset' ? String((now + 10_000) / 1000) : null) } }; }
    return { ok: true, status: 200, json: async () => ({ items: [] }) };
  };
  const c = new T212Client(config, { fetch: f, now: () => now, sleep: async (ms) => { slept.push(ms); now += ms; } });
  await c.get('/equity/history/orders?limit=50', 'orders');
  assert.equal(slept[0], 10_000, 'waited for the reset');
  await c.get('/equity/history/orders?limit=50', 'orders');
  assert.ok(slept[slept.length - 1] >= 3000, 'spaced the next call');
  assert.throws(() => c.url('https://evil.example.com/x'), /another site/);
  assert.equal(c.url('/api/v0/equity/history/orders?cursor=1'), 'https://live.trading212.com/api/v0/equity/history/orders?cursor=1');
});

test('older response shapes still parse', () => {
  const o = parseOrder({ id: 9, ticker: 'ABCD_US_EQ', type: 'MARKET', status: 'FILLED', filledQuantity: -2, fillPrice: 180, filledValue: 300.5, dateExecuted: '2025-01-01T00:00:00Z', taxes: [{ quantity: 0.25 }] });
  assert.equal(o!.side, 'SELL');
  assert.equal(o!.quantity, 2);
  assert.equal(o!.net_value, 30050);
  assert.equal(o!.taxes, 25);
  const p = parsePosition({ ticker: 'ABCD_US_EQ', quantity: 1, averagePrice: 150, currentPrice: 180, ppl: 24.1 });
  assert.equal(p!.unrealised, 2410);
  assert.equal(parsePosition({}), null);
});

test('uninvested cash nudge after a week', () => {
  const { db, isa } = setup();
  const today = todayIso();
  const snap = (daysAgo: number, free: number) => setValuation(db, isa, addDays(today, -daysAgo), 500000, 'trading212', { freeCash: free });
  snap(10, 1000);
  for (const d of [8, 5, 2, 0]) snap(d, 12000);
  const c = uninvestedCash(db, isa, today)!;
  assert.equal(c.amount, 12000);
  assert.equal(c.days, 8);
  assert.ok(c.nudge);
  assert.ok(healthChecks(db, today).some((h) => h.id === 'idle-cash'));
  snap(0, 500);
  assert.equal(uninvestedCash(db, isa, today)!.nudge, false);
});

test('investing page: holdings, pies, allocation and activity from the synced copy', async () => {
  const { portfolio, holdingDetail, symbolOf } = await import('../server/investing.ts');
  const { db, isa } = setup();
  await syncTrading212Full(db, isa, config, { fetch: fakeApi().f, sleep: noSleep });
  const p: any = portfolio(db);
  assert.equal(p.account.id, isa);
  assert.equal(p.holdings.length, 1);
  const h = p.holdings[0];
  assert.equal(h.symbol, 'EXSP');
  assert.equal(h.type, 'Funds (ETFs)');
  assert.equal(h.weight, 1);
  assert.equal(Math.round(h.plPct * 1000), 111);
  assert.deepEqual(h.pies.map((x: any) => x.name), ['Core']);
  assert.equal(p.pies[0].holdings[0].target, 1);
  assert.equal(p.allocation.byPie[0].label, 'Core');
  assert.equal(p.summary.netDeposited, 15000);
  assert.equal(p.summary.gainOnDeposits, 512050 - 15000);
  assert.deepEqual(p.activity.map((a: any) => a.kind), ['interest', 'deposit', 'buy', 'dividend']);
  const d: any = holdingDetail(db, 'EXSP_EQ');
  assert.equal(d.orders.length, 2);
  assert.equal(d.totals.bought, 13515);
  assert.equal(d.totals.fees, 50);
  assert.equal(d.dividends[0].amount, 321);
  assert.equal(symbolOf('EXMPl_EQ'), 'EXMP');
  assert.equal(symbolOf('ABCD_US_EQ'), 'ABCD');
});
