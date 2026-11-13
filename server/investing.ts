/**
 * The Investing page: holdings, pies, allocation and recent activity, built
 * from the local copy of Trading 212 data (see t212.ts). Read-only.
 */
import { type DB } from './db.ts';
import { ValidationError } from './money.ts';
import { syncedAccounts } from './investments.ts';

interface PositionRow {
  ticker: string; name: string | null; isin: string | null; currency: string | null; quantity: number; quantity_in_pies: number | null;
  average_price: number | null; current_price: number | null; value: number | null; cost: number | null; unrealised: number | null;
  fx_impact: number | null; opened_at: string | null; updated_at: string;
  inst_name: string | null; short_name: string | null; type: string | null;
}

/** "ABCDl_EQ" → "ABCD", "WXYZ_US_EQ" → "WXYZ", unless Trading 212 gave a short name. */
export function symbolOf(ticker: string, shortName?: string | null) {
  if (shortName) return shortName;
  const head = ticker.split('_')[0];
  return /[a-z]$/.test(head) && head.length > 2 ? head.slice(0, -1) : head;
}

const TYPE_LABEL: Record<string, string> = { ETF: 'Funds (ETFs)', STOCK: 'Shares', FUND: 'Funds (ETFs)', ETC: 'Commodities (ETCs)' };
const typeLabel = (t: string | null) => (t ? TYPE_LABEL[t.toUpperCase()] ?? t.charAt(0) + t.slice(1).toLowerCase() : 'Other');
const currencyLabel = (c: string | null) => (c === 'GBP' || c === 'GBX' ? 'Pounds' : c === 'USD' ? 'US dollars' : c === 'EUR' ? 'Euros' : c ?? 'Other');

function accountFor(db: DB, accountId?: number) {
  const id = accountId ?? syncedAccounts(db)[0] ?? (db.prepare("SELECT id FROM accounts WHERE type = 'investment' AND archived = 0 ORDER BY id").get() as { id: number } | undefined)?.id;
  if (!id) return null;
  return db.prepare('SELECT id, name, sync_provider, last_synced_at FROM accounts WHERE id = ?').get(id) as { id: number; name: string; sync_provider: string | null; last_synced_at: string | null };
}

