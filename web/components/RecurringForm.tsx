import React, { useState } from 'react';
import { api, type Recurring, type RecurringType, type Frequency } from '../api.ts';
import { FREQUENCY_LABELS, money, parseAmount, penceToInput, shortDate } from '../format.ts';
import { AccountSelect, Badge, CategorySelect, Field, Modal, Segmented, useApp, useConfirm } from './ui.tsx';
import { Icon } from './Icon.tsx';

export interface RecurringDraft {
  oneOff?: boolean;
  name?: string; type?: RecurringType; amount?: number; variable?: boolean; frequency?: Frequency; startDate?: string;
  accountId?: number; categoryId?: number | null; transferAccountId?: number | null; matchPattern?: string | null;
}

export function RecurringForm({ item, draft, onClose }: { item?: Recurring | null; draft?: RecurringDraft; onClose: () => void }) {
  const { meta, accounts, categories, refresh, toast } = useApp();
  const [confirm, confirmNode] = useConfirm();
  const src = item ?? draft ?? {};
  const [type, setType] = useState<RecurringType>(src.type ?? 'bill');
  const [name, setName] = useState(src.name ?? '');
  const [amount, setAmount] = useState(src.amount ? penceToInput(src.amount) : '');
  const [variable, setVariable] = useState(src.variable ?? false);
  const [frequency, setFrequency] = useState<Frequency | 'once'>(item?.oneOff || draft?.oneOff ? 'once' : src.frequency ?? 'monthly');
  const [startDate, setStartDate] = useState(src.startDate ?? meta.today);
  const [lastWorking, setLastWorking] = useState(item?.schedule === 'last_working_day');
  const [endDate, setEndDate] = useState(item?.oneOff ? '' : item?.endDate ?? '');
  const [accountId, setAccountId] = useState<number | null>(src.accountId ?? accounts.find((a) => a.type === 'current')?.id ?? null);
  const [categoryId, setCategoryId] = useState<number | null>(src.categoryId ?? null);
  const [transferAccountId, setTransfer] = useState<number | null>(src.transferAccountId ?? null);
  const [matchPattern, setMatch] = useState(src.matchPattern ?? '');
  const [notes, setNotes] = useState(item?.notes ?? '');
  const [active, setActive] = useState(item?.active ?? true);
  const [tab, setTab] = useState<'details' | 'history'>('details');
  const [shares, setShares] = useState<ShareDraft[]>((item?.shares ?? []).map((x) => ({ name: x.name, amount: penceToInput(x.amount), accountId: x.accountId, matchPattern: x.matchPattern ?? '' })));
  const [applyToPast, setApplyToPast] = useState(!item?.shares.length);
  const shareable = type === 'bill' || type === 'subscription';
  const [error, setError] = useState<string | null>(null);

  function changeType(t: RecurringType) {
    setType(t);
    setCategoryId(null);
    if (t === 'income' && !item) {
      const salary = categories.find((c) => c.name === 'Salary');
      if (salary) setCategoryId(salary.id);
    }
    if (t === 'subscription' && !item) {
      const subs = categories.find((c) => c.name === 'Subscriptions');
      if (subs) setCategoryId(subs.id);
    }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const pence = parseAmount(amount);
    if (!pence) return setError(variable ? 'Enter a typical amount' : 'Enter the amount');
    if (!accountId) return setError('Choose an account');
    const once = frequency === 'once';
    const body = {
      name, type, amount: pence, variable, frequency: once ? 'annually' : frequency, startDate,
      schedule: frequency === 'monthly' && lastWorking ? 'last_working_day' : 'fixed',
      endDate: once ? startDate : endDate || null, accountId,
      categoryId: type === 'saving' ? null : categoryId,
      transferAccountId: type === 'saving' ? transferAccountId : null,
      matchPattern: matchPattern.trim() || null, notes: notes.trim() || null, active,
    };
    const shareBody: { name: string; amount: number; accountId: number | null; matchPattern: string | null }[] = [];
    if (shareable) {
      for (const sh of shares) {
        if (!sh.name.trim() && !sh.amount.trim()) continue;
        const p = parseAmount(sh.amount);
        if (!sh.name.trim()) return setError('Each person who pays you back needs a name');
        if (!p || p <= 0) return setError(`Enter how much ${sh.name.trim()} pays you`);
        shareBody.push({ name: sh.name.trim(), amount: p, accountId: sh.accountId, matchPattern: sh.matchPattern.trim() || null });
      }
      if (shareBody.reduce((n, x) => n + x.amount, 0) > pence) return setError('Other people pay back more than it costs. Check the amounts.');
    }
    try {
      let rid = item?.id;
      if (item) await api.put(`/api/recurring/${item.id}`, body);
      else rid = (await api.post<{ id: number }>('/api/recurring', body)).id;
      let moved = 0;
      if (rid && (shareBody.length || item?.shares.length)) {
        moved = (await api.put<{ recategorised: number }>(`/api/recurring/${rid}/shares`, { shares: shareable ? shareBody : [], applyToPast: applyToPast && shareBody.length > 0 })).recategorised;
      }
      toast(item ? (moved ? `Saved · ${moved} past payment${moved === 1 ? '' : 's'} from them now count against ${name}` : 'Saved') : `${name} added`);
      refresh();
      onClose();
    } catch (err: any) { setError(err.message); }
  }

  async function remove() {
    if (!item) return;
    if (!(await confirm(`Delete ${item.name}? Its payment history links are removed; your transactions stay.`))) return;
    await api.del(`/api/recurring/${item.id}`);
    toast('Deleted');
    refresh();
    onClose();
  }

  const accountLabel = type === 'income' ? 'Paid into' : type === 'saving' ? 'From' : 'Paid from';

  return (
    <Modal title={item ? item.name : 'New regular payment'} onClose={onClose}
      footer={tab === 'details' ? <>
        {item && <button type="button" className="btn btn-ghost-danger" onClick={remove}><Icon name="trash" size={16} /> Delete</button>}
        <span className="spacer" />
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="submit" form="rec-form" className="btn btn-primary">Save</button>
      </> : undefined}>
      {item && (
        <div style={{ marginBottom: 14 }}>
          <Segmented value={tab} onChange={setTab} options={[{ value: 'details', label: 'Details' }, { value: 'history', label: `History (${item.history.length})` }]} />
        </div>
      )}
      {tab === 'history' && item ? <History item={item} /> : (
        <form id="rec-form" className="form" onSubmit={save}>
          <Segmented<RecurringType> value={type} onChange={changeType} options={[
            { value: 'bill', label: 'Bill' }, { value: 'subscription', label: 'Subscription' },
            { value: 'saving', label: 'Saving or debt' }, { value: 'income', label: 'Income' },
          ]} />
          {type === 'saving' && <p className="hint-box"><Icon name="info" size={16} />A regular transfer to savings, your ISA, or a card or loan you're paying off. It counts as committed money, never as spending.</p>}
          <div className="grid-2">
            <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder={type === 'income' ? 'Salary' : type === 'saving' ? 'ISA contribution' : 'Council tax'} /></Field>
            <Field label={variable ? 'Typical amount' : 'Amount'}>
              <div className="amount-field"><span>£</span><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" /></div>
            </Field>
          </div>
          <label className="check"><input type="checkbox" checked={variable} onChange={(e) => setVariable(e.target.checked)} />
            <span>The amount varies (energy, water, phone usage). Any amount will match and price changes won't be flagged.</span></label>
          <div className="grid-2">
            <Field label="How often">
              <select value={frequency} onChange={(e) => setFrequency(e.target.value as Frequency | 'once')}>
                {meta.frequencies.map((f) => <option key={f} value={f}>{FREQUENCY_LABELS[f]}</option>)}
                <option value="once">Once (one-off)</option>
              </select>
            </Field>
            <Field label={frequency === 'once' ? (type === 'income' ? 'Expected on' : 'Due on') : item || draft ? 'First due date' : 'Next due date'} hint={frequency === 'monthly' && lastWorking ? 'Any date in the first month; it moves to the last working day.' : undefined}>
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </Field>
          </div>
          {frequency === 'monthly' && (
            <label className="check"><input type="checkbox" checked={lastWorking} onChange={(e) => setLastWorking(e.target.checked)} />
              <span>On the last working day of the month (skips weekends and UK bank holidays)</span></label>
          )}
          <div className="grid-2">
            <Field label={accountLabel}><AccountSelect value={accountId} onChange={setAccountId} exclude={type === 'saving' ? transferAccountId : null} /></Field>
            {type === 'saving' ? (
              <Field label="To"><AccountSelect value={transferAccountId} onChange={setTransfer} exclude={accountId} /></Field>
            ) : (
              <Field label="Category"><CategorySelect kind={type === 'income' ? 'income' : 'expense'} value={categoryId} onChange={setCategoryId} /></Field>
            )}
          </div>
          <Field label="Bank description contains" hint={type === 'saving' ? 'Optional: leave blank to match any transfer between these accounts.' : `Used to spot the payment in your transactions. Leave blank to use “${name || 'the name'}”.`}>
            <input value={matchPattern} onChange={(e) => setMatch(e.target.value)} placeholder={type === 'income' ? 'ACME LTD' : 'NETFLIX'} />
          </Field>
          {type === 'income' && frequency !== 'once' && (
            <p className="hint-box"><Icon name="info" size={16} />
              <span>Bonuses are handled automatically. If a bonus comes in the same payment as your salary, it's matched as that month's pay and shown as extra, and your usual salary stays the same. If it's paid separately, categorise it as <strong>Bonuses</strong>. To plan for one, add it as a one-off.</span></p>
          )}
          {shareable && frequency !== 'once' && (
            <SharedWith shares={shares} setShares={setShares} total={parseAmount(amount) ?? 0} applyToPast={applyToPast} setApplyToPast={setApplyToPast}
              hadShares={!!item?.shares.length} categoryName={categories.find((c) => c.id === categoryId)?.name ?? null} />
          )}
          <div className="grid-2">
            {frequency !== 'once' && <Field label="Ends (optional)"><input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} /></Field>}
            <Field label="Notes"><input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Contract ends March" /></Field>
          </div>
          {item && <label className="check"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /><span>Active (untick when cancelled; history is kept)</span></label>}
          {error && <p className="form-error">{error}</p>}
        </form>
      )}
      {confirmNode}
    </Modal>
  );
}

