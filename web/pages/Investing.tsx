import React, { useMemo, useState } from 'react';
import { api } from '../api.ts';
import { amountsHidden, money, pct, privateLabel, shortDate, timeAgo } from '../format.ts';
import { Badge, Card, Empty, Modal, Money, Segmented, Stat, useApp, useData } from '../components/ui.tsx';
import { Donut, ValueLine } from '../components/charts.tsx';
import { Icon } from '../components/Icon.tsx';
import { useT212 } from '../components/T212.tsx';
import { navigate, setParams, useRoute } from '../router.ts';

interface Holding {
  ticker: string; symbol: string; name: string; type: string; currency: string | null; quantity: number;
  averagePrice: number | null; currentPrice: number | null; value: number | null; cost: number | null;
  pl: number | null; plPct: number | null; fxImpact: number | null; weight: number | null;
  pies: { id: string; name: string }[]; inPie: boolean; openedAt: string | null; free: boolean;
}
interface Slice { label: string; value: number; share: number; name?: string }
interface Pie {
  id: string; name: string; value: number | null; invested: number | null; result: number | null; resultPct: number | null;
  cash: number | null; goal: number | null; goalPct: number | null; dividends: number | null;
  holdings: { ticker: string; symbol: string; name: string; target: number | null; current: number | null; value: number | null; result: number | null; drift: number | null }[];
}
interface Activity { date: string; kind: string; title: string; detail: string | null; amount: number | null; count?: number }
interface Portfolio {
  account: { id: number; name: string; synced: boolean; lastSyncedAt: string | null } | null;
  asOf: string | null;
  summary: {
    value: number; invested: number; holdingsValue: number; unrealised: number; unrealisedPct: number | null; realised: number | null;
    cash: { total: number | null; free: number | null; inPies: number | null; reserved: number | null };
    netDeposited: number; deposited: number; withdrawn: number; firstDeposit: string | null; gainOnDeposits: number;
  };
  holdings: Holding[];
  pies: Pie[];
  allocation: { byHolding: Slice[]; byType: Slice[]; byPie: Slice[] | null; byCurrency: Slice[] };
  pending: any[];
  activity: Activity[];
  history: { date: string; value: number; contributed: number | null }[];
}

const PALETTE = ['#6366f1', '#0ea5e9', '#14b8a6', '#f59e0b', '#ec4899', '#8b5cf6', '#22c55e', '#f97316', '#06b6d4', '#e11d48', '#84cc16', '#a855f7'];
const colourAt = (i: number) => PALETTE[i % PALETTE.length];

/** A share price in the instrument's own currency. GBX is pence. */
function price(n: number | null, currency: string | null) {
  if (n == null) return '–';
  if (amountsHidden()) return '•••';
  if (currency === 'GBX') return `${n.toLocaleString('en-GB', { maximumFractionDigits: n >= 100 ? 0 : 2 })}p`;
  const sym = currency === 'GBP' ? '£' : currency === 'USD' ? '$' : currency === 'EUR' ? '€' : '';
  return `${sym}${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: n < 1 ? 4 : 2 })}${sym ? '' : ` ${currency ?? ''}`}`;
}
function shares(q: number) {
  if (amountsHidden()) return '•••';
  return q.toLocaleString('en-GB', { maximumFractionDigits: q >= 100 ? 0 : q >= 1 ? 3 : 4 });
}
const tone = (n: number | null | undefined) => (n == null || n === 0 ? '' : n > 0 ? 'tone-good' : 'tone-bad');
const signedPct = (n: number | null, digits = 1) => (n == null ? '–' : `${n > 0 ? '+' : ''}${pct(n, digits)}`);

type SortKey = 'value' | 'return' | 'name' | 'weight';