export function portfolio(db: DB, accountId?: number) {
  const acc = accountFor(db, accountId);
  if (!acc) return { account: null } as const;

  const rows = db.prepare(
    `SELECT p.*, i.name AS inst_name, i.short_name, i.type FROM t212_positions p LEFT JOIN t212_instruments i ON i.ticker = p.ticker
     WHERE p.account_id = ? ORDER BY IFNULL(p.value, 0) DESC`,
  ).all(acc.id) as unknown as PositionRow[];

  const pies = db.prepare('SELECT * FROM t212_pies WHERE account_id = ? ORDER BY IFNULL(value, 0) DESC').all(acc.id) as any[];
  const pieInst = db.prepare(
    `SELECT pi.*, p.name AS pie_name FROM t212_pie_instruments pi JOIN t212_pies p ON p.id = pi.pie_id WHERE p.account_id = ?`,
  ).all(acc.id) as any[];
  const pieOf = new Map<string, { id: string; name: string }[]>();
  for (const r of pieInst) {
    if (!pieOf.has(r.ticker)) pieOf.set(r.ticker, []);
    pieOf.get(r.ticker)!.push({ id: r.pie_id, name: r.pie_name ?? 'Pie' });
  }

  const total = rows.reduce((n, r) => n + (r.value ?? 0), 0);
  const holdings = rows.map((r) => {
    const cost = r.cost ?? null;
    const pl = r.unrealised ?? (r.value != null && cost != null ? r.value - cost : null);
    return {
      ticker: r.ticker,
      symbol: symbolOf(r.ticker, r.short_name),
      name: r.name ?? r.inst_name ?? r.ticker,
      type: typeLabel(r.type),
      currency: r.currency,
      quantity: r.quantity,
      averagePrice: r.average_price,
      currentPrice: r.current_price,
      value: r.value,
      cost,
      pl,
      plPct: pl != null && cost ? pl / cost : null,
      fxImpact: r.fx_impact,
      weight: total && r.value != null ? r.value / total : null,
      pies: pieOf.get(r.ticker) ?? [],
      inPie: (r.quantity_in_pies ?? 0) > 0,
      openedAt: r.opened_at?.slice(0, 10) ?? null,
      // No cost but a value: shares received for free (e.g. a spin-off).
      free: (cost === 0 || r.average_price === 0) && (r.value ?? 0) > 0,
    };
  });

  const group = (key: (h: (typeof holdings)[number]) => string) => {
    const m = new Map<string, number>();
    for (const h of holdings) m.set(key(h), (m.get(key(h)) ?? 0) + (h.value ?? 0));
    return [...m].map(([label, value]) => ({ label, value, share: total ? value / total : 0 })).sort((a, b) => b.value - a.value);
  };
  const hasPieMap = pieInst.length > 0;

  const latest = db.prepare(
    "SELECT date, value, details FROM valuations WHERE account_id = ? ORDER BY date DESC LIMIT 1",
  ).get(acc.id) as { date: string; value: number; details: string | null } | undefined;
  const d = latest?.details ? JSON.parse(latest.details) : {};

  const cashRows = db.prepare('SELECT type, SUM(amount) AS s, COUNT(*) AS n FROM t212_cash WHERE account_id = ? GROUP BY type').all(acc.id) as { type: string; s: number; n: number }[];
  const cashBy = (t: string) => cashRows.find((r) => r.type === t)?.s ?? 0;
  const deposited = cashBy('DEPOSIT') + cashBy('TRANSFER');
  const withdrawn = -cashBy('WITHDRAW');
  const firstDeposit = (db.prepare("SELECT MIN(date_time) AS d FROM t212_cash WHERE account_id = ? AND type IN ('DEPOSIT','TRANSFER')").get(acc.id) as { d: string | null }).d?.slice(0, 10) ?? null;

  const invested = d.totalCost ?? holdings.reduce((n, h) => n + (h.cost ?? 0), 0);
  const unrealised = d.unrealisedProfitLoss ?? holdings.reduce((n, h) => n + (h.pl ?? 0), 0);
  const value = latest?.value ?? total;

  return {
    account: { id: acc.id, name: acc.name, synced: acc.sync_provider === 'trading212', lastSyncedAt: acc.last_synced_at },
    asOf: latest?.date ?? null,
    summary: {
      value,
      invested,
      holdingsValue: d.investments ?? total,
      unrealised,
      unrealisedPct: invested ? unrealised / invested : null,
      realised: d.realisedProfitLoss ?? null,
      cash: { total: d.cash ?? null, free: d.freeCash ?? null, inPies: d.cashInPies ?? null, reserved: d.cashReserved ?? null },
      netDeposited: deposited - withdrawn,
      deposited,
      withdrawn,
      firstDeposit,
      // Value against everything you've put in, net of withdrawals.
      gainOnDeposits: value - (deposited - withdrawn),
    },
    holdings,
    pies: pies.map((p) => ({
      id: p.id,
      name: p.name ?? 'Pie',
      value: p.value,
      invested: p.invested,
      result: p.result,
      resultPct: p.invested ? (p.result ?? 0) / p.invested : null,
      cash: p.cash,
      goal: p.goal,
      goalPct: p.goal ? Math.min(1, (p.value ?? 0) / p.goal) : null,
      dividends: p.dividends_gained,
      holdings: pieInst.filter((r) => r.pie_id === p.id).map((r) => {
        const h = holdings.find((x) => x.ticker === r.ticker);
        return {
          ticker: r.ticker, symbol: h?.symbol ?? symbolOf(r.ticker), name: h?.name ?? r.ticker,
          target: r.expected_share, current: r.current_share, value: r.value, result: r.result,
          drift: r.expected_share != null && r.current_share != null ? r.current_share - r.expected_share : null,
        };
      }).sort((a, b) => (b.target ?? 0) - (a.target ?? 0)),
    })),
    allocation: {
      byHolding: holdings.map((h) => ({ label: h.symbol, name: h.name, value: h.value ?? 0, share: h.weight ?? 0 })),
      byType: group((h) => h.type),
      byPie: hasPieMap ? group((h) => (h.pies.length ? h.pies.map((p) => p.name).join(' + ') : 'Not in a pie')) : null,
      byCurrency: group((h) => currencyLabel(h.currency)),
    },
    pending: db.prepare('SELECT * FROM t212_pending WHERE account_id = ? ORDER BY created_at DESC').all(acc.id),
    activity: activity(db, acc.id, 30),
    history: valueHistory(db, acc.id),
  };
}

