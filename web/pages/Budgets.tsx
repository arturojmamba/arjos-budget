import React, { useMemo, useState } from 'react';
import { api, qs } from '../api.ts';
import { money, monthLabel, parseAmount, penceToInput, pct } from '../format.ts';
import { AccountSelect, Badge, Bubble, Card, Empty, Field, Modal, Money, Progress, Segmented, useApp, useConfirm, useData, usePageAdd } from '../components/ui.tsx';
import { Icon } from '../components/Icon.tsx';
import { navigate } from '../router.ts';

type Period = 'weekly' | 'monthly' | 'annual';
export interface BudgetView {
  id: number; name: string; period: Period; rollover: boolean; colour: string; icon: string | null; archived: boolean; percent: number | null;
  kind: 'spending' | 'saving'; account: { id: number; name: string; colour: string } | null;
  categories: { id: number; name: string; colour: string }[];
  current: { key: string; start: string; end: string; label: string; short: string };
  limit: number; carried: number; available: number; spent: number; remaining: number; pct: number;
  status: 'ok' | 'warn' | 'over';
  pace: { elapsed: number; expected: number; projected: number; perDayLeft: number | null; daysLeft: number; onTrack: boolean } | null;
  history: { key: string; label: string; short: string; limit: number; spent: number }[];
}
export interface BudgetList {
  month: string;
  budgets: BudgetView[];
  takeHome: number | null;
  savings: { target: number; saved: number; count: number };
  summary: { total: number; spent: number; remaining: number; pct: number | null; over: number; warn: number; unbudgeted: number;
    unbudgetedCategories: { id: number; name: string; colour: string; amount: number }[] };
}
interface Suggestion { categoryId: number; name: string; colour: string; icon: string | null; average: number; suggested: number; months: number; percent: number | null; recommended: number | null }
interface Guide {
  takeHome: { amount: number | null; source: 'manual' | 'salary' | 'average' | 'none'; derived: number | null; derivedSource: string };
  split: { needs: number; wants: number; savings: number };
  actual: { needs: number; wants: number; savings: number };
  categories: { categoryId: number; name: string; colour: string; icon: string | null; group: 'needs' | 'wants'; percent: number | null; custom: boolean; amount: number | null; average: number; budgetId: number | null; budgetName: string | null }[];
  totalPercent: number;
}
const pctText = (bp: number | null) => (bp == null ? '—' : `${(bp / 100).toFixed(bp % 100 === 0 ? 0 : bp % 10 === 0 ? 1 : 2)}%`);

const PERIOD_LABEL: Record<Period, string> = { weekly: 'Weekly', monthly: 'Monthly', annual: 'Yearly' };

