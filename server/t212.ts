/**
 * Trading 212 full sync (read-only).
 *
 * Pulls everything the API key is allowed to read and keeps a local copy:
 * account value, holdings, pending orders, order history, dividends,
 * deposits/withdrawals/interest, instrument details and pies.
 *
 * Safety:
 * - Every request is a GET. There is no code path that places, edits or
 *   cancels orders, or changes pies. `T212Client.get` is the only way out.
 * - The key and secret are only ever put in the Authorization header. They
 *   are never logged, stored, or returned in errors.
 * - Each endpoint has its own rate limit; calls are spaced out and a 429 waits
 *   for the reset time the server gives (or gives up for this run).
 */
import { type DB, tx } from './db.ts';
import { ValidationError, parseMoney } from './money.ts';
import { addDays, todayIso } from './dates.ts';
import { type T212Config, parseSummary, setValuation, syncedAccounts } from './investments.ts';

export interface T212Response { ok: boolean; status: number; json(): Promise<any>; headers?: { get(name: string): string | null } }
export type T212Fetch = (url: string, init: { method: 'GET'; headers: Record<string, string>; signal?: AbortSignal }) => Promise<T212Response>;

export interface SyncDeps {
  fetch?: T212Fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type EndpointKey = 'summary' | 'positions' | 'pending' | 'orders' | 'dividends' | 'cash' | 'instruments' | 'pies';

/** What each part of the sync needs, in the words Trading 212 uses for API key permissions. */
export const ENDPOINTS: { key: EndpointKey; label: string; permission: string }[] = [
  { key: 'summary', label: 'Account value and cash (daily snapshots)', permission: 'Account data' },
  { key: 'positions', label: 'Holdings', permission: 'Portfolio' },
  { key: 'pending', label: 'Pending orders', permission: 'Orders – read' },
  { key: 'orders', label: 'Order history', permission: 'History – orders' },
  { key: 'dividends', label: 'Dividends', permission: 'History – dividends' },
  { key: 'cash', label: 'Deposits, withdrawals and interest', permission: 'History – transactions' },
  { key: 'instruments', label: 'Instrument names and types', permission: 'Metadata' },
  { key: 'pies', label: 'Pies', permission: 'Pies – read' },
];

/** Minimum gap between calls to the same endpoint, from Trading 212's published limits (plus a margin). */
const GAP_MS: Record<string, number> = {
  summary: 5500,
  positions: 1200,
  pending: 1200,
  orders: 3200, // 20 a minute
  dividends: 3200,
  cash: 3200,
  instruments: 51000,
  pies: 31000,
  pie: 5500,
};

/** Instrument list is big and rarely changes. */
const INSTRUMENTS_EVERY_DAYS = 7;
/** Safety stop for history paging. 50 per page, so this is 100,000 items. */
const MAX_PAGES = 2000;
/** Longest we'll wait for a rate-limit reset before giving up until the next sync. */
const MAX_WAIT_MS = 70_000;

export class T212Error extends Error {
  constructor(public kind: 'auth' | 'denied' | 'unavailable' | 'error', message: string) { super(message); }
}

export class T212Client {
  private last = new Map<string, number>();
  private fetchImpl: T212Fetch;
  private sleep: (ms: number) => Promise<void>;
  private now: () => number;
  private origin: string;
  calls = 0;

  constructor(private config: T212Config, deps: SyncDeps = {}) {
    this.fetchImpl = deps.fetch ?? (fetch as unknown as T212Fetch);
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = deps.now ?? Date.now;
    this.origin = new URL(config.baseUrl).origin;
  }

  /** Turn an API path (or a nextPagePath) into a full URL on the same host. Anything else is refused. */
  url(path: string): string {
    if (/^https?:\/\//.test(path)) {
      if (new URL(path).origin !== this.origin) throw new T212Error('error', 'Trading 212 sent a link to another site.');
      return path;
    }
    if (path.startsWith('/api/')) return this.origin + path;
    return this.config.baseUrl + (path.startsWith('/') ? path : `/${path}`);
  }