/**
 * Recent orders, deposits, withdrawals, interest and dividends, newest first.
 * Auto-invest buys placed together for a pie are grouped into one line.
 */
export function activity(db: DB, accountId: number, limit = 30) {
  const orders = db.prepare(
    `SELECT o.*, i.short_name FROM t212_orders o LEFT JOIN t212_instruments i ON i.ticker = o.ticker
     WHERE o.account_id = ? AND (o.status = 'FILLED' OR o.filled_at IS NOT NULL) ORDER BY IFNULL(o.filled_at, o.created_at) DESC LIMIT 400`,
  ).all(accountId) as any[];
  type Item = { date: string; kind: 'buy' | 'sell' | 'autoinvest' | 'deposit' | 'withdrawal' | 'interest' | 'dividend' | 'fee' | 'transfer'; title: string; detail: string | null; amount: number | null; count?: number };
  const out: Item[] = [];
  const groups = new Map<string, Item>();
  const pieName = new Map((db.prepare('SELECT pi.ticker, p.name FROM t212_pie_instruments pi JOIN t212_pies p ON p.id = pi.pie_id WHERE p.account_id = ?').all(accountId) as { ticker: string; name: string }[]).map((r) => [r.ticker, r.name]));
  for (const o of orders) {
    const when = (o.filled_at ?? o.created_at ?? '') as string;
    const sym = symbolOf(o.ticker ?? '', o.short_name);
    const amount = o.net_value != null ? Math.abs(o.net_value) : null;
    if (o.initiated_from === 'AUTOINVEST' && o.side !== 'SELL') {
      const key = `${when.slice(0, 10)}:${(o.created_at ?? '').slice(0, 16)}`;
      const g = groups.get(key);
      if (g) { g.amount = (g.amount ?? 0) + (amount ?? 0); g.count = (g.count ?? 1) + 1; g.detail = `${g.count} buys`; }
      else {
        const pie = pieName.get(o.ticker);
        const item: Item = { date: when, kind: 'autoinvest', title: pie ? `Auto-invest into ${pie}` : 'Auto-invest', detail: sym, amount, count: 1 };
        groups.set(key, item); out.push(item);
      }
      continue;
    }
    out.push({ date: when, kind: o.side === 'SELL' ? 'sell' : 'buy', title: `${o.side === 'SELL' ? 'Sold' : 'Bought'} ${sym}`, detail: o.quantity != null ? `${fmtQty(o.quantity)} shares` : null, amount });
  }
  for (const c of db.prepare('SELECT * FROM t212_cash WHERE account_id = ? ORDER BY date_time DESC LIMIT 200').all(accountId) as any[]) {
    const kind = c.type === 'DEPOSIT' ? 'deposit' : c.type === 'WITHDRAW' ? 'withdrawal' : c.type === 'FEE' ? 'fee' : c.type === 'TRANSFER' ? 'transfer' : 'interest';
    const title = { deposit: 'Deposit', withdrawal: 'Withdrawal', fee: 'Fee', transfer: 'Transfer in', interest: c.type === 'LENDING_INTEREST' ? 'Share lending interest' : 'Interest on cash' }[kind];
    out.push({ date: c.date_time ?? '', kind, title, detail: null, amount: c.amount });
  }
  for (const v of db.prepare('SELECT d.*, i.short_name FROM t212_dividends d LEFT JOIN t212_instruments i ON i.ticker = d.ticker WHERE d.account_id = ? ORDER BY paid_on DESC LIMIT 100').all(accountId) as any[]) {
    out.push({ date: v.paid_on ?? '', kind: 'dividend', title: `Dividend from ${symbolOf(v.ticker ?? '', v.short_name)}`, detail: v.name, amount: v.amount });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit).map((i) => ({ ...i, date: i.date.slice(0, 10) }));
}

