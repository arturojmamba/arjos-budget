import React, { useEffect, useState } from 'react';
import { api, qs, type Plan } from '../api.ts';
import { PaceRings, PaceKey, paceTone, cycleProgress } from '../components/PaceRings.tsx';
import { money, monthLabel, parseAmount, pct, penceToInput, shortDate, niceName } from '../format.ts';
import { Badge, Card, Money, Progress, useApp, useConfirm, useData } from '../components/ui.tsx';
import { Icon, CatGlyph } from '../components/Icon.tsx';
import { navigate, setParams } from '../router.ts';

interface Move { key: string; kind: 'goal' | 'saving' | 'debt' | 'card'; title: string; to: string; amount: number; due: string | null; status: 'done' | 'partial' | 'waiting' | 'skipped'; moved: number; movedOn: string | null; note: string | null }
interface PaydayData {
  cycle: string; next: string; period: string; closing: string; today: string; daysSince: number; daysToNext: number;
  steps: Record<'pay' | 'close' | 'plan' | 'moves' | 'budgets', boolean>;
  pay: { name: string; expected: number | null; date: string; actual: number | null; actualDate: string | null; description: string | null; diff: number | null; arrived: boolean; other: { date: string; description: string; amount: number }[] };
  close: { month: string; income: number; spending: number; saved: number; savingsRate: number | null; budgets: { id: number; name: string; icon: string | null; colour: string; limit: number; spent: number; over: boolean }[]; looseEnds: { title: string; detail: string; link: string; linkLabel: string }[] };
  plan: {
    pay: number; buffer: number;
    bills: { total: number; items: { recurringId: number; name: string; date: string; amount: number; paid: boolean; coveredBy: string | null }[] };
    debts: { total: number; items: { recurringId: number; name: string; date: string; amount: number; paid: boolean }[] };
    savings: { total: number; items: { key: string; name: string; icon: string | null; amount: number; accountName: string }[] };
    budgets: { total: number; items: { id: number; name: string; icon: string | null; colour: string; limit: number; period: string }[] };
  };
  moves: Move[];
  budgets: { id: number; name: string; icon: string | null; colour: string; limit: number; setLimit: number; period: string; typical: number | null; verdict: string | null; suggestion: number | null; months: number; under: number }[];
  items: { id: number; text: string; done: boolean }[];
  completedAt: string | null;
}
interface Log { cycle: string; period: string; completedAt: string; inProgress: boolean; planned: { pay: number; plan: { bills: number; debts: number; savings: number; budgets: number; buffer: number } }; actual: { income: number; spending: number; saved: number; left: number } }

const SPLIT = [
  { key: 'bills', label: 'Bills', colour: '#6250d6' },
  { key: 'debts', label: 'Debt payments', colour: '#e34948' },
  { key: 'savings', label: 'Savings', colour: '#0ea5e9' },
  { key: 'budgets', label: 'Budgets', colour: '#eda100' },
] as const;