  /** The only network call in this module. Always GET. */
  async get(path: string, group: string): Promise<any> {
    const gap = GAP_MS[group] ?? 1200;
    for (let attempt = 0; attempt < 4; attempt++) {
      const wait = (this.last.get(group) ?? 0) + gap - this.now();
      if (wait > 0) await this.sleep(wait);
      this.last.set(group, this.now());
      this.calls++;
      let res: T212Response;
      try {
        const auth = Buffer.from(`${this.config.key}:${this.config.secret}`).toString('base64');
        res = await this.fetchImpl(this.url(path), {
          method: 'GET',
          headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(20000),
        });
      } catch (e: any) {
        if (e instanceof T212Error) throw e;
        throw new T212Error('error', e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'Trading 212 did not respond in time.' : 'Could not reach Trading 212. Check your internet connection.');
      }
      if (res.status === 401) throw new T212Error('auth', 'Trading 212 rejected the API key. Check T212_API_KEY and T212_API_SECRET in .env.');
      if (res.status === 403) throw new T212Error('denied', 'The API key doesn’t have this permission.');
      if (res.status === 404 || res.status === 410) throw new T212Error('unavailable', 'Trading 212 no longer offers this.');
      if (res.status === 429) {
        const reset = Number(res.headers?.get('x-ratelimit-reset'));
        const until = Number.isFinite(reset) && reset > 0 ? reset * 1000 - this.now() : gap;
        if (until > MAX_WAIT_MS) throw new T212Error('error', 'Trading 212 is rate-limiting requests. It will carry on at the next sync.');
        await this.sleep(Math.max(until, 1000));
        continue;
      }
      if (!res.ok) throw new T212Error('error', `Trading 212 returned an error (${res.status}).`);
      try { return await res.json(); } catch { throw new T212Error('error', 'Trading 212 sent an unexpected response.'); }
    }
    throw new T212Error('error', 'Trading 212 is rate-limiting requests. It will carry on at the next sync.');
  }
}

// ---------------------------------------------------------------------------
// Parsing. Field names follow the current API with fallbacks for the older shapes.

const pence = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? parseMoney(v) : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v));
const items = (body: any): any[] => (Array.isArray(body) ? body : Array.isArray(body?.items) ? body.items : []);

export function parsePosition(p: any) {
  const inst = p?.instrument ?? {};
  const wi = p?.walletImpact ?? {};
  const ticker = str(inst.ticker ?? p?.ticker);
  const quantity = num(p?.quantity);
  if (!ticker || quantity === null) return null;
  return {
    ticker,
    name: str(inst.name),
    isin: str(inst.isin),
    currency: str(inst.currency),
    quantity,
    quantity_in_pies: num(p.quantityInPies ?? p.pieQuantity),
    average_price: num(p.averagePricePaid ?? p.averagePrice),
    current_price: num(p.currentPrice),
    value: pence(wi.currentValue),
    cost: pence(wi.totalCost),
    unrealised: pence(wi.unrealizedProfitLoss ?? p.ppl),
    fx_impact: pence(wi.fxImpact ?? p.fxPpl),
    opened_at: str(p.createdAt ?? p.initialFillDate),
  };
}

export function parseOrder(it: any) {
  const o = it?.order ?? it ?? {};
  const f = it?.fill ?? null;
  const orderId = str(o.id);
  const fillId = str(f?.id);
  if (!orderId && !fillId) return null;
  const rawQty = num(f?.quantity ?? o.filledQuantity ?? o.quantity ?? o.orderedQuantity);
  const side = str(o.side) ?? (rawQty !== null && rawQty < 0 ? 'SELL' : 'BUY');
  const wi = f?.walletImpact ?? {};
  const taxes = (Array.isArray(wi.taxes) ? wi.taxes : Array.isArray(o.taxes) ? o.taxes : [])
    .map((t: any) => pence(t?.quantity) ?? 0).reduce((s: number, n: number) => s + n, 0);
  return {
    id: fillId ? `fill:${fillId}` : `order:${orderId}`,
    order_id: orderId,
    ticker: str(o.ticker ?? o.instrument?.ticker),
    name: str(o.instrument?.name),
    isin: str(o.instrument?.isin),
    side: side?.toUpperCase() ?? null,
    type: str(o.type),
    status: str(o.status),
    quantity: rawQty === null ? null : Math.abs(rawQty),
    price: num(f?.price ?? o.fillPrice),
    instrument_currency: str(o.currency ?? o.instrument?.currency),
    net_value: pence(wi.netValue ?? o.filledValue),
    realised: pence(wi.realisedProfitLoss),
    taxes,
    fx_rate: num(wi.fxRate),
    created_at: str(o.createdAt ?? o.dateCreated),
    filled_at: str(f?.filledAt ?? o.dateExecuted),
    initiated_from: str(o.initiatedFrom),
  };
}

