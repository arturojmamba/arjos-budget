import React, { useEffect, useState } from 'react';
import { api, qs } from '../api.ts';
import { money, monthLabel, parseAmount, penceToInput, shortDate } from '../format.ts';
import { AccountSelect, Badge, Bubble, Card, Empty, Field, Modal, Money, Segmented, Stat, useApp, useConfirm, useData } from '../components/ui.tsx';
import { Icon } from '../components/Icon.tsx';
import { navigate } from '../router.ts';
import { EmojiPicker } from './Categories.tsx';

type Status = 'done' | 'on_track' | 'behind' | 'no_target';
export interface Goal {
  id: number; name: string; icon: string | null; colour: string; mode: 'rest' | 'share'; archived: boolean; notes: string | null;
  account: { id: number; name: string; type: string; colour: string } | null;
  target: number | null; deadline: string | null; monthlyTarget: number | null; monthlyPercent: number | null; monthlyFixed: number | null;
  isEmergency: boolean; completedAt: string | null;
  saved: number; balance: number; progress: number | null; thisMonth: number; avg3: number;
  remaining: number | null; monthsLeft: number | null; neededPerMonth: number | null; eta: string | null; status: Status;
  contributed: number | null; growth: number | null; coverMonths: number | null;
  history: { month: string; saved: number; added: number }[];
}
interface GoalAccount { id: number; name: string; type: string; colour: string; balance: number; setAside: number; unassigned: number; overAssigned: number; hasRest: boolean }
export interface GoalList {
  goals: Goal[]; accounts: GoalAccount[];
  withoutGoals: { id: number; name: string; type: string; colour: string; balance: number }[];
  essentials: number; takeHome: number | null;
  totals: { saved: number; target: number; thisMonth: number; monthlyTarget: number; done: number; count: number };
}

const TYPE_LABEL: Record<string, string> = { savings: 'Savings', pot: 'Pot', investment: 'Investing', current: 'Current account', cash: 'Cash' };
const pctText = (bp: number) => `${(bp / 100).toFixed(bp % 100 === 0 ? 0 : 1)}%`;