export function Budgets({ month }: { month: string }) {
  const { meta } = useApp();
  const { data, error } = useData<BudgetList>(() => api.get(`/api/budgets${qs({ month })}`), [month]);
  const { data: suggestions } = useData<Suggestion[]>(() => api.get('/api/budgets/suggestions'), []);
  const [editing, setEditing] = useState<BudgetView | 'new' | 'new-goal' | { draft: { categoryId: number; name: string; percent: number | null } } | null>(null);
  usePageAdd('New budget', () => setEditing('new'));
  const [quickStart, setQuickStart] = useState(false);

  if (error) return <Empty icon="alert" title="Couldn't load budgets">{error}</Empty>;
  if (!data) return <div className="loading" />;
  const { summary } = data;
  const budgets = data.budgets.filter((b) => b.kind !== 'saving');
  const goals = data.budgets.filter((b) => b.kind === 'saving');
  const isCurrent = month === meta.currentMonth;
  const goalsSection = (
    <button className="banner banner-info" onClick={() => navigate('/goals')}>
      <Icon name="gift" size={16} />
      <span>Savings targets have moved to <strong>Goals</strong>, where you can set monthly amounts, targets and deadlines.</span>
      <Icon name="chevron-right" size={16} />
    </button>
  );
  void goals;

  return (
    <div className="page">
      {budgets.length === 0 ? (
        <>
        <Card>
          <Empty icon="piggy-bank" title="Set your first budgets">
            Pick a limit for the things you spend on day to day: groceries, eating out, shopping. You'll see how much is left and get a warning as you get close.
          </Empty>
          <div className="row gap" style={{ justifyContent: 'center', paddingBottom: 10 }}>
            {suggestions && suggestions.length > 0 && <button className="btn btn-primary" onClick={() => setQuickStart(true)}><Icon name="sparkles" size={16} /> Suggest budgets from my spending</button>}
            <button className="btn" onClick={() => setEditing('new')}><Icon name="plus" size={16} /> Create a budget</button>
          </div>
        </Card>
        {goalsSection}
        <PayGuide month={month} onCreate={(d) => setEditing(d as any)} startOpen />
        </>
      ) : (
        <>
          <Card>
            <div className="budget-summary">
              <div className="stack" style={{ gap: 10 }}>
                <div className="budget-summary-nums">
                  <div><span className="muted small">Budgeted for {monthLabel(month)}</span><Money value={summary.total} className="strong" /></div>
                  <div><span className="muted small">Spent</span><Money value={summary.spent} className="strong" /></div>
                  <div><span className="muted small">{summary.remaining >= 0 ? 'Left' : 'Over'}</span><Money value={Math.abs(summary.remaining)} className={`strong ${summary.remaining >= 0 ? 'tone-good' : 'tone-bad'}`} /></div>
                  <div><span className="muted small">Used</span><span className="strong">{pct(summary.pct)}</span></div>
                </div>
                <Progress value={summary.spent} max={summary.total} />
                <div className="row gap small">
                  {summary.over > 0 && <Badge tone="bad">{summary.over} over budget</Badge>}
                  {summary.warn > 0 && <Badge tone="warn">{summary.warn} nearly used up</Badge>}
                  {summary.unbudgeted > 0 && (
                    <span className="muted">
                      {money(summary.unbudgeted)} of day-to-day spending isn't in a budget
                      {summary.unbudgetedCategories.length > 0 && ` (${summary.unbudgetedCategories.slice(0, 3).map((c) => c.name).join(', ')}${summary.unbudgetedCategories.length > 3 ? '…' : ''})`}
                    </span>
                  )}
                </div>
              </div>
              <div className="row gap">
                {suggestions && suggestions.length > 0 && <button className="btn" onClick={() => setQuickStart(true)}><Icon name="sparkles" size={16} /> Suggestions</button>}
                <button className="btn btn-primary" onClick={() => setEditing('new')}><Icon name="plus" size={16} /> New budget</button>
              </div>
            </div>
          </Card>

          <PayGuide month={month} onCreate={(d) => setEditing(d as any)} />

          <div className="budget-grid">
            {budgets.map((b) => <BudgetCard key={b.id} b={b} month={month} isCurrent={isCurrent} onEdit={() => setEditing(b)} />)}
          </div>

          {goalsSection}

          <Compare budgets={budgets.filter((b) => b.period === 'monthly')} />
        </>
      )}


      {editing && <BudgetForm budget={typeof editing === 'string' || 'draft' in editing ? null : editing} draft={(editing as any).draft} goal={editing === 'new-goal' || (typeof editing === 'object' && 'kind' in editing && editing.kind === 'saving')}
        takeHome={data.takeHome} others={budgets.filter((b) => typeof editing === 'string' || (editing as any).draft || b.id !== (editing as BudgetView).id)} onClose={() => setEditing(null)} />}
      {quickStart && suggestions && <QuickStart suggestions={suggestions} onClose={() => setQuickStart(false)} />}
    </div>
  );
}