export function parsePending(o: any) {
  const id = str(o?.id);
  if (!id) return null;
  const q = num(o.quantity);
  return {
    id,
    ticker: str(o.ticker ?? o.instrument?.ticker),
    name: str(o.instrument?.name),
    side: str(o.side)?.toUpperCase() ?? (q !== null && q < 0 ? 'SELL' : 'BUY'),
    type: str(o.type),
    status: str(o.status),
    quantity: q === null ? null : Math.abs(q),
    value: pence(o.value),
    limit_price: num(o.limitPrice),
    stop_price: num(o.stopPrice),
    created_at: str(o.createdAt ?? o.creationTime),
  };
}

export function parseDividend(d: any) {
  const amount = pence(d?.amount);
  if (amount === null) return null;
  const ticker = str(d.ticker ?? d.instrument?.ticker);
  const paidOn = str(d.paidOn);
  return {
    reference: str(d.reference) ?? `${ticker}:${paidOn}:${amount}`,
    ticker,
    name: str(d.instrument?.name),
    isin: str(d.instrument?.isin),
    amount,
    currency: str(d.currency),
    gross_per_share: num(d.grossAmountPerShare),
    quantity: num(d.quantity),
    type: str(d.type),
    paid_on: paidOn,
  };
}

export function parseCash(t: any) {
  const amount = pence(t?.amount);
  const type = str(t?.type);
  if (amount === null || !type) return null;
  const dt = str(t.dateTime);
  return { reference: str(t.reference) ?? `${type}:${dt}:${amount}`, type, amount, currency: str(t.currency), date_time: dt };
}

export function parsePieInstrument(i: any) {
  const ticker = str(i?.ticker);
  if (!ticker) return null;
  return {
    ticker,
    owned_quantity: num(i.ownedQuantity),
    expected_share: num(i.expectedShare),
    current_share: num(i.currentShare),
    invested: pence(i.result?.priceAvgInvestedValue ?? i.result?.investedValue),
    value: pence(i.result?.priceAvgValue ?? i.result?.value),
    result: pence(i.result?.priceAvgResult ?? i.result?.result),
  };
}

export function parseInstrument(i: any) {
  const ticker = str(i?.ticker);
  if (!ticker) return null;
  return { ticker, name: str(i.name), short_name: str(i.shortName), isin: str(i.isin), currency: str(i.currencyCode ?? i.currency), type: str(i.type), added_on: str(i.addedOn) };
}

// ---------------------------------------------------------------------------
// Storage

function setStatus(db: DB, key: EndpointKey, status: 'ok' | 'denied' | 'error' | 'unavailable', message: string | null, count?: number) {
  db.prepare(
    `INSERT INTO t212_sync (endpoint, status, message, last_try_at, last_ok_at, items) VALUES (?1, ?2, ?3, datetime('now'), CASE WHEN ?2 = 'ok' THEN datetime('now') END, IFNULL(?4, 0))
     ON CONFLICT(endpoint) DO UPDATE SET status = ?2, message = ?3, last_try_at = datetime('now'),
       last_ok_at = CASE WHEN ?2 = 'ok' THEN datetime('now') ELSE last_ok_at END, items = IFNULL(?4, items)`,
  ).run(key, status, message, count ?? null);
}

function upsert(db: DB, table: string, key: string, row: Record<string, unknown>): boolean {
  const cols = Object.keys(row);
  const existed = db.prepare(`SELECT 1 FROM ${table} WHERE ${key} = ?`).get(row[key] as any) !== undefined;
  db.prepare(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
     ON CONFLICT(${key}) DO UPDATE SET ${cols.filter((c) => c !== key).map((c) => `${c} = excluded.${c}`).join(', ')}`,
  ).run(...(cols.map((c) => row[c]) as any[]));
  return !existed;
}

const countRows = (db: DB, table: string, accountId?: number) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}${accountId ? ' WHERE account_id = ?' : ''}`).get(...(accountId ? [accountId] : [])) as { n: number }).n;

// ---------------------------------------------------------------------------
// Sync

interface RunState { running: boolean; step: string | null; startedAt: number | null; finishedAt: number | null; error: string | null }
const runs = new WeakMap<DB, RunState>();
function runState(db: DB): RunState {
  if (!runs.has(db)) runs.set(db, { running: false, step: null, startedAt: null, finishedAt: null, error: null });
  return runs.get(db)!;
}