export function Goals() {
  const { meta } = useApp();
  const [showArchived, setShowArchived] = useState(false);
  const { data, error } = useData<GoalList>(() => api.get(`/api/goals${qs({ archived: showArchived ? 1 : undefined })}`), [showArchived]);
  const [editing, setEditing] = useState<Goal | { accountId?: number; name?: string; emergency?: boolean } | null>(null);
  const [moving, setMoving] = useState<Goal | null>(null);

  if (error) return <Empty icon="alert" title="Couldn't load goals">{error}</Empty>;
  if (!data) return <div className="loading" />;
  const live = data.goals.filter((g) => !g.archived);
  const archived = data.goals.filter((g) => g.archived);
  const t = data.totals;

  return (
    <div className="page">
      <div className="stats">
        <Stat label="In your goals" value={<Money value={t.saved} />} sub={t.target ? `of ${money(t.target, { compact: true })} in targets` : `${t.count} goal${t.count === 1 ? '' : 's'}`} />
        <Stat label={`Added in ${monthLabel(meta.currentMonth, true)}`} value={<Money value={t.thisMonth} />} tone={t.thisMonth >= 0 ? 'good' : 'bad'}
          sub={t.monthlyTarget ? `${money(t.monthlyTarget, { compact: true })} a month planned` : 'Set monthly amounts to plan ahead'} />
        <Stat label="Goals reached" value={<span>{t.done} <span className="muted small">of {live.filter((g) => g.target).length}</span></span>} sub="Goals with a target" />
        <Stat label="Essentials a month" value={<Money value={data.essentials} />} sub="Rent, bills, groceries, transport (3-month average)" />
      </div>

      <div className="row gap" style={{ justifyContent: 'space-between' }}>
        <p className="muted small">Goals follow the real balance of the account they're in. One account can hold several goals.</p>
        <button className="btn btn-primary" onClick={() => setEditing({})}><Icon name="plus" size={16} /> New goal</button>
      </div>

      {live.length === 0 && (
        <Card><Empty icon="piggy-bank" title="No goals yet">
          Give your savings a purpose: an emergency fund, a holiday, a house deposit. Progress updates on its own as you import.
        </Empty></Card>
      )}

      {data.accounts.map((a) => {
        const goals = live.filter((g) => g.account?.id === a.id);
        if (!goals.length) return null;
        return (
          <section key={a.id} className="stack" style={{ gap: 12 }}>
            <div className="goal-acct-head">
              <span className="acct-colour" style={{ background: a.colour, height: 22 }} />
              <h2>{a.name}</h2>
              <span className="muted small">{TYPE_LABEL[a.type] ?? a.type} · <Money value={a.balance} /></span>
              {goals.length > 1 || a.setAside > 0 ? <span className="muted small">· {money(a.setAside)} set aside</span> : null}
              {a.unassigned > 0 && <Badge tone="info">{money(a.unassigned)} not in a goal</Badge>}
              {a.overAssigned > 0 && <Badge tone="bad">{money(a.overAssigned)} more set aside than is in the account</Badge>}
              <span className="spacer" />
              <button className="btn btn-sm" onClick={() => setEditing({ accountId: a.id })}><Icon name="plus" size={14} /> Add a goal here</button>
            </div>
            <div className="goal-grid">
              {goals.map((g) => <GoalCard key={g.id} g={g} essentials={data.essentials} onEdit={() => setEditing(g)} onMove={() => setMoving(g)} />)}
            </div>
          </section>
        );
      })}

      {data.withoutGoals.length > 0 && (
        <Card title="Savings without a goal">
          <p className="muted small" style={{ marginBottom: 10 }}>Turn one into a goal to track it here.</p>
          <div className="row gap" style={{ flexWrap: 'wrap' }}>
            {data.withoutGoals.map((a) => (
              <button key={a.id} className="chip-btn" onClick={() => setEditing({ accountId: a.id, name: a.name, emergency: /emergency/i.test(a.name) })}>
                <span className="dot" style={{ background: a.colour }} />{a.name} · {money(a.balance)} <Icon name="plus" size={14} />
              </button>
            ))}
          </div>
        </Card>
      )}

      <div>
        <button className="link-btn small" onClick={() => setShowArchived(!showArchived)}>{showArchived ? 'Hide finished and archived goals' : 'Show finished and archived goals'}</button>
        {showArchived && (archived.length === 0 ? <p className="muted small">None yet.</p> : (
          <div className="goal-grid" style={{ marginTop: 12 }}>
            {archived.map((g) => <GoalCard key={g.id} g={g} essentials={data.essentials} onEdit={() => setEditing(g)} onMove={() => setMoving(g)} />)}
          </div>
        ))}
      </div>

      {editing && <GoalForm goal={'id' in editing ? editing : null} preset={'id' in editing ? undefined : editing} list={data} onClose={() => setEditing(null)} />}
      {moving && <MoveModal g={moving} list={data} onClose={() => setMoving(null)} />}
    </div>
  );
}

function Ring({ value, colour, size = 64, children }: { value: number; colour: string; size?: number; children?: React.ReactNode }) {
  const r = 26, c = 2 * Math.PI * r;
  return (
    <span className="ring" style={{ width: size, height: size }}>
      <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
        <circle cx="32" cy="32" r={r} fill="none" stroke="var(--surface-2)" strokeWidth="7" />
        <circle cx="32" cy="32" r={r} fill="none" stroke={colour} strokeWidth="7" strokeLinecap="round"
          strokeDasharray={`${Math.max(0, Math.min(1, value)) * c} ${c}`} transform="rotate(-90 32 32)" />
      </svg>
      <span className="ring-inner">{children}</span>
    </span>
  );
}