export function Investing() {
  const { meta } = useApp();
  const { data, reload } = useData(() => api.get<Portfolio>('/api/investing'), []);
  const t212 = useT212(reload);
  const [view, setView] = useState<'holding' | 'type' | 'pie' | 'currency'>('holding');
  const [sort, setSort] = useState<SortKey>('value');
  const [open, setOpen] = useState<string | null>(null);
  const { params } = useRoute();
  const tab = (params.get('view') as 'holdings' | 'performance' | 'isa') || 'holdings';

  const sorted = useMemo(() => {
    if (!data?.holdings) return [];
    const h = [...data.holdings];
    const by: Record<SortKey, (a: Holding, b: Holding) => number> = {
      value: (a, b) => (b.value ?? 0) - (a.value ?? 0),
      weight: (a, b) => (b.weight ?? 0) - (a.weight ?? 0),
      return: (a, b) => (b.plPct ?? -Infinity) - (a.plPct ?? -Infinity),
      name: (a, b) => a.symbol.localeCompare(b.symbol),
    };
    return h.sort(by[sort]);
  }, [data, sort]);

  if (!data) return <div className="page"><div className="skeleton" style={{ height: 120 }} /></div>;
  if (!data.account) {
    return <div className="page"><Card><Empty icon="trending-up" title="No investment account yet">Add your Stocks & Shares ISA under Accounts and tick “Get the value from Trading 212” to see your holdings here.</Empty></Card></div>;
  }
  const s = data.summary;
  const syncing = !!t212.status?.running;
  const noHoldings = data.holdings.length === 0;

  const slices: Slice[] = view === 'holding' ? data.allocation.byHolding : view === 'type' ? data.allocation.byType : view === 'pie' ? (data.allocation.byPie ?? []) : data.allocation.byCurrency;
  const donutItems = slices.map((x, i) => ({ label: x.label, value: x.value, colour: colourAt(i) }));

  return (
    <div className="page investing">
      <div className="inv-head">
        <div>
          <h2 className="inv-title">{data.account.name}</h2>
          <span className="muted small">
            {syncing ? `Syncing ${t212.status?.step?.toLowerCase() ?? ''}…` : data.account.lastSyncedAt ? `Updated ${timeAgo(data.account.lastSyncedAt)}` : 'Not synced yet'}
            {s.firstDeposit && ` · investing since ${shortDate(s.firstDeposit)}`}
          </span>
        </div>
        {data.account.synced && (
          <button className="btn" onClick={() => t212.sync()} disabled={syncing || !meta.trading212.configured}>
            <Icon name="refresh" size={16} /> {syncing ? 'Syncing…' : 'Sync now'}
          </button>
        )}
      </div>

      <div className="stats">
        <Stat label="Value" value={<Money value={s.value} />} sub={s.cash.total ? `incl. ${money(s.cash.total)} cash` : undefined} />
        <Stat label="Return on holdings" value={<Money value={s.unrealised} sign />} tone={s.unrealised >= 0 ? 'good' : 'bad'}
          sub={`${signedPct(s.unrealisedPct)} on ${money(s.invested)} invested`} />
        <Stat label="Money put in" value={<Money value={s.netDeposited} />}
          sub={s.withdrawn ? `${money(s.deposited)} in, ${money(s.withdrawn)} taken out` : 'deposits'} />
        <Stat label="Up or down overall" value={<Money value={s.gainOnDeposits} sign />} tone={s.gainOnDeposits >= 0 ? 'good' : 'bad'}
          sub={`value vs money put in${s.realised ? ` · ${money(s.realised, { sign: true })} realised on sales` : ''}`} />
      </div>

      <div className="row gap">
        <Segmented value={tab} onChange={(v) => setParams('/investing', { view: v === 'holdings' ? null : v })}
          options={[{ value: 'holdings', label: 'Holdings' }, { value: 'performance', label: 'Performance' }, { value: 'isa', label: 'ISA allowance' }]} />
      </div>
      {tab === 'performance' && <Performance onOpen={setOpen} />}
      {tab === 'isa' && <IsaAllowance />}
      {tab === 'holdings' && (noHoldings ? (
        <Card><Empty icon="trending-up" title="No holdings yet">{data.account.synced ? 'Sync with Trading 212 to pull in your holdings.' : 'This account isn’t synced with Trading 212. Turn syncing on under Accounts to see holdings.'}</Empty></Card>
      ) : (
        <>
          <div className="inv-grid">
            <Card title="Where your money is" action={
              <Segmented value={view} onChange={setView} options={[
                { value: 'holding', label: 'Holdings' }, { value: 'type', label: 'Type' },
                ...(data.allocation.byPie ? [{ value: 'pie' as const, label: 'Pie' }] : []),
                { value: 'currency', label: 'Currency' },
              ]} />}>
              <div className="alloc">
                <Donut items={donutItems} size={190} thickness={24} centre={<><span className="donut-label">Holdings</span><span className="donut-value">{money(s.holdingsValue, { compact: true })}</span></>} />
                <ul className="alloc-list">
                  {slices.slice(0, view === 'holding' ? 8 : 12).map((x, i) => (
                    <li key={x.label}>
                      <i style={{ background: colourAt(i) }} />
                      <span className="alloc-name" title={x.name}>{x.label}{x.name && view === 'holding' && <span className="muted small"> {x.name}</span>}</span>
                      <span className="alloc-pct">{pct(x.share, x.share < 0.1 ? 1 : 0)}</span>
                    </li>
                  ))}
                  {view === 'holding' && slices.length > 8 && (
                    <li className="muted small"><i style={{ background: 'var(--track)' }} /><span className="alloc-name">{slices.length - 8} more</span>
                      <span className="alloc-pct">{pct(slices.slice(8).reduce((n, x) => n + x.share, 0), 1)}</span></li>
                  )}
                </ul>
              </div>
            </Card>
            <Card title="Value over time">
              {data.history.length >= 2 ? (
                <>
                  <span className="legend"><i className="lg-income" />Value {data.history.some((h) => h.contributed != null) && <><i className="lg-contrib" />Money put in</>}</span>
                  <ValueLine points={data.history.map((h) => ({ ...h, contributed: h.contributed ?? h.value }))} height={170} />
                </>
              ) : <p className="muted">The app saves your value once a day when it syncs, so this chart fills in over the coming days.</p>}
              {data.history.length > 0 && data.history.length < 14 && <p className="muted small">Started recording on {shortDate(data.history[0].date)}. Fills in a little more each day.</p>}
              {s.cash.free != null && s.cash.free >= 2500 && <p className="tone-warn small"><Icon name="info" size={14} /> {money(s.cash.free)} is sitting as uninvested cash.</p>}
            </Card>
          </div>

          {data.pies.length > 0 && (
            <div className="pie-grid">
              {data.pies.map((p) => <PieCard key={p.id} pie={p} onOpen={setOpen} />)}
            </div>
          )}

          <Card title="Holdings" pad={false} action={
            <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort holdings">
              <option value="value">Biggest first</option><option value="return">Best return first</option><option value="name">A to Z</option>
            </select>}>
            <div className="table-wrap">
              <table className="hold-table">
                <thead><tr>
                  <th>Holding</th><th className="num hide-sm">Shares</th><th className="num hide-sm">Avg price</th><th className="num hide-sm">Price</th>
                  <th className="num">Value</th><th className="num">Return</th><th className="num hide-sm">Weight</th>
                </tr></thead>
                <tbody>
                  {sorted.map((h) => (
                    <tr key={h.ticker} onClick={() => setOpen(h.ticker)} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') setOpen(h.ticker); }}>
                      <td>
                        <div className="hold-name">
                          <span className="ticker-badge">{h.symbol.slice(0, 5)}</span>
                          <div className="stack" style={{ gap: 1, minWidth: 0 }}>
                            <strong className="ellipsis">{h.name}</strong>
                            <span className="muted small">{h.type}{h.pies.map((p) => <span key={p.id} className="tag">{p.name}</span>)}{h.free && <span className="tag">Free shares</span>}</span>
                          </div>
                        </div>
                      </td>
                      <td className="num hide-sm">{shares(h.quantity)}</td>
                      <td className="num hide-sm muted">{h.free ? '–' : price(h.averagePrice, h.currency)}</td>
                      <td className="num hide-sm">{price(h.currentPrice, h.currency)}</td>
                      <td className="num"><strong>{h.value != null ? money(h.value) : '–'}</strong></td>
                      <td className="num">
                        <span className={tone(h.pl)}>{h.pl != null ? money(h.pl, { sign: true }) : '–'}</span>
                        <div className={`small ${tone(h.pl)}`}>{h.free ? 'free' : signedPct(h.plPct)}</div>
                      </td>
                      <td className="num hide-sm"><div className="weight"><span>{pct(h.weight ?? 0, (h.weight ?? 0) < 0.1 ? 1 : 0)}</span><div className="progress"><span style={{ width: `${Math.round((h.weight ?? 0) * 100)}%`, background: 'var(--accent)' }} /></div></div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted small hold-foot">Returns are in pounds and include currency moves. Prices are in each share's own currency (p is pence).</p>
          </Card>

          <div className="inv-grid">
            <Card title="Recent activity" pad={false}>
              <ul className="activity">
                {data.activity.slice(0, 10).map((a, i) => (
                  <li key={i}>
                    <span className={`act-icon act-${a.kind}`}><Icon name={ACT_ICON[a.kind] ?? 'transfer'} size={15} /></span>
                    <div className="grow"><span>{a.title}</span><span className="muted small">{shortDate(a.date)}{a.detail ? ` · ${a.detail}` : ''}</span></div>
                    {a.amount != null && <span className={a.kind === 'withdrawal' || a.kind === 'fee' ? '' : a.kind === 'deposit' || a.kind === 'dividend' || a.kind === 'interest' ? 'tone-good' : ''}>{money(Math.abs(a.amount))}</span>}
                  </li>
                ))}
                {data.activity.length === 0 && <li className="muted">Nothing yet.</li>}
              </ul>
            </Card>
            <div className="stack" style={{ gap: 18 }}>
              <Card title="Cash">
                <div className="cash-split">
                  <div><span className="muted small">Free to invest</span><strong>{money(s.cash.free ?? 0)}</strong></div>
                  <div><span className="muted small">Waiting in pies</span><strong>{money(s.cash.inPies ?? 0)}</strong></div>
                  <div><span className="muted small">Reserved for orders</span><strong>{money(s.cash.reserved ?? 0)}</strong></div>
                </div>
              </Card>
              <Card title="Pending orders">
                {data.pending.length === 0 ? <p className="muted">None. Orders you place in Trading 212 that haven't filled yet show here.</p> : (
                  <ul className="activity">
                    {data.pending.map((o: any) => (
                      <li key={o.id}>
                        <span className="act-icon act-buy"><Icon name="repeat" size={15} /></span>
                        <div className="grow"><span>{o.side === 'SELL' ? 'Sell' : 'Buy'} {o.ticker?.split('_')[0]}</span><span className="muted small">{(o.type ?? '').toLowerCase()} order{o.limit_price ? ` at ${o.limit_price}` : ''}{o.quantity ? ` · ${shares(o.quantity)} shares` : ''}</span></div>
                        {o.value != null && <span>{money(o.value)}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          </div>
        </>
      ))}
      {open && <HoldingModal ticker={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

const ACT_ICON: Record<string, string> = { buy: 'plus', autoinvest: 'repeat', sell: 'cash', deposit: 'download', withdrawal: 'upload', interest: 'percentage', dividend: 'gift', fee: 'alert', transfer: 'transfer' };

function PieCard({ pie, onOpen }: { pie: Pie; onOpen: (t: string) => void }) {
  const maxDrift = Math.max(0, ...pie.holdings.map((h) => Math.abs(h.drift ?? 0)));
  return (
    <Card title={<span className="row gap"><Icon name="dashboard" size={16} /> {pie.name}</span>} action={pie.resultPct != null && (
      <Badge tone={(pie.result ?? 0) >= 0 ? 'good' : 'bad'}>{privateLabel((pie.result ?? 0) >= 0, signedPct(pie.resultPct), signedPct(pie.resultPct), signedPct(pie.resultPct))}</Badge>)}>
      <div className="pie-nums">
        <div><span className="muted small">Value</span><strong>{money(pie.value ?? 0)}</strong></div>
        <div><span className="muted small">Put in</span><strong>{money(pie.invested ?? 0)}</strong></div>
        <div><span className="muted small">Return</span><strong className={tone(pie.result)}>{money(pie.result ?? 0, { sign: true })}</strong></div>
      </div>
      {pie.goal != null && pie.goal > 0 && (
        <div className="pie-goal">
          <div className="row"><span className="small">Goal {money(pie.goal)}</span><span className="spacer" /><span className="small muted">{pct(pie.goalPct ?? 0)}</span></div>
          <div className="progress"><span style={{ width: `${Math.round((pie.goalPct ?? 0) * 100)}%`, background: 'var(--accent)' }} /></div>
        </div>
      )}
      {pie.holdings.length > 0 ? (
        <table className="pie-table">
          <thead><tr><th>Holding</th><th className="num">Target</th><th className="num">Now</th><th className="num">Return</th></tr></thead>
          <tbody>
            {pie.holdings.map((h) => (
              <tr key={h.ticker} onClick={() => onOpen(h.ticker)}>
                <td><span className="ticker-badge sm">{h.symbol.slice(0, 5)}</span> <span className="ellipsis">{h.name}</span></td>
                <td className="num muted">{h.target != null ? pct(h.target) : '–'}</td>
                <td className="num">{h.current != null ? pct(h.current) : '–'}
                  {h.drift != null && Math.abs(h.drift) >= 0.02 && <span className={`drift ${h.drift > 0 ? 'over' : 'under'}`} title="Away from target">{h.drift > 0 ? '▲' : '▼'}</span>}</td>
                <td className={`num ${tone(h.result)}`}>{h.result != null ? money(h.result, { sign: true }) : '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="muted small">Sync again to see what's in this pie and how close it is to its targets.</p>}
      {maxDrift >= 0.02 && <p className="muted small">▲▼ more than 2 points away from target. Trading 212 rebalances when you invest or tap “Rebalance”.</p>}
      {!!pie.cash && pie.cash >= 100 && <p className="muted small">{money(pie.cash)} cash waiting to be invested{pie.dividends ? ` · ${money(pie.dividends)} dividends earned` : ''}</p>}
    </Card>
  );
}

interface HoldingDetail {
  holding: Holding | null; name: string;
  orders: { id: string; side: string; type: string; status: string; quantity: number | null; price: number | null; currency: string | null; amount: number | null; taxes: number | null; realised: number | null; via: string | null; date: string }[];
  dividends: { date: string; amount: number; quantity: number | null; perShare: number | null }[];
  totals: { bought: number; sold: number; fees: number; realised: number; buys: number; autoinvest: number };
}

function HoldingModal({ ticker, onClose }: { ticker: string; onClose: () => void }) {
  const { data, error } = useData(() => api.get<HoldingDetail>(`/api/investing/holding/${encodeURIComponent(ticker)}`), [ticker]);
  const h = data?.holding;
  const [show, setShow] = useState(15);
  return (
    <Modal title={data?.name ?? 'Holding'} onClose={onClose} wide>
      {error && <p className="form-error">{error}</p>}
      {!data ? <div className="skeleton" style={{ height: 160 }} /> : (
        <div className="form">
          {h && (
            <div className="stats stats-3">
              <Stat label="Value" value={<Money value={h.value ?? 0} />} sub={`${shares(h.quantity)} shares at ${price(h.currentPrice, h.currency)}`} />
              <Stat label="Return" value={<Money value={h.pl ?? 0} sign />} tone={(h.pl ?? 0) >= 0 ? 'good' : 'bad'} sub={h.free ? 'received free' : `${signedPct(h.plPct)} · average ${price(h.averagePrice, h.currency)}`} />
              <Stat label="Of your holdings" value={pct(h.weight ?? 0, 1)} sub={h.pies.length ? `in ${h.pies.map((p) => p.name).join(', ')}` : h.type} />
            </div>
          )}
          {h?.fxImpact ? <p className="muted small">Currency moves account for {money(h.fxImpact, { sign: true })} of the return, because this is priced in {h.currency === 'USD' ? 'US dollars' : h.currency}.</p> : null}
          <div className="cash-split small">
            <div><span className="muted">Bought</span><strong>{money(data.totals.bought)}</strong></div>
            <div><span className="muted">Sold</span><strong>{money(data.totals.sold)}</strong></div>
            {data.totals.realised !== 0 && <div><span className="muted">Realised on sales</span><strong className={tone(data.totals.realised)}>{money(data.totals.realised, { sign: true })}</strong></div>}
            {data.totals.fees > 0 && <div><span className="muted">Fees and stamp duty</span><strong>{money(data.totals.fees)}</strong></div>}
            {data.dividends.length > 0 && <div><span className="muted">Dividends</span><strong className="tone-good">{money(data.dividends.reduce((n, d) => n + d.amount, 0))}</strong></div>}
          </div>
          <div>
            <h4 className="sub-head">Orders <span className="muted small">{data.orders.length}{data.totals.autoinvest ? `, ${data.totals.autoinvest} from auto-invest` : ''}</span></h4>
            <table className="stmt-table">
              <thead><tr><th>Date</th><th>Order</th><th className="num">Shares</th><th className="num">Price</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {data.orders.slice(0, show).map((o) => (
                  <tr key={o.id}>
                    <td>{shortDate(o.date)}</td>
                    <td>{o.side === 'SELL' ? 'Sell' : 'Buy'}{o.status !== 'FILLED' ? <span className="tag">{o.status.toLowerCase()}</span> : o.via === 'AUTOINVEST' ? <span className="muted small"> · auto</span> : ''}</td>
                    <td className="num">{o.quantity != null ? shares(o.quantity) : '–'}</td>
                    <td className="num">{price(o.price, o.currency)}</td>
                    <td className="num">{o.amount != null ? money(Math.abs(o.amount)) : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.orders.length > show && <button className="link-btn" onClick={() => setShow(show + 50)}>Show more</button>}
          </div>
          {data.dividends.length > 0 && (
            <div>
              <h4 className="sub-head">Dividends</h4>
              <table className="stmt-table">
                <thead><tr><th>Paid</th><th className="num">Shares</th><th className="num">Amount</th></tr></thead>
                <tbody>{data.dividends.map((d, i) => <tr key={i}><td>{shortDate(d.date)}</td><td className="num">{d.quantity != null ? shares(d.quantity) : '–'}</td><td className="num tone-good">{money(d.amount)}</td></tr>)}</tbody>
              </table>
            </div>
          )}
          <button className="link-btn" style={{ alignSelf: 'flex-start' }} onClick={() => { onClose(); navigate('/accounts'); }}>Open the account</button>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Performance (7.5)

interface Perf {
  available: boolean; reason?: string;
  account: string; asOf: string; since: string; days: number;
  value: number; deposited: number; withdrawn: number; netIn: number; gain: number;
  annual: number | null; annualReliable: boolean; periodReturn: number | null; simpleReturn: number | null;
  breakdown: { parts: { key: string; label: string; value: number }[]; fees: number; other: number; total: number };
  costs: { fees: number; orderFees: number; cashFees: number; bought: number; pctOfBought: number | null; fxOnHoldings: number };
  holdings: { ticker: string; symbol: string; name: string; open: boolean; value: number; unrealised: number; realised: number; dividends: number; fees: number; fx: number; bought: number; pie: string | null; total: number; totalPct: number | null }[];
  pies: { name: string; total: number; value: number; bought: number; count: number; pct: number | null }[];
}

function Performance({ onOpen }: { onOpen: (t: string) => void }) {
  const { data } = useData<Perf>(() => api.get('/api/investing/performance'), []);
  const [group, setGroup] = useState<'pie' | 'holding'>('pie');
  if (!data) return <div className="loading" />;
  if (!data.available) return <Card><Empty icon="trending-up" title="Not available yet">{data.reason}</Empty></Card>;
  const months = Math.max(1, Math.round(data.days / 30.4));
  const maxAbs = Math.max(1, ...data.breakdown.parts.map((p) => Math.abs(p.value)), Math.abs(data.breakdown.other));
  const maxPie = Math.max(1, ...data.pies.map((p) => Math.abs(p.total)));
  const maxHolding = Math.max(1, ...data.holdings.map((h) => Math.abs(h.total)));
  return (
    <>
      <div className="stats">
        <Stat label="Return so far" value={data.periodReturn != null ? signedPct(data.periodReturn) : '–'} tone={(data.periodReturn ?? 0) >= 0 ? 'good' : 'bad'}
          sub={`since ${shortDate(data.since)} (${months} month${months === 1 ? '' : 's'})`} />
        <Stat label="A year, at this rate" value={data.annual != null ? signedPct(data.annual) : '–'} tone={(data.annual ?? 0) >= 0 ? 'good' : 'bad'}
          sub={data.annualReliable ? 'money-weighted annual return' : 'under a year in: treat this as rough'} />
        <Stat label="Up or down" value={<Money value={data.gain} sign />} tone={data.gain >= 0 ? 'good' : 'bad'} sub={`value ${money(data.value)} vs ${money(data.netIn)} put in`} />
        <Stat label="Fees and stamp duty" value={<Money value={data.costs.fees} />} sub={data.costs.pctOfBought != null ? `${pct(data.costs.pctOfBought, 2)} of the ${money(data.costs.bought)} you've bought` : undefined} />
      </div>
      <p className="muted small">“Return so far” weighs each deposit by how long it's been invested, so money you added last week doesn't drag the figure down or prop it up. A simple value-against-money-in figure would be {data.simpleReturn != null ? signedPct(data.simpleReturn) : '–'}; it understates the swing when most of your money went in recently.</p>
      <div className="inv-grid">
        <Card title="Where it came from">
          <ul className="perf-parts">
            {[...data.breakdown.parts.filter((p) => p.value !== 0 || p.key === 'unrealised' || p.key === 'realised'), ...(Math.abs(data.breakdown.other) >= 50 ? [{ key: 'other', label: 'Currency on cash and rounding', value: data.breakdown.other }] : [])].map((p) => (
              <li key={p.key}>
                <span className="grow">{p.label}</span>
                <span className="perf-bar"><span className={p.value >= 0 ? 'pos' : 'neg'} style={{ width: `${(Math.abs(p.value) / maxAbs) * 100}%` }} /></span>
                <strong className={tone(p.value)}>{money(p.value, { sign: true })}</strong>
              </li>
            ))}
            <li className="perf-total"><span className="grow">Total</span><strong className={tone(data.breakdown.total)}>{money(data.breakdown.total, { sign: true })}</strong></li>
          </ul>
          <p className="muted small">Fees and stamp duty ({money(data.breakdown.fees)}) are already inside these figures. Currency moves account for {money(data.costs.fxOnHoldings, { sign: true })} of your US shares' return.</p>
        </Card>
        <Card title="Money in and out" >
          <div className="glance">
            <div><span className="muted small">Deposited</span><strong>{money(data.deposited)}</strong></div>
            <div><span className="muted small">Withdrawn</span><strong>{money(data.withdrawn)}</strong></div>
            <div><span className="muted small">Put in, net</span><strong>{money(data.netIn)}</strong></div>
            <div><span className="muted small">Worth now</span><strong>{money(data.value)}</strong></div>
          </div>
          <p className="muted small" style={{ marginTop: 10 }}>Counted from {shortDate(data.since)}{data.since > '2024' ? '' : ''}. Value as of {shortDate(data.asOf)}.</p>
        </Card>
      </div>
      <Card title="What made the return" pad={false} action={<Segmented value={group} onChange={setGroup} options={[{ value: 'pie', label: 'By pie' }, { value: 'holding', label: 'By holding' }]} />}>
        {group === 'pie' ? (
          <table className="report-table">
            <thead><tr><th>Pie</th><th className="num hide-sm">Bought</th><th className="num hide-sm">Worth now</th><th>Return</th><th className="num">£</th><th className="num">%</th></tr></thead>
            <tbody>
              {data.pies.map((p) => (
                <tr key={p.name}>
                  <td><strong>{p.name}</strong><span className="muted small"> · {p.count} holding{p.count === 1 ? '' : 's'}</span></td>
                  <td className="num hide-sm muted">{money(p.bought)}</td>
                  <td className="num hide-sm">{p.value ? money(p.value) : '–'}</td>
                  <td><span className="perf-bar"><span className={p.total >= 0 ? 'pos' : 'neg'} style={{ width: `${(Math.abs(p.total) / maxPie) * 100}%` }} /></span></td>
                  <td className={`num ${tone(p.total)}`}>{money(p.total, { sign: true })}</td>
                  <td className={`num ${tone(p.total)}`}>{p.pct != null ? signedPct(p.pct) : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="report-table">
            <thead><tr><th>Holding</th><th className="num hide-sm">Still own</th><th className="num hide-sm">Sold</th><th className="num hide-sm">Dividends</th><th>Return</th><th className="num">£</th><th className="num">%</th></tr></thead>
            <tbody>
              {data.holdings.map((h) => (
                <tr key={h.ticker} className="clickable" onClick={() => onOpen(h.ticker)}>
                  <td><span className="row gap nowrap"><span className="ticker-badge sm">{h.symbol.slice(0, 5)}</span><span className="ellipsis" style={{ maxWidth: 200 }}>{h.name}</span>{!h.open && <span className="tag">Sold</span>}</span></td>
                  <td className={`num hide-sm ${tone(h.unrealised)}`}>{h.open ? money(h.unrealised, { sign: true }) : '–'}</td>
                  <td className={`num hide-sm ${tone(h.realised)}`}>{h.realised ? money(h.realised, { sign: true }) : '–'}</td>
                  <td className="num hide-sm">{h.dividends ? money(h.dividends) : '–'}</td>
                  <td><span className="perf-bar"><span className={h.total >= 0 ? 'pos' : 'neg'} style={{ width: `${(Math.abs(h.total) / maxHolding) * 100}%` }} /></span></td>
                  <td className={`num ${tone(h.total)}`}>{money(h.total, { sign: true })}</td>
                  <td className={`num ${tone(h.total)}`}>{h.totalPct != null ? signedPct(h.totalPct) : 'free'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small hold-foot">Return here is what each one has made or lost in pounds: unrealised on what you still own, plus realised on sales, plus dividends. % is against what you paid in total.</p>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// ISA allowance (7.4)

interface Isa {
  taxYear: string; start: string; end: string; allowance: number; used: number; remaining: number; over: number;
  paidIn: number; withdrawn: number; replaced: number; replaceable: number; daysLeft: number; monthsLeft: number; perMonthToFill: number;
  source: 'trading212' | 'bank';
  matching: null | {
    matched: { date: string; bankDate: string; amount: number; type: string; from: string | null; fromSavings: boolean; lagDays: number }[];
    t212Only: { date: string; amount: number; type: string; note: string }[];
    bankOnly: { date: string; amount: number; from: string | null; description: string; note: string }[];
    fromSavings: number; fromPay: number; bySource: { account: string; amount: number; savings: boolean }[];
  };
}

function IsaAllowance() {
  const { data } = useData<Isa>(() => api.get('/api/isa/details'), []);
  const [all, setAll] = useState(false);
  if (!data) return <div className="loading" />;
  const m = data.matching;
  const share = Math.min(1, data.used / data.allowance);
  const list = m ? (all ? m.matched : m.matched.slice(0, 8)) : [];
  return (
    <>
      <div className="inv-grid">
        <Card title={`Tax year ${data.taxYear}`} action={<span className="muted small">{shortDate(data.start)} – {shortDate(data.end)}</span>}>
          <div className="isa-head">
            <div><span className="muted small">Allowance used</span><strong>{money(data.used)}</strong></div>
            <div className="right"><span className="muted small">Left to use</span><strong className="tone-good">{money(data.remaining)}</strong></div>
          </div>
          <div className="progress isa-progress"><span style={{ width: `${share * 100}%`, background: data.over ? 'var(--bad)' : 'var(--accent)' }} /></div>
          <div className="row small muted"><span>£0</span><span className="spacer" /><span>{money(data.allowance, { compact: true })}</span></div>
          {data.over > 0 && <p className="tone-bad small">You've paid in {money(data.over)} more than the allowance. Contact Trading 212 about the excess.</p>}
          <ul className="isa-facts">
            <li><span className="grow">Paid in this tax year</span><strong>{money(data.paidIn)}</strong></li>
            <li><span className="grow">Taken out</span><strong>{money(data.withdrawn)}</strong></li>
            {data.withdrawn > 0 && <li><span className="grow">Put back since (doesn't use allowance)</span><strong>{money(data.replaced)}</strong></li>}
            {data.replaceable > 0 && <li className="tone-good"><span className="grow">Can still put back without using allowance</span><strong>{money(data.replaceable)}</strong></li>}
            <li><span className="grow">Days left in the tax year</span><strong>{data.daysLeft}</strong></li>
            <li><span className="grow">To use it all, a month from now on</span><strong>{money(data.perMonthToFill)}</strong></li>
          </ul>
          <p className="muted small">{data.source === 'trading212' ? 'From Trading 212\'s own record of deposits and withdrawals. ' : 'From transfers on your bank statements (sync Trading 212 for exact figures). '}Your Trading 212 ISA is flexible: money you take out can go back in before 5 April without using allowance, and deposits after a withdrawal count as putting it back first. Growth and dividends never use allowance.</p>
          <p className="muted small" style={{ marginTop: 8 }}>From 6 April 2027 the overall allowance stays £20,000, but under-65s can put at most £12,000 of it into Cash ISAs. Stocks & Shares ISAs aren't affected.</p>
        </Card>
        {m && (
          <Card title="Where the money came from">
            <ul className="isa-facts">
              {m.bySource.map((s) => (
                <li key={s.account}><span className="grow">{s.account}{s.savings && <span className="tag">moved from savings</span>}</span><strong>{money(s.amount)}</strong></li>
              ))}
            </ul>
            {m.fromSavings > 0 && <p className="small">{money(m.fromSavings)} came from your savings rather than your pay, so it was moved, not newly saved. Your savings figures already treat it that way.</p>}
            {(m.t212Only.length > 0 || m.bankOnly.length > 0) ? (
              <div className="sub-list">
                <span className="muted small">Only on one side</span>
                {m.t212Only.map((x, i) => <div key={`t${i}`} className="row small gap"><span className="nowrap">{shortDate(x.date)}</span><span className="grow muted">Trading 212 only: {x.note}</span><strong>{money(x.amount, { sign: true })}</strong></div>)}
                {m.bankOnly.map((x, i) => <div key={`b${i}`} className="row small gap"><span className="nowrap">{shortDate(x.date)}</span><span className="grow muted">Bank only ({x.from ?? '?'}): {x.note}</span><strong>{money(x.amount, { sign: true })}</strong></div>)}
              </div>
            ) : <p className="small tone-good"><Icon name="check" size={14} /> Every deposit matches a bank transfer.</p>}
          </Card>
        )}
      </div>
      {m && (
        <Card title="Deposits matched to your bank" className="isa-match" pad={false} action={<span className="muted small">{m.matched.length} matched</span>}>
          <table className="report-table">
            <thead><tr><th>Trading 212</th><th className="hide-sm">Bank</th><th>From</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {list.map((x, i) => (
                <tr key={i}>
                  <td className="nowrap">{shortDate(x.date)}{x.amount < 0 && <span className="tag">withdrawal</span>}</td>
                  <td className="nowrap hide-sm muted">{shortDate(x.bankDate)}{x.lagDays !== 0 && <span className="small"> ({Math.abs(x.lagDays)} day{Math.abs(x.lagDays) === 1 ? '' : 's'} {x.lagDays < 0 ? 'later' : 'earlier'})</span>}</td>
                  <td><span className="ellipsis">{x.from ?? '–'}</span>{x.fromSavings && <span className="tag">from savings</span>}</td>
                  <td className={`num ${x.amount < 0 ? '' : ''}`}>{money(x.amount, { sign: x.amount < 0 })}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {m.matched.length > 8 && <div className="pager"><button className="link-btn" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${m.matched.length}`}</button></div>}
        </Card>
      )}
    </>
  );
}