/** Page through a history endpoint. After the first full backfill, stop at the first page with nothing new. */
async function syncHistory(
  db: DB, client: T212Client, key: 'orders' | 'dividends' | 'cash', accountId: number,
  path: string, table: string, idCol: string, parse: (x: any) => Record<string, unknown> | null,
) {
  const backfilled = (db.prepare('SELECT backfilled FROM t212_sync WHERE endpoint = ?').get(key) as { backfilled: number } | undefined)?.backfilled === 1;
  let next: string | null = `${path}?limit=50`;
  let added = 0;
  for (let page = 0; next && page < MAX_PAGES; page++) {
    const body = await client.get(next, key);
    let newOnPage = 0;
    tx(db, () => {
      for (const raw of items(body)) {
        const row = parse(raw);
        if (!row) continue;
        if (upsert(db, table, idCol, { ...row, account_id: accountId })) newOnPage++;
      }
    });
    added += newOnPage;
    const np = body?.nextPagePath;
    next = typeof np === 'string' && np ? np : null;
    if (backfilled && newOnPage === 0) break;
  }
  db.prepare(
    `INSERT INTO t212_sync (endpoint, backfilled) VALUES (?, 1) ON CONFLICT(endpoint) DO UPDATE SET backfilled = 1`,
  ).run(key);
  return added;
}

export interface FullSyncResult {
  value: number | null;
  steps: { key: EndpointKey; status: string; message: string | null; added?: number }[];
  calls: number;
}

/**
 * Sync everything the key allows. Each part is independent: a missing permission
 * marks that part and the rest carries on. A rejected key stops the run.
 */
