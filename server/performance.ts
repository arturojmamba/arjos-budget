/**
 * Investment performance (7.5): a return that accounts for when money went in,
 * where the gain or loss came from, and what it cost.
 *
 * - Annual return is money-weighted (XIRR): deposits are money in, withdrawals
 *   money out, and today's value is what you'd get back now.
 * - "Return so far" is the same idea over the whole period without annualising
 *   (Modified Dietz), which reads better when you've been investing under a year.
 * - Breakdown: open holdings (unrealised), sales (realised), dividends, interest,
 *   fees, and whatever's left (currency on cash, rounding).
 */
import { type DB } from './db.ts';
import { daysBetween, todayIso } from './dates.ts';
import { syncedAccounts } from './investments.ts';
import { symbolOf } from './investing.ts';

export interface Flow { date: string; amount: number } // + into the account, − out of it

/** Annual money-weighted return: the rate at which deposits grow into withdrawals plus today's value. */
export function xirr(flows: Flow[], value: number, asOf: string): number | null {
  if (!flows.length || !flows.some((f) => f.amount > 0)) return null;
  const t0 = flows.reduce((m, f) => (f.date < m ? f.date : m), flows[0].date);
  const years = (d: string) => daysBetween(t0, d) / 365;
  // From your side: deposits are money out (−), withdrawals and today's value are money back (+).
  const cfs = [...flows.map((f) => ({ t: years(f.date), v: -f.amount })), { t: years(asOf), v: value }];
  const npv = (r: number) => cfs.reduce((s, c) => s + c.v / (1 + r) ** c.t, 0);
  let lo = -0.9999, hi = 10;
  let flo = npv(lo), fhi = npv(hi);
  if (!Number.isFinite(flo) || !Number.isFinite(fhi) || flo * fhi > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fm = npv(mid);
    if (Math.abs(fm) < 1e-7 || hi - lo < 1e-10) return mid;
    if (fm * flo < 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
  }
  return (lo + hi) / 2;
}

/** Return over the whole period, weighting each deposit by how long it was invested (Modified Dietz). */
export function periodReturn(flows: Flow[], value: number, asOf: string): number | null {
  if (!flows.length) return null;
  const start = flows.reduce((m, f) => (f.date < m ? f.date : m), flows[0].date);
  const total = Math.max(1, daysBetween(start, asOf));
  const net = flows.reduce((s, f) => s + f.amount, 0);
  const weighted = flows.reduce((s, f) => s + f.amount * (daysBetween(f.date, asOf) / total), 0);
  return weighted > 0 ? (value - net) / weighted : null;
}

/**
 * Where to start the clock. A test deposit (say £1) long before you really started
 * would otherwise stretch the period and distort the return, so tiny early amounts
 * followed by a long gap are counted from when you actually began.
 */
export function startFrom(flows: Flow[]): Flow[] {
  const sorted = [...flows].sort((a, b) => a.date.localeCompare(b.date));
  const total = sorted.filter((f) => f.amount > 0).reduce((s, f) => s + f.amount, 0);
  let i = 0, lead = 0;
  while (i < sorted.length - 1) {
    lead += sorted[i].amount;
    if (Math.abs(lead) > total * 0.01 || daysBetween(sorted[i].date, sorted[i + 1].date) < 90) break;
    i++;
  }
  if (i === 0) return sorted;
  const moved = sorted.slice(0, i).reduce((s, f) => s + f.amount, 0);
  return [{ date: sorted[i].date, amount: sorted[i].amount + moved }, ...sorted.slice(i + 1)];
}

export function performance(db: DB, today = todayIso()) {
  const accountId = syncedAccounts(db)[0];
  if (!accountId) return { available: false as const, reason: 'Turn on Trading 212 sync for your ISA to see performance.' };
  const acc = db.prepare('SELECT name FROM accounts WHERE id = ?').get(accountId) as { name: string };
  const flows = (db.prepare(
    "SELECT substr(date_time, 1, 10) AS date, amount FROM t212_cash WHERE account_id = ? AND type IN ('DEPOSIT','WITHDRAW','TRANSFER') ORDER BY date_time",
  ).all(accountId) as unknown as Flow[]);
  const flowsUsed = startFrom(flows);
  const latest = db.prepare('SELECT date, value, details FROM valuations WHERE account_id = ? ORDER BY date DESC LIMIT 1').get(accountId) as { date: string; value: number; details: string | null } | undefined;
  if (!flows.length || !latest) return { available: false as const, reason: 'Sync with Trading 212 first: performance needs your deposit history and a current value.' };
  const asOf = latest.date;
  const value = latest.value;
  const details = latest.details ? JSON.parse(latest.details) : {};
  const deposited = flows.filter((f) => f.amount > 0).reduce((s, f) => s + f.amount, 0);
  const withdrawn = -flows.filter((f) => f.amount < 0).reduce((s, f) => s + f.amount, 0);
  const gain = value - (deposited - withdrawn);

  // Where it came from.
  const positions = db.prepare(
    `SELECT p.ticker, p.name, p.value, p.cost, p.unrealised, p.fx_impact, i.short_name FROM t212_positions p
     LEFT JOIN t212_instruments i ON i.ticker = p.ticker WHERE p.account_id = ?`,
  ).all(accountId) as any[];
  const orders = db.prepare(
    `SELECT o.ticker, o.name, o.side, o.realised, o.taxes, o.net_value, i.short_name FROM t212_orders o
     LEFT JOIN t212_instruments i ON i.ticker = o.ticker WHERE o.account_id = ? AND (o.status = 'FILLED' OR o.filled_at IS NOT NULL)`,
  ).all(accountId) as any[];
  const dividends = db.prepare('SELECT ticker, SUM(amount) AS amount FROM t212_dividends WHERE account_id = ? GROUP BY ticker').all(accountId) as { ticker: string; amount: number }[];
  const interest = (db.prepare(
    "SELECT IFNULL(SUM(amount), 0) AS n FROM t212_cash WHERE account_id = ? AND type IN ('INTEREST_ON_FREE_CASH','LENDING_INTEREST')",
  ).get(accountId) as { n: number }).n;
  const cashFees = (db.prepare("SELECT IFNULL(SUM(amount), 0) AS n FROM t212_cash WHERE account_id = ? AND type = 'FEE'").get(accountId) as { n: number }).n;

  const unrealised = details.unrealisedProfitLoss ?? positions.reduce((s, p) => s + (p.unrealised ?? 0), 0);
  const realised = details.realisedProfitLoss ?? orders.reduce((s, o) => s + (o.realised ?? 0), 0);
  const dividendTotal = dividends.reduce((s, d) => s + d.amount, 0);
  // Stamp duty, currency conversion and other charges Trading 212 lists against each fill (stored as money out).
  const orderFees = orders.reduce((s, o) => s + Math.abs(o.taxes ?? 0), 0);
  const fees = orderFees + Math.abs(cashFees);
  const bought = orders.filter((o) => o.side !== 'SELL').reduce((s, o) => s + Math.abs(o.net_value ?? 0), 0);
  const parts = [
    { key: 'unrealised', label: 'Holdings you still own', value: unrealised },
    { key: 'realised', label: 'Shares you sold', value: realised },
    { key: 'dividends', label: 'Dividends', value: dividendTotal },
    { key: 'interest', label: 'Interest on cash', value: interest },
  ];
  const explained = parts.reduce((s, p) => s + p.value, 0);
  const other = gain - explained;

  // By holding, including ones you've sold completely.
  const pieOf = new Map((db.prepare(
    'SELECT pi.ticker, p.name FROM t212_pie_instruments pi JOIN t212_pies p ON p.id = pi.pie_id WHERE p.account_id = ?',
  ).all(accountId) as { ticker: string; name: string }[]).map((r) => [r.ticker, r.name]));
  const byTicker = new Map<string, { ticker: string; symbol: string; name: string; open: boolean; value: number; unrealised: number; realised: number; dividends: number; fees: number; fx: number; bought: number }>();
  const row = (ticker: string, name: string | null, short: string | null) => {
    if (!byTicker.has(ticker)) byTicker.set(ticker, { ticker, symbol: symbolOf(ticker, short), name: name ?? ticker, open: false, value: 0, unrealised: 0, realised: 0, dividends: 0, fees: 0, fx: 0, bought: 0 });
    return byTicker.get(ticker)!;
  };
  for (const p of positions) { const r = row(p.ticker, p.name, p.short_name); r.open = true; r.value = p.value ?? 0; r.unrealised = p.unrealised ?? 0; r.fx = p.fx_impact ?? 0; }
  for (const o of orders) {
    if (!o.ticker) continue;
    const r = row(o.ticker, o.name, o.short_name);
    r.realised += o.realised ?? 0;
    r.fees += Math.abs(o.taxes ?? 0);
    if (o.side !== 'SELL') r.bought += Math.abs(o.net_value ?? 0);
  }
  for (const d of dividends) if (d.ticker) row(d.ticker, null, null).dividends += d.amount;
  const holdings = [...byTicker.values()].map((h) => ({
    ...h, pie: pieOf.get(h.ticker) ?? null,
    total: h.unrealised + h.realised + h.dividends,
    totalPct: h.bought ? (h.unrealised + h.realised + h.dividends) / h.bought : null,
  })).sort((a, b) => a.total - b.total);

  const pies = new Map<string, { name: string; total: number; value: number; bought: number; count: number }>();
  for (const h of holdings) {
    const k = h.pie ?? (h.open ? 'Not in a pie' : 'Sold');
    const p = pies.get(k) ?? { name: k, total: 0, value: 0, bought: 0, count: 0 };
    p.total += h.total; p.value += h.value; p.bought += h.bought; p.count++;
    pies.set(k, p);
  }

  const days = daysBetween(flowsUsed[0].date, asOf);
  const annual = xirr(flowsUsed, value, asOf);
  return {
    available: true as const,
    account: acc.name, asOf, since: flowsUsed[0].date, days,
    value, deposited, withdrawn, netIn: deposited - withdrawn, gain,
    annual,
    // Annualising a few months exaggerates swings, so say when it's early days.
    annualReliable: days >= 365,
    periodReturn: periodReturn(flowsUsed, value, asOf),
    simpleReturn: deposited - withdrawn > 0 ? gain / (deposited - withdrawn) : null,
    breakdown: { parts, fees, other, total: gain },
    costs: { fees, orderFees, cashFees: Math.abs(cashFees), bought, pctOfBought: bought ? fees / bought : null, fxOnHoldings: positions.reduce((s, p) => s + (p.fx_impact ?? 0), 0) },
    holdings,
    pies: [...pies.values()].sort((a, b) => a.total - b.total).map((p) => ({ ...p, pct: p.bought ? p.total / p.bought : null })),
  };
}