function GoalCard({ g, essentials, onEdit, onMove }: { g: Goal; essentials: number; onEdit: () => void; onMove: () => void }) {
  const { meta } = useApp();
  const maxHist = Math.max(1, ...g.history.map((h) => Math.max(h.saved, g.target ?? 0)));
  const hist = g.history.slice(-6);
  let pace: React.ReactNode = null;
  if (g.status === 'done') pace = <span className="tone-good">Reached{g.completedAt ? ` on ${shortDate(g.completedAt)}` : ''} 🎉</span>;
  else if (g.target && g.deadline && g.neededPerMonth != null) {
    pace = g.status === 'behind'
      ? <span className="tone-warn">Needs {money(g.neededPerMonth)} a month to reach it by {shortDate(g.deadline)}{g.avg3 > 0 ? ` (you've averaged ${money(g.avg3, { compact: true })})` : ''}</span>
      : <span>{money(g.neededPerMonth)} a month gets you there by {shortDate(g.deadline)}</span>;
  } else if (g.target && g.eta) pace = <span>At this pace, there by <strong>{monthLabel(g.eta)}</strong></span>;
  else if (g.target) pace = <span className="muted">Add money regularly to see when you'll get there</span>;
  else pace = g.avg3 > 0 ? <span>Averaging {money(g.avg3)} a month</span> : <span className="muted">No target set</span>;

  const monthPct = g.monthlyTarget ? Math.max(0, Math.min(1, g.thisMonth / g.monthlyTarget)) : null;

  return (
    <div className={`card card-pad goal-card ${g.status === 'done' ? 'goal-done' : ''} ${g.archived ? 'is-archived' : ''}`}>
      <div className="goal-top">
        <Ring value={g.progress ?? (g.saved > 0 ? 1 : 0)} colour={g.colour}><span className="goal-emoji">{g.icon ?? '🎯'}</span></Ring>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="budget-name">{g.name}
            {g.status === 'done' && <Badge tone="good">Done</Badge>}
            {g.status === 'behind' && <Badge tone="warn">Behind</Badge>}
            {g.isEmergency && <Badge tone="info">Emergency fund</Badge>}
            {g.archived && <Badge>Archived</Badge>}
          </div>
          <div className="budget-cats">{g.mode === 'share' ? 'Money set aside' : g.account && g.saved !== g.balance ? 'Rest of the account' : 'Whole account'}{g.deadline ? ` · by ${shortDate(g.deadline)}` : ''}</div>
          <div className="goal-figures">
            <Money value={g.saved} className="goal-saved" />
            {g.target ? <span className="muted small">of {money(g.target)} · {Math.round((g.progress ?? 0) * 100)}%</span> : null}
          </div>
        </div>
      </div>

      {g.target != null && (
        <div className="milestones" aria-hidden="true">
          {[0.25, 0.5, 0.75, 1].map((m) => <span key={m} className={(g.progress ?? 0) >= m ? 'hit' : ''} style={(g.progress ?? 0) >= m ? { background: g.colour } : undefined}>{m === 1 ? '🏁' : `${m * 100}%`}</span>)}
        </div>
      )}

      <div className="goal-month">
        <div className="row gap" style={{ justifyContent: 'space-between' }}>
          <span className="small">Added in {monthLabel(meta.currentMonth, true)}: <Money value={g.thisMonth} className={g.thisMonth > 0 ? 'amt-saved strong' : g.thisMonth < 0 ? 'tone-bad strong' : 'strong'} /></span>
          {g.monthlyTarget ? <span className="muted small">of {money(g.monthlyTarget)}{g.monthlyPercent ? ` (${pctText(g.monthlyPercent)} of pay)` : ''}</span> : null}
        </div>
        {monthPct != null && <div className="progress"><span className="progress-good" style={{ width: `${monthPct * 100}%`, background: g.colour }} /></div>}
      </div>

      <p className="small goal-pace">{pace}</p>
      {g.growth != null && (
        <p className="small muted">Paid in {money(g.contributed ?? 0)} · growth <span className={g.growth >= 0 ? 'tone-good' : 'tone-bad'}>{money(g.growth, { sign: true })}</span></p>
      )}
      {g.coverMonths != null && (
        <p className="small muted">Covers <strong className={g.coverMonths >= 3 ? 'tone-good' : 'tone-warn'}>{g.coverMonths.toFixed(1)} months</strong> of essentials ({money(essentials, { compact: true })} a month). 3–6 months is the usual aim.</p>
      )}

      <div className="mini-bars" aria-label="Saved at the end of each month">
        {hist.map((h, i) => (
          <div key={h.month} className="mini-bar" title={`${monthLabel(h.month)}: ${money(h.saved)}${h.added ? ` (${money(h.added, { sign: true })} added)` : ''}`}>
            {g.target && <span className="lim" style={{ bottom: `calc(${(g.target / maxHist) * 30}px + 16px)` }} />}
            <span className={`b ${i === hist.length - 1 ? 'cur' : ''}`} style={{ height: `${(Math.max(0, h.saved) / maxHist) * 30}px`, background: g.colour }} />
            <i>{monthLabel(h.month, true)}</i>
          </div>
        ))}
      </div>

      <div className="budget-foot">
        <span className="row gap">
          {g.mode === 'share' && !g.archived && <button className="btn btn-sm" onClick={onMove}><Icon name="transfer" size={14} /> Add or take out</button>}
          {g.account && <button className="link-btn small" onClick={() => navigate(`/transactions${qs({ accountId: g.account!.id, month: 'all' })}`)}>Transactions</button>}
        </span>
        <button className="link-btn small" onClick={onEdit}>Edit</button>
      </div>
    </div>
  );
}