function BudgetCard({ b, month, isCurrent, onEdit }: { b: BudgetView; month: string; isCurrent: boolean; onEdit: () => void }) {
  const over = b.remaining < 0;
  const tone = b.status === 'over' ? 'bad' : b.status === 'warn' ? 'warn' : 'good';
  const periodText = b.period === 'monthly' ? (isCurrent ? 'This month' : b.current.label) : b.period === 'weekly' ? (b.pace ? `This week · ${b.current.label}` : b.current.label) : (b.pace ? `This year` : b.current.label);
  const maxHist = Math.max(1, ...b.history.map((h) => Math.max(h.spent, h.limit)));
  const linkQuery = b.period === 'monthly' ? { month } : b.period === 'weekly' ? { from: b.current.start, to: b.current.end } : {};

  let foot: React.ReactNode = null;
  if (b.pace) {
    if (over) foot = <span className="tone-bad">Over by {money(-b.remaining)}</span>;
    else if (!b.pace.onTrack && b.pace.projected > b.available) foot = <span className="tone-warn">On pace to spend {money(b.pace.projected)}</span>;
    else if (b.pace.perDayLeft != null) foot = <span>{money(b.pace.perDayLeft)} a day for {b.pace.daysLeft} day{b.pace.daysLeft === 1 ? '' : 's'}</span>;
  } else {
    foot = over ? <span className="tone-bad">Overspent by {money(-b.remaining)}</span> : <span className="tone-good">{money(b.remaining)} unspent</span>;
  }

  return (
    <div className={`card card-pad budget status-${b.status}`} role="button" tabIndex={0} onClick={onEdit} onKeyDown={(e) => e.key === 'Enter' && onEdit()}>
      <div className="budget-top">
        <Bubble colour={b.colour} icon={b.icon} size={38} />
        <div className="grow">
          <div className="budget-name">{b.name}
            {b.status === 'over' && <Badge tone="bad">Over</Badge>}
            {b.status === 'warn' && <Badge tone="warn">{Math.round(b.pct * 100)}% used</Badge>}
          </div>
          <div className="budget-cats">{periodText}{b.percent != null && <> · {pctText(b.percent)} of pay</>} · {b.categories.map((c) => c.name).join(', ')}</div>
        </div>
      </div>
      <div className="budget-figures">
        <span className={`budget-left ${over ? 'tone-bad' : ''}`}>{money(Math.abs(b.remaining))} <span className="muted small" style={{ fontWeight: 500, letterSpacing: 0 }}>{over ? 'over' : 'left'}</span></span>
        <span className="muted small">{money(b.spent)} of {money(b.available)}{b.carried > 0 && <> (incl. {money(b.carried)} rolled over)</>}</span>
      </div>
      <div className="progress" title={b.pace ? `By today you'd expect to have spent ${money(b.pace.expected)}` : undefined}>
        <span className={`progress-${tone}`} style={{ width: `${Math.min(100, b.pct * 100)}%` }} />
        {b.pace && <i className="pace-mark" style={{ left: `${Math.min(100, b.pace.elapsed * 100)}%` }} />}
      </div>
      <div className="budget-foot">
        {foot}
        <button className="link-btn" onClick={(e) => { e.stopPropagation(); navigate(`/transactions${qs({ budgetId: b.id, ...linkQuery })}`); }}>Transactions</button>
      </div>
      <div className="mini-bars" aria-label="Last 6 periods">
        {b.history.map((h, i) => (
          <div key={h.key} className="mini-bar" role="img" aria-label={`${h.label}: ${money(h.spent)} of ${money(h.limit)}, ${h.spent > h.limit ? 'over' : 'within the limit'}`} title={`${h.label}: ${money(h.spent)} of ${money(h.limit)}${h.spent > h.limit ? ', over' : ''}`}>
            <span className="lim" style={{ bottom: `calc(${(h.limit / maxHist) * 30}px + 16px)` }} />
            <span className={`b ${h.spent > h.limit ? 'over' : ''} ${i === b.history.length - 1 ? 'cur' : ''}`} style={{ height: `${(h.spent / maxHist) * 30}px` }} />
            <i>{h.short}</i>
          </div>
        ))}
      </div>
    </div>
  );
}