export async function syncTrading212Full(db: DB, accountId: number, config: T212Config | null, deps: SyncDeps = {}, opts: { force?: boolean } = {}): Promise<FullSyncResult> {
  const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId) as any;
  if (!acc || acc.type !== 'investment') throw new ValidationError('Not an investment account');
  if (!config) {
    const msg = 'Add T212_API_KEY and T212_API_SECRET to the .env file, then restart the app.';
    db.prepare('UPDATE accounts SET sync_error = ? WHERE id = ?').run(msg, accountId);
    throw new ValidationError(msg);
  }
  const state = runState(db);
  if (state.running) throw new ValidationError('Already syncing with Trading 212.');
  Object.assign(state, { running: true, step: null, startedAt: Date.now(), finishedAt: null, error: null });

  const client = new T212Client(config, deps);
  const result: FullSyncResult = { value: null, steps: [], calls: 0 };

  const step = async (key: EndpointKey, fn: () => Promise<{ added?: number; count?: number } | void>) => {
    state.step = ENDPOINTS.find((e) => e.key === key)!.label;
    try {
      const r = (await fn()) || {};
      setStatus(db, key, 'ok', null, r.count);
      result.steps.push({ key, status: 'ok', message: null, added: r.added });
    } catch (e: any) {
      if (e instanceof T212Error && e.kind === 'auth') throw e;
      const kind = e instanceof T212Error ? e.kind : 'error';
      const message = e instanceof T212Error || e instanceof ValidationError ? e.message : 'Something went wrong reading this.';
      if (!(e instanceof T212Error || e instanceof ValidationError)) console.warn(`  Trading 212 ${key}:`, e?.message);
      setStatus(db, key, kind === 'auth' ? 'error' : kind, message);
      result.steps.push({ key, status: kind, message });
      if (key === 'summary') db.prepare('UPDATE accounts SET sync_error = ? WHERE id = ?').run(message, accountId);
    }
  };

  try {
    await step('summary', async () => {
      const parsed = parseSummary(await client.get('/equity/account/summary', 'summary'));
      if ('error' in parsed) throw new ValidationError(parsed.error);
      tx(db, () => {
        setValuation(db, accountId, todayIso(), parsed.value, 'trading212', parsed.details);
        db.prepare("UPDATE accounts SET last_synced_at = datetime('now'), sync_error = NULL WHERE id = ?").run(accountId);
      });
      result.value = parsed.value;
      // Count of daily value snapshots kept.
      return { count: (db.prepare("SELECT COUNT(*) AS n FROM valuations WHERE account_id = ? AND source = 'trading212'").get(accountId) as { n: number }).n };
    });

    await step('positions', async () => {
      const body = await client.get('/equity/positions', 'positions');
      const rows = items(body).map(parsePosition).filter((r): r is NonNullable<typeof r> => r !== null);
      tx(db, () => {
        db.prepare('DELETE FROM t212_positions WHERE account_id = ?').run(accountId);
        for (const r of rows) upsertPosition(db, accountId, r);
      });
      return { count: rows.length };
    });

    await step('pending', async () => {
      const rows = items(await client.get('/equity/orders', 'pending')).map(parsePending).filter((r): r is NonNullable<typeof r> => r !== null);
      tx(db, () => {
        db.prepare('DELETE FROM t212_pending WHERE account_id = ?').run(accountId);
        for (const r of rows) upsert(db, 't212_pending', 'id', { ...r, account_id: accountId });
      });
      return { count: rows.length };
    });

    await step('orders', async () => ({ added: await syncHistory(db, client, 'orders', accountId, '/equity/history/orders', 't212_orders', 'id', parseOrder), count: countRows(db, 't212_orders', accountId) }));
    await step('dividends', async () => ({ added: await syncHistory(db, client, 'dividends', accountId, '/equity/history/dividends', 't212_dividends', 'reference', parseDividend), count: countRows(db, 't212_dividends', accountId) }));
    await step('cash', async () => ({ added: await syncHistory(db, client, 'cash', accountId, '/equity/history/transactions', 't212_cash', 'reference', parseCash), count: countRows(db, 't212_cash', accountId) }));

    const inst = db.prepare('SELECT last_ok_at FROM t212_sync WHERE endpoint = ?').get('instruments') as { last_ok_at: string | null } | undefined;
    const instDue = opts.force || !inst?.last_ok_at || inst.last_ok_at.slice(0, 10) <= addDays(todayIso(), -INSTRUMENTS_EVERY_DAYS);
    if (instDue) {
      await step('instruments', async () => {
        const rows = items(await client.get('/equity/metadata/instruments', 'instruments')).map(parseInstrument).filter((r): r is NonNullable<typeof r> => r !== null);
        tx(db, () => { for (const r of rows) upsert(db, 't212_instruments', 'ticker', r); });
        return { count: countRows(db, 't212_instruments') };
      });
    }

    const pieRow = db.prepare('SELECT status, last_try_at FROM t212_sync WHERE endpoint = ?').get('pies') as { status: string } | undefined;
    if (pieRow?.status !== 'unavailable' || opts.force) {
      await step('pies', async () => {
        const list = items(await client.get('/equity/pies', 'pies'));
        const rows: Record<string, unknown>[] = [];
        const pieHoldings = new Map<string, NonNullable<ReturnType<typeof parsePieInstrument>>[]>();
        for (const p of list) {
          const id = str(p?.id);
          if (!id) continue;
          let name: string | null = null; let goal: number | null = null;
          let holdings: ReturnType<typeof parsePieInstrument>[] = [];
          try {
            const d = await client.get(`/equity/pies/${encodeURIComponent(id)}`, 'pie');
            name = str(d?.settings?.name); goal = pence(d?.settings?.goal);
            holdings = (Array.isArray(d?.instruments) ? d.instruments : []).map(parsePieInstrument).filter(Boolean);
          } catch (e) { if (e instanceof T212Error && e.kind === 'auth') throw e; }
          pieHoldings.set(id, holdings as NonNullable<ReturnType<typeof parsePieInstrument>>[]);
          rows.push({
            id, name, goal, status: str(p.status),
            cash: pence(p.cash),
            invested: pence(p.result?.priceAvgInvestedValue ?? p.result?.investedValue),
            value: pence(p.result?.priceAvgValue ?? p.result?.value),
            result: pence(p.result?.priceAvgResult ?? p.result?.result),
            dividends_gained: pence(p.dividendDetails?.gained),
          });
        }
        tx(db, () => {
          db.prepare('DELETE FROM t212_pies WHERE account_id = ?').run(accountId);
          for (const r of rows) upsert(db, 't212_pies', 'id', { ...r, account_id: accountId });
          const ins = db.prepare('INSERT OR REPLACE INTO t212_pie_instruments (pie_id, ticker, owned_quantity, expected_share, current_share, invested, value, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
          for (const [pieId, hs] of pieHoldings) for (const h of hs) ins.run(pieId, h.ticker, h.owned_quantity, h.expected_share, h.current_share, h.invested, h.value, h.result);
        });
        return { count: rows.length };
      });
    }
  } catch (e: any) {
    // Only a rejected key gets here.
    const message = e instanceof T212Error ? e.message : 'Trading 212 sync failed.';
    state.error = message;
    db.prepare('UPDATE accounts SET sync_error = ? WHERE id = ?').run(message, accountId);
    for (const ep of ENDPOINTS) if (!result.steps.some((s) => s.key === ep.key)) { setStatus(db, ep.key, 'error', message); }
    throw new ValidationError(message);
  } finally {
    result.calls = client.calls;
    Object.assign(state, { running: false, step: null, finishedAt: Date.now() });
  }
  return result;
}