function GoalForm({ goal, preset, list, onClose }: { goal: Goal | null; preset?: { accountId?: number; name?: string; emergency?: boolean }; list: GoalList; onClose: () => void }) {
  const { accounts, refresh, toast } = useApp();
  const [confirm, confirmNode] = useConfirm();
  const [name, setName] = useState(goal?.name ?? preset?.name ?? '');
  const [icon, setIcon] = useState<string | null>(goal?.icon ?? (preset?.emergency ? '🛡️' : '🎯'));
  const [accountId, setAccountId] = useState<number | null>(goal?.account?.id ?? preset?.accountId ?? null);
  const acctInfo = list.accounts.find((a) => a.id === accountId);
  const others = list.goals.filter((g) => !g.archived && g.account?.id === accountId && g.id !== goal?.id);
  const restTaken = others.some((g) => g.mode === 'rest');
  const [mode, setMode] = useState<'rest' | 'share'>(goal?.mode ?? 'rest');
  useEffect(() => { if (!goal) setMode(restTaken ? 'share' : 'rest'); }, [accountId]); // eslint-disable-line
  const [target, setTarget] = useState(goal?.target ? penceToInput(goal.target) : '');
  const [deadline, setDeadline] = useState(goal?.deadline ?? '');
  const [monthlyMode, setMonthlyMode] = useState<'none' | 'amount' | 'percent'>(goal?.monthlyPercent ? 'percent' : goal?.monthlyFixed ? 'amount' : 'none');
  const [monthly, setMonthly] = useState(goal?.monthlyFixed ? penceToInput(goal.monthlyFixed) : '');
  const [percent, setPercent] = useState(goal?.monthlyPercent ? String(goal.monthlyPercent / 100) : '');
  const [emergency, setEmergency] = useState(goal?.isEmergency ?? preset?.emergency ?? false);
  const [startWith, setStartWith] = useState('');
  const [notes, setNotes] = useState(goal?.notes ?? '');
  const [error, setError] = useState<string | null>(null);

  const saved = goal?.saved ?? 0;
  const tgt = parseAmount(target);
  const monthsTo = deadline ? Math.max(1, monthsBetweenClient(new Date().toISOString().slice(0, 7), deadline.slice(0, 7)) + 1) : null;
  const neededHint = tgt && monthsTo ? `${money(Math.ceil(Math.max(0, tgt - saved) / monthsTo))} a month gets you there` : null;
  const freeNow = acctInfo ? (acctInfo.hasRest ? (list.goals.find((g) => g.account?.id === accountId && g.mode === 'rest')?.saved ?? 0) : acctInfo.unassigned)
    : accounts.find((a) => a.id === accountId)?.balance ?? 0;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const body = {
      name, icon, accountId, mode, target: target ? parseAmount(target) : null, deadline: deadline || null,
      monthlyTarget: monthlyMode === 'amount' ? parseAmount(monthly) : null,
      monthlyPercent: monthlyMode === 'percent' ? Math.round(Number(percent) * 100) : null,
      isEmergency: emergency, notes, startWith: !goal && mode === 'share' ? parseAmount(startWith || '0') || null : null,
    };
    if (target && !body.target) return setError('Enter the target, e.g. 5000');
    if (monthlyMode === 'amount' && !body.monthlyTarget) return setError('Enter the monthly amount');
    if (monthlyMode === 'percent' && !(body.monthlyPercent! > 0)) return setError('Enter a percentage, e.g. 10');
    try {
      if (goal) await api.put(`/api/goals/${goal.id}`, body);
      else await api.post('/api/goals', body);
      toast(goal ? 'Goal updated' : 'Goal added');
      refresh();
      onClose();
    } catch (err: any) { setError(err.message); }
  }
  async function archive() {
    if (!goal) return;
    await api.put(`/api/goals/${goal.id}`, { archived: !goal.archived });
    toast(goal.archived ? 'Goal restored' : 'Goal archived');
    refresh();
    onClose();
  }
  async function remove() {
    if (!goal) return;
    if (!(await confirm(`Delete ${goal.name}? No real money moves${goal.mode === 'share' ? '; what was set aside goes back to the rest of the account' : ''}.`))) return;
    await api.del(`/api/goals/${goal.id}`);
    toast('Goal deleted');
    refresh();
    onClose();
  }

  return (
    <Modal title={goal ? `Edit ${goal.name}` : 'New goal'} onClose={onClose} wide
      footer={<>
        {goal && <button type="button" className="btn btn-ghost-danger" onClick={remove}><Icon name="trash" size={16} /> Delete</button>}
        {goal && <button type="button" className="btn btn-ghost" onClick={archive}>{goal.archived ? 'Restore' : 'Archive'}</button>}
        <span className="spacer" />
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="submit" form="goal-form" className="btn btn-primary">Save</button>
      </>}>
      <form id="goal-form" className="form" onSubmit={save}>
        <div className="grid-2">
          <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Japan trip" autoFocus={!goal} /></Field>
          <Field label="Where the money is"><AccountSelect value={accountId} onChange={setAccountId} filter={(a) => !a.isLiability} /></Field>
        </div>
        {accountId && (
          <Field label="How much of the account" hint={others.length ? `Also in this account: ${others.map((o) => o.name).join(', ')}` : undefined}>
            <Segmented value={mode} onChange={setMode} options={[
              { value: 'rest', label: restTaken ? 'What’s left (taken)' : others.length ? 'Whatever’s left' : 'The whole account' },
              { value: 'share', label: 'Set money aside for it' },
            ]} />
            <p className="muted small" style={{ marginTop: 6 }}>{mode === 'rest'
              ? 'Follows the account balance (minus anything set aside for other goals). Updates on its own as you import.'
              : 'Earmark part of the balance for this goal. No real money moves. Add more as you save.'}</p>
            {mode === 'rest' && restTaken && <p className="form-error">Another goal already uses what's left here. Choose "Set money aside".</p>}
          </Field>
        )}
        {!goal && mode === 'share' && accountId && (
          <Field label="Set aside now" hint={`${money(Math.max(0, freeNow))} available in this account`}>
            <div className="amount-field" style={{ maxWidth: 220 }}><span>£</span><input inputMode="decimal" value={startWith} onChange={(e) => setStartWith(e.target.value)} placeholder="0.00" /></div>
          </Field>
        )}
        <div className="grid-2">
          <Field label="Target (optional)">
            <div className="amount-field"><span>£</span><input inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="5000.00" /></div>
          </Field>
          <Field label="By (optional)" hint={neededHint ?? undefined}><input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} /></Field>
        </div>
        <label className="check"><input type="checkbox" checked={emergency} onChange={(e) => setEmergency(e.target.checked)} />
          <span><strong>This is my emergency fund</strong><br /><span className="muted small">Shows how many months of essentials it would cover.</span></span></label>
        {emergency && list.essentials > 0 && (
          <div className="hint-box" style={{ display: 'block' }}>
            <span className="small">Your essentials are about <strong>{money(list.essentials)}</strong> a month. Common targets:</span>
            <div className="row gap" style={{ marginTop: 8 }}>
              {[3, 6].map((n) => <button type="button" key={n} className="btn btn-sm" onClick={() => setTarget(penceToInput(list.essentials * n))}>{n} months · {money(list.essentials * n)}</button>)}
            </div>
          </div>
        )}
        <Field label="Monthly amount" hint="What you plan to put in each month. Shown against what you actually add.">
          <Segmented value={monthlyMode} onChange={setMonthlyMode} options={[{ value: 'none', label: 'None' }, { value: 'amount', label: 'Fixed amount' }, { value: 'percent', label: '% of take-home pay' }]} />
          {monthlyMode === 'amount' && <div className="amount-field" style={{ maxWidth: 220, marginTop: 8 }}><span>£</span><input inputMode="decimal" value={monthly} onChange={(e) => setMonthly(e.target.value)} placeholder="500.00" /></div>}
          {monthlyMode === 'percent' && (
            <div className="row gap" style={{ marginTop: 8 }}>
              <div className="amount-field" style={{ maxWidth: 160 }}><input inputMode="decimal" value={percent} onChange={(e) => setPercent(e.target.value)} placeholder="10" /><span>%</span></div>
              {list.takeHome && Number(percent) > 0 && <span className="muted small">{money(Math.round((list.takeHome * Number(percent)) / 100))} a month from {money(list.takeHome)} take-home</span>}
            </div>
          )}
        </Field>
        <Field label="Emoji"><EmojiPicker value={icon} onChange={setIcon} colour={goal?.colour ?? accounts.find((a) => a.id === accountId)?.colour ?? '#0ea5e9'} /></Field>
        <Field label="Notes"><input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Flights booked in March" /></Field>
        {error && <p className="form-error">{error}</p>}
      </form>
      {confirmNode}
    </Modal>
  );
}