export function Payday({ params }: { params: URLSearchParams }) {
  const { toast, refresh } = useApp();
  const cycleParam = params.get('cycle');
  const { data, reload, loading } = useData<PaydayData>(() => api.get(`/api/payday${qs({ cycle: cycleParam ?? undefined })}`), [cycleParam]);
  const { data: logs, reload: reloadLogs } = useData<Log[]>(() => api.get('/api/payday/logs'), []);
  const period = data?.period;
  const { data: monthPlan } = useData<Plan | null>(() => (period ? api.get(`/api/plan${qs({ month: period })}`) : Promise.resolve(null)), [period]);
  const [open, setOpen] = useState<string | null>(null);
  const [confirm, confirmNode] = useConfirm();

  const order = ['pay', 'close', 'plan', 'moves', 'budgets', 'own', 'finish'] as const;
  const isDone = (k: string) => {
    if (!data) return false;
    if (k === 'own') return data.items.length > 0 && data.items.every((i) => i.done);
    if (k === 'finish') return !!data.completedAt;
    return data.steps[k as keyof PaydayData['steps']];
  };
  // The first unfinished step is open unless you've opened another.
  const current = data ? order.find((k) => !isDone(k) && !(k === 'own' && data.items.length === 0)) ?? null : null;
  const shown = open ?? current;

  async function check(key: string, done = true) {
    if (!data) return;
    try { await api.post('/api/payday/check', { cycle: data.cycle, key, done }); setOpen(null); reload(); } catch (e: any) { toast(e.message, 'error'); }
  }
  async function finish() {
    if (!data) return;
    try { await api.post('/api/payday/complete', { cycle: data.cycle }); toast('Payday done. Nice work 🎉'); reload(); reloadLogs(); refresh(); } catch (e: any) { toast(e.message, 'error'); }
  }
  async function reopen() {
    if (!data || !(await confirm('Reopen this payday? Your ticks stay; the saved plan is replaced when you finish again.', { label: 'Reopen' }))) return;
    await api.post('/api/payday/reopen', { cycle: data.cycle }); reload(); reloadLogs();
  }

  if (!data) return <div className="page"><div className="loading" /></div>;
  const ownCount = data.items.length;
  const stepKeys = order.filter((k) => !(k === 'own' && ownCount === 0));
  const doneCount = stepKeys.filter(isDone).length;
  const prevCycle = `${shiftMonth(data.cycle.slice(0, 7), -1)}-28`;
  const isCurrent = data.cycle <= data.today && data.next > data.today;
  const upcoming = data.cycle > data.today;

  const stepProps = (k: string) => ({ k, done: isDone(k), open: shown === k, onToggle: () => setOpen(shown === k ? '__none' : k) });
  const p = data.plan;
  const leftForBudgets = p.pay - p.bills.total - p.debts.total - p.savings.total;

  return (
    <div className={`page payday ${loading ? 'stale' : ''}`}>
      <div className="payday-head">
        <div>
          <h2>{shortDate(data.cycle)}</h2>
          <span className="muted">{upcoming ? 'Planning ahead' : isCurrent ? 'This payday' : 'Past payday'} · pays for {monthLabel(data.period)} · next payday {shortDate(data.next)}{data.daysToNext > 0 && data.cycle <= data.today ? ` (in ${data.daysToNext} day${data.daysToNext === 1 ? '' : 's'})` : ''}</span>
        </div>
        <div className="payday-head-side">
        {isCurrent && monthPlan && monthPlan.incomeExpected > 0 && (() => {
          const time = cycleProgress(data.today, data.cycle, data.next);
          const free = monthPlan.freeToSpend;
          const pot = monthPlan.otherSpending + Math.max(0, free);
          const used = free < 0 ? 1 : pot > 0 ? monthPlan.otherSpending / pot : 0;
          return <div className="payday-rings"><PaceRings time={time} money={used} tone={paceTone(time, used, free < 0)} size={72} /><PaceKey time={time} money={used} /></div>;
        })()}
        <div className="payday-nav">
          <button className="icon-btn" aria-label="Previous payday" onClick={() => setParams('/payday', { cycle: prevCycle })}><Icon name="chevron-left" size={18} /></button>
          {!isCurrent && <button className="btn btn-sm" onClick={() => setParams('/payday', {})}>This payday</button>}
          <button className="icon-btn" aria-label="Next payday" onClick={() => setParams('/payday', { cycle: data.next })}><Icon name="chevron-right" size={18} /></button>
        </div>
        </div>
      </div>

      <div className="payday-grid">
      <div className="payday-steps">
      <div className="payday-progress" aria-label={`${doneCount} of ${stepKeys.length} steps done`}>
        <div className="payday-pips">{stepKeys.map((k) => <span key={k} className={`pip ${isDone(k) ? 'on' : ''} ${shown === k ? 'cur' : ''}`} />)}</div>
        <span className="muted small">{data.completedAt ? `All done · finished ${shortDate(data.completedAt.slice(0, 10))}` : `${doneCount} of ${stepKeys.length} done`}</span>
      </div>
      {/* 1. Pay */}
      <Step {...stepProps('pay')} n={1} title="Check your pay"
        summary={data.pay.arrived ? `${money(data.pay.actual!)} arrived ${shortDate(data.pay.actualDate!)}` : upcoming ? `Expecting ${data.pay.expected != null ? money(data.pay.expected) : 'your pay'}` : 'Not in your imports yet'}>
        {data.pay.arrived ? (
          <div className="pay-check">
            <div className="pay-big"><Money value={data.pay.actual!} /><span className="muted small">{niceName(data.pay.description)} · {shortDate(data.pay.actualDate!)}</span></div>
            {data.pay.diff == null ? null : data.pay.diff === 0
              ? <Badge tone="good"><Icon name="check" size={12} /> Exactly what you expected</Badge>
              : <Badge tone={data.pay.diff > 0 ? 'good' : 'warn'}>{money(Math.abs(data.pay.diff))} {data.pay.diff > 0 ? 'more' : 'less'} than the usual {money(data.pay.expected!)}</Badge>}
            {data.pay.diff != null && data.pay.diff < 0 && <p className="muted small">Worth checking your payslip: tax code, pension, student loan, or fewer hours.</p>}
          </div>
        ) : (
          <div className="pay-check">
            <p>{upcoming ? `Your ${data.pay.name} is due ${shortDate(data.cycle)}.` : `There's no ${data.pay.name} in your imports around ${shortDate(data.cycle)} yet.`}</p>
            {!upcoming && <button className="btn" onClick={() => navigate('/import')}><Icon name="upload" size={16} /> Import your statement</button>}
          </div>
        )}
        {data.pay.other.length > 0 && (
          <div className="sub-list">
            <span className="muted small">Other money in for {monthLabel(data.period, true)}</span>
            {data.pay.other.map((o, i) => <div key={i} className="row small"><span className="ellipsis">{niceName(o.description)} <span className="muted">· {shortDate(o.date)}</span></span><span className="spacer" /><Money value={o.amount} /></div>)}
          </div>
        )}
        <StepFoot onDone={() => check('pay')} label="Pay looks right" done={data.steps.pay} onUndo={() => check('pay', false)} />
      </Step>

      {/* 2. Close last month */}
      <Step {...stepProps('close')} n={2} title={`Close ${monthLabel(data.close.month)}`}
        summary={`${money(data.close.spending)} spent · ${data.close.budgets.filter((b) => b.over).length} of ${data.close.budgets.length} budgets over · ${data.close.looseEnds.length ? `${data.close.looseEnds.length} to tidy` : 'nothing to tidy'}`}>
        <div className="close-stats">
          <div><span className="muted small">Money in</span><strong><Money value={data.close.income} /></strong></div>
          <div><span className="muted small">Spent</span><strong><Money value={data.close.spending} /></strong></div>
          <div><span className="muted small">Saved and invested</span><strong><Money value={data.close.saved} /></strong></div>
          <div><span className="muted small">Savings rate</span><strong>{data.close.savingsRate != null ? pct(data.close.savingsRate) : '–'}</strong></div>
        </div>
        {data.close.budgets.length > 0 && (
          <ul className="close-budgets">
            {data.close.budgets.map((b) => (
              <li key={b.id}>
                <span className="ellipsis cat-label"><CatGlyph icon={b.icon} /> {b.name}</span>
                <Progress value={b.spent} max={b.limit} />
                <span className={`small nowrap ${b.over ? 'tone-bad' : 'muted'}`}>{money(b.spent)} of {money(b.limit)}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="sub-list">
          <span className="muted small">Loose ends</span>
          {data.close.looseEnds.length === 0 ? <p className="small">Nothing to tidy. 🎉</p> : data.close.looseEnds.map((l, i) => (
            <div key={i} className="loose">
              <Icon name="alert" size={15} />
              <span className="grow"><strong className="small">{l.title}</strong><span className="muted small">{l.detail}</span></span>
              <button className="link-btn small" onClick={() => navigate(l.link)}>{l.linkLabel}</button>
            </div>
          ))}
        </div>
        <StepFoot onDone={() => check('close')} label="Month closed" done={data.steps.close} onUndo={() => check('close', false)} extra={<button className="link-btn small" onClick={() => navigate('/reports?view=budgets')}>See budget track record</button>} />
      </Step>

      {/* 3. Plan */}
      <Step {...stepProps('plan')} n={3} title="Give every pound a job"
        summary={`${money(p.pay)} → bills ${money(p.bills.total)}, debts ${money(p.debts.total)}, savings ${money(p.savings.total)}, budgets ${money(p.budgets.total)} · ${p.buffer >= 0 ? `${money(p.buffer)} buffer` : `${money(-p.buffer)} short`}`}>
        <div className="split-bar" role="img" aria-label="How your pay is split">
          {SPLIT.map((s) => { const v = p[s.key].total; return v > 0 && <span key={s.key} style={{ flex: v, background: s.colour }} title={`${s.label}: ${money(v)}`} />; })}
          {p.buffer > 0 && <span style={{ flex: p.buffer }} className="split-buffer" title={`Buffer: ${money(p.buffer)}`} />}
        </div>
        <div className="split-legend">
          <div><span className="muted small">Pay</span><strong><Money value={p.pay} /></strong></div>
          {SPLIT.map((s) => <div key={s.key}><span className="muted small"><i className="key-box" style={{ background: s.colour }} /> {s.label}</span><strong>{money(p[s.key].total)}</strong></div>)}
          <div className={p.buffer >= 0 ? 'buffer-ok' : 'buffer-short'}><span className="small">{p.buffer >= 0 ? 'Buffer' : 'Short by'}</span><strong>{money(Math.abs(p.buffer))}</strong></div>
        </div>
        {p.buffer < 0 && <p className="tone-bad small">Your plan needs {money(-p.buffer)} more than this pay. Lower a budget in the next step, or move a saving.</p>}
        <div className="plan-groups">
          <PlanGroup title="Bills before next payday" total={p.bills.total} items={p.bills.items.map((b) => ({ key: `b${b.recurringId}${b.date}`, label: b.name, sub: `${shortDate(b.date)}${b.coveredBy ? ` · in your ${b.coveredBy} budget` : ''}`, amount: b.amount, faded: !!b.coveredBy, done: b.paid }))} />
          <PlanGroup title="Debt payments" total={p.debts.total} items={p.debts.items.map((d) => ({ key: `d${d.recurringId}${d.date}`, label: d.name, sub: shortDate(d.date), amount: d.amount, done: d.paid }))} />
          <PlanGroup title="Savings" total={p.savings.total} items={p.savings.items.map((s) => ({ key: s.key, label: `${s.icon ?? ''} ${s.name}`, sub: s.accountName, amount: s.amount }))} />
          <PlanGroup title={`Budgets for ${monthLabel(data.period, true)}`} total={p.budgets.total} items={p.budgets.items.map((b) => ({ key: `g${b.id}`, label: `${b.icon ?? ''} ${b.name}`, sub: b.period === 'monthly' ? '' : b.period, amount: b.limit }))} />
        </div>
        <StepFoot onDone={() => check('plan')} label="Plan looks good" done={data.steps.plan} onUndo={() => check('plan', false)} />
      </Step>

      {/* 4. Moves */}
      <Step {...stepProps('moves')} n={4} title="Move the money"
        summary={data.moves.length ? `${data.moves.filter((m) => m.status === 'done').length} of ${data.moves.length} moved${data.moves.some((m) => m.status === 'skipped') ? ', some skipped' : ''}` : 'Nothing to move'}>
        <p className="muted small">Make these in your banking apps. Each one ticks itself off when the transfer shows up in an import.</p>
        <ul className="moves">
          {data.moves.map((m) => (
            <li key={m.key} className={`move move-${m.status}`}>
              <span className="move-icon">{m.status === 'done' ? <Icon name="check" size={15} /> : m.status === 'partial' ? '◐' : m.status === 'skipped' ? '–' : ''}</span>
              <span className="grow">
                <strong>{m.title}</strong>
                <span className="muted small">
                  {m.to && m.kind !== 'card' ? `to ${m.to}` : ''}{m.due ? `${m.to && m.kind !== 'card' ? ' · ' : ''}due ${shortDate(m.due)}` : ''}
                  {m.status === 'done' && m.movedOn ? ` · moved ${shortDate(m.movedOn)}` : ''}
                  {m.status === 'partial' ? ` · ${money(m.moved)} moved so far` : ''}
                  {m.status === 'waiting' ? ' · waiting for an import' : ''}
                  {m.note ? ` · ${m.note}` : ''}
                </span>
                {m.kind === 'card' && <span className="muted small">Already counted in your spending, so it isn't in the plan above.</span>}
              </span>
              <strong className="nowrap">{money(m.amount)}</strong>
              {m.status !== 'done' && <button className="link-btn small" onClick={() => check(`skip:${m.key}`, m.status !== 'skipped')}>{m.status === 'skipped' ? 'Undo skip' : 'Skip'}</button>}
            </li>
          ))}
        </ul>
        {data.moves.length === 0 && <p className="small">No transfers due before next payday.</p>}
        <StepFoot onDone={() => check('moves')} label={data.moves.every((m) => m.status === 'done' || m.status === 'skipped') ? 'All moved' : 'Mark as done anyway'} done={data.steps.moves} onUndo={() => check('moves', false)} />
      </Step>

      {/* 5. Budgets */}
      <Step {...stepProps('budgets')} n={5} title={`Set ${monthLabel(data.period)} budgets`}
        summary={`${money(p.budgets.total)} across ${data.budgets.length} budget${data.budgets.length === 1 ? '' : 's'} · ${money(leftForBudgets)} available after bills, debts and savings`}>
        <BudgetEditor data={data} leftForBudgets={leftForBudgets} onSaved={() => { check('budgets'); refresh(); }} done={data.steps.budgets} onUndo={() => check('budgets', false)} />
      </Step>

      {/* Your own steps */}
      <Step {...stepProps('own')} n={ownCount ? 6 : '+'} title="Your own steps" summary={ownCount ? `${data.items.filter((i) => i.done).length} of ${ownCount} done` : 'Add anything you do every payday'} optional={ownCount === 0}>
        <OwnSteps data={data} onCheck={check} onChange={reload} />
      </Step>

      {/* Finish */}
      <Step {...stepProps('finish')} n={ownCount ? 7 : 6} title="Finish" summary={data.completedAt ? `Saved ${shortDate(data.completedAt.slice(0, 10))}` : 'Save this plan to look back on'}>
        {data.completedAt ? (
          <div className="row gap"><Badge tone="good"><Icon name="check" size={12} /> Done for {monthLabel(data.period)}</Badge><span className="spacer" /><button className="link-btn small" onClick={reopen}>Reopen</button></div>
        ) : (
          <>
            <p className="small">Saves the plan ({money(p.pay)} pay, {p.buffer >= 0 ? `${money(p.buffer)} buffer` : `${money(-p.buffer)} short`}) so next month you can see how it went.
              {doneCount < stepKeys.length - 1 && <span className="muted"> You can finish with steps left; they'll stay as they are.</span>}</p>
            <button className="btn btn-primary" onClick={finish}><Icon name="check" size={16} /> Finish payday</button>
          </>
        )}
      </Step>

      </div>
      <aside className="payday-side">
        <Card title="At a glance">
          <div className="glance-pay"><span className="muted small">{data.pay.arrived ? 'Pay received' : 'Expected pay'}</span><strong><Money value={p.pay} /></strong></div>
          <div className="split-bar thin" role="img" aria-label="How your pay is split">
            {SPLIT.map((x) => { const v = p[x.key].total; return v > 0 && <span key={x.key} style={{ flex: v, background: x.colour }} />; })}
            {p.buffer > 0 && <span style={{ flex: p.buffer }} className="split-buffer" />}
          </div>
          <ul className="glance-list">
            {SPLIT.map((x) => <li key={x.key}><i className="key-box" style={{ background: x.colour }} /><span className="grow">{x.label}</span><span>{money(p[x.key].total)}</span></li>)}
            <li className={p.buffer >= 0 ? 'tone-good' : 'tone-bad'}><i className="key-box split-buffer" /><span className="grow"><strong>{p.buffer >= 0 ? 'Buffer' : 'Short by'}</strong></span><strong>{money(Math.abs(p.buffer))}</strong></li>
          </ul>
        </Card>
        <Card title="Next payday">
          <div className="glance-pay"><strong>{shortDate(data.next)}</strong><span className="muted small">{data.daysToNext > 0 ? `in ${data.daysToNext} day${data.daysToNext === 1 ? '' : 's'}` : 'today'} · pays for {monthLabel(addMonthsClient(data.period, 1))}</span></div>
          <button className="btn btn-sm" style={{ marginTop: 10 }} onClick={() => setParams('/payday', { cycle: data.next })}>Plan it now <Icon name="chevron-right" size={14} /></button>
        </Card>
      </aside>
      </div>

      {logs && logs.length > 0 && (
        <Card title="Past paydays" pad={false}>
          <table className="report-table">
            <thead><tr><th>Month</th><th className="num">Pay</th><th className="num">Planned buffer</th><th className="num">Spent</th><th className="num hide-sm">Budgets</th><th className="num">Left over</th></tr></thead>
            <tbody>
              {logs.map((l) => (
                <tr key={l.cycle} className="clickable" onClick={() => setParams('/payday', { cycle: l.cycle })}>
                  <td>{monthLabel(l.period)}{l.inProgress && <span className="tag">so far</span>}</td>
                  <td className="num"><Money value={l.planned.pay} /></td>
                  <td className="num"><Money value={l.planned.plan.buffer} /></td>
                  <td className="num"><Money value={l.actual.spending} /></td>
                  <td className="num hide-sm muted"><Money value={l.planned.plan.budgets} /></td>
                  <td className={`num ${l.actual.left >= 0 ? 'tone-good' : 'tone-bad'}`}><Money value={l.actual.left} sign /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {confirmNode}
    </div>
  );
}

const STEP_NAMES: Record<string, string> = { pay: 'Check your pay', close: 'Close last month', plan: 'Give every pound a job', moves: 'Move the money', budgets: 'Set budgets', own: 'Your own steps', finish: 'Finish' };
const addMonthsClient = (m: string, n: number) => shiftMonth(m, n);

function shiftMonth(m: string, n: number) { const [y, mo] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mo - 1 + n, 1)); return d.toISOString().slice(0, 7); }

function Step({ k, n, title, summary, done, open, onToggle, optional, children }: { k: string; n: number | string; title: string; summary: string; done: boolean; open: boolean; onToggle: () => void; optional?: boolean; children: React.ReactNode }) {
  return (
    <section className={`pd-step ${done ? 'done' : ''} ${open ? 'open' : ''} ${optional ? 'optional' : ''}`} aria-labelledby={`pd-${k}`}>
      <button className="pd-step-head" onClick={onToggle} aria-expanded={open}>
        <span className="pd-num">{done ? <Icon name="check" size={15} /> : n}</span>
        <span className="grow"><strong id={`pd-${k}`}>{title}</strong><span className="muted small">{summary}</span></span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={18} />
      </button>
      {open && <div className="pd-step-body">{children}</div>}
    </section>
  );
}

function StepFoot({ onDone, label, done, onUndo, extra }: { onDone: () => void; label: string; done: boolean; onUndo: () => void; extra?: React.ReactNode }) {
  return (
    <div className="pd-foot">
      {extra}
      <span className="spacer" />
      {done ? <button className="link-btn small" onClick={onUndo}>Not done yet</button> : <button className="btn btn-primary" onClick={onDone}><Icon name="check" size={16} /> {label}</button>}
    </div>
  );
}

function PlanGroup({ title, total, items }: { title: string; total: number; items: { key: string; label: string; sub: string; amount: number; faded?: boolean; done?: boolean }[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="plan-group">
      <button className="plan-group-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} /><span className="grow">{title} <span className="muted small">({items.length})</span></span><strong>{money(total)}</strong>
      </button>
      {open && (
        <ul>
          {items.length === 0 && <li className="muted small">None</li>}
          {items.map((i) => (
            <li key={i.key} className={i.faded ? 'faded' : ''}>
              <span className="grow"><span className="ellipsis">{i.label}</span>{i.sub && <span className="muted small"> · {i.sub}</span>}</span>
              {i.done && <Badge tone="good">Paid</Badge>}
              <span className="nowrap">{money(i.amount)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BudgetEditor({ data, leftForBudgets, onSaved, done, onUndo }: { data: PaydayData; leftForBudgets: number; onSaved: () => void; done: boolean; onUndo: () => void }) {
  const { toast } = useApp();
  const [vals, setVals] = useState<Record<number, string>>({});
  useEffect(() => { setVals(Object.fromEntries(data.budgets.map((b) => [b.id, penceToInput(b.setLimit)]))); }, [data.cycle, data.budgets.map((b) => b.setLimit).join()]); // eslint-disable-line
  const perMonth = (b: PaydayData['budgets'][number], v: number) => (b.period === 'weekly' ? Math.round((v * 30.4) / 7) : b.period === 'annual' ? Math.round(v / 12) : v);
  const total = data.budgets.reduce((n, b) => n + perMonth(b, parseAmount(vals[b.id] ?? '') ?? b.setLimit), 0);
  const changed = data.budgets.filter((b) => (parseAmount(vals[b.id] ?? '') ?? b.setLimit) !== b.setLimit);
  async function save() {
    const limits: Record<number, number> = {};
    for (const b of changed) {
      const v = parseAmount(vals[b.id] ?? '');
      if (v == null || v <= 0) return toast(`Enter a limit for ${b.name}`, 'error');
      limits[b.id] = v;
    }
    try {
      if (changed.length) await api.post('/api/payday/budgets', { cycle: data.cycle, limits });
      toast(changed.length ? `${changed.length} budget${changed.length === 1 ? '' : 's'} updated for ${monthLabel(data.period)}` : 'Budgets kept as they are');
      onSaved();
    } catch (e: any) { toast(e.message, 'error'); }
  }
  const room = leftForBudgets - total;
  return (
    <>
      <table className="report-table pd-budgets">
        <thead><tr><th>Budget</th><th className="num hide-sm">Usually spent</th><th className="num">Limit</th><th /></tr></thead>
        <tbody>
          {data.budgets.map((b) => (
            <tr key={b.id}>
              <td><span className="row gap nowrap"><CatGlyph icon={b.icon} /><span className="ellipsis">{b.name}</span>{b.period !== 'monthly' && <span className="tag">{b.period}</span>}</span>
                {b.verdict === 'too-tight' && <span className="tone-warn small block">Over in {b.months - b.under} of {b.months} months</span>}
                {b.verdict === 'roomy' && <span className="muted small block">Usually well under</span>}</td>
              <td className="num hide-sm muted">{b.typical != null && b.months ? money(b.typical) : '–'}</td>
              <td className="num"><span className="amount-field compact"><span>£</span><input inputMode="decimal" value={vals[b.id] ?? ''} onChange={(e) => setVals({ ...vals, [b.id]: e.target.value })} aria-label={`${b.name} limit`} /></span></td>
              <td>{b.suggestion && (parseAmount(vals[b.id] ?? '') ?? 0) !== b.suggestion && <button className="link-btn small nowrap" onClick={() => setVals({ ...vals, [b.id]: penceToInput(b.suggestion!) })}>Use {money(b.suggestion)}</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className={`budget-room ${room >= 0 ? 'ok' : 'short'}`}>
        <span>Budgets total <strong>{money(total)}</strong> of the <strong>{money(leftForBudgets)}</strong> left after bills, debts and savings.</span>
        <strong>{room >= 0 ? `${money(room)} buffer` : `${money(-room)} over`}</strong>
      </div>
      <div className="pd-foot">
        <span className="muted small">Changes apply from {monthLabel(data.period)}; earlier months keep their limits.</span>
        <span className="spacer" />
        {done && !changed.length ? <button className="link-btn small" onClick={onUndo}>Not done yet</button>
          : <button className="btn btn-primary" onClick={save}><Icon name="check" size={16} /> {changed.length ? `Save ${changed.length} change${changed.length === 1 ? '' : 's'}` : 'Keep these budgets'}</button>}
      </div>
    </>
  );
}

function OwnSteps({ data, onCheck, onChange }: { data: PaydayData; onCheck: (key: string, done?: boolean) => void; onChange: () => void }) {
  const { toast } = useApp();
  const [text, setText] = useState('');
  async function add(e: React.FormEvent) {
    e.preventDefault();
    try { await api.post('/api/payday/items', { text }); setText(''); onChange(); } catch (err: any) { toast(err.message, 'error'); }
  }
  async function remove(id: number) { await api.del(`/api/payday/items/${id}`); onChange(); }
  return (
    <>
      {data.items.length > 0 && (
        <ul className="own-steps">
          {data.items.map((i) => (
            <li key={i.id}>
              <label className="check"><input type="checkbox" checked={i.done} onChange={(e) => onCheck(`item:${i.id}`, e.target.checked)} /><span className={i.done ? 'struck' : ''}>{i.text}</span></label>
              <button className="icon-btn" onClick={() => remove(i.id)} aria-label={`Remove “${i.text}”`}><Icon name="x" size={14} /></button>
            </li>
          ))}
        </ul>
      )}
      <form className="row gap" onSubmit={add}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Pay church, check my credit score" maxLength={120} aria-label="New step" style={{ flex: 1 }} />
        <button className="btn" type="submit" disabled={!text.trim()}><Icon name="plus" size={16} /> Add</button>
      </form>
      <p className="muted small">These repeat every payday.</p>
    </>
  );
}

/** Overview nudge, shown for the first ten days after payday until the routine's finished. */
export function PaydayCard() {
  const { data } = useData<{ cycle: string; period: string; daysSince: number; stepsDone: number; stepsTotal: number; completedAt: string | null; show: boolean }>(() => api.get('/api/payday/status'), []);
  if (!data?.show) return null;
  return (
    <button className="payday-card" onClick={() => navigate('/payday')}>
      <span className="payday-card-emoji">💷</span>
      <span className="grow">
        <strong>{data.daysSince === 0 ? "It's payday!" : `Payday was ${shortDate(data.cycle)}`}</strong>
        <span className="small">Run your payday routine for {monthLabel(data.period)} · {data.stepsDone} of {data.stepsTotal} steps done</span>
      </span>
      <span className="btn btn-primary btn-sm">{data.stepsDone ? 'Carry on' : 'Start'}</span>
    </button>
  );
}