function fmtQty(q: number) {
  return q >= 100 ? q.toFixed(0) : q >= 1 ? q.toFixed(2).replace(/\.?0+$/, '') : q.toPrecision(3);
}

/** Daily value snapshots against money put in (deposits less withdrawals, from Trading 212's history). */
export function valueHistory(db: DB, accountId: number) {
  const vals = db.prepare('SELECT date, value FROM valuations WHERE account_id = ? ORDER BY date').all(accountId) as { date: string; value: number }[];
  const flows = db.prepare(
    "SELECT substr(date_time, 1, 10) AS date, SUM(amount) AS amount FROM t212_cash WHERE account_id = ? AND type IN ('DEPOSIT','WITHDRAW','TRANSFER') GROUP BY 1 ORDER BY 1",
  ).all(accountId) as { date: string; amount: number }[];
  let i = 0; let running = 0;
  return vals.map((v) => {
    while (i < flows.length && flows[i].date <= v.date) running += flows[i++].amount;
    return { date: v.date, value: v.value, contributed: flows.length ? running : null };
  });
}

/** One holding: its numbers plus every order and dividend for it. */
export function holdingDetail(db: DB, ticker: string, accountId?: number) {
  const acc = accountFor(db, accountId);
  if (!acc) throw new ValidationError('No investment account');
  const p = portfolio(db, acc.id);
  const h = 'holdings' in p ? p.holdings?.find((x) => x.ticker === ticker) : undefined;
  const orders = db.prepare(
    `SELECT id, side, type, status, quantity, price, instrument_currency AS currency, net_value AS amount, taxes, realised, initiated_from AS via,
            substr(IFNULL(filled_at, created_at), 1, 10) AS date
     FROM t212_orders WHERE account_id = ? AND ticker = ? ORDER BY IFNULL(filled_at, created_at) DESC`,
  ).all(acc.id, ticker) as any[];
  const dividends = db.prepare('SELECT substr(paid_on, 1, 10) AS date, amount, quantity, gross_per_share AS perShare, type FROM t212_dividends WHERE account_id = ? AND ticker = ? ORDER BY paid_on DESC').all(acc.id, ticker);
  if (!h && !orders.length) throw new ValidationError('Holding not found');
  const filled = orders.filter((o) => o.status === 'FILLED' || o.amount != null);
  return {
    holding: h ?? null,
    name: h?.name ?? orders[0]?.name ?? ticker,
    orders,
    dividends,
    totals: {
      bought: filled.filter((o) => o.side !== 'SELL').reduce((n, o) => n + Math.abs(o.amount ?? 0), 0),
      sold: filled.filter((o) => o.side === 'SELL').reduce((n, o) => n + Math.abs(o.amount ?? 0), 0),
      fees: filled.reduce((n, o) => n + (o.taxes ?? 0), 0),
      realised: filled.reduce((n, o) => n + (o.realised ?? 0), 0),
      buys: filled.filter((o) => o.side !== 'SELL').length,
      autoinvest: filled.filter((o) => o.via === 'AUTOINVEST').length,
    },
  };
}