function monthsBetweenClient(a: string, b: string): number {
  const [y1, m1] = a.split('-').map(Number);
  const [y2, m2] = b.split('-').map(Number);
  return (y2 - y1) * 12 + (m2 - m1);
}

function MoveModal({ g, list, onClose }: { g: Goal; list: GoalList; onClose: () => void }) {
  const { refresh, toast, meta } = useApp();
  const [dir, setDir] = useState<'in' | 'out'>('in');
  const [amount, setAmount] = useState('');
  const [fromGoal, setFromGoal] = useState<number | ''>('');
  const [note, setNote] = useState('');
  const [date, setDate] = useState(meta.today);
  const [error, setError] = useState<string | null>(null);
  const { data: moves } = useData<{ id: number; date: string; amount: number; note: string | null }[]>(() => api.get(`/api/goals/${g.id}/moves`), []);
  const acct = list.accounts.find((a) => a.id === g.account?.id);
  const rest = list.goals.find((o) => !o.archived && o.account?.id === g.account?.id && o.mode === 'rest');
  const shares = list.goals.filter((o) => !o.archived && o.account?.id === g.account?.id && o.mode === 'share' && o.id !== g.id && o.saved > 0);
  const available = rest ? rest.saved : acct?.unassigned ?? 0;

  async function save() {
    const p = parseAmount(amount);
    if (!p) return setError('Enter an amount');
    try {
      await api.post(`/api/goals/${g.id}/move`, { amount: dir === 'in' ? p : -p, date, note, fromGoalId: dir === 'in' && fromGoal ? fromGoal : null });
      toast(dir === 'in' ? `Set aside ${money(p)} for ${g.name}` : `Released ${money(p)} from ${g.name}`);
      refresh();
      onClose();
    } catch (e: any) { setError(e.message); }
  }
  return (
    <Modal title={`${g.name}: add or take out`} onClose={onClose}
      footer={<><span className="spacer" /><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={save}>{dir === 'in' ? 'Set aside' : 'Take out'}</button></>}>
      <div className="form">
        <p className="muted small">This earmarks money in {g.account?.name}. Nothing moves between banks. To save more, move money into {g.account?.name} as usual, then set it aside here.</p>
        <Segmented value={dir} onChange={setDir} options={[{ value: 'in', label: 'Set money aside' }, { value: 'out', label: 'Take money out' }]} />
        <div className="grid-2">
          <Field label="Amount" hint={dir === 'in' ? `${money(Math.max(0, fromGoal ? shares.find((s) => s.id === fromGoal)?.saved ?? 0 : available))} available` : `${money(g.saved)} set aside`}>
            <div className="amount-field"><span>£</span><input inputMode="decimal" autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="100.00" /></div>
          </Field>
          <Field label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        </div>
        {dir === 'in' && shares.length > 0 && (
          <Field label="From">
            <select value={fromGoal} onChange={(e) => setFromGoal(e.target.value ? Number(e.target.value) : '')}>
              <option value="">{rest ? `${rest.name} (the rest of the account)` : 'Money not in a goal'}</option>
              {shares.map((s) => <option key={s.id} value={s.id}>{s.name} · {money(s.saved)}</option>)}
            </select>
          </Field>
        )}
        {dir === 'out' && <p className="muted small">It goes back to {rest ? rest.name : 'the unassigned part of the account'}.</p>}
        <Field label="Note (optional)"><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="November payday" /></Field>
        {error && <p className="form-error">{error}</p>}
        {moves && moves.length > 0 && (
          <div>
            <p className="field-label" style={{ marginBottom: 6 }}>History</p>
            <ul className="moves-list">
              {moves.slice(0, 8).map((m) => (
                <li key={m.id}><span className="muted small">{shortDate(m.date)}</span><span className="grow small">{m.note ?? (m.amount > 0 ? 'Set aside' : 'Taken out')}</span>
                  <Money value={m.amount} className={m.amount > 0 ? 'amt-saved' : ''} /></li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}

/** Compact goal tiles for the Overview page. */
export function GoalStrip() {
  const { data } = useData<GoalList>(() => api.get('/api/goals'), []);
  if (!data) return null;
  const goals = data.goals.filter((g) => !g.archived).slice(0, 4);
  if (!goals.length) return null;
  return (
    <Card title="Goals" action={<button className="link-btn" onClick={() => navigate('/goals')}>All goals</button>}>
      <div className="goal-strip">
        {goals.map((g) => (
          <button key={g.id} className="goal-tile" onClick={() => navigate('/goals')}>
            <Ring value={g.progress ?? (g.saved > 0 ? 1 : 0)} colour={g.colour} size={52}><span className="goal-emoji sm">{g.icon ?? '🎯'}</span></Ring>
            <span className="goal-tile-text">
              <span className="strong ellipsis">{g.name}</span>
              <span className="small"><Money value={g.saved} />{g.target ? <span className="muted"> of {money(g.target, { compact: true })}</span> : null}</span>
              <span className={`small ${g.thisMonth > 0 ? 'amt-saved' : 'muted'}`}>{g.thisMonth ? `${money(g.thisMonth, { sign: true, compact: true })} this month` : g.status === 'done' ? 'Reached 🎉' : 'Nothing added this month'}</span>
            </span>
          </button>
        ))}
      </div>
    </Card>
  );
}