function Compare({ budgets }: { budgets: BudgetView[] }) {
  if (budgets.length === 0) return null;
  const cols = budgets[0].history;
  const totals = cols.map((_, i) => budgets.reduce((s, b) => s + b.history[i].spent, 0));
  const limits = cols.map((_, i) => budgets.reduce((s, b) => s + b.history[i].limit, 0));
  return (
    <Card title="Month by month" pad={false} action={<span className="muted small">Spent against each month's limit</span>}>
      <div className="compare-wrap">
        <table className="compare-table">
          <thead><tr><th>Budget</th>{cols.map((c) => <th key={c.key}>{c.short}</th>)}<th>Average</th></tr></thead>
          <tbody>
            {budgets.map((b) => {
              const avg = Math.round(b.history.slice(0, -1).reduce((s, h) => s + h.spent, 0) / Math.max(1, b.history.length - 1));
              return (
                <tr key={b.id}>
                  <td><span className="row gap"><span className="dot" style={{ background: b.colour }} />{b.name}</span></td>
                  {b.history.map((h, i) => (
                    <td key={h.key} className={`${h.spent > h.limit ? 'over' : ''} ${i === b.history.length - 1 ? 'cur' : ''}`} title={`Limit ${money(h.limit)}`}>{h.spent ? money(h.spent) : '—'}</td>
                  ))}
                  <td className="muted">{money(avg)}</td>
                </tr>
              );
            })}
            <tr>
              <td><strong>Total</strong></td>
              {totals.map((t, i) => <td key={i} className={`${t > limits[i] ? 'over' : ''} ${i === totals.length - 1 ? 'cur' : ''}`}><strong>{money(t)}</strong></td>)}
              <td className="muted">{money(Math.round(totals.slice(0, -1).reduce((s, t) => s + t, 0) / Math.max(1, totals.length - 1)))}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="muted small" style={{ padding: '10px 20px 16px' }}>The average leaves out the current month. Red means over that month's limit.</p>
    </Card>
  );
}

function BudgetForm({ budget, draft, goal = false, takeHome, others, onClose }: {
  budget: BudgetView | null; draft?: { categoryId: number; name: string; percent: number | null }; goal?: boolean; takeHome: number | null; others: BudgetView[]; onClose: () => void;
}) {
  const { categories, accounts, refresh, toast } = useApp();
  const [accountId, setAccountId] = useState<number | null>(budget?.account?.id ?? null);
  const [confirm, confirmNode] = useConfirm();
  const [name, setName] = useState(budget?.name ?? draft?.name ?? '');
  const [mode, setMode] = useState<'amount' | 'percent'>(budget ? (budget.percent != null ? 'percent' : 'amount') : draft?.percent != null && takeHome ? 'percent' : 'amount');
  const [percent, setPercent] = useState(budget?.percent != null ? String(budget.percent / 100) : draft?.percent != null ? String(draft.percent / 100) : '');
  const [period, setPeriod] = useState<Period>(budget?.period ?? 'monthly');
  const [amount, setAmount] = useState(budget ? penceToInput(budget.limit) : '');
  const [cats, setCats] = useState<Set<number>>(new Set(budget?.categories.map((c) => c.id) ?? (draft ? [draft.categoryId] : [])));
  const [rollover, setRollover] = useState(budget?.rollover ?? false);
  const [applyAll, setApplyAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const expense = useMemo(() => categories.filter((c) => c.kind === 'expense' && !c.archived), [categories]);
  const parents = expense.filter((c) => c.parentId === null);

  function toggle(id: number) {
    setCats((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      if (!name || (budget === null && s.size <= 1)) {
        const only = [...n];
        if (only.length === 1) setName(expense.find((c) => c.id === only[0])?.name ?? '');
      }
      return n;
    });
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const pence = parseAmount(amount);
    const bp = Math.round(Number(percent) * 100);
    if (mode === 'amount' && !pence) return setError(goal ? 'Enter the target, e.g. 500' : 'Enter the limit, e.g. 250');
    if (mode === 'percent' && !(bp > 0 && bp <= 10000)) return setError('Enter a percentage, e.g. 10');
    if (goal && !accountId) return setError('Choose the account you are saving into');
    const body = {
      name: name.trim() || (goal ? accounts.find((a) => a.id === accountId)?.name ?? '' : ''), period,
      amount: mode === 'amount' ? pence : undefined, percent: mode === 'percent' ? bp : null,
      kind: goal ? 'saving' : 'spending', accountId: goal ? accountId : null,
      categoryIds: goal ? [] : [...cats], rollover: goal ? false : rollover, applyFrom: applyAll ? 'all' : 'now',
    };
    try {
      if (budget) await api.put(`/api/budgets/${budget.id}`, body);
      else await api.post('/api/budgets', body);
      toast(budget ? 'Budget updated' : 'Budget created');
      refresh();
      onClose();
    } catch (err: any) { setError(err.message); }
  }

  async function remove() {
    if (!budget) return;
    if (!(await confirm(`Delete the ${budget.name} ${goal ? 'savings goal' : 'budget'}? Your transactions aren't affected.`))) return;
    await api.del(`/api/budgets/${budget.id}`);
    toast('Budget deleted');
    refresh();
    onClose();
  }

  const amountChanged = budget && mode === 'amount' && budget.percent == null && parseAmount(amount) !== budget.limit;
  const overlaps = goal ? [] : others.filter((o) => o.categories.some((c) => cats.has(c.id)));

  return (
    <Modal title={budget ? `Edit ${budget.name}` : goal ? 'New savings goal' : 'New budget'} onClose={onClose}
      footer={<>
        {budget && <button type="button" className="btn btn-ghost-danger" onClick={remove}><Icon name="trash" size={16} /> Delete</button>}
        <span className="spacer" />
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="submit" form="budget-form" className="btn btn-primary">Save</button>
      </>}>
      <form id="budget-form" className="form" onSubmit={save}>
        {goal ? (
          <>
            <Field label="Saving into" hint="Money you move into this account counts towards the goal. Withdrawals take it back off; growth and interest don't count.">
              <AccountSelect value={accountId} onChange={(id) => { setAccountId(id); if (!name || accounts.some((a) => a.name === name)) setName(accounts.find((a) => a.id === id)?.name ?? ''); }}
                filter={(a) => !a.isLiability && a.type !== 'current'} />
            </Field>
          </>
        ) : (<>
        <Field label="Categories" hint="Subcategories are included automatically.">
          <div className="cat-pick">
            {parents.map((c) => (
              <React.Fragment key={c.id}>
                <button type="button" className={`cat-chip ${cats.has(c.id) ? 'on' : ''}`} style={cats.has(c.id) ? { color: c.colour, background: `${c.colour}14` } : undefined} onClick={() => toggle(c.id)} aria-pressed={cats.has(c.id)}>
                  <span className="dot" style={{ background: c.colour }} />{c.name}
                </button>
                {!cats.has(c.id) && expense.filter((s) => s.parentId === c.id).map((s) => (
                  <button type="button" key={s.id} className={`cat-chip ${cats.has(s.id) ? 'on' : ''}`} style={cats.has(s.id) ? { color: c.colour, background: `${c.colour}14` } : undefined} onClick={() => toggle(s.id)} aria-pressed={cats.has(s.id)}>
                    <span className="muted">{c.name} ›</span> {s.name}
                  </button>
                ))}
              </React.Fragment>
            ))}
          </div>
        </Field>
        {overlaps.length > 0 && (
          <p className="hint-box"><Icon name="info" size={16} />
            Also covered by {overlaps.map((o) => `“${o.name}”`).join(' and ')}. Spending counts towards both, but only once in the month total. Useful for a weekly limit inside a monthly one.
          </p>
        )}
        </>)}
        <div className="grid-2">
          <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder={goal ? 'Emergency fund' : 'Personal spending'} /></Field>
          <Field label={goal ? 'Target' : 'Limit'} hint={mode === 'percent' && takeHome ? `${money(previewAmount(takeHome, Number(percent), period))} a ${period === 'weekly' ? 'week' : period === 'annual' ? 'year' : 'month'} from ${money(takeHome)} take-home pay` : undefined}>
            {mode === 'amount'
              ? <div className="amount-field"><span>£</span><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="250.00" /></div>
              : <div className="amount-field"><input inputMode="decimal" value={percent} onChange={(e) => setPercent(e.target.value)} placeholder="10" /><span>% of pay</span></div>}
          </Field>
        </div>
        <Segmented value={mode} onChange={setMode} options={[{ value: 'amount', label: 'Fixed amount' }, { value: 'percent', label: '% of take-home pay' }]} />
        {mode === 'percent' && !takeHome && <p className="form-error">Set your take-home pay in the guide below (or add your salary under Bills and income) to use percentages.</p>}
        {mode === 'percent' && <p className="muted small">The limit updates automatically when your pay changes. Past months keep the limit they had.</p>}
        <Field label="Every">
          <Segmented<Period> value={period} onChange={setPeriod} options={[{ value: 'weekly', label: 'Week' }, { value: 'monthly', label: 'Month' }, { value: 'annual', label: 'Year' }]} />
        </Field>
        {period === 'weekly' && <p className="muted small">Weeks run Monday to Sunday.</p>}
        {!goal && <label className="check"><input type="checkbox" checked={rollover} onChange={(e) => setRollover(e.target.checked)} />
          <span><strong>Roll over unused money</strong><br /><span className="muted small">What you don't spend is added to next {period === 'weekly' ? 'week' : period === 'annual' ? 'year' : 'month'}. Overspending isn't carried forward. Off means it resets each time.</span></span></label>}
        {amountChanged && budget?.period === period && (
          <label className="check"><input type="checkbox" checked={applyAll} onChange={(e) => setApplyAll(e.target.checked)} />
            <span>Also use the new limit for past {period === 'weekly' ? 'weeks' : period === 'annual' ? 'years' : 'months'}<br /><span className="muted small">Otherwise it applies from now on and past results stay as they were.</span></span></label>
        )}
        {error && <p className="form-error">{error}</p>}
      </form>
      {confirmNode}
    </Modal>
  );
}

function QuickStart({ suggestions, onClose }: { suggestions: Suggestion[]; onClose: () => void }) {
  const { refresh, toast } = useApp();
  const [picked, setPicked] = useState<Record<number, string>>(() => Object.fromEntries(suggestions.map((s) => [s.categoryId, penceToInput(s.recommended ?? s.suggested)])));
  const [on, setOn] = useState<Set<number>>(new Set(suggestions.slice(0, 6).map((s) => s.categoryId)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      let n = 0;
      for (const s of suggestions) {
        if (!on.has(s.categoryId)) continue;
        const amount = parseAmount(picked[s.categoryId] ?? '');
        if (!amount) throw new Error(`Enter a limit for ${s.name}`);
        // Kept at the recommended amount: make it a % of pay so it follows pay changes.
        const asPercent = s.percent != null && s.recommended != null && amount === s.recommended;
        await api.post('/api/budgets', { name: s.name, period: 'monthly', ...(asPercent ? { percent: s.percent } : { amount }), categoryIds: [s.categoryId] });
        n++;
      }
      toast(`Created ${n} budget${n === 1 ? '' : 's'}`);
      refresh();
      onClose();
    } catch (e: any) { setError(e.message); setBusy(false); refresh(); }
  }

  return (
    <Modal title="Suggested monthly budgets" onClose={onClose} wide
      footer={<><span className="muted small">{suggestions.some((s) => s.recommended != null) ? 'Pre-filled with the recommended share of your pay; your usual spending is shown for comparison.' : `Based on your average over the last ${suggestions[0]?.months || 3} months, rounded up.`}</span><span className="spacer" />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={create} disabled={busy || on.size === 0}>Create {on.size} budget{on.size === 1 ? '' : 's'}</button></>}>
      <ul className="history-list">
        {suggestions.map((s) => (
          <li key={s.categoryId}>
            <input type="checkbox" checked={on.has(s.categoryId)} onChange={() => setOn((o) => { const n = new Set(o); n.has(s.categoryId) ? n.delete(s.categoryId) : n.add(s.categoryId); return n; })} aria-label={`Budget for ${s.name}`} />
            <Bubble colour={s.colour} icon={s.icon} size={30} />
            <span className="grow"><strong>{s.name}</strong> <span className="muted small">· you usually spend {money(s.average)}{s.recommended != null && s.percent != null ? ` · recommended ${pctText(s.percent)} of pay = ${money(s.recommended)}` : ''}</span></span>
            <div className="amount-field" style={{ width: 130 }}><span>£</span><input inputMode="decimal" value={picked[s.categoryId] ?? ''} onChange={(e) => setPicked((p) => ({ ...p, [s.categoryId]: e.target.value }))} aria-label={`${s.name} limit`} /></div>
          </li>
        ))}
      </ul>
      {error && <p className="form-error">{error}</p>}
    </Modal>
  );
}

function previewAmount(pay: number, pctNum: number, period: Period): number {
  if (!Number.isFinite(pctNum) || pctNum <= 0) return 0;
  const monthly = Math.round((pay * Math.round(pctNum * 100)) / 10000);
  return period === 'weekly' ? Math.round((monthly * 12) / 52) : period === 'annual' ? monthly * 12 : monthly;
}

function PayGuide({ month, onCreate, startOpen = false }: { month: string; onCreate: (e: { draft: { categoryId: number; name: string; percent: number | null } }) => void; startOpen?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const { refresh, toast } = useApp();
  const { data: g } = useData<Guide>(() => api.get(`/api/budgets/guide${qs({ month })}`), [month]);
  const [pay, setPay] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [splitEdit, setSplitEdit] = useState<{ needs: string; wants: string; savings: string } | null>(null);
  if (!g) return null;
  const take = g.takeHome.amount;
  const dirty = Object.keys(edits).length > 0;

  async function savePay() {
    if (pay === null) return;
    const p = pay.trim() === '' ? null : parseAmount(pay);
    if (pay.trim() !== '' && p === null) return toast('Enter an amount like 3200', 'error');
    await api.put('/api/budgets/guide', { takeHome: p });
    setPay(null);
    toast(p ? 'Take-home pay saved' : 'Using your salary again');
    refresh();
  }
  async function savePercents() {
    const percents: Record<string, number | null> = {};
    for (const [k, v] of Object.entries(edits)) {
      if (v.trim() === '') { percents[k] = null; continue; }
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 100) return toast('Percentages must be 0–100', 'error');
      percents[k] = Math.round(n * 100);
    }
    await api.put('/api/budgets/guide', { percents });
    setEdits({});
    toast('Recommendations saved');
    refresh();
  }
  async function saveSplit() {
    if (!splitEdit) return;
    const split = { needs: Math.round(Number(splitEdit.needs) * 100), wants: Math.round(Number(splitEdit.wants) * 100), savings: Math.round(Number(splitEdit.savings) * 100) };
    try { await api.put('/api/budgets/guide', { split }); setSplitEdit(null); toast('Split saved'); refresh(); } catch (e: any) { toast(e.message, 'error'); }
  }
  async function reset() {
    await api.put('/api/budgets/guide', { reset: true });
    setEdits({});
    toast('Back to the recommended percentages');
    refresh();
  }

  const sourceText = g.takeHome.source === 'manual' ? 'set by you' : g.takeHome.source === 'salary' ? 'from your salary in Bills and income' : g.takeHome.source === 'average' ? 'average income, last 3 months' : 'not set';
  const parts: { key: 'needs' | 'wants' | 'savings'; label: string; colour: string; note: string }[] = [
    { key: 'needs', label: 'Needs', colour: 'var(--spend)', note: 'Rent, bills, groceries, transport' },
    { key: 'wants', label: 'Wants', colour: '#8b5cf6', note: 'Eating out, shopping, fun' },
    { key: 'savings', label: 'Savings', colour: 'var(--saved)', note: 'Money moved to savings and investments' },
  ];

  return (
    <Card title="Budgeting from your pay" action={<button className="link-btn" onClick={reset}>Reset to recommended</button>}>
      <div className="guide-top">
        <div className="guide-pay">
          <span className="muted small">Monthly take-home pay</span>
          {pay === null ? (
            <div className="row gap">
              <span className="strong" style={{ fontSize: 22 }}>{take ? money(take) : 'Not set'}</span>
              <button className="link-btn" onClick={() => setPay(take ? penceToInput(take) : '')}>Change</button>
            </div>
          ) : (
            <div className="row gap">
              <div className="amount-field" style={{ width: 150 }}><span>£</span><input inputMode="decimal" value={pay} onChange={(e) => setPay(e.target.value)} autoFocus /></div>
              <button className="btn btn-sm" onClick={savePay}>Save</button>
              {g.takeHome.source === 'manual' && <button className="link-btn" onClick={() => { setPay(''); setTimeout(savePay, 0); }}>Use salary</button>}
            </div>
          )}
          <span className="muted small">{sourceText}</span>
        </div>
        <div className="guide-split">
          <div className="row gap" style={{ justifyContent: 'space-between' }}>
            <span className="field-label">The {pctText(g.split.needs).replace('%', '')}/{pctText(g.split.wants).replace('%', '')}/{pctText(g.split.savings).replace('%', '')} rule this month</span>
            {splitEdit ? null : <button className="link-btn" onClick={() => setSplitEdit({ needs: String(g.split.needs / 100), wants: String(g.split.wants / 100), savings: String(g.split.savings / 100) })}>Change split</button>}
          </div>
          {splitEdit ? (
            <div className="row gap end">
              {parts.map((p) => (
                <Field key={p.key} label={p.label}><div className="amount-field" style={{ width: 90 }}><input inputMode="decimal" value={splitEdit[p.key]} onChange={(e) => setSplitEdit({ ...splitEdit, [p.key]: e.target.value })} /><span>%</span></div></Field>
              ))}
              <button className="btn btn-sm" onClick={saveSplit}>Save</button>
              <button className="link-btn" onClick={() => setSplitEdit(null)}>Cancel</button>
            </div>
          ) : (
            <div className="split-rows">
              {parts.map((p) => {
                const target = take ? Math.round((take * g.split[p.key]) / 10000) : null;
                const actual = g.actual[p.key];
                const saving = p.key === 'savings';
                const over = target != null && !saving && actual > target;
                const reached = target != null && saving && actual >= target;
                return (
                  <div key={p.key} className="split-row">
                    <span className="dot" style={{ background: p.colour }} />
                    <span className="grow"><strong>{p.label}</strong> <span className="muted small">{pctText(g.split[p.key])} · {p.note}</span></span>
                    <span className={`small ${over ? 'tone-bad' : reached ? 'tone-good' : 'muted'}`}>{money(actual)}{target != null && <> of {money(target)}</>}</span>
                    {target != null && <span className="rule-bar"><Progress value={actual} max={target} tone={saving ? (reached ? 'good' : 'info') : undefined} /></span>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="row gap" style={{ marginTop: 14 }}>
        <button className="link-btn" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'} recommended % for each category <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} /></button>
      </div>
      {open && <>
      <div className="compare-wrap" style={{ marginTop: 10 }}>
        <table className="compare-table guide-table">
          <thead><tr><th>Day-to-day category</th><th>Recommended</th><th>Per month</th><th>You usually spend</th><th></th></tr></thead>
          <tbody>
            {g.categories.map((c) => {
              const edited = edits[c.categoryId];
              const shown = edited ?? (c.percent != null ? String(c.percent / 100) : '');
              const pctNum = Number(shown);
              const amount = take && shown !== '' && Number.isFinite(pctNum) ? Math.round((take * Math.round(pctNum * 100)) / 10000) : null;
              const over = amount != null && c.average > amount;
              return (
                <tr key={c.categoryId}>
                  <td><span className="row gap"><span className="dot" style={{ background: c.colour }} />{c.name}{c.custom && <span className="tag">Yours</span>}</span></td>
                  <td><div className="amount-field pct-input"><input inputMode="decimal" value={shown} onChange={(e) => setEdits({ ...edits, [c.categoryId]: e.target.value })} aria-label={`${c.name} percent`} placeholder="—" /><span>%</span></div></td>
                  <td>{amount != null ? money(amount) : '—'}</td>
                  <td className={over ? 'over' : 'muted'}>{c.average ? money(c.average) : '—'}</td>
                  <td>{c.budgetId
                    ? <span className="muted small">In “{c.budgetName}”</span>
                    : <button className="btn btn-sm" onClick={() => onCreate({ draft: { categoryId: c.categoryId, name: c.name, percent: shown !== '' && Number.isFinite(pctNum) ? Math.round(pctNum * 100) : null } })}>Create budget</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="row gap" style={{ justifyContent: 'space-between', marginTop: 12 }}>
        <span className="muted small">Recommendations total {pctText(g.categories.reduce((s, c) => s + (edits[c.categoryId] !== undefined ? Math.round(Number(edits[c.categoryId] || 0) * 100) : c.percent ?? 0), 0))} of pay for day-to-day spending. These are common rules of thumb, not advice. Adjust them to suit you.</span>
        {dirty && <button className="btn btn-primary btn-sm" onClick={savePercents}>Save percentages</button>}
      </div>
      </>}
    </Card>
  );
}

function SavingsGoals({ goals, totals, month, isCurrent, onNew, onEdit }: {
  goals: BudgetView[]; totals: { target: number; saved: number; count: number }; month: string; isCurrent: boolean; onNew: () => void; onEdit: (g: BudgetView) => void;
}) {
  return (
    <section className="stack" style={{ gap: 12 }}>
      <div className="row gap" style={{ justifyContent: 'space-between' }}>
        <div>
          <h2>Savings goals</h2>
          <p className="muted small">{goals.length
            ? <>Saved <strong className="tone-good">{money(totals.saved)}</strong> of {money(totals.target)} {isCurrent ? 'this month' : `in ${monthLabel(month)}`}</>
            : 'Set a target for what goes into Trading 212, your emergency fund or a pot each month.'}</p>
        </div>
        <button className="btn" onClick={onNew}><Icon name="plus" size={16} /> New savings goal</button>
      </div>
      {goals.length > 0 && (
        <div className="budget-grid">
          {goals.map((g) => <GoalCard key={g.id} g={g} month={month} isCurrent={isCurrent} onEdit={() => onEdit(g)} />)}
        </div>
      )}
    </section>
  );
}

function GoalCard({ g, month, isCurrent, onEdit }: { g: BudgetView; month: string; isCurrent: boolean; onEdit: () => void }) {
  const done = g.spent >= g.available;
  const toGo = Math.max(0, g.available - g.spent);
  const periodText = g.period === 'monthly' ? (isCurrent ? 'This month' : g.current.label) : g.period === 'weekly' ? `Week of ${g.current.label}` : g.current.label;
  const maxHist = Math.max(1, ...g.history.map((h) => Math.max(h.spent, h.limit)));
  const linkQuery = g.period === 'monthly' ? { month } : { from: g.current.start, to: g.current.end };
  let foot: React.ReactNode;
  if (done) foot = <span className="tone-good">Target reached{g.spent > g.available ? `, ${money(g.spent - g.available)} extra` : ''}</span>;
  else if (g.pace) foot = g.pace.onTrack ? <span>{money(toGo)} to go · {g.pace.daysLeft} day{g.pace.daysLeft === 1 ? '' : 's'} left</span> : <span className="tone-warn">Behind: {money(toGo)} to go in {g.pace.daysLeft} day{g.pace.daysLeft === 1 ? '' : 's'}</span>;
  else foot = <span className="tone-bad">Missed by {money(toGo)}</span>;
  return (
    <div className={`card card-pad budget goal ${done ? 'goal-done' : ''}`} role="button" tabIndex={0} onClick={onEdit} onKeyDown={(e) => e.key === 'Enter' && onEdit()}>
      <div className="budget-top">
        <Bubble colour={g.colour} icon={g.icon} size={38} />
        <div className="grow">
          <div className="budget-name">{g.name}{done && <Badge tone="good">Done</Badge>}{!done && g.status === 'warn' && <Badge tone="warn">Behind</Badge>}</div>
          <div className="budget-cats">{periodText}{g.percent != null && <> · {pctText(g.percent)} of pay</>} · into {g.account?.name}</div>
        </div>
      </div>
      <div className="budget-figures">
        <span className="budget-left tone-good">{money(Math.max(0, g.spent))} <span className="muted small" style={{ fontWeight: 500, letterSpacing: 0 }}>saved</span></span>
        <span className="muted small">of {money(g.available)}</span>
      </div>
      <div className="progress" title={g.pace ? `By today you'd have saved ${money(g.pace.expected)} at an even pace` : undefined}>
        <span className="progress-good" style={{ width: `${Math.max(0, Math.min(100, g.pct * 100))}%` }} />
        {g.pace && !done && <i className="pace-mark" style={{ left: `${Math.min(100, g.pace.elapsed * 100)}%` }} />}
      </div>
      <div className="budget-foot">
        {foot}
        <button className="link-btn" onClick={(e) => { e.stopPropagation(); navigate(`/transactions${qs({ budgetId: g.id, ...linkQuery })}`); }}>Transactions</button>
      </div>
      <div className="mini-bars" aria-label="Last 6 periods">
        {g.history.map((h, i) => (
          <div key={h.key} className="mini-bar" title={`${h.label}: saved ${money(h.spent)} of ${money(h.limit)}`}>
            <span className="lim" style={{ bottom: `calc(${(h.limit / maxHist) * 30}px + 16px)` }} />
            <span className={`b good ${i === g.history.length - 1 ? 'cur' : ''}`} style={{ height: `${(Math.max(0, h.spent) / maxHist) * 30}px` }} />
            <i>{h.short}</i>
          </div>
        ))}
      </div>
    </div>
  );
}
