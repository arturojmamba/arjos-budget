import { PaceRings, PaceKey, paceTone, cycleProgress, lastPayday } from '../components/PaceRings.tsx';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, qs, type Summary, type Plan, type Occurrence, type MonthSpending } from '../api.ts';
import { money, monthLabel, pct, dayMonth, relativeDay, addMonths, shortDate, privateLabel, niceName } from '../format.ts';
import { Badge, Card, Empty, Money, Stat, useApp, useData, Bubble, Progress } from '../components/ui.tsx';
import { Donut, IncomeSpendBars, Cumulative } from '../components/charts.tsx';
import { GoalStrip } from './Goals.tsx';
import { PaydayCard } from './Payday.tsx';
import { amountsHidden as amountsHiddenNow } from '../format.ts';
import { PlanBreakdown } from './Bills.tsx';
import type { BudgetList } from './Budgets.tsx';
import { Badge } from '../components/ui.tsx';
import { TxnRow } from './Transactions.tsx';
import { Icon } from '../components/Icon.tsx';
import { navigate } from '../router.ts';

export function Overview({ month }: { month: string }) {
  const { categories, meta } = useApp();
  const { data: s, error } = useData<Summary>(() => api.get(`/api/summary${qs({ month })}`), [month]);
  const { data: plan } = useData<Plan>(() => api.get(`/api/plan${qs({ month })}`), [month]);
  const { data: upcoming } = useData<Occurrence[]>(() => api.get('/api/upcoming?days=35'), []);
  const { data: budgets } = useData<BudgetList>(() => api.get(`/api/budgets${qs({ month })}`), [month]);
  const statsRef = useNavyBand();
  if (error) return <Empty icon="alert" title="Couldn't load your summary">{error}</Empty>;
  if (!s || !plan) return <div className="loading" />;
  const isCurrent = month === meta.currentMonth;
  const open = (upcoming ?? []).filter((o) => o.status !== 'paid' && o.status !== 'skipped');
  const dueSoon = open.filter((o) => o.dueDate <= addDays(meta.today, 30)).slice(0, 6);
  const payday = open.find((o) => o.type === 'income')?.dueDate ?? null;
  const showPlan = plan.billsTotal > 0 || plan.savingsTotal > 0 || plan.debtTotal > 0 || plan.incomeExpected > 0;
  // This month with a plan: one tile answers "how am I doing?", so the rest needn't repeat it.
  const heroOn = isCurrent && plan.incomeExpected > 0 && (plan.billsTotal > 0 || plan.savingsTotal > 0);
  const showBudgets = !!budgets && budgets.budgets.some((b) => b.kind !== 'saving');
  const showDue = isCurrent && dueSoon.length > 0;

  const hasData = s.history.some((h) => h.income || h.spending) || s.accounts.some((a) => a.balance !== 0);
  const catIcon = (id: number | null) => categories.find((c) => c.id === id)?.icon ?? 'dots';
  const left = s.income - s.spending;

  return (
    <div className="page">
      {!hasData && (
        <div className="welcome card card-pad">
          <div>
            <h2>Welcome. Let's get your money in one place</h2>
            <p className="muted">Start by setting each account's current balance, then import a CSV export from your bank.</p>
          </div>
          <div className="row gap">
            <button className="btn" onClick={() => navigate('/accounts')}><Icon name="wallet" size={16} /> Set balances</button>
            <button className="btn btn-primary" onClick={() => navigate('/import')}><Icon name="upload" size={16} /> Import transactions</button>
          </div>
        </div>
      )}

      {s.uncategorised > 0 && (
        <button className="banner banner-warn" onClick={() => navigate(`/transactions${qs({ uncategorised: 1 })}`)}>
          <Icon name="tag" size={16} />
          <span>{s.uncategorised} transaction{s.uncategorised === 1 ? '' : 's'} this month need a category</span>
          <Icon name="chevron-right" size={16} />
        </button>
      )}
      <PaydayCard />
      <HealthBanner />

      <div ref={statsRef} className={`stats ${heroOn ? 'stats-hero' : ''} on-navy band-stats`}>
        {heroOn && <FreeHero s={s} plan={plan} payday={payday} today={meta.today} />}
        <Stat label="Income" value={<Money value={s.income} />}
          sub={plan.incomeExpected > s.income ? `${money(plan.incomeExpected - s.income, { compact: true })} still expected`
            : plan.incomeExtra > 0 ? `Incl. ${money(plan.incomeExtra, { compact: true })} above usual pay`
            : s.incomeByCategory.slice(0, 2).map((c) => `${c.name} ${money(c.amount, { compact: true })}`).join(' · ') || 'Nothing yet'} />
        <Stat label="Spent" value={<Money value={s.spending} />} sub={`${money(s.fixed, { compact: true })} fixed · ${money(s.variable, { compact: true })} variable`} />
        {heroOn ? null : plan.incomeExpected > 0 && (plan.billsTotal > 0 || plan.savingsTotal > 0) ? (
          <Stat label={privateLabel(plan.freeToSpend >= 0, 'Free to spend', 'Over budget', 'After bills and spending')} value={<Money value={Math.abs(plan.freeToSpend)} />} tone={plan.freeToSpend >= 0 ? 'good' : 'bad'}
            sub={`After ${money(plan.committed, { compact: true })} of bills and savings`} />
        ) : (
          <Stat label={privateLabel(left >= 0, 'Left over', 'Overspent', 'Income minus spending')} value={<Money value={Math.abs(left)} />} tone={left >= 0 ? 'good' : 'bad'} sub={`Savings rate ${pct(s.savingsRate)}`} />
        )}
        <Stat label="Net worth" value={<Money value={s.netWorth} />} sub={<span>{s.netWorthChange >= 0 ? 'Up' : 'Down'} {money(Math.abs(s.netWorthChange), { compact: true })} on last month</span>} />
      </div>

      {/* Row 1: where the money went | this month's plan */}
      <div className={`ov-row ${showPlan ? 'ov-wide-narrow' : ''}`}>
        <SpendingByCategory s={s} month={month} />
        {showPlan && (
          <Card title={isCurrent ? 'This month' : monthLabel(month)} action={<button className="link-btn" onClick={() => navigate('/bills')}>Bills</button>}>
            <PlanBreakdown plan={plan} />
            <MonthPace s={s} plan={plan} payday={isCurrent ? payday : null} today={meta.today} catIcon={catIcon} hero={heroOn} />
          </Card>
        )}
      </div>

      {/* Row 2: every account, grouped by what it is */}
      <MoneyAndDebt s={s} />
      <GoalStrip />

      {/* Row 3: budgets | what's due soon (whichever exist) */}
      {(showBudgets || showDue) && (
        <div className={`ov-row ${showBudgets && showDue ? 'ov-even' : ''}`}>
          {showBudgets && budgets && (
            <Card title="Budgets" action={<button className="link-btn" onClick={() => navigate(`/budgets${qs({ m: isCurrent ? undefined : month })}`)}>All budgets</button>}>
              <div className="stack" style={{ gap: 12 }}>
                <div className="row gap" style={{ justifyContent: 'space-between' }}>
                  <span><Money value={budgets.summary.spent} className="strong" /> <span className="muted small">of {money(budgets.summary.total)}</span></span>
                  <span className={`small ${budgets.summary.remaining >= 0 ? 'tone-good' : 'tone-bad'}`}>{money(Math.abs(budgets.summary.remaining))} {privateLabel(budgets.summary.remaining >= 0, 'left', 'over', '')}{!amountsHiddenNow() && <> · {pct(budgets.summary.pct)} used</>}</span>
                </div>
                <Progress value={budgets.summary.spent} max={budgets.summary.total} />
                <ul className="budget-mini">
                  {budgets.budgets.filter((b) => b.kind !== 'saving').sort((a, b) => b.pct - a.pct).slice(0, 6).map((b) => (
                    <li key={b.id}>
                      <span className="grow">{b.name}{b.period !== 'monthly' && <span className="muted small"> · {b.period === 'weekly' ? 'this week' : 'this year'}</span>}</span>
                      <span className={`small ${b.remaining < 0 ? 'tone-bad' : 'muted'}`}>{money(Math.abs(b.remaining))} {privateLabel(b.remaining >= 0, 'left', 'over', '')}</span>
                      <span className="budget-mini-bar"><Progress value={b.spent} max={b.available} /></span>
                    </li>
                  ))}
                </ul>
              </div>
            </Card>
          )}
          {showDue && (
            <Card title="Coming up" pad={false} action={<button className="link-btn" onClick={() => navigate('/bills')}>See all</button>}>
              <ul className="due-list compact">
                {dueSoon.map((o) => {
                  const dm = dayMonth(o.dueDate);
                  return (
                    <li key={`${o.recurringId}-${o.dueDate}`} className={`due status-${o.status}`}>
                      <span className="due-date"><strong>{dm.day}</strong><span>{dm.month}</span></span>
                      <span className="grow"><span className="due-name">{o.name}</span><span className="muted small">{relativeDay(o.dueDate, meta.today)}</span></span>
                      {o.status === 'overdue' && <Badge tone="bad">Overdue</Badge>}
                      <span className={`money ${o.type === 'income' ? 'amt-in' : ''}`}>{o.type === 'income' ? '+' : ''}{money(o.expected)}</span>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}
        </div>
      )}

      {/* Row 4: trend | latest activity */}
      <div className="ov-row ov-even">
        <Card title="Income vs spending" action={<span className="legend"><i className="lg-income" />Income <i className="lg-spend" />Spending <i className="lg-saved" />Saved</span>}>
          {s.history.some((h) => h.income || h.spending)
            ? <><IncomeSpendBars data={s.history} height={220} /><HistoryAverages history={s.history} /></>
            : <Empty icon="trending-up" title="Nothing to compare yet">Import a few months of statements to see income against spending.</Empty>}
        </Card>
        <Card title="Recent transactions" pad={false} action={<button className="link-btn" onClick={() => navigate('/transactions')}>See all</button>}>
          {s.recent.length === 0 ? <Empty icon="list" title="No transactions yet" /> : (
            <ul className="txn-list compact">{s.recent.map((t) => <TxnRow key={t.id} t={t} showDate />)}</ul>
          )}
        </Card>
      </div>
    </div>
  );
}

const GROUPS: { key: string; title: string; match: (a: Summary['accounts'][number]) => boolean }[] = [
  { key: 'everyday', title: 'Everyday', match: (a) => a.type === 'current' || a.type === 'cash' },
  { key: 'savings', title: 'Savings and investments', match: (a) => ['savings', 'pot', 'investment', 'other_asset'].includes(a.type) },
  { key: 'debt', title: 'Cards and loans', match: (a) => a.isLiability },
];

/** Accounts grouped by what they are, each group with its own total. */
function MoneyAndDebt({ s }: { s: Summary }) {
  const top = s.accounts.filter((a) => a.parentId === null);
  const children = (id: number) => s.accounts.filter((a) => a.parentId === id);
  return (
    <Card title="Money and debt" action={<span className="row gap"><span className="muted small">Net worth <Money value={s.netWorth} /></span><button className="link-btn" onClick={() => navigate('/accounts')}>Accounts</button></span>}>
      <div className="money-groups">
        {GROUPS.map((g) => {
          const list = top.filter(g.match);
          const all = s.accounts.filter(g.match);
          const total = all.reduce((sum, a) => sum + a.balance, 0);
          const isDebt = g.key === 'debt';
          return (
            <section key={g.key} className="money-group">
              <header>
                <span className="field-label">{g.title}</span>
                {isDebt
                  ? <button className="money-group-link" onClick={() => navigate('/debts')} title="See debts"><Money value={-total} className="strong tone-bad" /></button>
                  : <Money value={total} className="strong" />}
              </header>
              {list.length === 0 ? <p className="muted small">None yet</p> : (
                <ul className="acct-mini">
                  {list.map((a) => (
                    <React.Fragment key={a.id}>
                      <li>
                        <button onClick={() => navigate(`/transactions${qs({ accountId: a.id })}`)}>
                          <span className={`dot ${a.isLiability ? 'dot-debt' : ''}`} style={{ background: a.colour }} />
                          <span className="grow">{a.name}</span>
                          {a.isLiability
                            ? <span className="money">{a.balance < 0 ? money(-a.balance) : a.balance === 0 ? <span className="muted">Paid off</span> : `${money(a.balance)} credit`}</span>
                            : <Money value={a.balance} />}
                        </button>
                      </li>
                      {children(a.id).map((c) => (
                        <li key={c.id} className="acct-mini-child">
                          <button onClick={() => navigate(`/transactions${qs({ accountId: c.id })}`)}>
                            <span className="dot" style={{ background: c.colour }} />
                            <span className="grow">{c.name}</span>
                            <Money value={c.balance} />
                          </button>
                        </li>
                      ))}
                    </React.Fragment>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </Card>
  );
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000);
}

const CAT_LIMIT = 6;

/** Category breakdown with its own month arrows, so you can look back without leaving the current month. */
function SpendingByCategory({ s, month }: { s: Summary; month: string }) {
  const { categories, meta } = useApp();
  const [m, setM] = useState(month);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => setM(month), [month]);
  const { data: other } = useData<MonthSpending | null>(() => (m === month ? Promise.resolve(null) : api.get(`/api/spending${qs({ month: m })}`)), [m, month]);
  const view: MonthSpending | null = m === month ? { month, spending: s.spending, byCategory: s.byCategory, daily: s.daily } : other;
  const earliest = meta.months[meta.months.length - 1] ?? month;
  const catIcon = (id: number | null) => categories.find((c) => c.id === id)?.icon ?? 'dots';
  const cats = (view?.byCategory ?? []).filter((c) => c.amount > 0);
  const shown = showAll ? cats : cats.slice(0, CAT_LIMIT);
  const hiddenTotal = cats.slice(CAT_LIMIT).reduce((t, c) => t + c.amount, 0);

  return (
    <Card title="Spending by category" action={
      <span className="month-step">
        <button className="icon-btn" onClick={() => setM(addMonths(m, -1))} disabled={m <= earliest} aria-label="Previous month"><Icon name="chevron-left" size={16} /></button>
        <span className="small strong">{monthLabel(m, true)} {m.slice(0, 4)}</span>
        <button className="icon-btn" onClick={() => setM(addMonths(m, 1))} disabled={m >= meta.currentMonth} aria-label="Next month"><Icon name="chevron-right" size={16} /></button>
      </span>
    }>
      {!view ? <div className="loading" /> : cats.length === 0 ? (
        <Empty icon="shopping-bag" title={`No spending recorded in ${monthLabel(m)}`} />
      ) : (
        <>
          <div className="cat-breakdown">
            <Donut
              items={cats.map((c) => ({ label: c.name, value: c.amount, colour: c.colour }))}
              centre={<><span className="donut-label">Spent</span><span className="donut-value">{money(view.spending)}</span></>}
            />
            <ul className="cat-list">
              {shown.map((c) => (
                <li key={c.categoryId ?? 'none'}>
                  <button className="cat-row" onClick={() => navigate(`/transactions${qs({ month: m, categoryId: c.categoryId ?? undefined, uncategorised: c.categoryId == null ? 1 : undefined })}`)}>
                    <Bubble colour={c.colour} icon={catIcon(c.categoryId)} size={30} />
                    <span className="cat-name">{c.name}{c.isFixed && <span className="tag">Fixed</span>}</span>
                    <span className="cat-amt"><Money value={c.amount} /><span className="muted small">{view.spending ? Math.round((c.amount / view.spending) * 100) : 0}%</span></span>
                    <span className="cat-bar"><Progress value={c.amount} max={cats[0].amount} colour={c.colour} /></span>
                  </button>
                </li>
              ))}
              {cats.length > CAT_LIMIT && (
                <li>
                  <button className="link-btn cat-more" onClick={() => setShowAll(!showAll)}>
                    {showAll ? 'Show fewer' : <>{cats.length - CAT_LIMIT} more categories · <Money value={hiddenTotal} /></>}
                  </button>
                </li>
              )}
            </ul>
          </div>
          <div className="spark-wrap">
            <span className="muted small">Spending through {monthLabel(m)}</span>
            <Cumulative daily={view.daily} month={m} height={88} />
          </div>
        </>
      )}
    </Card>
  );
}

/**
 * The answer to "how am I doing this month?": what's free to spend, a verdict, and the daily amount
 * to payday. Over (red) when the plan costs more than this month's pay; "Spending faster" (amber)
 * when well ahead of last month at the same point; otherwise on track (green).
 */
function FreeHero({ s, plan, payday, today }: { s: Summary; plan: Plan; payday: string | null; today: string }) {
  const p = s.pace;
  const free = plan.freeToSpend;
  const daysLeft = payday ? Math.max(1, daysBetween(today, payday)) : Math.max(1, p.daysInMonth - p.day + 1);
  const perDay = free > 0 ? Math.floor(free / daysLeft) : 0;
  const ahead = p.isCurrent && p.lastMonthToDate > 0 ? p.spentToDate - p.lastMonthToDate : 0;
  // The rings: time through the pay cycle against the share of spending money used.
  const month = plan.month;
  const start = payday ? lastPayday(month) : `${month}-01`;
  const end = payday ?? `${month}-${String(p.daysInMonth).padStart(2, '0')}`;
  const time = cycleProgress(today, start, end);
  const pot = plan.otherSpending + Math.max(0, free);
  const used = free < 0 ? 1 : pot > 0 ? plan.otherSpending / pot : 0;
  const tone = paceTone(time, used, free < 0);
  const verdict = tone === 'bad' ? 'Over' : tone === 'warn' ? 'Spending ahead of time' : 'On track';
  const until = payday ? `until payday` : `left this month`;
  return (
    <div className="stat stat-hero">
      <div className="stat-hero-body">
        <div className="stat-hero-top">
          <p className="stat-label">{free >= 0 ? 'Free to spend' : 'Over this month'}</p>
          <Badge tone={tone}>{verdict}</Badge>
        </div>
        <p className={`stat-value ${free < 0 ? 'tone-bad' : ''}`}><Money value={Math.abs(free)} /></p>
        <p className="stat-sub">
          {free < 0
            ? <>Bills, savings and spending come to more than this month's pay. Spend less or move a saving.</>
            : <><Money value={perDay} /> a day for {daysLeft} day{daysLeft === 1 ? '' : 's'} {until}{ahead !== 0 && Math.abs(ahead) >= 100 ? <>, <Money value={Math.abs(ahead)} /> {ahead > 0 ? 'more' : 'less'} spent than by this point last month</> : null}.</>}
        </p>
      </div>
      <div className="stat-hero-rings">
        <PaceRings time={time} money={used} tone={tone} />
        <PaceKey time={time} money={used} />
      </div>
    </div>
  );
}

/** How the month is going: pace against last month, a daily allowance until payday, and the biggest purchases. */
function MonthPace({ s, plan, payday, today, catIcon, hero }: { s: Summary; plan: Plan; payday: string | null; today: string; catIcon: (id: number | null) => string; hero?: boolean }) {
  const { categories } = useApp();
  const p = s.pace;
  const diff = p.spentToDate - p.lastMonthToDate;
  const daysLeft = payday ? Math.max(1, daysBetween(today, payday)) : Math.max(1, p.daysInMonth - p.day + 1);
  const perDay = plan.freeToSpend > 0 ? Math.floor(plan.freeToSpend / daysLeft) : 0;
  const hasPlan = plan.incomeExpected > 0 && (plan.billsTotal > 0 || plan.savingsTotal > 0);
  return (
    <div className="pace">
      {!hero && <div className="pace-tiles">
        <div className="pace-tile">
          <span className="muted small">{p.isCurrent ? `Spent by day ${p.day}` : 'Spent this month'}</span>
          <Money value={p.spentToDate} className="strong" />
          {p.lastMonthToDate > 0 && (
            <span className={`small ${diff > 0 ? 'tone-bad' : 'tone-good'}`}>
              {money(Math.abs(diff), { compact: true })} {privateLabel(diff <= 0, 'less', 'more', 'difference')} {amountsHiddenNow() ? 'vs' : 'than'} {p.isCurrent ? 'this point last month' : 'the month before'}
            </span>
          )}
        </div>
        {p.isCurrent && hasPlan ? (
          <div className="pace-tile">
            <span className="muted small">{payday ? `Per day until payday (${daysLeft}d)` : `Per day for ${daysLeft} days left`}</span>
            <Money value={perDay} className={`strong ${perDay > 0 ? '' : 'tone-bad'}`} />
            <span className="muted small">{amountsHiddenNow() ? 'After bills and spending' : plan.freeToSpend > 0 ? `${money(plan.freeToSpend, { compact: true })} free to spend` : 'Nothing left after bills'}</span>
          </div>
        ) : (
          <div className="pace-tile">
            <span className="muted small">Average per day</span>
            <Money value={Math.round(p.spentToDate / Math.max(1, p.day))} className="strong" />
            <span className="muted small">over {p.day} day{p.day === 1 ? '' : 's'}</span>
          </div>
        )}
      </div>}
      {s.topSpends.length > 0 && (
        <div className="pace-top">
          <span className="muted small strong-label">Biggest spends</span>
          <ul>
            {s.topSpends.map((t) => {
              const c = categories.find((x) => x.id === t.categoryId);
              return (
                <li key={t.id}>
                  <Bubble colour={c?.colour ?? '#94a3b8'} icon={catIcon(t.categoryId)} size={26} />
                  <span className="grow ellipsis">{niceName(t.description)}<span className="muted small"> · {shortDate(t.date)}</span></span>
                  <Money value={t.amount} />
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Averages over the months shown in the chart that have any data. */
function HistoryAverages({ history }: { history: Summary['history'] }) {
  const months = history.filter((h) => h.income || h.spending);
  if (months.length === 0) return null;
  const avgIn = Math.round(months.reduce((t, h) => t + h.income, 0) / months.length);
  const avgOut = Math.round(months.reduce((t, h) => t + h.spending, 0) / months.length);
  const saved = avgIn - avgOut;
  const avgSaved = Math.round(months.reduce((t, h) => t + h.saved, 0) / months.length);
  return (
    <div className="hist-avg">
      <div><span className="muted small">Avg income</span><Money value={avgIn} className="strong amt-in" /></div>
      <div><span className="muted small">Avg spending</span><Money value={avgOut} className="strong" /></div>
      <div><span className="muted small">Avg {privateLabel(saved >= 0, 'left over', 'overspent', 'difference')}</span><Money value={Math.abs(saved)} className={`strong ${saved >= 0 ? 'tone-good' : 'tone-bad'}`} /><span className="muted small">{avgIn > 0 ? `${Math.round((saved / avgIn) * 100)}% of income` : ''}</span></div>
      <div><span className="muted small">Avg saved</span><Money value={avgSaved} className="strong amt-saved" /><span className="muted small">into savings and investments</span></div>
    </div>
  );
}

/** A quiet nudge when the data health checks (other than uncategorised, shown above) find something. */
function HealthBanner() {
  const { data } = useData<{ id: string; title: string }[]>(() => api.get('/api/health'), []);
  const issues = (data ?? []).filter((h) => h.id !== 'uncategorised');
  if (!issues.length) return null;
  return (
    <button className="banner banner-info" onClick={() => navigate('/settings')}>
      <Icon name="info" size={16} />
      <span>{issues.length === 1 ? issues[0].title : `${issues.length} things to tidy up: ${issues.slice(0, 2).map((i) => i.title).join(' · ')}${issues.length > 2 ? '…' : ''}`}</span>
      <Icon name="chevron-right" size={16} />
    </button>
  );
}

/** Paints the navy band on the page behind the greeting and the headline tiles, sized to end just below them. */
function useNavyBand() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const main = document.querySelector<HTMLElement>('.main');
    if (!main) return;
    const fit = () => {
      const el = ref.current;
      if (!el) return;
      const h = el.getBoundingClientRect().bottom - main.getBoundingClientRect().top + 26;
      main.style.setProperty('--band-h', `${Math.round(h)}px`);
      main.classList.add('has-band');
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(main);
    if (ref.current) ro.observe(ref.current);
    return () => { ro.disconnect(); main.classList.remove('has-band'); main.style.removeProperty('--band-h'); };
  });
  return ref;
}
