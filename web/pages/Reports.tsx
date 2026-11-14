import React, { useEffect, useMemo, useState } from 'react';
import { api, qs } from '../api.ts';
import { money, monthLabel, pct, shortDate, amountsHidden, niceName } from '../format.ts';
import { Badge, Bubble, Card, Empty, Field, Money, Segmented, Stat, useApp, useData, useFitRows, usePaged } from '../components/ui.tsx';
import { IncomeSpendBars } from '../components/charts.tsx';
import { LineChart, Spark, StackedBars, Waterfall, useHidden } from '../components/viz.tsx';
import { Icon } from '../components/Icon.tsx';
import { navigate, setParams } from '../router.ts';

type Tab = 'week' | 'spending' | 'cashflow' | 'compare' | 'networth' | 'year';
const TABS: { value: Tab; label: string }[] = [
  { value: 'week', label: 'This week' }, { value: 'spending', label: 'Spending' }, { value: 'cashflow', label: 'Cash flow' },
  { value: 'compare', label: 'Compare' }, { value: 'networth', label: 'Net worth' },
];
/** Old links (trends, merchants, ask) still land somewhere sensible. */
const OLD: Record<string, Tab> = { trends: 'spending', merchants: 'spending', explore: 'spending' };

export function Reports({ params }: { params: URLSearchParams }) {
  const raw = params.get('tab') ?? 'spending';
  const tab: Tab = (OLD[raw] ?? raw) as Tab;
  const go = (t: Tab, extra: Record<string, string | number | undefined | null> = {}) => setParams('/reports', { tab: t === 'spending' ? undefined : t, ...extra });
  return (
    <div className="page">
      <div className="report-tabs no-print">
        {tab !== 'year' ? <Segmented<Tab> value={tab} onChange={(t) => go(t)} options={TABS} /> : <button className="btn btn-sm" onClick={() => go('spending')}><Icon name="chevron-left" size={14} /> Back to reports</button>}
        <span className="spacer" />
        {tab !== 'year' && <button className="btn btn-sm" onClick={() => go('year')} aria-label="Year in review"><Icon name="file" size={14} /> <span className="hide-sm-text">Year in review</span></button>}
      </div>
      {tab === 'week' && <WeekTab week={params.get('week')} onWeek={(w) => go('week', { week: w })} />}
      {tab === 'spending' && <SpendingTab params={params} />}
      {tab === 'cashflow' && <CashFlow />}
      {tab === 'compare' && <CompareTab />}
      {tab === 'networth' && <NetWorth />}
      {tab === 'year' && <YearReview params={params} onChange={(kind, year) => go('year', { kind, year })} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// This week: Monday to Sunday, week by week

interface WeekData {
  from: string; to: string; upTo: string; current: boolean; elapsed: number; previousWeek: string; nextWeek: string | null; isLastWeek: boolean; isFirstWeek: boolean;
  spent: number; dayToDay: number; fixed: number; income: number; saved: number; count: number;
  last: { spent: number; dayToDay: number; sameDays: boolean; fullWeek: number };
  typical: { spent: number; dayToDay: number; weeks: number } | null;
  days: { date: string; label: string; spent: number; count: number; future: boolean; today: boolean }[];
  series: { key: string; label: string; colour: string; values: number[] }[];
  categories: { categoryId: number | null; name: string; colour: string; icon: string | null; fixed: boolean; total: number; count: number; previous: number; change: number }[];
  places: { merchant: string; label: string; total: number; count: number; colour: string; category: string }[];
  biggest: { id: number; date: string; description: string; merchant: string; label: string; category: string; colour: string; amount: number }[];
  bills: { recurringId: number; name: string; type: string; date: string; amount: number; status: string }[];
  upcoming: { recurringId: number; name: string; type: string; date: string; amount: number; status: string }[];
  budgets: { id: number; name: string; icon: string | null; colour: string; period: string; periodLabel: string; thisWeek: number; spent: number; available: number; remaining: number; status: string }[];
}

const dayMonth = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const weekday = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'long' });
/** "£40 less than …" / "£40 more than …" / "the same as …". */
function versus(now: number, then: number, what: string) {
  const diff = now - then;
  if (Math.abs(diff) < 100) return <>about the same as {what}</>;
  return <><strong className={diff > 0 ? 'tone-bad' : 'tone-good'}>{money(Math.abs(diff))} {diff > 0 ? 'more' : 'less'}</strong> than {what}</>;
}

function WeekTab({ week, onWeek }: { week: string | null; onWeek: (w: string | null) => void }) {
  const { data, error } = useData<WeekData>(() => api.get(`/api/reports/week${qs({ week: week ?? undefined })}`), [week]);
  const [hidden, toggle, setHidden] = useHidden();
  // Rent and bills land on one day and dwarf everything else: start with them hidden (click the key to show).
  useEffect(() => {
    if (data) setHidden(new Set(data.categories.filter((c) => c.fixed && c.total > 0).map((c) => String(c.categoryId))));
  }, [data?.from]); // eslint-disable-line
  if (error) return <Card><Empty icon="calendar" title="Can't show that week">{error}</Empty></Card>;
  if (!data) return <div className="loading" />;
  const range = { from: data.from, to: data.to };
  const lastWeekStart = data.previousWeek;
  const title = data.current ? 'This week' : data.isLastWeek ? 'Last week' : `Week of ${dayMonth(data.from)}`;
  const lastLabel = data.current ? 'by this point last week' : 'the week before';
  const typicalDay = data.typical ? Math.round(data.typical.dayToDay / 7) : null;
  const maxCat = Math.max(1, ...data.categories.map((c) => Math.max(c.total, c.previous)));
  const maxPlace = Math.max(1, ...data.places.map((p) => p.total));
  const openDay = (i: number) => { const d = data.days[i]; if (!d.future) navigate(`/transactions${qs({ from: d.date, to: d.date, month: 'all' })}`); };
  return (
    <>
      <div className="week-head">
        <button className="btn btn-icon" aria-label="Previous week" onClick={() => onWeek(lastWeekStart)}><Icon name="chevron-left" size={16} /></button>
        <div className="week-title">
          <h2>{title}</h2>
          <span className="muted small">Mon {dayMonth(data.from)} – Sun {dayMonth(data.to)} {data.to.slice(0, 4)}{data.current && data.elapsed < 7 ? ` · so far, up to ${weekday(data.upTo)}` : ''}</span>
        </div>
        <button className="btn btn-icon" aria-label="Next week" disabled={!data.nextWeek} onClick={() => data.nextWeek && onWeek(data.nextWeek)}><Icon name="chevron-right" size={16} /></button>
        <span className="spacer" />
        {!data.current && <button className="btn btn-sm" onClick={() => onWeek(null)}>This week</button>}
      </div>

      <p className="week-lede">
        {data.count === 0 ? <>No spending recorded {data.current ? 'yet this week' : 'this week'}.</> : <>
          {data.current ? "You've spent " : 'You spent '}<strong><Money value={data.spent} /></strong>{data.current ? ' so far this week' : ''}, {versus(data.spent, data.last.spent, lastLabel)}.
          {data.typical && <> Day-to-day spending was <Money value={data.dayToDay} />, {versus(data.dayToDay, data.current ? Math.round(data.typical.dayToDay * data.elapsed / 7) : data.typical.dayToDay, data.current ? 'a typical week by now' : 'a typical week')}.</>}
        </>}
      </p>

      <div className="stats">
        <Stat label="Spent" value={<Money value={data.spent} />} sub={<>{money(data.last.spent)} {lastLabel}</>} />
        <Stat label="Day-to-day" value={<Money value={data.dayToDay} />} sub={data.typical ? <>Typical week {money(data.typical.dayToDay)}</> : 'Leaves out bills and rent'} />
        <Stat label="Bills and fixed costs" value={<Money value={data.fixed} />} sub={`${data.bills.filter((b) => b.status === 'paid').length} of ${data.bills.length} due this week paid`} />
        <Stat label="Money in" value={<Money value={data.income} />} sub={data.saved ? <>Saved and invested {money(data.saved)}</> : 'Nothing moved to savings'} tone={data.income > 0 ? 'good' : undefined} />
      </div>

      <Card title="Day by day" action={<span className="muted small">{data.categories.some((c) => c.fixed && c.total > 0) ? 'Bills and rent are hidden: click the key to show them' : 'Click a day to see its transactions'}</span>}>
        {data.count === 0 ? <p className="muted">Nothing to show for this week.</p> : (
          <StackedBars labels={data.days.map((d) => `${d.label} ${Number(d.date.slice(8))}`)} titles={data.days.map((d) => `${weekday(d.date)} ${dayMonth(d.date)}`)}
            series={data.series} hidden={hidden} onToggle={toggle} onBarClick={openDay} barHint="Click to see this day's transactions"
            selected={data.current ? data.days.findIndex((d) => d.today) : null}
            reference={typicalDay ? { value: typicalDay, label: 'typical day-to-day' } : undefined} height={220} />
        )}
      </Card>

      <div className="grid-2-cards">
        <Card title="By category" pad={false} action={<span className="muted small">vs {data.current ? 'same days last week' : 'week before'}</span>}>
          {data.categories.length === 0 ? <p className="muted pad">No spending.</p> : (
            <table className="report-table week-cats">
              <tbody>
                {data.categories.map((c) => (
                  <tr key={String(c.categoryId)} className="clickable" onClick={() => navigate(`/transactions${qs({ from: range.from, to: data.upTo, month: 'all', categoryId: c.categoryId ?? undefined, uncategorised: c.categoryId == null ? 1 : undefined })}`)}>
                    <td>
                      <span className="row gap nowrap"><span className="dot" style={{ background: c.colour }} />{c.name}{c.fixed && <span className="tag">Fixed</span>}</span>
                      <span className="week-bar"><span style={{ width: `${(c.total / maxCat) * 100}%`, background: c.colour }} /><span className="prev" style={{ left: `${(c.previous / maxCat) * 100}%` }} title={`${money(c.previous)} ${data.current ? 'same days last week' : 'week before'}`} /></span>
                    </td>
                    <td className="num"><strong>{money(c.total)}</strong><div className="muted small">{c.count} {c.count === 1 ? 'spend' : 'spends'}</div></td>
                    <td className={`num small ${c.change > 100 ? 'tone-bad' : c.change < -100 ? 'tone-good' : 'muted'}`}>{Math.abs(c.change) < 100 ? 'same' : `${c.change > 0 ? '+' : '−'}${money(Math.abs(c.change))}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="muted small pad">The tick on each bar marks {data.current ? 'the same days last week' : 'the week before'}.</p>
        </Card>

        <div className="stack">
          {data.budgets.length > 0 && (
            <Card title="Budgets" action={<button className="link-btn small" onClick={() => navigate('/budgets')}>Budgets</button>}>
              <ul className="week-list">
                {data.budgets.map((b) => (
                  <li key={b.id}>
                    <span className="week-icon">{b.icon ?? '•'}</span>
                    <span className="grow"><strong>{b.name}</strong><div className="muted small">{money(b.thisWeek)} this week · {b.remaining >= 0 ? `${money(b.remaining)} left` : `${money(-b.remaining)} over`} for {b.periodLabel}</div>
                      <span className="week-bar"><span style={{ width: `${Math.min(100, (b.spent / Math.max(1, b.available)) * 100)}%`, background: b.status === 'over' ? 'var(--bad)' : b.status === 'warn' ? 'var(--warn)' : b.colour }} /></span>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Card title="Where you spent it">
            {data.places.length === 0 ? <p className="muted">No spending.</p> : (
              <ul className="week-list">
                {data.places.map((p) => (
                  <li key={p.merchant} className="clickable" onClick={() => navigate(`/transactions${qs({ from: range.from, to: data.upTo, month: 'all', merchant: p.merchant })}`)}>
                    <span className="dot" style={{ background: p.colour }} />
                    <span className="grow"><span className="ellipsis">{p.label}</span><span className="week-bar thin"><span style={{ width: `${(p.total / maxPlace) * 100}%`, background: p.colour }} /></span></span>
                    <span className="num"><strong>{money(p.total)}</strong>{p.count > 1 && <div className="muted small">{p.count} times</div>}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <div className="grid-2-cards">
        <Card title="Biggest spends">
          {data.biggest.length === 0 ? <p className="muted">No spending.</p> : (
            <ul className="week-list">
              {data.biggest.map((b) => (
                <li key={b.id} className="clickable" onClick={() => navigate(`/transactions${qs({ from: b.date, to: b.date, month: 'all', merchant: b.merchant })}`)}>
                  <span className="dot" style={{ background: b.colour }} />
                  <span className="grow"><strong>{niceName(b.label)}</strong><div className="muted small">{weekday(b.date).slice(0, 3)} {dayMonth(b.date)} · {b.category}</div></span>
                  <strong className="num">{money(b.amount)}</strong>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title={data.current ? 'Bills this week and next' : 'Bills this week'} action={<button className="link-btn small" onClick={() => navigate('/bills')}>Bills</button>}>
          {data.bills.length === 0 && data.upcoming.length === 0 ? <p className="muted">No bills due.</p> : (
            <ul className="week-list">
              {data.bills.map((b) => (
                <li key={`${b.recurringId}-${b.date}`}>
                  <span className="week-date">{weekday(b.date).slice(0, 3)}<b>{Number(b.date.slice(8))}</b></span>
                  <span className="grow">{b.name}</span>
                  <Badge tone={b.status === 'paid' ? 'good' : b.status === 'overdue' ? 'bad' : 'neutral'}>{b.status === 'paid' ? 'Paid' : b.status === 'overdue' ? 'Overdue' : b.status === 'skipped' ? 'Skipped' : 'Due'}</Badge>
                  <strong className="num">{money(b.amount)}</strong>
                </li>
              ))}
              {data.upcoming.length > 0 && <li className="week-sep muted small">Next week</li>}
              {data.upcoming.map((b) => (
                <li key={`n${b.recurringId}-${b.date}`} className="muted">
                  <span className="week-date">{weekday(b.date).slice(0, 3)}<b>{Number(b.date.slice(8))}</b></span>
                  <span className="grow">{b.name}</span>
                  <span className="num">{money(b.amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

const signedPct = (n: number | null | undefined, digits = 0) => (n == null || !Number.isFinite(n) ? '–' : `${n > 0 ? '+' : ''}${pct(n, digits)}`);
const changeTone = (n: number | null | undefined) => (n == null ? '' : n > 0.02 ? 'tone-bad' : n < -0.02 ? 'tone-good' : 'muted');
const shortMonth = (m: string) => monthLabel(m, true).split(' ')[0];

// ---------------------------------------------------------------------------
// Spending: explore, cut back, habits, budgets

type View = 'explore' | 'cutback' | 'habits' | 'budgets';

function SpendingTab({ params }: { params: URLSearchParams }) {
  const view = (params.get('view') as View) || 'explore';
  const set = (extra: Record<string, string | number | undefined | null>) => {
    const keep: Record<string, string | null> = {};
    for (const k of ['view', 'from', 'to', 'cat', 'merchant', 'q']) keep[k] = params.get(k);
    setParams('/reports', { ...keep, ...extra });
  };
  return (
    <>
      <div className="report-sub no-print">
        <Segmented<View> value={view} onChange={(v) => set({ view: v === 'explore' ? null : v })} options={[
          { value: 'explore', label: 'Where it went' }, { value: 'cutback', label: 'Where to cut back' },
          { value: 'habits', label: 'Habits' }, { value: 'budgets', label: 'Budget track record' },
        ]} />
      </div>
      {view === 'explore' && <Explorer params={params} set={set} />}
      {view === 'cutback' && <CutBack open={(extra) => set({ view: null, ...extra })} />}
      {view === 'habits' && <Habits params={params} set={set} />}
      {view === 'budgets' && <BudgetRecord />}
    </>
  );
}

interface ExplorerData {
  range: Range; previous: Range; months: string[]; level: 'category' | 'subcategory' | 'merchant' | 'transactions';
  crumbs: { label: string; categoryId?: number | null; merchant?: string | null }[];
  category: { id: number; name: string; colour: string; icon: string | null } | null;
  total: number; prevTotal: number | null; change: number | null; compared: boolean; perMonth: number; count: number; average: number; monthTotals: number[];
  series: { key: string; label: string; colour: string; icon: string | null; drill: { categoryId?: number; merchant?: string } | null; values: number[]; total: number; count: number; share: number; prev: number | null; change: number | null }[];
  places: { merchant: string; label: string; total: number; count: number; average: number; last: string; values: number[]; category: string }[];
  transactions: { id: number; date: string; description: string; amount: number; category: string; colour: string }[];
}

function useRangeParams(params: URLSearchParams, fallback: string): Range {
  const { meta } = useApp();
  const p = presets(meta.today).find((x) => x.key === fallback)!.range;
  return { from: params.get('from') || p.from, to: params.get('to') || p.to };
}

function Explorer({ params, set }: { params: URLSearchParams; set: (x: Record<string, string | number | undefined | null>) => void }) {
  const range = useRangeParams(params, '6m');
  const cat = params.get('cat') ? Number(params.get('cat')) : null;
  const merchant = params.get('merchant');
  const q = params.get('q') ?? '';
  const [search, setSearch] = useState(q);
  useEffect(() => { setSearch(q); }, [q]);
  useEffect(() => { const t = setTimeout(() => { if (search !== q) set({ q: search || null }); }, 350); return () => clearTimeout(t); }, [search]); // eslint-disable-line
  const { data, loading, error } = useData<ExplorerData>(() => api.get(`/api/reports/spending${qs({ from: range.from, to: range.to, categoryId: cat ?? undefined, merchant: merchant ?? undefined, search: q || undefined })}`), [range.from, range.to, cat, merchant, q]);
  const [hidden, toggle, setHidden] = useHidden();
  useEffect(() => { setHidden(new Set()); }, [cat, merchant]); // eslint-disable-line

  const drill = (d: { categoryId?: number; merchant?: string } | null) => {
    if (!d) return;
    if (d.merchant) set({ merchant: d.merchant });
    else if (d.categoryId) set({ cat: d.categoryId, merchant: null });
  };
  /** A month in the chart opens that month's transactions, keeping the category, place or search you're looking at. */
  const openMonth = (i: number) => {
    if (!data) return;
    const m = data.months[i];
    if (!m) return;
    navigate(`/transactions${qs({ month: m, categoryId: cat ?? undefined, merchant: merchant ?? undefined, search: q || undefined })}`);
  };
  if (error && !data) return <Card><Empty icon="alert" title="Couldn't load this">{error}</Empty></Card>;
  const levelTitle = !data ? '' : data.level === 'category' ? 'By category' : data.level === 'subcategory' ? `${data.category?.name} by subcategory` : data.level === 'merchant' ? `${data.crumbs[data.crumbs.length - 1].label} by place` : `${data.crumbs[data.crumbs.length - 1].label}`;
  const visible = data?.series.filter((s) => !hidden.has(s.key)) ?? [];
  const visibleTotal = visible.reduce((n, s) => n + s.total, 0);
  return (
    <>
      <div className="report-filters">
        <RangePicker value={range} onChange={(r) => set({ from: r.from, to: r.to })} />
        <div className="search"><Icon name="search" size={16} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search, e.g. coffee or taxi" aria-label="Search spending" />{search && <button className="icon-btn" onClick={() => setSearch('')} aria-label="Clear search"><Icon name="x" size={14} /></button>}</div>
      </div>
      {data && (
        <nav className="crumbs" aria-label="Drill-down">
          {data.crumbs.map((c, i) => (
            <React.Fragment key={i}>
              {i > 0 && <Icon name="chevron-right" size={14} />}
              {i === data.crumbs.length - 1 ? <strong>{c.label}</strong>
                : <button className="link-btn" onClick={() => set({ cat: c.categoryId ?? null, merchant: c.merchant ?? null })}>{c.label}</button>}
            </React.Fragment>
          ))}
          {q && <Badge>matching “{q}”</Badge>}
        </nav>
      )}
      {!data ? <div className="loading" /> : (
        <div className={`stale-wrap ${loading ? 'stale' : ''}`}>
          <div className="stats">
            <Stat label="Spent" value={<Money value={data.total} />} sub={<span className={changeTone(data.change)}>{!data.compared ? 'no earlier data to compare with' : data.change == null ? 'nothing spent before' : `${signedPct(data.change)} vs the ${data.months.length === 1 ? 'month' : `${data.months.length} months`} before`}</span>} />
            <Stat label="Per month" value={<Money value={data.perMonth} />} sub={`over ${data.months.length} month${data.months.length === 1 ? '' : 's'}`} />
            <Stat label="Transactions" value={String(data.count)} sub={data.count ? `${money(data.average)} on average` : undefined} />
            <Stat label={data.level === 'transactions' ? 'Last time' : 'Biggest part'} value={data.level === 'transactions' ? (data.transactions[0] ? shortDate(data.transactions[0].date) : '–') : (data.series[0]?.label ?? '–')}
              sub={data.level === 'transactions' ? (data.transactions[0] ? money(data.transactions[0].amount) : undefined) : data.series[0] ? `${pct(data.series[0].share)} of this` : undefined} />
          </div>
          {data.count === 0 ? <Card><Empty icon="search" title="No spending here">Try a longer period or clear the search.</Empty></Card> : (
            <>
              <Card title={levelTitle} action={<span className="muted small">{data.level === 'transactions' ? 'Month by month' : 'Click a colour to look inside · click a month to see its transactions · click the key to hide'}</span>}>
                <StackedBars labels={data.months.map(shortMonth)} titles={data.months.map((m) => monthLabel(m))}
                  series={data.level === 'transactions' ? [{ key: 'all', label: data.crumbs[data.crumbs.length - 1].label, colour: data.category?.colour ?? '#2a78d6', values: data.monthTotals }] : data.series}
                  hidden={hidden} onToggle={toggle} height={260}
                  reference={data.months.length > 1 ? { value: Math.round(visible.reduce((n, s) => n + s.total, 0) / data.months.length), label: `average ${money(Math.round(visibleTotal / data.months.length))}` } : undefined}
                  onSegmentClick={data.level === 'transactions' ? undefined : (key) => drill(data.series.find((s) => s.key === key)?.drill ?? null)}
                  onBarClick={openMonth} barHint="Click to see these transactions" />
              </Card>
              <div className="grid-main">
                {data.level !== 'transactions' ? (
                  <Card pad={false} className="fit-row" title="Breakdown" action={<span className="muted small">{data.compared ? `change vs ${shortDate(data.previous.from)} – ${shortDate(data.previous.to)}` : 'no earlier data to compare with'}</span>}>
                    <BreakdownTable data={data} hidden={hidden} drill={drill} />
                  </Card>
                ) : (
                  <TransactionsCard data={data} range={range} />
                )}
                {data.level !== 'transactions' ? (
                  <Card pad={false} title={data.level === 'merchant' ? 'Biggest spends' : 'Top places'}>
                    {data.level === 'merchant' ? <TxList list={data.transactions.slice().sort((a, b) => b.amount - a.amount).slice(0, 10)} /> : (
                      <ul className="place-list">
                        {data.places.slice(0, 10).map((p) => (
                          <li key={p.merchant}>
                            <button onClick={() => set({ merchant: p.merchant })}>
                              <span className="grow"><strong className="ellipsis">{p.label}</strong><span className="muted small">{p.count} × {money(p.average)} · {p.category} · last {shortDate(p.last)}</span></span>
                              <Spark values={p.values} />
                              <strong><Money value={p.total} /></strong>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Card>
                ) : (
                  <Card title="At a glance">
                    <div className="glance">
                      <div><span className="muted small">Visits</span><strong>{data.count}</strong></div>
                      <div><span className="muted small">Usual spend</span><strong>{money(data.average)}</strong></div>
                      <div><span className="muted small">Per month</span><strong>{money(data.perMonth)}</strong></div>
                      <div><span className="muted small">A year at this rate</span><strong>{money(data.perMonth * 12)}</strong></div>
                    </div>
                  </Card>
                )}
              </div>
              {data.level !== 'transactions' && data.level !== 'merchant' && <TransactionsCard data={data} range={range} />}
            </>
          )}
        </div>
      )}
    </>
  );
}

function TxList({ list }: { list: ExplorerData['transactions'] }) {
  return (
    <ul className="tx-mini">
      {list.map((t) => (
        <li key={t.id}>
          <span className="date muted small">{shortDate(t.date)}</span>
          <span className="grow ellipsis">{t.description}<span className="muted small"> · {t.category}</span></span>
          <strong className={t.amount < 0 ? 'tone-good' : ''}>{t.amount < 0 ? money(-t.amount, { sign: true }) : money(t.amount)}</strong>
        </li>
      ))}
    </ul>
  );
}

function TransactionsCard({ data, range }: { data: ExplorerData; range: Range }) {
  const [n, setN] = useState(12);
  const last = data.crumbs[data.crumbs.length - 1];
  return (
    <Card pad={false} title="Latest transactions" action={<button className="link-btn small" onClick={() => txLink(range, { categoryId: data.category?.id, merchant: last.merchant ?? undefined })}>Open in Transactions</button>}>
      <TxList list={data.transactions.slice(0, n)} />
      {data.transactions.length > n && <div className="pager"><button className="link-btn" onClick={() => setN(n + 24)}>Show more</button></div>}
    </Card>
  );
}

// ---- Where to cut back

interface CutData {
  recent: Range; before: Range; enoughHistory: boolean;
  risingCategories: { categoryId: number; name: string; colour: string; icon: string | null; fixed: boolean; now: number; was: number; extra: number; change: number | null }[];
  risingPlaces: { merchant: string; label: string; category: string; colour: string; visits: number; visitsBefore: number; now: number; was: number; extra: number; change: number | null }[];
  smallSpends: { merchant: string; label: string; category: string; colour: string; visits: number; average: number; total: number; perYear: number }[];
  subscriptions: { list: { id: number; name: string; monthly: number; yearly: number; amount: number; yourShare: number; shared: boolean; account: string; since: string; lastPaid: string | null; priceChanges: number }[]; monthly: number; yearly: number; untracked: { merchant: string; label: string; count: number; total: number; last: string }[] };
  potential: number;
}

function CutBack({ open }: { open: (x: Record<string, string | number | null>) => void }) {
  const { data } = useData<CutData>(() => api.get('/api/reports/cutback'), []);
  if (!data) return <div className="loading" />;
  const recentText = `${monthLabel(data.recent.from.slice(0, 7), true)} – ${monthLabel(data.recent.to.slice(0, 7), true)}`;
  const beforeText = `${monthLabel(data.before.from.slice(0, 7), true)} – ${monthLabel(data.before.to.slice(0, 7), true)}`;
  const maxSmall = Math.max(1, ...data.smallSpends.map((s) => s.perYear));
  const look = (x: Record<string, string | number | null>) => open({ from: data.before.from, to: data.recent.to, ...x });
  return (
    <>
      {data.enoughHistory && data.potential > 0 && (
        <div className="cut-hero">
          <span className="cut-hero-num">{money(data.potential)}<span className="muted small"> a month</span></span>
          <span>is how much more you've been spending on day-to-day categories over {recentText} than over {beforeText}. Getting back to your usual would free that up.</span>
        </div>
      )}
      {!data.enoughHistory && <Card><p className="muted">Comparing needs about six months of history. The small spends and subscriptions below work now.</p></Card>}
      <div className="grid-2-cards">
        {data.enoughHistory && (
          <Card title="Categories creeping up" pad={false} action={<span className="muted small">per month, {recentText} vs {beforeText}</span>}>
            {data.risingCategories.length === 0 ? <p className="muted pad">Nothing has crept up noticeably. 👍</p> : (
              <ul className="cut-list">
                {data.risingCategories.map((c) => (
                  <li key={c.categoryId}>
                    <button onClick={() => look({ cat: c.categoryId, merchant: null })}>
                      <Bubble colour={c.colour} icon={c.icon} size={32} />
                      <span className="grow"><strong>{c.name}</strong>{c.fixed && <span className="tag">Fixed</span>}<span className="muted small">{money(c.was)} → {money(c.now)} a month</span></span>
                      <span className="cut-delta tone-bad">+{money(c.extra)}<span className="muted small">{c.change != null ? signedPct(c.change) : 'new'}</span></span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
        {data.enoughHistory && (
          <Card title="Places you're spending more at" pad={false} action={<span className="muted small">per month</span>}>
            {data.risingPlaces.length === 0 ? <p className="muted pad">No place stands out.</p> : (
              <ul className="cut-list">
                {data.risingPlaces.map((p) => (
                  <li key={p.merchant}>
                    <button onClick={() => look({ merchant: p.merchant, cat: null })}>
                      <i className="key-box" style={{ background: p.colour }} />
                      <span className="grow"><strong className="ellipsis">{p.label}</strong><span className="muted small">{p.category} · {p.visitsBefore} → {p.visits} visits</span></span>
                      <span className="cut-delta tone-bad">+{money(p.extra)}<span className="muted small">{money(p.was)} → {money(p.now)}</span></span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
        <Card title="Small spends that add up" pad={false} action={<span className="muted small">last 90 days</span>}>
          {data.smallSpends.length === 0 ? <p className="muted pad">No frequent small spends.</p> : (
            <ul className="cut-list">
              {data.smallSpends.map((s) => (
                <li key={s.merchant}>
                  <button onClick={() => open({ merchant: s.merchant, cat: null })}>
                    <span className="grow">
                      <strong className="ellipsis">{s.label}</strong>
                      <span className="muted small">{s.visits} × {money(s.average)} = {money(s.total)} · {s.category}</span>
                      <span className="year-bar"><span style={{ width: `${(s.perYear / maxSmall) * 100}%`, background: s.colour }} /></span>
                    </span>
                    <span className="cut-delta"><span>{money(s.perYear)}</span><span className="muted small">a year</span></span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Subscriptions" pad={false} action={<span className="muted small">{money(data.subscriptions.monthly)} a month · {money(data.subscriptions.yearly)} a year</span>}>
          <ul className="cut-list">
            {data.subscriptions.list.map((s) => (
              <li key={s.id}>
                <button onClick={() => navigate('/bills')}>
                  <span className="grow"><strong className="ellipsis">{s.name}</strong>
                    <span className="muted small">{s.shared ? `your share of ${money(s.amount)}` : s.account}{s.lastPaid ? ` · last paid ${shortDate(s.lastPaid)}` : ' · no payment found yet'}{s.priceChanges ? ' · price has changed' : ''}</span></span>
                  <span className="cut-delta"><span>{money(s.yearly)}</span><span className="muted small">a year</span></span>
                </button>
              </li>
            ))}
          </ul>
          {data.subscriptions.untracked.length > 0 && (
            <p className="muted small pad">Also charged under Subscriptions but not set up as one: {data.subscriptions.untracked.map((u) => `${u.label} (${money(u.total)})`).join(', ')}. Add them in Bills so they're counted.</p>
          )}
          <p className="muted small pad">Ask of each: did I use it last month?</p>
        </Card>
      </div>
    </>
  );
}

// ---- Habits

interface HabitData {
  range: Range; days: number; total: number; count: number;
  weekday: { day: string; short: string; total: number; count: number; perDay: number; days: number }[];
  weekdayVsWeekend: { weekday: number; weekend: number }; busiest: string | null;
  sizes: { label: string; count: number; total: number }[];
  frequent: { merchant: string; label: string; category: string; colour: string; visits: number; perWeek: number; average: number; total: number }[];
  noSpendDays: number; typicalSpend: number; oneOffs: { count: number; total: number; threshold: number };
}

function Habits({ params, set }: { params: URLSearchParams; set: (x: Record<string, string | number | undefined | null>) => void }) {
  const range = useRangeParams(params, '6m');
  const { data, loading } = useData<HabitData>(() => api.get(`/api/reports/habits${qs({ from: range.from, to: range.to })}`), [range.from, range.to]);
  const maxCount = data ? Math.max(1, ...data.sizes.map((s) => s.count)) : 1;
  const maxTotal = data ? Math.max(1, ...data.sizes.map((s) => s.total)) : 1;
  return (
    <>
      <div className="report-filters"><RangePicker value={range} onChange={(r) => set({ from: r.from, to: r.to })} /></div>
      {!data ? <div className="loading" /> : (
        <div className={`stale-wrap ${loading ? 'stale' : ''}`}>
          <p className="muted small">Day-to-day spending only: rent, bills and subscriptions are left out{data.oneOffs.count ? `, and so ${data.oneOffs.count === 1 ? 'is 1 one-off' : `are ${data.oneOffs.count} one-offs`} of ${money(data.oneOffs.threshold)} or more (${money(data.oneOffs.total)})` : ''}.</p>
          <div className="stats">
            <Stat label="On a weekday" value={<Money value={data.weekdayVsWeekend.weekday} />} sub="per day, on average" />
            <Stat label="At the weekend" value={<Money value={data.weekdayVsWeekend.weekend} />} sub="per day, on average" />
            <Stat label="Typical spend" value={<Money value={data.typicalSpend} />} sub={`half of your ${data.count} spends are less`} />
            <Stat label="No-spend days" value={String(data.noSpendDays)} sub={`of ${data.days} days`} />
          </div>
          <div className="grid-2-cards">
            <Card title="By day of the week" action={data.busiest && <span className="muted small">Busiest: {data.busiest}</span>}>
              <StackedBars labels={data.weekday.map((d) => d.short)} titles={data.weekday.map((d) => `${d.day}s · ${d.count} spends over ${d.days} days`)}
                series={[{ key: 'perDay', label: 'Average per day', colour: '#2a78d6', values: data.weekday.map((d) => d.perDay) }]} legend={false} height={220} />
            </Card>
            <Card title="How big your spends are" pad={false}>
              <table className="report-table sizes">
                <thead><tr><th>Size</th><th>How many</th><th>How much in total</th></tr></thead>
                <tbody>
                  {data.sizes.map((s) => (
                    <tr key={s.label}>
                      <td className="nowrap">{s.label}</td>
                      <td><span className="hbar"><span style={{ width: `${(s.count / maxCount) * 100}%` }} /></span><span className="small">{s.count}</span></td>
                      <td><span className="hbar total"><span style={{ width: `${(s.total / maxTotal) * 100}%` }} /></span><span className="small">{money(s.total)}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted small pad">Lots of small spends can add up to as much as a few big ones.</p>
            </Card>
          </div>
          <Card title="Where you go most" pad={false}>
            <table className="report-table">
              <thead><tr><th>Place</th><th className="hide-sm">Category</th><th className="num">Visits</th><th className="num">Per week</th><th className="num">Usual spend</th><th className="num">Total</th></tr></thead>
              <tbody>
                {data.frequent.map((f) => (
                  <tr key={f.merchant} className="clickable" onClick={() => set({ view: null, merchant: f.merchant, cat: null })}>
                    <td><span className="row gap nowrap"><i className="key-box" style={{ background: f.colour }} /><span className="ellipsis">{f.label}</span></span></td>
                    <td className="muted hide-sm">{f.category}</td>
                    <td className="num">{f.visits}</td>
                    <td className="num">{f.perWeek >= 1 ? f.perWeek.toFixed(1) : f.perWeek.toFixed(2)}</td>
                    <td className="num"><Money value={f.average} /></td>
                    <td className="num strong"><Money value={f.total} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      )}
    </>
  );
}

// ---- Budget track record

interface BudgetRec {
  id: number; name: string; colour: string; icon: string | null; period: string; limit: number; startDate: string;
  current: { label: string; spent: number; available: number; pct: number; onTrack: boolean | null };
  history: { key: string; label: string; short: string; limit: number; spent: number; before: boolean; current: boolean }[];
  under: number; over: number; months: number; typical: number; averageOver: number;
  verdict: 'realistic' | 'too-tight' | 'roomy' | 'new'; suggestion: number | null;
}

function BudgetRecord() {
  const { data } = useData<BudgetRec[]>(() => api.get('/api/reports/budgets'), []);
  if (!data) return <div className="loading" />;
  if (!data.length) return <Card><Empty icon="piggy-bank" title="No spending budgets yet">Set some up under Budgets and their history shows here.</Empty></Card>;
  const VERDICT = { realistic: { tone: 'good', text: 'Realistic' }, 'too-tight': { tone: 'bad', text: 'Usually over' }, roomy: { tone: 'info', text: 'Room to spare' }, new: { tone: 'neutral', text: 'Too new to tell' } } as const;
  return (
    <>
      <p className="muted small">The last six {data[0].period === 'monthly' ? 'months' : 'periods'} for each budget, including months before you set it up, measured against today's limit. Red is the part over the limit.</p>
      <div className="budget-rec-grid">
        {data.map((b) => {
          const h = b.history;
          return (
            <Card key={b.id} title={<span className="row gap">{b.icon && <span>{b.icon}</span>}{b.name}</span>} action={<Badge tone={VERDICT[b.verdict].tone}>{VERDICT[b.verdict].text}</Badge>}>
              <StackedBars labels={h.map((x) => x.short)} titles={h.map((x) => `${x.label}${x.before ? ' (before you set this budget)' : ''}${x.current ? ' (so far)' : ''} · limit ${money(x.limit)}`)} legend={false} height={150}
                series={[
                  { key: 'in', label: 'Within limit', colour: b.colour, values: h.map((x) => Math.min(x.spent, x.limit || x.spent)) },
                  { key: 'over', label: 'Over limit', colour: 'var(--bad)', values: h.map((x) => (x.limit ? Math.max(0, x.spent - x.limit) : 0)) },
                ]}
                reference={{ value: b.limit, label: `limit ${money(b.limit)}` }} />
              <p className="small budget-rec-text">
                {b.months ? <>Within the limit in <strong>{b.under} of {b.months}</strong> past months. Typically {money(b.typical)}{b.over ? `, and ${money(b.averageOver)} over when it goes over` : ''}.</> : 'No full months yet.'}
                {b.suggestion && b.verdict === 'too-tight' && <> A limit of about <strong>{money(b.suggestion)}</strong> would match what you actually spend, or keep {money(b.limit)} as a stretch goal.</>}
                {b.suggestion && b.verdict === 'roomy' && <> You could lower it to about <strong>{money(b.suggestion)}</strong> and move the difference to a goal.</>}
              </p>
              <button className="link-btn small" onClick={() => navigate('/budgets')}>Open Budgets</button>
            </Card>
          );
        })}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Cash flow

interface FlowRow { month: string; income: number; spending: number; saved: number; fixed: number; flexible: number; savingsRate: number | null; current: boolean }
interface Curve { usual: number[]; now: number[]; usualToday: number; usualEnd: number; spentToday: number; projected: number; firstWeekShare: number | null; midMonthShare: number | null }
interface CashData {
  flow: FlowRow[]; averages: { income: number; spending: number; saved: number; fixed: number; flexible: number }; savingsRate: number | null;
  payday: { month: string; today: number; days: number; months: string[]; income: { usual: number; thisMonth: number }; all: Curve; flexible: Curve };
}

function CashFlow() {
  const [months, setMonths] = useState('12');
  const { data, loading } = useData<CashData>(() => api.get(`/api/reports/cashflow${qs({ months })}`), [months]);
  const [hidden, toggle] = useHidden();
  const [hidden2, toggle2] = useHidden();
  const [mode, setMode] = useState<'flexible' | 'all'>('flexible');
  if (!data) return <div className="loading" />;
  const f = data.flow;
  const labels = f.map((x) => shortMonth(x.month));
  const titles = f.map((x) => `${monthLabel(x.month)}${x.current ? ' (so far)' : ''}`);
  const pd = data.payday;
  const c = pd[mode];
  const dayLabels = Array.from({ length: pd.days + 1 }, (_, d) => (d === 0 ? 'Pay' : String(d)));
  const dayTitles = dayLabels.map((_, d) => (d === 0 ? 'Payday (end of last month)' : `${d} ${monthLabel(pd.month, true)}`));
  const ahead = c.spentToday - c.usualToday;
  return (
    <div className={`stale-wrap ${loading ? 'stale' : ''}`}>
      <div className="report-filters">
        <Segmented value={months} onChange={setMonths} options={[{ value: '6', label: '6 months' }, { value: '12', label: '12 months' }, { value: '24', label: '2 years' }]} />
      </div>
      <div className="stats">
        <Stat label="Money in" value={<Money value={data.averages.income} />} sub="a month, on average" />
        <Stat label="Spending" value={<Money value={data.averages.spending} />} sub={`${money(data.averages.fixed)} fixed · ${money(data.averages.flexible)} flexible`} />
        <Stat label="Saved and invested" value={<Money value={data.averages.saved} />} sub="a month, on average" />
        <Stat label="Savings rate" value={data.savingsRate != null ? pct(data.savingsRate) : '–'} sub="of money in" />
      </div>

      <Card title="Payday to payday" action={<Segmented value={mode} onChange={setMode} options={[{ value: 'flexible', label: 'Day-to-day' }, { value: 'all', label: 'Everything' }]} />}>
        <div className="payday-summary">
          <div><span className="muted small">Spent so far this month</span><strong>{money(c.spentToday)}</strong>
            <span className={`small ${ahead > 0 ? 'tone-bad' : 'tone-good'}`}>{money(Math.abs(ahead))} {ahead > 0 ? 'more' : 'less'} than usual by the {ordinal(pd.today)}</span></div>
          <div><span className="muted small">On this pace, the month ends at</span><strong>{money(c.projected)}</strong><span className="muted small">usually {money(c.usualEnd)}</span></div>
          <div><span className="muted small">Usually spent by the 7th</span><strong>{c.firstWeekShare != null ? pct(c.firstWeekShare) : '–'}</strong><span className="muted small">and {c.midMonthShare != null ? pct(c.midMonthShare) : '–'} by the 15th</span></div>
        </div>
        <LineChart labels={dayLabels} titles={dayTitles} height={250} hidden={hidden2} onToggle={toggle2} markLast area="now"
          series={[
            { key: 'now', label: `${monthLabel(pd.month, true)} so far`, colour: 'var(--accent)', values: dayLabels.map((_, d) => (d <= pd.today ? c.now[d] ?? null : null)) },
            { key: 'usual', label: `Usual (average of ${pd.months.length} month${pd.months.length === 1 ? '' : 's'})`, colour: 'var(--text-3)', values: dayLabels.map((_, d) => c.usual[d] ?? null), dashed: true },
          ]}
          reference={mode === 'all' && pd.income.usual ? { value: pd.income.usual, label: `usual money in ${money(pd.income.usual)}` } : undefined} />
        <p className="muted small">How your spending builds up from payday through the month. Your salary lands at the end of the month before, so day “Pay” is the last working day. {mode === 'flexible' ? 'Day-to-day leaves out rent, bills and subscriptions.' : ''}</p>
      </Card>

      <Card title="Money in, out and saved">
        <StackedBars grouped labels={labels} titles={titles} hidden={hidden} onToggle={toggle} height={260}
          series={[
            { key: 'income', label: 'Money in', colour: 'var(--income)', values: f.map((x) => x.income) },
            { key: 'spending', label: 'Spending', colour: 'var(--spend)', values: f.map((x) => x.spending) },
            { key: 'saved', label: 'Saved and invested', colour: '#0ea5e9', values: f.map((x) => x.saved) },
          ]} />
      </Card>
      <div className="grid-2-cards">
        <Card title="Fixed and flexible spending">
          <StackedBars labels={labels} titles={titles} height={220}
            series={[
              { key: 'fixed', label: 'Fixed: rent, bills, subscriptions, loans', colour: '#6250d6', values: f.map((x) => x.fixed) },
              { key: 'flexible', label: 'Flexible: everything else', colour: '#eda100', values: f.map((x) => x.flexible) },
            ]}
            reference={{ value: data.averages.spending, label: `average ${money(data.averages.spending)}` }} />
        </Card>
        <Card title="Savings rate">
          <LineChart labels={labels} titles={titles} height={220} format={(n) => `${n.toFixed(0)}%`} axisFormat={(n) => `${n}%`} legend={false}
            series={[{ key: 'rate', label: 'Saved, as % of money in', colour: 'var(--saved)', values: f.map((x) => (x.savingsRate == null ? null : Math.round(x.savingsRate * 1000) / 10)) }]}
            reference={data.savingsRate != null ? { value: Math.round(data.savingsRate * 100), label: `average ${pct(data.savingsRate)}` } : undefined} />
        </Card>
      </div>
    </div>
  );
}

function ordinal(n: number) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ---------------------------------------------------------------------------
// Compare

interface CompareData {
  a: { range: Range; income: number; spending: number; saved: number; net: number }; b: { range: Range; income: number; spending: number; saved: number; net: number };
  categories: { categoryId: number | null; name: string; colour: string; a: number; b: number; diff: number; change: number | null }[];
  places: { merchant: string; label: string; category: string; colour: string; a: number; b: number; aCount: number; bCount: number; diff: number }[];
  days: { a: number; b: number }; perDay: { a: number; b: number };
}

function comparePresets(today: string): { key: string; label: string; a: Range; b: Range }[] {
  const m = today.slice(0, 7), d = Number(today.slice(8, 10));
  const lm = shiftMonth(m, -1), lm2 = shiftMonth(m, -2), ly = shiftMonth(m, -13);
  const sameDay = (month: string) => `${month}-${String(Math.min(d, Number(monthEnd(month).slice(8)))).padStart(2, '0')}`;
  return [
    { key: 'mtd', label: `This month so far vs the same days last month`, a: { from: `${m}-01`, to: today }, b: { from: `${lm}-01`, to: sameDay(lm) } },
    { key: 'lm', label: `${monthLabel(lm)} vs ${monthLabel(lm2)}`, a: { from: `${lm}-01`, to: monthEnd(lm) }, b: { from: `${lm2}-01`, to: monthEnd(lm2) } },
    { key: 'yoy', label: `${monthLabel(lm)} vs ${monthLabel(ly)}`, a: { from: `${lm}-01`, to: monthEnd(lm) }, b: { from: `${ly}-01`, to: monthEnd(ly) } },
    { key: 'q', label: 'Last 3 months vs the 3 before', a: { from: `${shiftMonth(m, -3)}-01`, to: monthEnd(lm) }, b: { from: `${shiftMonth(m, -6)}-01`, to: monthEnd(shiftMonth(m, -4)) } },
  ];
}

function CompareTab() {
  const { meta } = useApp();
  const list = comparePresets(meta.today);
  const [key, setKey] = useState('mtd');
  const [custom, setCustom] = useState<{ a: Range; b: Range }>({ a: list[1].a, b: list[1].b });
  const sel = key === 'custom' ? custom : list.find((p) => p.key === key)!;
  const { a, b } = sel;
  const { data, loading } = useData<CompareData>(() => api.get(`/api/reports/compare2${qs({ aFrom: a.from, aTo: a.to, bFrom: b.from, bTo: b.to })}`), [a.from, a.to, b.from, b.to]);
  const steps = useMemo(() => {
    if (!data) return [];
    const top = data.categories.filter((c) => c.diff !== 0).slice(0, 7);
    const rest = data.categories.filter((c) => !top.includes(c)).reduce((n, c) => n + c.diff, 0);
    return [...top.map((c) => ({ key: String(c.categoryId), label: c.name, value: c.diff })), ...(rest ? [{ key: '__rest', label: 'Everything else', value: rest }] : [])];
  }, [data]);
  const diff = data ? data.a.spending - data.b.spending : 0;
  const cell = (va: number, vb: number, goodWhenUp = false) => {
    const d = va - vb;
    return <td className={`num ${d === 0 ? '' : (d > 0) !== goodWhenUp ? 'tone-bad' : 'tone-good'}`}><Money value={d} sign /></td>;
  };
  return (
    <>
      <div className="report-filters">
        <select value={key} onChange={(e) => setKey(e.target.value)} aria-label="What to compare">
          {list.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          <option value="custom">Choose two periods…</option>
        </select>
      </div>
      {key === 'custom' && (
        <Card>
          <div className="compare-pickers">
            <Field label="This period"><RangePicker value={custom.a} onChange={(r) => setCustom({ ...custom, a: r })} /></Field>
            <Field label="Against"><RangePicker value={custom.b} onChange={(r) => setCustom({ ...custom, b: r })} /></Field>
          </div>
        </Card>
      )}
      {!data ? <div className="loading" /> : (
        <div className={`stale-wrap ${loading ? 'stale' : ''}`}>
          <div className="stats">
            <Stat label="Spending" value={<Money value={data.a.spending} />} tone={diff > 0 ? 'bad' : 'good'}
              sub={<span className={diff > 0 ? 'tone-bad' : 'tone-good'}>{money(diff, { sign: true })} vs {money(data.b.spending)}</span>} />
            <Stat label="Per day" value={<Money value={data.perDay.a} />} sub={`vs ${money(data.perDay.b)} (${data.days.a} vs ${data.days.b} days)`} />
            <Stat label="Money in" value={<Money value={data.a.income} />} sub={`vs ${money(data.b.income)}`} />
            <Stat label="Saved" value={<Money value={data.a.saved} />} sub={`vs ${money(data.b.saved)}`} />
          </div>
          <Card title="What made the difference" action={<span className="muted small">{rangeText(b)} → {rangeText(a)}</span>}>
            <Waterfall start={{ label: 'Before', value: data.b.spending }} end={{ label: 'Now', value: data.a.spending }} steps={steps}
              onStepClick={(k) => k !== '__rest' && k !== 'null' && setParams('/reports', { cat: k, from: a.from, to: a.to })} />
          </Card>
          <div className="grid-2-cards">
            <Card pad={false} title="By category">
              <table className="report-table">
                <thead><tr><th>Category</th><th className="num">Now</th><th className="num">Before</th><th className="num">Difference</th></tr></thead>
                <tbody>
                  {data.categories.slice(0, 15).map((c) => (
                    <tr key={String(c.categoryId)}>
                      <td><span className="row gap nowrap"><i className="key-box" style={{ background: c.colour }} /><span className="ellipsis">{c.name}</span></span></td>
                      <td className="num"><Money value={c.a} /></td>
                      <td className="num muted"><Money value={c.b} /></td>
                      {cell(c.a, c.b)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            <Card pad={false} title="Places that made the difference">
              <table className="report-table">
                <thead><tr><th>Place</th><th className="num">Now</th><th className="num">Before</th><th className="num">Difference</th></tr></thead>
                <tbody>
                  {data.places.map((p) => (
                    <tr key={p.merchant}>
                      <td><span className="stack" style={{ gap: 0 }}><span className="ellipsis">{p.label}</span><span className="muted small">{p.category} · {p.aCount} vs {p.bCount} visits</span></span></td>
                      <td className="num"><Money value={p.a} /></td>
                      <td className="num muted"><Money value={p.b} /></td>
                      {cell(p.a, p.b)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </div>
          <Card pad={false} title="Totals">
            <table className="report-table">
              <thead><tr><th /><th className="num">{rangeText(a)}</th><th className="num">{rangeText(b)}</th><th className="num">Difference</th></tr></thead>
              <tbody>
                <tr><td>Money in</td><td className="num"><Money value={data.a.income} /></td><td className="num"><Money value={data.b.income} /></td>{cell(data.a.income, data.b.income, true)}</tr>
                <tr><td>Spending</td><td className="num"><Money value={data.a.spending} /></td><td className="num"><Money value={data.b.spending} /></td>{cell(data.a.spending, data.b.spending)}</tr>
                <tr><td>Saved and invested</td><td className="num"><Money value={data.a.saved} /></td><td className="num"><Money value={data.b.saved} /></td>{cell(data.a.saved, data.b.saved, true)}</tr>
                <tr><td>Money in minus spending</td><td className="num"><Money value={data.a.net} /></td><td className="num"><Money value={data.b.net} /></td>{cell(data.a.net, data.b.net, true)}</tr>
              </tbody>
            </table>
          </Card>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Date ranges

interface Range { from: string; to: string }
const iso = (d: Date) => d.toISOString().slice(0, 10);
function monthEnd(m: string) { const [y, mo] = m.split('-').map(Number); return iso(new Date(Date.UTC(y, mo, 0))); }
function shiftMonth(m: string, n: number) { const [y, mo] = m.split('-').map(Number); return iso(new Date(Date.UTC(y, mo - 1 + n, 1))).slice(0, 7); }
function taxYearStart(today: string) { const y = Number(today.slice(0, 4)); return today >= `${y}-04-06` ? y : y - 1; }

function presets(today: string): { key: string; label: string; range: Range }[] {
  const m = today.slice(0, 7);
  const ty = taxYearStart(today);
  return [
    { key: 'this-month', label: 'This month', range: { from: `${m}-01`, to: monthEnd(m) } },
    { key: 'last-month', label: 'Last month', range: { from: `${shiftMonth(m, -1)}-01`, to: monthEnd(shiftMonth(m, -1)) } },
    { key: '3m', label: 'Last 3 months', range: { from: `${shiftMonth(m, -2)}-01`, to: monthEnd(m) } },
    { key: '6m', label: 'Last 6 months', range: { from: `${shiftMonth(m, -5)}-01`, to: monthEnd(m) } },
    { key: '12m', label: 'Last 12 months', range: { from: `${shiftMonth(m, -11)}-01`, to: monthEnd(m) } },
    { key: 'year', label: `This year (${today.slice(0, 4)})`, range: { from: `${today.slice(0, 4)}-01-01`, to: `${today.slice(0, 4)}-12-31` } },
    { key: 'tax', label: `Tax year ${ty}/${String(ty + 1).slice(2)}`, range: { from: `${ty}-04-06`, to: `${ty + 1}-04-05` } },
  ];
}

function RangePicker({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  const { meta } = useApp();
  const list = presets(meta.today);
  const match = list.find((p) => p.range.from === value.from && p.range.to === value.to)?.key ?? 'custom';
  return (
    <div className="range-picker">
      <select value={match} onChange={(e) => { const p = list.find((x) => x.key === e.target.value); if (p) onChange(p.range); }} aria-label="Period">
        {list.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        <option value="custom">Custom dates</option>
      </select>
      <input type="date" value={value.from} onChange={(e) => e.target.value && onChange({ ...value, from: e.target.value })} aria-label="From" />
      <span className="muted small">to</span>
      <input type="date" value={value.to} onChange={(e) => e.target.value && onChange({ ...value, to: e.target.value })} aria-label="To" />
    </div>
  );
}

const rangeText = (r: Range) => `${shortDate(r.from)} – ${shortDate(r.to)}`;
const txLink = (r: Range, extra: Record<string, string | number | undefined> = {}) => navigate(`/transactions${qs({ from: r.from, to: r.to, month: 'all', ...extra })}`);

// ---------------------------------------------------------------------------
// Net worth

interface NWPoint { month: string; cash: number; savings: number; investments: number; cards: number; loans: number; assets: number; debts: number; netWorth: number }
interface NWData { points: NWPoint[]; changes: { month: string; change: number; saved: number; growth: number; debtPaid: number }[]; milestones: { month: string; label: string }[]; high: { month: string; value: number } | null }

const NW_GROUPS: { key: keyof NWPoint; label: string; colour: string }[] = [
  { key: 'cash', label: 'Current accounts', colour: '#64748b' },
  { key: 'savings', label: 'Savings and pots', colour: '#0ea5e9' },
  { key: 'investments', label: 'Investments', colour: '#8b5cf6' },
  { key: 'cards', label: 'Credit cards', colour: '#f97316' },
  { key: 'loans', label: 'Loans and other debts', colour: '#ec4899' },
];

function NetWorth() {
  const [months, setMonths] = useState('24');
  const { data } = useData<NWData>(() => api.get(`/api/reports/networth${qs({ months })}`), [months]);
  if (!data) return <div className="loading" />;
  if (!data.points.length) return <Card><Empty icon="trending-up" title="Not enough history yet" /></Card>;
  const last = data.points[data.points.length - 1];
  const first = data.points[0];
  return (
    <>
      <div className="row gap" style={{ justifyContent: 'space-between' }}>
        <h2>Net worth over time</h2>
        <Segmented value={months} onChange={setMonths} options={[{ value: '6', label: '6 months' }, { value: '12', label: '12 months' }, { value: '24', label: '2 years' }, { value: '60', label: '5 years' }]} />
      </div>
      <div className="stats">
        <Stat label="Net worth now" value={<Money value={last.netWorth} />} sub={<span className={last.netWorth - first.netWorth >= 0 ? 'tone-good' : 'tone-bad'}>{money(last.netWorth - first.netWorth, { sign: true })} since {monthLabel(first.month, true)}</span>} />
        <Stat label="What you own" value={<Money value={last.assets} />} sub="Cash, savings and investments" />
        <Stat label="What you owe" value={<Money value={-last.debts} />} sub="Cards and loans" />
        <Stat label="Highest" value={<Money value={data.high?.value ?? 0} />} sub={data.high ? monthLabel(data.high.month) : ''} />
      </div>
      <Card title="Month by month" action={<span className="muted small">Click the key to hide a type of account</span>}>
        <NetWorthBars points={data.points} />
      </Card>
      <div className="grid-main">
        <Card title="What changed it" pad={false}>
          <table className="report-table">
            <thead><tr><th>Month</th><th className="num">Change</th><th className="num">Saved</th><th className="num">Investment growth</th><th className="num">Debt</th></tr></thead>
            <tbody>
              {[...data.changes].reverse().map((c) => (
                <tr key={c.month}>
                  <td>{monthLabel(c.month)}</td>
                  <td className={`num strong ${c.change >= 0 ? 'tone-good' : 'tone-bad'}`}><Money value={c.change} sign /></td>
                  <td className="num"><Money value={c.saved} /></td>
                  <td className={`num ${c.growth >= 0 ? 'tone-good' : 'tone-bad'}`}><Money value={c.growth} sign /></td>
                  <td className="num"><Money value={c.debtPaid} sign /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small" style={{ padding: '10px 20px 16px' }}>Debt: positive means you owe less than the month before.</p>
        </Card>
        <Card title="Milestones">
          {data.milestones.length === 0 ? <p className="muted small">They'll show here as you pass them: £10k, £25k, cards cleared…</p> : (
            <ul className="insights">{data.milestones.map((m, i) => <li key={i}><span>🏁</span><span className="grow">{m.label}</span><span className="muted small">{monthLabel(m.month)}</span></li>)}</ul>
          )}
        </Card>
      </div>
    </>
  );
}

function NetWorthBars({ points }: { points: NWPoint[] }) {
  const [hidden, toggle] = useHidden();
  return (
    <StackedBars labels={points.map((p) => shortMonth(p.month))} titles={points.map((p) => monthLabel(p.month))} height={280} hidden={hidden} onToggle={toggle}
      series={NW_GROUPS.map((g) => ({ key: g.key as string, label: g.label, colour: g.colour, values: points.map((p) => p[g.key] as number) }))}
      line={{ label: 'Net worth', colour: 'var(--text)', values: points.map((p) => p.netWorth) }} />
  );
}

// ---------------------------------------------------------------------------
// Year in review

interface YearData {
  kind: 'calendar' | 'tax'; year: number; label: string; range: Range; partial: boolean; through: string;
  income: number; spending: number; saved: number; net: number; savingsRate: number | null;
  categories: { categoryId: number | null; name: string; colour: string; isFixed: boolean; amount: number; count: number }[];
  fixed: number;
  merchants: { merchant: string; total: number; count: number; category: string }[];
  monthly: { month: string; income: number; spending: number; saved: number }[];
  biggest: { id: number; date: string; description: string; amount: number; category: string }[];
  interest: number; subscriptions: number;
  debt: { start: number; end: number; paidDown: number };
  netWorth: { start: number; end: number };
  isa: { paidIn: number; allowance: number };
  goals: { name: string; icon: string | null; target: number | null; date: string }[];
  noSpendDays: number; days: number; transactions: number;
}

function YearReview({ params, onChange }: { params: URLSearchParams; onChange: (kind: 'calendar' | 'tax', year: number) => void }) {
  const { data: years } = useData<{ calendar: number[]; tax: number[] }>(() => api.get('/api/reports/years'), []);
  const kind = (params.get('kind') as 'calendar' | 'tax') || 'calendar';
  const year = Number(params.get('year')) || (years ? (kind === 'tax' ? years.tax[0] : years.calendar[0]) : 0);
  const { data } = useData<YearData | null>(() => (year ? api.get(`/api/reports/year${qs({ kind, year })}`) : Promise.resolve(null)), [kind, year]);
  if (!years || !data) return <div className="loading" />;
  const list = kind === 'tax' ? years.tax : years.calendar;
  const maxCat = Math.max(1, ...data.categories.map((c) => c.amount));
  return (
    <div className="year-review">
      <div className="row gap no-print" style={{ justifyContent: 'space-between' }}>
        <div className="row gap">
          <Segmented value={kind} onChange={(k) => onChange(k, k === 'tax' ? years.tax[0] : years.calendar[0])} options={[{ value: 'calendar', label: 'Calendar year' }, { value: 'tax', label: 'Tax year' }]} />
          <select value={year} onChange={(e) => onChange(kind, Number(e.target.value))} aria-label="Year">
            {list.map((y) => <option key={y} value={y}>{kind === 'tax' ? `${y}/${String(y + 1).slice(2)}` : y}</option>)}
          </select>
        </div>
        <button className="btn btn-primary" onClick={() => window.print()}><Icon name="download" size={16} /> Download PDF</button>
      </div>

      <header className="yr-head">
        <p className="muted small">Year in review</p>
        <h1>{data.label}</h1>
        <p className="muted">{shortDate(data.range.from)} – {shortDate(data.range.to)}{data.partial ? ` · so far, up to ${shortDate(data.through)}` : ''}</p>
      </header>

      <div className="stats">
        <Stat label="Money in" value={<Money value={data.income} />} sub={`${data.transactions.toLocaleString('en-GB')} transactions`} />
        <Stat label="Money out" value={<Money value={data.spending} />} sub={`${money(data.fixed, { compact: true })} of it fixed costs`} />
        <Stat label="Saved and invested" value={<Money value={data.saved} />} sub={data.savingsRate != null ? `Savings rate ${pct(data.savingsRate)}` : ''} />
        <Stat label="Net worth" value={<Money value={data.netWorth.end} />} sub={<span className={data.netWorth.end - data.netWorth.start >= 0 ? 'tone-good' : 'tone-bad'}>{money(data.netWorth.end - data.netWorth.start, { sign: true })} over the year</span>} />
      </div>

      <Card title="Month by month" action={<span className="legend"><i className="lg-income" />In <i className="lg-spend" />Out <i className="lg-saved" />Saved</span>}>
        <IncomeSpendBars data={data.monthly} height={200} />
      </Card>

      <div className="yr-grid">
        <Card title="Where it went">
          <ul className="yr-cats">
            {data.categories.map((c) => (
              <li key={String(c.categoryId)}>
                <span className="grow"><span className="dot" style={{ background: c.colour }} /> {c.name}</span>
                <Money value={c.amount} className="strong" />
                <span className="yr-bar"><span style={{ width: `${(c.amount / maxCat) * 100}%`, background: c.colour }} /></span>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Top places">
          <ol className="yr-list">
            {data.merchants.map((m) => <li key={m.merchant}><span className="grow">{m.merchant} <span className="muted small">· {m.count} times</span></span><Money value={m.total} /></li>)}
          </ol>
          <p className="field-label" style={{ margin: '14px 0 6px' }}>Biggest single purchases</p>
          <ol className="yr-list">
            {data.biggest.map((b) => <li key={b.id}><span className="grow">{niceName(b.description)} <span className="muted small">· {shortDate(b.date)}</span></span><Money value={b.amount} /></li>)}
          </ol>
        </Card>
      </div>

      <div className="yr-facts">
        <div><span className="muted small">Debt</span><strong>{data.debt.paidDown >= 0 ? <>Paid down <Money value={data.debt.paidDown} /></> : <>Up <Money value={-data.debt.paidDown} /></>}</strong><span className="muted small"><Money value={data.debt.start} /> → <Money value={data.debt.end} /></span></div>
        <div><span className="muted small">Interest and fees</span><strong><Money value={data.interest} /></strong><span className="muted small">Charged on cards and loans</span></div>
        <div><span className="muted small">Subscriptions</span><strong><Money value={data.subscriptions} /></strong><span className="muted small">Across the year</span></div>
        <div><span className="muted small">ISA paid in</span><strong><Money value={data.isa.paidIn} /></strong><span className="muted small">{kind === 'tax' ? `of the ${money(data.isa.allowance, { compact: true })} allowance` : 'Use the tax year view for the allowance'}</span></div>
        <div><span className="muted small">No-spend days</span><strong>{data.noSpendDays}</strong><span className="muted small">of {data.days} days</span></div>
        <div><span className="muted small">Goals reached</span><strong>{data.goals.length}</strong><span className="muted small">{data.goals.map((g) => `${g.icon ?? '🎯'} ${g.name}`).join(', ') || 'None yet'}</span></div>
      </div>
      <p className="muted small print-only">Generated {new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}. Transfers between your own accounts and card repayments aren't counted as money in or out.</p>
    </div>
  );
}

const BREAKDOWN_PAGE = 10;

/** The breakdown table, ten rows at a time, biggest first, with arrows for the rest. */
function BreakdownTable({ data, hidden, drill }: { data: any; hidden: Set<string>; drill: (d: any) => void }) {
  const { ref, size } = useFitRows(data.series.length, BREAKDOWN_PAGE);
  const { rows, pager } = usePaged<any>(data.series, size, data.series.map((s: any) => s.key).join('|'));
  return (
    <div className="fit-fill" ref={ref}>
    <table className="report-table breakdown">
      <thead data-fit-head><tr><th>{data.level === 'category' ? 'Category' : data.level === 'subcategory' ? 'Subcategory' : 'Place'}</th><th className="num">Spent</th><th className="hide-sm">Share</th><th className="num hide-sm">Per month</th><th className="num">Change</th><th className="hide-sm">Trend</th></tr></thead>
      <tbody>
        {rows.map((s) => (
          <tr data-fit-row key={s.key} className={`${s.drill ? 'clickable' : ''} ${hidden.has(s.key) ? 'off' : ''}`} onClick={() => drill(s.drill)} tabIndex={s.drill ? 0 : -1} onKeyDown={(e) => { if (e.key === 'Enter') drill(s.drill); }}>
            <td><span className="row gap nowrap"><i className="key-box" style={{ background: s.colour }} />{s.icon && <span>{s.icon}</span>}<span className="ellipsis">{s.label}</span>{s.drill && <Icon name="chevron-right" size={14} />}</span></td>
            <td className="num strong"><Money value={s.total} /></td>
            <td className="hide-sm"><span className="share-bar"><span style={{ width: `${Math.round(s.share * 100)}%`, background: s.colour }} /></span><span className="muted small">{pct(s.share)}</span></td>
            <td className="num hide-sm"><Money value={Math.round(s.total / data.months.length)} /></td>
            <td className={`num ${changeTone(s.change)}`}>{s.prev == null ? <span className="muted">–</span> : s.prev === 0 ? <span className="muted small">new</span> : signedPct(s.change)}</td>
            <td className="hide-sm"><Spark values={s.values} colour={s.colour} width={64} /></td>
          </tr>
        ))}
      </tbody>
    </table>
      {pager}
    </div>
  );
}
