/**
 * Investment accounts (your Trading 212 Stocks & Shares ISA).
 *
 * - Money you pay in is a transfer (not spending), so the ledger balance of
 *   the account is what you've contributed.
 * - Valuations record what it's worth on a date. The difference is market
 *   growth, which is never counted as income or spending.
 * - Valuations come from Trading 212 (read-only API) or are typed in.
 */
import { type DB, tx } from './db.ts';
import { ValidationError, assertPence, parseMoney } from './money.ts';
import { isIsoDate, todayIso } from './dates.ts';

/** Overall annual ISA allowance (all ISA types combined). */
export const ISA_ALLOWANCE = 2_000_000;

export function setValuation(db: DB, accountId: number, date: string, value: number, source = 'manual', details?: unknown) {
  const acc = db.prepare('SELECT type FROM accounts WHERE id = ?').get(accountId) as { type: string } | undefined;
  if (!acc) throw new ValidationError('Account not found');
  if (acc.type !== 'investment') throw new ValidationError('Valuations are only for investment accounts');
  if (!isIsoDate(date)) throw new ValidationError('Invalid date');
  if (date > todayIso()) throw new ValidationError('Valuation date cannot be in the future');
  assertPence(value, 'Value');
  if (value < 0) throw new ValidationError('Value cannot be negative');
  db.prepare(
    `INSERT INTO valuations (account_id, date, value, source, details) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(account_id, date) DO UPDATE SET value = excluded.value, source = excluded.source, details = excluded.details, created_at = datetime('now')`,
  ).run(accountId, date, value, source, details === undefined ? null : JSON.stringify(details));
}

export function deleteValuation(db: DB, accountId: number, date: string) {
  db.prepare('DELETE FROM valuations WHERE account_id = ? AND date = ?').run(accountId, date);
}

/** Value and contributions over time, for the chart. */
export function investmentHistory(db: DB, accountId: number) {
  const vals = db.prepare('SELECT date, value, source, details FROM valuations WHERE account_id = ? ORDER BY date').all(accountId) as any[];
  const acc = db.prepare('SELECT anchor_balance, anchor_date FROM accounts WHERE id = ?').get(accountId) as { anchor_balance: number; anchor_date: string };
  const contributedAt = (date: string) => {
    const r = db.prepare(
      `SELECT IFNULL(SUM(CASE WHEN t.date > ?2 AND t.date <= ?1 THEN p.amount WHEN t.date > ?1 AND t.date <= ?2 THEN -p.amount ELSE 0 END), 0) AS n
       FROM postings p JOIN transactions t ON t.id = p.transaction_id WHERE p.account_id = ?3`,
    ).get(date, acc.anchor_date, accountId) as { n: number };
    return acc.anchor_balance + r.n;
  };
  return vals.map((v) => ({
    date: v.date,
    value: v.value,
    contributed: contributedAt(v.date),
    source: v.source,
    details: v.details ? JSON.parse(v.details) : null,
  }));
}

/** UK tax year containing a date: 6 April to 5 April. */
export function taxYear(date: string): { start: string; end: string; label: string } {
  const y = Number(date.slice(0, 4));
  const startYear = date >= `${y}-04-06` ? y : y - 1;
  return { start: `${startYear}-04-06`, end: `${startYear + 1}-04-05`, label: `${startYear}/${String(startYear + 1).slice(2)}` };
}

/**
 * How much of this tax year's ISA allowance you've used: money paid into ISA
 * accounts from your other accounts since 6 April. Growth doesn't count.
 */
export function isaAllowance(db: DB, date = todayIso()) {
  const ty = taxYear(date);
  const rows = db.prepare(
    `SELECT a.id, a.name,
            (SELECT IFNULL(SUM(p.amount), 0) FROM postings p JOIN transactions t ON t.id = p.transaction_id
              WHERE p.account_id = a.id AND p.amount > 0 AND t.kind = 'transfer' AND t.date BETWEEN ?1 AND ?2) AS paid_in,
            (SELECT IFNULL(SUM(-p.amount), 0) FROM postings p JOIN transactions t ON t.id = p.transaction_id
              WHERE p.account_id = a.id AND p.amount < 0 AND t.kind = 'transfer' AND t.date BETWEEN ?1 AND ?2) AS withdrawn
     FROM accounts a WHERE a.wrapper = 'isa' AND a.archived = 0`,
  ).all(ty.start, ty.end) as { id: number; name: string; paid_in: number; withdrawn: number }[];
  const used = rows.reduce((s, r) => s + r.paid_in, 0);
  return {
    taxYear: ty.label,
    start: ty.start,
    end: ty.end,
    allowance: ISA_ALLOWANCE,
    used,
    remaining: Math.max(0, ISA_ALLOWANCE - used),
    accounts: rows.map((r) => ({ id: r.id, name: r.name, paidIn: r.paid_in, withdrawn: r.withdrawn })),
  };
}