interface ShareDraft { name: string; amount: string; accountId: number | null; matchPattern: string }

/** People who pay you back for their part of this bill. */
function SharedWith({ shares, setShares, total, applyToPast, setApplyToPast, hadShares, categoryName }: {
  shares: ShareDraft[]; setShares: (s: ShareDraft[]) => void; total: number; applyToPast: boolean; setApplyToPast: (v: boolean) => void; hadShares: boolean; categoryName: string | null;
}) {
  const { accounts } = useApp();
  const [open, setOpen] = useState(shares.length > 0);
  const defaultAccount = accounts.find((a) => a.type === 'current')?.id ?? null;
  const set = (i: number, patch: Partial<ShareDraft>) => setShares(shares.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const back = shares.reduce((n, s) => n + (parseAmount(s.amount) ?? 0), 0);
  const last = shares[shares.length - 1];
  function add() {
    setShares([...shares, { name: '', amount: last?.amount ?? '', accountId: last?.accountId ?? defaultAccount, matchPattern: '' }]);
    setOpen(true);
  }
  function splitEvenly() {
    if (!total || !shares.length) return;
    const each = Math.floor(total / (shares.length + 1));
    setShares(shares.map((s) => ({ ...s, amount: penceToInput(each) })));
  }
  if (!open) {
    return <button type="button" className="link-btn" style={{ alignSelf: 'flex-start' }} onClick={add}><Icon name="plus" size={14} /> Others pay me back for this (shared or family plan)</button>;
  }
  return (
    <fieldset className="share-box">
      <legend>Shared with</legend>
      <p className="muted small">People who pay you back for their part. Their payments count against {categoryName ?? 'this bill'}, so your spending shows only your share.</p>
      {shares.map((s, i) => (
        <div key={i} className="share-row">
          <input aria-label="Name" value={s.name} onChange={(e) => set(i, { name: e.target.value })} placeholder="Name on their payment" />
          <div className="amount-field"><span>£</span><input aria-label="Amount" inputMode="decimal" value={s.amount} onChange={(e) => set(i, { amount: e.target.value })} placeholder="0.00" /></div>
          <select aria-label="Paid into" title="The account they pay into" value={s.accountId ?? ''} onChange={(e) => set(i, { accountId: e.target.value ? Number(e.target.value) : null })}>
            <option value="">Into any account</option>
            {accounts.filter((a) => !a.isLiability).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <button type="button" className="icon-btn" aria-label={`Remove ${s.name || 'person'}`} onClick={() => setShares(shares.filter((_, j) => j !== i))}><Icon name="x" size={16} /></button>
        </div>
      ))}
      <div className="row gap">
        <button type="button" className="btn btn-sm" onClick={add}><Icon name="plus" size={14} /> Add person</button>
        {shares.length > 0 && total > 0 && <button type="button" className="btn btn-sm" onClick={splitEvenly}>Split evenly with me</button>}
        <span className="spacer" />
        {shares.length > 0 && total > 0 && (
          <span className={`small ${back > total ? 'tone-bad' : 'muted'}`}>They pay {money(back)} · <strong>you pay {money(Math.max(0, total - back))}</strong></span>
        )}
      </div>
      {shares.length > 0 && (
        <label className="check"><input type="checkbox" checked={applyToPast} onChange={(e) => setApplyToPast(e.target.checked)} />
          <span>{hadShares ? 'Also update' : 'Also move'} their past payments to {categoryName ?? 'this category'} (matched by name, in any word order)</span></label>
      )}
    </fieldset>
  );
}

function History({ item }: { item: Recurring }) {
  return (
    <div className="form">
      {item.shareCycles.length > 0 && <ShareGrid item={item} />}
      {item.priceChanges.length > 0 && (
        <div className="price-changes">
          {item.priceChanges.slice().reverse().map((c) => (
            <div key={c.date} className={`price-change ${c.to > c.from ? 'up' : 'down'}`}>
              <Icon name={c.to > c.from ? 'trending-up' : 'chevron-down'} size={16} />
              <span>{c.to > c.from ? 'Price went up' : 'Price went down'} from {money(c.from)} to <strong>{money(c.to)}</strong></span>
              <span className="muted small">{shortDate(c.date)}</span>
            </div>
          ))}
        </div>
      )}
      {item.history.length === 0 ? <p className="muted">No payments matched yet. They're linked automatically when the transaction appears.</p> : (
        <ul className="history-list">
          {item.history.map((h) => (
            <li key={h.dueDate}>
              <span className="nowrap">{shortDate(h.dueDate)}</span>
              <span className="grow muted small">{h.status === 'skipped' ? 'Skipped' : h.description ?? 'Marked as paid'}{h.paidDate && h.paidDate !== h.dueDate ? ` · paid ${shortDate(h.paidDate)}` : ''}</span>
              {(() => { const x = item.extras.find((e) => e.date === (h.paidDate ?? h.dueDate)); return x ? <Badge tone="good">+{money(x.extra)} above usual</Badge> : null; })()}
              {h.status === 'paid' ? <><Badge tone="good">{item.type === 'income' ? 'Received' : 'Paid'}</Badge><span className="money strong-sm">{h.amount != null ? money(h.amount) : '—'}</span></> : <Badge>Skipped</Badge>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Who paid you back, per due date. */
export function ShareGrid({ item }: { item: Recurring }) {
  const cycles = item.shareCycles;
  return (
    <div className="share-grid-wrap">
      <table className="share-grid">
        <thead><tr><th>Paid you back</th>{cycles.map((c) => <th key={c.dueDate} className="num">{shortDate(c.dueDate)}</th>)}</tr></thead>
        <tbody>
          {item.shares.map((s) => (
            <tr key={s.id}>
              <td>{s.name} <span className="muted small">{money(s.amount)}</span></td>
              {cycles.map((c) => {
                const p = c.people.find((x) => x.shareId === s.id);
                return <td key={c.dueDate} className="num" title={p?.paidDate ? `${money(p.paid)} on ${shortDate(p.paidDate)}` : 'Not yet'}>
                  {p && p.paid > 0 ? <span className={p.paid < p.expected ? 'tone-warn' : 'tone-good'}>{p.paid === p.expected ? '✓' : money(p.paid)}</span> : <span className="muted">–</span>}
                </td>;
              })}
            </tr>
          ))}
          <tr className="share-total"><td>Received</td>{cycles.map((c) => <td key={c.dueDate} className="num">{money(c.received)}</td>)}</tr>
        </tbody>
      </table>
    </div>
  );
}