function upsertPosition(db: DB, accountId: number, r: NonNullable<ReturnType<typeof parsePosition>>) {
  const row = { account_id: accountId, ...r };
  const cols = Object.keys(row);
  db.prepare(
    `INSERT INTO t212_positions (${cols.join(', ')}, updated_at) VALUES (${cols.map(() => '?').join(', ')}, datetime('now'))
     ON CONFLICT(account_id, ticker) DO UPDATE SET ${cols.filter((c) => c !== 'account_id' && c !== 'ticker').map((c) => `${c} = excluded.${c}`).join(', ')}, updated_at = datetime('now')`,
  ).run(...(cols.map((c) => (row as any)[c]) as any[]));
}

/** Start a full sync in the background (used by "Sync now"). Returns at once. */
export function startSync(db: DB, config: T212Config | null, deps: SyncDeps = {}, opts: { force?: boolean } = {}) {
  const ids = syncedAccounts(db);
  if (!ids.length) throw new ValidationError('No account is set to sync with Trading 212. Edit your ISA under Accounts and tick “Get the value from Trading 212”.');
  if (!config) throw new ValidationError('Add T212_API_KEY and T212_API_SECRET to the .env file, then restart the app.');
  if (runState(db).running) throw new ValidationError('Already syncing with Trading 212.');
  const p = syncTrading212Full(db, ids[0], config, deps, opts).catch((e) => { runState(db).error = e.message; });
  return { started: true, done: p };
}

/** Everything the Settings card needs. */
export function syncStatus(db: DB, config: T212Config | null) {
  const rows = new Map((db.prepare('SELECT * FROM t212_sync').all() as any[]).map((r) => [r.endpoint, r]));
  const state = runState(db);
  const accountId = syncedAccounts(db)[0] ?? null;
  return {
    configured: config !== null,
    environment: config?.baseUrl.includes('demo') ? 'demo' : 'live',
    accountId,
    running: state.running,
    step: state.step,
    lastRunError: state.error,
    endpoints: ENDPOINTS.map((e) => {
      const r = rows.get(e.key);
      return { key: e.key, label: e.label, permission: e.permission, status: r?.status ?? 'never', message: r?.message ?? null, lastOkAt: r?.last_ok_at ?? null, lastTryAt: r?.last_try_at ?? null, items: r?.items ?? 0 };
    }),
    cash: accountId ? uninvestedCash(db, accountId) : null,
  };
}

/** Free cash below this isn't worth a nudge. */
export const IDLE_CASH_MIN = 2500;
/** How long cash has to sit before we mention it. */
export const IDLE_CASH_DAYS = 7;

/**
 * Cash sitting in the account that isn't invested, and for how long, from the
 * daily snapshots. `since` is the first day of the current run of days with
 * at least IDLE_CASH_MIN free.
 */
export function uninvestedCash(db: DB, accountId: number, today = todayIso()) {
  const snaps = db.prepare(
    `SELECT date, details FROM valuations WHERE account_id = ? AND source = 'trading212' AND date <= ? ORDER BY date DESC LIMIT 120`,
  ).all(accountId, today) as { date: string; details: string | null }[];
  const free = (d: string | null) => {
    if (!d) return null;
    try { const j = JSON.parse(d); return typeof j.freeCash === 'number' ? j.freeCash : null; } catch { return null; }
  };
  const latest = snaps.length ? free(snaps[0].details) : null;
  if (latest === null) return null;
  let since = snaps[0].date;
  for (const s of snaps) {
    const f = free(s.details);
    if (f === null || f < IDLE_CASH_MIN) break;
    since = s.date;
  }
  const days = latest >= IDLE_CASH_MIN ? Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${since}T12:00:00Z`)) / 86400000) : 0;
  return { amount: latest, asOf: snaps[0].date, since: latest >= IDLE_CASH_MIN ? since : null, days, nudge: latest >= IDLE_CASH_MIN && days >= IDLE_CASH_DAYS };
}