// ---------------------------------------------------------------------------
// Trading 212 (read-only)

export interface T212Config { key: string; secret: string; baseUrl: string }

export function trading212Config(env = process.env): T212Config | null {
  const key = env.T212_API_KEY?.trim();
  const secret = env.T212_API_SECRET?.trim();
  if (!key || !secret) return null;
  const baseUrl = env.T212_ENV === 'demo' ? 'https://demo.trading212.com/api/v0' : 'https://live.trading212.com/api/v0';
  return { key, secret, baseUrl };
}

type Fetch = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

const lastCall = new WeakMap<DB, Map<number, number>>();

/**
 * Fetch the account summary and store today's valuation.
 * Only GET /equity/account/summary is ever called. Keys are never logged or returned.
 */
export async function syncTrading212(db: DB, accountId: number, config: T212Config | null, fetchImpl: Fetch = fetch as unknown as Fetch) {
  const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId) as any;
  if (!acc || acc.type !== 'investment') throw new ValidationError('Not an investment account');
  if (!config) {
    const msg = 'Add T212_API_KEY and T212_API_SECRET to the .env file, then restart the app.';
    db.prepare('UPDATE accounts SET sync_error = ? WHERE id = ?').run(msg, accountId);
    throw new ValidationError(msg);
  }
  // Trading 212 allows one summary request every 5 seconds.
  const now = Date.now();
  if (!lastCall.has(db)) lastCall.set(db, new Map());
  const calls = lastCall.get(db)!;
  if (now - (calls.get(accountId) ?? 0) < 6000) throw new ValidationError('Synced a moment ago. Try again in a few seconds.');
  calls.set(accountId, now);

  let body: any;
  try {
    const auth = Buffer.from(`${config.key}:${config.secret}`).toString('base64');
    const res = await fetchImpl(`${config.baseUrl}/equity/account/summary`, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error('Trading 212 rejected the API key. Check it was created on the ISA account with the “Account data” permission, and that T212_API_KEY and T212_API_SECRET are both set.');
    }
    if (res.status === 429) throw new Error('Trading 212 is rate-limiting requests. It will retry at the next sync.');
    if (!res.ok) throw new Error(`Trading 212 returned an error (${res.status}).`);
    body = await res.json();
  } catch (e: any) {
    const msg = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'Trading 212 did not respond in time.'
      : e instanceof Error && e.message.startsWith('Trading 212') ? e.message
      : 'Could not reach Trading 212. Check your internet connection.';
    db.prepare('UPDATE accounts SET sync_error = ? WHERE id = ?').run(msg, accountId);
    throw new ValidationError(msg);
  }

  const parsed = parseSummary(body);
  if ('error' in parsed) {
    db.prepare('UPDATE accounts SET sync_error = ? WHERE id = ?').run(parsed.error, accountId);
    throw new ValidationError(parsed.error);
  }
  tx(db, () => {
    setValuation(db, accountId, todayIso(), parsed.value, 'trading212', parsed.details);
    db.prepare("UPDATE accounts SET last_synced_at = datetime('now'), sync_error = NULL WHERE id = ?").run(accountId);
  });
  return parsed;
}

export function parseSummary(body: any): { value: number; details: Record<string, number | string | null> } | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'Trading 212 sent an unexpected response.' };
  if (body.currency && body.currency !== 'GBP') return { error: `This Trading 212 account is in ${body.currency}; only GBP is supported.` };
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? parseMoney(v) : null);
  const investments = n(body.investments?.currentValue);
  const cashParts = [body.cash?.availableToTrade, body.cash?.inPies, body.cash?.reservedForOrders].map(n);
  let value: number | null = null;
  // Account value = investments + all cash (free, in pies, reserved). Fall back to totalValue.
  if (investments !== null && cashParts.every((c) => c !== null)) value = investments + cashParts.reduce((s, c) => s! + c!, 0)!;
  else value = n(body.totalValue);
  if (value === null) return { error: 'Trading 212 response did not include an account value.' };
  return {
    value,
    details: {
      investments,
      cash: cashParts.every((c) => c !== null) ? cashParts.reduce((s, c) => s! + c!, 0) : null,
      freeCash: cashParts[0],
      cashInPies: cashParts[1],
      cashReserved: cashParts[2],
      totalCost: n(body.investments?.totalCost),
      unrealisedProfitLoss: n(body.investments?.unrealizedProfitLoss),
      realisedProfitLoss: n(body.investments?.realizedProfitLoss),
      totalValue: n(body.totalValue),
      currency: body.currency ?? null,
    },
  };
}

/** Accounts set to sync with Trading 212. */
export function syncedAccounts(db: DB): number[] {
  return (db.prepare("SELECT id FROM accounts WHERE sync_provider = 'trading212' AND archived = 0").all() as { id: number }[]).map((r) => r.id);
}
