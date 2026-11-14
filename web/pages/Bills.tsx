import React, { useState } from 'react';
import { api, qs, type Occurrence, type Plan, type Recurring, type Suggestion } from '../api.ts';
import { FREQUENCY_LABELS, privateLabel, addMonths, dayMonth, money, monthLabel, pct, relativeDay, shortDate } from '../format.ts';
import { Badge, Bubble, Card, Empty, Modal, Money, Stat, useApp, useData } from '../components/ui.tsx';
import { Icon } from '../components/Icon.tsx';
import { RecurringForm, type RecurringDraft } from '../components/RecurringForm.tsx';

const TYPE_ICON: Record<string, string> = { bill: 'bolt', subscription: 'repeat', saving: 'piggy-bank', income: 'briefcase' };
const TYPE_COLOUR: Record<string, string> = { bill: '#eab308', subscription: '#6366f1', saving: '#0ea5e9', income: '#059669' };

export function Bills() {
  const { meta, categories } = useApp();
  const { data: items } = useData<Recurring[]>(() => api.get('/api/recurring'), []);
  const { data: monthItems } = useData<Occurrence[]>(() => api.get(`/api/upcoming${qs({ month: meta.currentMonth })}`), []);
  const [day, setDay] = useState<string | null>(null);
  const { data: plan } = useData<Plan>(() => api.get(`/api/plan${qs({ month: meta.currentMonth })}`), []);
  const { data: suggestions } = useData<Suggestion[]>(() => api.get('/api/recurring/suggestions'), []);
  const [editing, setEditing] = useState<{ item?: Recurring; draft?: RecurringDraft } | null>(null);
  const [paying, setPaying] = useState<Occurrence | null>(null);
  const [showSuggestions, setShowSuggestions] = useState(false);

  if (!items || !monthItems || !plan) return <div className="loading" />;
  // The rest of this month: anything due from today, plus anything still unpaid from earlier.
  const upcoming = monthItems.filter((o) => (day ? o.dueDate === day : o.dueDate >= meta.today || o.status === 'overdue' || o.status === 'due'));
  const leftOut = monthItems.filter((o) => o.type !== 'income' && o.dueDate >= meta.today && o.status !== 'paid' && o.status !== 'skipped').reduce((s, o) => s + o.expected, 0);

  const groups: { type: Recurring['type']; title: string }[] = [
    { type: 'bill', title: 'Bills' }, { type: 'subscription', title: 'Subscriptions' },
    { type: 'saving', title: 'Savings and debt repayments' }, { type: 'income', title: 'Income' },
  ];
  const rises = items.filter((i) => i.active && i.type !== 'income' && i.lastChange && i.lastChange.to > i.lastChange.from && i.lastChange.date >= addDaysIso(meta.today, -120));

  return (
    <div className="page">
      <div className="stats">
        <Stat label="Committed this month" value={<Money value={plan.committed} />}
          sub={plan.committedShare != null ? `${pct(plan.committedShare)} of income · bills, savings${plan.debtTotal ? ', debts' : ''}` : 'Bills and savings due'} />
        <Stat label="Still to pay" value={<Money value={plan.billsRemaining} />} sub={`${money(plan.billsPaid, { compact: true })} of ${money(plan.billsTotal, { compact: true })} bills paid`} />
        <Stat label="Regular costs per month" value={<Money value={plan.monthly.bills + plan.monthly.subscriptions} />}
          sub={`${money(plan.monthly.subscriptions, { compact: true })} subscriptions · annual bills spread out`} />
        <Stat label="Income this month" value={<Money value={plan.incomeExpected} />}
          sub={`${money(plan.incomeReceived, { compact: true })} received${plan.incomeExtra > 0 ? ` · incl. ${money(plan.incomeExtra, { compact: true })} above usual pay` : ''}`} />
      </div>

      {rises.length > 0 && (
        <div className="banner banner-warn" style={{ cursor: 'default' }}>
          <Icon name="trending-up" size={16} />
          <span>{rises.map((r) => `${r.name} went up from ${money(r.lastChange!.from)} to ${money(r.lastChange!.to)}`).join(' · ')}</span>
        </div>
      )}
      {suggestions && suggestions.length > 0 && (
        <button className="banner banner-info" onClick={() => setShowSuggestions(true)}>
          <Icon name="sparkles" size={16} />
          <span>Found {suggestions.length} regular payment{suggestions.length === 1 ? '' : 's'} in your transactions that aren't tracked yet</span>
          <Icon name="chevron-right" size={16} />
        </button>
      )}

      <div className="grid-main">
        <Card className="fit-row" title={day ? `Due ${shortDate(day)}` : `Rest of ${monthLabel(meta.currentMonth)}`} pad={false}
          action={<span className="due-head-actions">
            {day
              ? <button className="link-btn" onClick={() => setDay(null)}>Show the rest of the month</button>
              : <span className="muted small">{money(leftOut)} still to go out</span>}
            <button className="btn btn-sm btn-primary" onClick={() => setEditing({})}><Icon name="plus" size={14} /> Add</button>
          </span>}>
          {upcoming.length === 0 ? (
            day
              ? <Empty icon="calendar" title="Nothing due that day" />
              : items.length === 0
                ? <Empty icon="calendar" title="Nothing due">Add your bills, subscriptions and salary to see what's coming.</Empty>
                : <Empty icon="check" title="All done for this month">Nothing else is due before the end of {monthLabel(meta.currentMonth)}.</Empty>
          ) : (
            <ul className="due-list fit-scroll">
              {upcoming.map((o) => {
                const dm = dayMonth(o.dueDate);
                const done = o.status === 'paid' || o.status === 'skipped';
                return (
                  <li key={`${o.recurringId}-${o.dueDate}`} className={`due status-${o.status}`}>
                    <span className="due-date"><strong>{dm.day}</strong><span>{dm.month}</span></span>
                    <Bubble colour={o.categoryColour ?? TYPE_COLOUR[o.type]} icon={o.categoryIcon ?? TYPE_ICON[o.type]} size={34} />
                    <span className="grow">
                      <span className="due-name">{o.name}</span>
                      <span className="muted small">{o.accountName} · {o.status === 'paid' && o.paidDate ? `paid ${shortDate(o.paidDate)}` : relativeDay(o.dueDate, meta.today)}</span>
                    </span>
                    <StatusBadge o={o} />
                    <span className={`money due-amt ${o.type === 'income' ? 'amt-in' : ''}`}>
                      {o.type === 'income' ? '+' : ''}{money(done && o.paidAmount != null ? o.paidAmount : o.expected)}
                    </span>
                    <button className="btn btn-sm" onClick={() => setPaying(o)}>{done ? 'Change' : o.type === 'income' ? 'Received' : 'Paid'}</button>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <BillCalendar today={meta.today} current={meta.currentMonth} selected={day} onSelect={(d) => setDay(d === day ? null : d)} />
      </div>

      <Card title="This month" className="plan-wide">
        <PlanBreakdown plan={plan} />
      </Card>

      {groups.map((g) => {
        const list = items.filter((i) => i.type === g.type);
        if (list.length === 0 && g.type !== 'income') return null;
        if (list.length === 0 && items.length === 0) return null;
        const total = list.filter((i) => i.active).reduce((s, i) => s + i.monthlyNet, 0);
        const anyShared = list.some((i) => i.active && i.sharedBack > 0);
        return (
          <Card key={g.type} title={g.title} pad={false} action={
            g.type === 'income'
              ? <span className="row gap"><span className="muted small">{money(total)} a month regular pay</span>
                  <button className="btn btn-sm" onClick={() => setEditing({ draft: { type: 'income', oneOff: true, name: 'Bonus', categoryId: categories.find((c) => c.name === 'Bonuses')?.id ?? null } })}><Icon name="plus" size={14} /> Expected bonus</button></span>
              : <span className="muted small">{money(total)} a month{anyShared ? ' (your share)' : ''}</span>}>
            <table className="rec-table">
              <thead><tr><th>Name</th><th>How often</th><th className="num">Amount</th><th className="num">Per month</th><th>Next due</th><th>Account</th></tr></thead>
              <tbody>
                {list.map((i) => (
                  <tr key={i.id} onClick={() => setEditing({ item: i })} className={i.active ? '' : 'is-inactive'}>
                    <td>
                      <span className="rec-name">
                        <Bubble colour={i.categoryColour ?? TYPE_COLOUR[i.type]} icon={i.categoryIcon ?? TYPE_ICON[i.type]} size={30} />
                        <span>{i.name}
                          {i.lastChange && i.lastChange.to > i.lastChange.from && <Badge tone="warn">↑ {money(i.lastChange.to - i.lastChange.from)}</Badge>}
                          {!i.active && <Badge>Cancelled</Badge>}
                          {i.variable && <span className="tag">Varies</span>}
                          {i.oneOff && <span className="tag">One-off</span>}
                          {i.active && i.sharedBack > 0 && <SharedTag i={i} />}
                          {i.type === 'income' && i.extrasThisYear > 0 && <Badge tone="good">+{money(i.extrasThisYear, { compact: true })} extra this year</Badge>}
                        </span>
                      </span>
                    </td>
                    <td className="muted">{i.oneOff ? 'Once' : FREQUENCY_LABELS[i.frequency]}{i.schedule === 'last_working_day' ? ', last working day' : ''}</td>
                    <td className="num">{i.sharedBack > 0
                      ? <span className="shared-amt"><span>{money(i.yourShare)}</span><span className="muted small">of {money(i.amount)}</span></span>
                      : money(i.amount)}</td>
                    <td className="num muted">{i.frequency === 'monthly' || i.oneOff ? '' : money(i.monthlyNet)}</td>
                    <td>{i.next ? <>{shortDate(i.next.dueDate)} {i.next.status === 'overdue' && <Badge tone="bad">Overdue</Badge>}</> : '—'}</td>
                    <td className="muted">{i.type === 'saving' ? `${i.accountName} → ${i.transferAccountName}` : i.accountName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        );
      })}

      {items.length === 0 && (
        <Card><Empty icon="repeat" title="Track your regular payments">Add rent, council tax, utilities, subscriptions, your salary and regular savings. Payments are matched to your transactions automatically.</Empty></Card>
      )}

      {editing && <RecurringForm item={editing.item} draft={editing.draft} onClose={() => setEditing(null)} />}
      {paying && <PaymentModal o={paying} onClose={() => setPaying(null)} />}
      {showSuggestions && suggestions && (
        <SuggestionsModal suggestions={suggestions} onClose={() => setShowSuggestions(false)} onAdd={(s) => { setShowSuggestions(false); setEditing({ draft: s }); }} />
      )}
    </div>
  );
}

/** "Shared · 4 of 5 paid" for the latest due date that has started collecting. */
function SharedTag({ i }: { i: Recurring }) {
  const { meta } = useApp();
  // Most recent due date on or before today, else the next one.
  const c = i.shareCycles.find((x) => x.dueDate <= meta.today) ?? i.shareCycles[0];
  if (!c) return null;
  const all = c.paidCount === i.shares.length;
  return <span className={`tag ${all ? 'tag-good' : ''}`} title={`${shortDate(c.dueDate)}: ${c.people.filter((p) => p.paid > 0).map((p) => p.name).join(', ') || 'nobody yet'}`}>
    Shared · {c.paidCount}/{i.shares.length} paid {shortDate(c.dueDate)}
  </span>;
}

function StatusBadge({ o }: { o: Occurrence }) {
  switch (o.status) {
    case 'paid': return <Badge tone="good"><Icon name="check" size={12} /> {o.type === 'income' ? 'Received' : 'Paid'}</Badge>;
    case 'skipped': return <Badge>Skipped</Badge>;
    case 'overdue': return <Badge tone="bad">Overdue</Badge>;
    case 'due': return <Badge tone="warn">Due</Badge>;
    default: return <Badge tone="info">Upcoming</Badge>;
  }
}

export function PlanBreakdown({ plan }: { plan: Plan }) {
  const income = Math.max(plan.incomeExpected, 1);
  const parts = [
    { label: 'Bills and subscriptions', value: plan.billsTotal, colour: '#eab308', sub: `${money(plan.billsPaid, { compact: true })} paid` },
    { label: 'Savings', value: plan.savingsTotal, colour: '#0ea5e9', sub: `${money(plan.savingsDone, { compact: true })} moved` },
    ...(plan.debtTotal > 0 ? [{ label: 'Debt repayments', value: plan.debtTotal, colour: 'var(--bad)', sub: `${money(plan.debtDone, { compact: true })} paid` }] : []),
    { label: 'Everyday spending so far', value: Math.max(0, plan.otherSpending), colour: 'var(--spend)' },
  ];
  const free = plan.freeToSpend;
  return (
    <div className="plan">
      <div className="plan-head">
        <span className="muted small">Income this month</span>
        <Money value={plan.incomeExpected} className="strong" />
      </div>
      <div className="plan-bar" aria-hidden="true">
        {parts.map((p) => <span key={p.label} style={{ width: `${Math.min(100, (p.value / income) * 100)}%`, background: p.colour }} />)}
      </div>
      <ul className="plan-list">
        {parts.map((p) => (
          <li key={p.label}><i style={{ background: p.colour }} /><span className="grow">{p.label}{p.sub && <span className="muted small plan-sub">{p.sub}</span>}</span><Money value={p.value} /></li>
        ))}
        <li className="plan-free"><i style={{ background: free >= 0 ? 'var(--good)' : 'var(--bad)' }} /><span className="grow"><strong>{privateLabel(free >= 0, 'Free to spend', 'Over budget', 'After bills and spending')}</strong></span><Money value={Math.abs(free)} className={free >= 0 ? 'tone-good strong' : 'tone-bad strong'} /></li>
      </ul>
    </div>
  );
}

function PaymentModal({ o, onClose }: { o: Occurrence; onClose: () => void }) {
  const { refresh, toast } = useApp();
  const done = o.status === 'paid' || o.status === 'skipped';
  const [mode, setMode] = useState<'record' | 'mark' | 'skip'>(o.status === 'skipped' ? 'skip' : 'mark');
  const [amount, setAmount] = useState((o.paidAmount ?? o.expected) / 100 + '');
  const [error, setError] = useState<string | null>(null);

  async function save(status: 'paid' | 'skipped' | 'unpaid') {
    try {
      const pence = Math.round(Number(amount) * 100);
      const body: any = { dueDate: o.dueDate, status };
      if (status === 'paid' && mode === 'record') body.record = { amount: pence > 0 ? pence : undefined };
      await api.post(`/api/recurring/${o.recurringId}/payment`, body);
      toast(status === 'unpaid' ? 'Marked as not paid' : status === 'skipped' ? 'Skipped' : 'Marked as paid');
      refresh();
      onClose();
    } catch (e: any) { setError(e.message); }
  }

  return (
    <Modal title={`${o.name} · ${shortDate(o.dueDate)}`} onClose={onClose}
      footer={<>
        {done && <button className="btn btn-ghost" onClick={() => save('unpaid')}><Icon name="undo" size={16} /> Mark as not {o.type === 'income' ? 'received' : 'paid'}</button>}
        <span className="spacer" />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={() => save(mode === 'skip' ? 'skipped' : 'paid')}>Save</button>
      </>}>
      <div className="form">
        {o.status === 'paid' && o.transactionId && <p className="hint-box"><Icon name="link" size={16} />Linked to a {money(o.paidAmount ?? 0)} transaction on {shortDate(o.paidDate!)}.</p>}
        <label className="check"><input type="radio" name="m" checked={mode === 'mark'} onChange={() => setMode('mark')} />
          <span><strong>Mark as {o.type === 'income' ? 'received' : 'paid'}</strong><br /><span className="muted small">It'll be matched automatically when you import the bank statement.</span></span></label>
        <label className="check"><input type="radio" name="m" checked={mode === 'record'} onChange={() => setMode('record')} />
          <span><strong>Also record the transaction now</strong><br /><span className="muted small">For cash or accounts you don't import. A later import will link to it, not duplicate it.</span></span></label>
        {mode === 'record' && (
          <div className="amount-field" style={{ maxWidth: 200 }}><span>£</span><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount" /></div>
        )}
        <label className="check"><input type="radio" name="m" checked={mode === 'skip'} onChange={() => setMode('skip')} />
          <span><strong>Skip this one</strong><br /><span className="muted small">Not due this time (a payment holiday, or paid another way).</span></span></label>
        {error && <p className="form-error">{error}</p>}
      </div>
    </Modal>
  );
}

function SuggestionsModal({ suggestions, onClose, onAdd }: { suggestions: Suggestion[]; onClose: () => void; onAdd: (s: Suggestion) => void }) {
  const { accounts } = useApp();
  return (
    <Modal title="Regular payments found" onClose={onClose} wide>
      <p className="muted" style={{ marginBottom: 12 }}>These repeat in your transactions. Add the ones you want to track. You can check and edit the details before saving.</p>
      <ul className="history-list">
        {suggestions.map((s) => (
          <li key={`${s.accountId}-${s.matchPattern}`}>
            <span className="grow"><strong>{s.name}</strong> <span className="muted small">· {FREQUENCY_LABELS[s.frequency].toLowerCase()} · {s.count} payments · {accounts.find((a) => a.id === s.accountId)?.name}{s.categoryName ? ` · ${s.categoryName}` : ''}</span></span>
            <span className="money">{s.variable ? '~' : ''}{money(s.amount)}</span>
            <button className="btn btn-sm" onClick={() => onAdd(s)}><Icon name="plus" size={14} /> Add</button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

function addDaysIso(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

/** Month grid of what's due each day. Steps through months; picking a day in this month filters the list. */
function BillCalendar({ today, current, selected, onSelect }: { today: string; current: string; selected: string | null; onSelect: (d: string) => void }) {
  const [month, setMonth] = useState(current);
  const { data } = useData<Occurrence[]>(() => api.get(`/api/upcoming${qs({ month })}`), [month]);
  const byDay = new Map<string, Occurrence[]>();
  for (const o of data ?? []) {
    if (!o.dueDate.startsWith(month)) continue;
    byDay.set(o.dueDate, [...(byDay.get(o.dueDate) ?? []), o]);
  }
  const [y, m] = month.split('-').map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7; // Monday first
  const cells: (string | null)[] = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)];
  while (cells.length % 7) cells.push(null);
  const out = [...byDay.values()].flat().filter((o) => o.type !== 'income').reduce((s, o) => s + (o.paidAmount ?? o.expected), 0);
  const inn = [...byDay.values()].flat().filter((o) => o.type === 'income').reduce((s, o) => s + (o.paidAmount ?? o.expected), 0);

  return (
    <Card title="Calendar" action={
      <span className="month-step">
        <button className="icon-btn" onClick={() => setMonth(addMonths(month, -1))} aria-label="Previous month"><Icon name="chevron-left" size={16} /></button>
        <span className="small strong">{monthLabel(month)}</span>
        <button className="icon-btn" onClick={() => setMonth(addMonths(month, 1))} aria-label="Next month"><Icon name="chevron-right" size={16} /></button>
      </span>
    }>
      <div className="cal" role="grid" aria-label={`Bills in ${monthLabel(month)}`}>
        {WEEKDAYS.map((w, i) => <span key={i} className="cal-wd">{w}</span>)}
        {cells.map((d, i) => {
          if (!d) return <span key={i} className="cal-cell empty" />;
          const list = byDay.get(d) ?? [];
          const total = list.filter((o) => o.type !== 'income').reduce((s, o) => s + (o.paidAmount ?? o.expected), 0);
          const income = list.some((o) => o.type === 'income');
          const allDone = list.length > 0 && list.every((o) => o.status === 'paid' || o.status === 'skipped');
          const late = list.some((o) => o.status === 'overdue');
          const clickable = month === current && list.length > 0;
          return (
            <button key={d} type="button" disabled={!clickable}
              className={`cal-cell ${d === today ? 'today' : ''} ${d < today ? 'past' : ''} ${d === selected ? 'on' : ''} ${list.length ? 'has' : ''} ${allDone ? 'done' : ''} ${late ? 'late' : ''}`}
              title={list.map((o) => `${o.name}: ${money(o.paidAmount ?? o.expected)}${o.status === 'paid' ? ' (paid)' : ''}`).join('\n') || undefined}
              onClick={() => clickable && onSelect(d)}>
              <span className="cal-day">{Number(d.slice(8))}</span>
              {list.length > 0 && (
                <span className="cal-dots">{list.slice(0, 4).map((o, j) => <i key={j} style={{ background: o.categoryColour ?? TYPE_COLOUR[o.type] }} />)}</span>
              )}
              {income ? <span className="cal-amt amt-in">Payday</span> : total > 0 ? <span className="cal-amt">{money(total, { compact: true })}</span> : null}
            </button>
          );
        })}
      </div>
      <div className="cal-foot small">
        <span className="muted">{money(out)} out{inn ? <> · <span className="amt-in">{money(inn)}</span> in</> : null}</span>
        <span className="muted">{month === current ? 'Tap a day to see what\'s due' : ''}</span>
      </div>
    </Card>
  );
}
