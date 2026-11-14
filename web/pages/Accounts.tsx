import React, { useState } from 'react';
import { api, qs, type Account, type IsaAllowance, type ValuationPoint } from '../api.ts';
import { ACCOUNT_TYPE_LABELS, money, parseAmount, penceToInput, shortDate, timeAgo, pct } from '../format.ts';
import { Card, Field, Modal, Money, useApp, useConfirm, Stat, Badge, Progress, useData, usePageAdd } from '../components/ui.tsx';
import { ValueLine } from '../components/charts.tsx';
import { Icon } from '../components/Icon.tsx';
import { navigate } from '../router.ts';
import { useT212 } from '../components/T212.tsx';

const COLOURS = ['#006a4d', '#11b67a', '#2e77bb', '#5a9bd5', '#117aca', '#7433ff', '#e11d48', '#f97316', '#eab308', '#0ea5e9', '#14b8a6', '#64748b'];

export function Accounts() {
  const { accounts } = useApp();
  const [editing, setEditing] = useState<Account | 'new' | null>(null);
  usePageAdd('Add account', () => setEditing('new'));
  const [investing, setInvesting] = useState<Account | null>(null);
  const top = accounts.filter((a) => a.parentId === null);
  const children = (id: number) => accounts.filter((a) => a.parentId === id);
  const assets = accounts.filter((a) => !a.isLiability).reduce((s, a) => s + a.balance, 0);
  const debts = accounts.filter((a) => a.isLiability).reduce((s, a) => s + a.balance, 0);

  const groups = [
    { title: 'Everyday', items: top.filter((a) => a.type === 'current' || a.type === 'cash') },
    { title: 'Savings', items: top.filter((a) => a.type === 'savings' || a.type === 'pot' || a.type === 'other_asset') },
    { title: 'Investments', items: top.filter((a) => a.type === 'investment') },
    { title: 'Credit cards and loans', items: top.filter((a) => a.isLiability) },
  ];

  return (
    <div className="page">
      <div className="stats">
        <Stat label="What you have" value={<Money value={assets} />} />
        <Stat label="What you owe" value={<Money value={-debts} />} tone={debts < 0 ? 'bad' : undefined} />
        <Stat label="Net worth" value={<Money value={assets + debts} />} />
        <div className="stat stat-action">
          <button className="btn btn-primary" onClick={() => setEditing('new')}><Icon name="plus" size={16} /> Add account</button>
        </div>
      </div>

      {groups.map((g) => g.items.length > 0 && (
        <Card key={g.title} title={g.title} pad={false}>
          <ul className="acct-list">
            {g.items.map((a) => (
              <React.Fragment key={a.id}>
                <AccountRow a={a} onEdit={() => setEditing(a)} onInvest={a.type === 'investment' ? () => setInvesting(a) : undefined} />
                {children(a.id).map((c) => <AccountRow key={c.id} a={c} child onEdit={() => setEditing(c)} />)}
              </React.Fragment>
            ))}
          </ul>
        </Card>
      ))}

      <IsaCard />

      <ArchivedAccounts />

      <p className="muted small center">Balances are worked out from a balance you confirm on a date, plus every transaction before or after it. Importing a CSV with a balance column keeps this up to date automatically.</p>

      {editing && <AccountForm account={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {investing && <InvestmentModal account={accounts.find((a) => a.id === investing.id) ?? investing} onClose={() => setInvesting(null)} />}
    </div>
  );
}

function AccountRow({ a, child, onEdit, onInvest }: { a: Account; child?: boolean; onEdit: () => void; onInvest?: () => void }) {
  if (a.type === 'investment') {
    return (
      <li className="acct">
        <span className="acct-colour" style={{ background: a.colour }} />
        <button className="acct-main" onClick={onInvest}>
          <span className="acct-name">{a.name} {a.wrapper === 'isa' && <span className="tag">ISA</span>}</span>
          <span className="acct-meta">
            {a.contributed != null && <>Paid in {money(a.contributed)} · </>}
            {a.syncProvider === 'trading212'
              ? a.syncError ? <span className="tone-bad">Sync problem: {a.syncError}</span> : a.lastSyncedAt ? <>Synced with Trading 212 {timeAgo(a.lastSyncedAt)}</> : 'Not synced yet'
              : a.valuationDate ? <>Valued {shortDate(a.valuationDate)}</> : 'No valuation yet'}
          </span>
        </button>
        <span className="acct-balance">
          <Money value={a.balance} />
          {a.growth != null && <span className={`small ${a.growth >= 0 ? 'tone-good' : 'tone-bad'}`}>{money(a.growth, { sign: true })}{a.contributed ? ` (${pct(a.growth / a.contributed, 1)})` : ''}</span>}
        </span>
        <button className="icon-btn" onClick={onEdit} aria-label={`Edit ${a.name}`}><Icon name="edit" size={16} /></button>
      </li>
    );
  }
  return (
    <li className={`acct ${child ? 'acct-child' : ''}`}>
      <span className="acct-colour" style={{ background: a.colour }} />
      <button className="acct-main" onClick={() => navigate(`/transactions${qs({ accountId: a.id })}`)}>
        <span className="acct-name">{a.name}</span>
        <span className="acct-meta">
          {ACCOUNT_TYPE_LABELS[a.type]}{a.institution ? ` · ${a.institution}` : ''} · {a.transactionCount} transactions
          {a.anchorDate && <> · balance confirmed {shortDate(a.anchorDate)}</>}
        </span>
      </button>
      <span className="acct-balance">
        {a.isLiability ? (
          a.balance < 0 ? <><Money value={-a.balance} /><span className="muted small">owed</span></> : a.balance === 0 ? <Badge tone="good">Paid off</Badge> : <><Money value={a.balance} /><span className="muted small">in credit</span></>
        ) : <Money value={a.balance} className={a.balance < 0 ? 'tone-bad' : ''} />}
      </span>
      <button className="icon-btn" onClick={onEdit} aria-label={`Edit ${a.name}`}><Icon name="edit" size={16} /></button>
    </li>
  );
}

function AccountForm({ account, onClose }: { account: Account | null; onClose: () => void }) {
  const { accounts, meta, refresh, toast } = useApp();
  const [confirm, confirmNode] = useConfirm();
  const [name, setName] = useState(account?.name ?? '');
  const [type, setType] = useState(account?.type ?? 'current');
  const [institution, setInstitution] = useState(account?.institution ?? '');
  const [parentId, setParentId] = useState<number | null>(account?.parentId ?? null);
  const [colour, setColour] = useState(account?.colour ?? COLOURS[Math.floor(Math.random() * COLOURS.length)]);
  const isLiab = ['credit_card', 'loan', 'other_liability'].includes(type);
  const initialBal = account ? (isLiab ? -account.balance : account.type === 'investment' ? account.contributed ?? 0 : account.balance) : 0;
  const [balance, setBalance] = useState(account ? penceToInput(initialBal) : '');
  const [balNegative, setBalNegative] = useState(initialBal < 0);
  const [balanceDate, setBalanceDate] = useState(meta.today);
  const [isa, setIsa] = useState(account ? account.wrapper === 'isa' : true);
  const [sync, setSync] = useState(account ? account.syncProvider === 'trading212' : false);
  const isInvestment = type === 'investment';
  const ledgerBalance = account?.type === 'investment' ? account.contributed ?? 0 : account?.balance ?? 0;
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    let pence = balance.trim() === '' ? 0 : parseAmount(balance);
    if (pence === null) return setError('Enter the balance as a number, e.g. 1250.00');
    if (balNegative) pence = -pence;
    // Liabilities are stored as negative (what you owe).
    const stored = isLiab ? -pence : pence;
    const balanceChanged = !account || stored !== ledgerBalance || balanceDate !== meta.today;
    const body: any = {
      name, type, institution: institution || null, parentId: type === 'pot' ? parentId : null, colour,
      wrapper: isInvestment && isa ? 'isa' : null, syncProvider: isInvestment && sync ? 'trading212' : null,
    };
    if (balanceChanged) { body.balance = stored; body.balanceDate = balanceDate; }
    try {
      if (account) await api.put(`/api/accounts/${account.id}`, body);
      else await api.post('/api/accounts', body);
      toast(account ? 'Account updated' : 'Account added');
      refresh();
      onClose();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function archive() {
    if (!account) return;
    await api.put(`/api/accounts/${account.id}`, { archived: true });
    toast('Account archived');
    refresh();
    onClose();
  }

  async function remove() {
    if (!account) return;
    if (!(await confirm(`Delete ${account.name}? This only works for accounts with no transactions.`))) return;
    try {
      await api.del(`/api/accounts/${account.id}`);
      toast('Account deleted');
      refresh();
      onClose();
    } catch (err: any) {
      setError(err.message);
    }
  }

  return (
    <Modal title={account ? 'Edit account' : 'Add account'} onClose={onClose}
      footer={<>
        {account && (account.transactionCount > 0
          ? <button type="button" className="btn btn-ghost" onClick={archive}><Icon name="archive" size={16} /> Archive</button>
          : <button type="button" className="btn btn-ghost-danger" onClick={remove}><Icon name="trash" size={16} /> Delete</button>)}
        <span className="spacer" />
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="submit" form="acct-form" className="btn btn-primary">Save</button>
      </>}>
      <form id="acct-form" className="form" onSubmit={save}>
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Current account" /></Field>
        <div className="grid-2">
          <Field label="Type">
            <select value={type} onChange={(e) => setType(e.target.value)}>
              {meta.accountTypes.map((t) => <option key={t} value={t}>{ACCOUNT_TYPE_LABELS[t]}</option>)}
            </select>
          </Field>
          <Field label="Bank"><input value={institution} onChange={(e) => setInstitution(e.target.value)} placeholder="Bank name" /></Field>
        </div>
        {type === 'pot' && (
          <Field label="Pot belongs to" hint="For pots or spaces, choose the account they belong to.">
            <select value={parentId ?? ''} onChange={(e) => setParentId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">None</option>
              {accounts.filter((a) => a.parentId === null && !a.isLiability && a.id !== account?.id).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
        )}
        <div className="grid-2">
          <Field label={isLiab ? 'Amount owed' : isInvestment ? 'Total paid in' : 'Balance'}
            hint={isLiab ? 'What the card statement says you owe' : isInvestment ? 'Everything you’ve contributed so far (not its current value)' : 'As shown in your banking app'}>
            <div className="amount-field">
              <span>£</span>
              <input inputMode="decimal" value={balance} onChange={(e) => setBalance(e.target.value)} placeholder="0.00" />
            </div>
          </Field>
          <Field label="At the end of"><input type="date" value={balanceDate} onChange={(e) => setBalanceDate(e.target.value)} max={meta.today} /></Field>
        </div>
        {isInvestment && (
          <>
            <label className="check"><input type="checkbox" checked={isa} onChange={(e) => setIsa(e.target.checked)} /><span>This is an ISA (counts towards your £20,000 allowance)</span></label>
            <label className="check"><input type="checkbox" checked={sync} onChange={(e) => setSync(e.target.checked)} /><span>Get the value from Trading 212 automatically (needs your API key: {meta.desktop ? 'add it in Settings → Trading 212' : <>in <code>.env</code></>})</span></label>
          </>
        )}
        {!isLiab && !isInvestment && (
          <label className="check"><input type="checkbox" checked={balNegative} onChange={(e) => setBalNegative(e.target.checked)} /><span>Overdrawn</span></label>
        )}
        <Field label="Colour">
          <div className="swatches">
            {COLOURS.map((c) => (
              <button type="button" key={c} className={`swatch ${c === colour ? 'on' : ''}`} style={{ background: c }} onClick={() => setColour(c)} aria-label={`Colour ${c}`} />
            ))}
          </div>
        </Field>
        {account && !isInvestment && <p className="muted small">Current balance: {money(account.balance)}. Changing the balance re-anchors the account. Past transactions are kept.</p>}
        {error && <p className="form-error">{error}</p>}
      </form>
      {confirmNode}
    </Modal>
  );
}

function IsaCard() {
  const { data } = useData<IsaAllowance>(() => api.get('/api/isa'), []);
  if (!data || data.accounts.length === 0) return null;
  const share = data.used / data.allowance;
  return (
    <Card title={`ISA allowance ${data.taxYear}`} action={<span className="muted small">6 Apr to 5 Apr</span>}>
      <div className="isa">
        <div className="row gap" style={{ justifyContent: 'space-between' }}>
          <span><Money value={data.used} className="strong" /> <span className="muted">paid in of {money(data.allowance, { compact: true })}</span></span>
          <span className="muted small">{money(data.remaining)} left until {shortDate(data.end)}</span>
        </div>
        <Progress value={data.used} max={data.allowance} tone={share >= 1 ? 'bad' : share >= 0.9 ? 'warn' : 'good'} />
        <p className="muted small">
          {data.source === 'trading212' ? 'From Trading 212’s record of deposits. ' : 'From transfers into your ISA this tax year. '}
          {data.replaceable ? `${money(data.replaceable)} you took out can go back in without using allowance. ` : ''}
          <button className="link-btn" onClick={() => navigate('/investing?view=isa')}>Details</button>
        </p>
      </div>
    </Card>
  );
}

function InvestmentModal({ account, onClose }: { account: Account; onClose: () => void }) {
  const { meta, refresh, toast } = useApp();
  const { data: history, reload } = useData<ValuationPoint[]>(() => api.get(`/api/accounts/${account.id}/valuations`), [account.id]);
  const [value, setValue] = useState('');
  const [date, setDate] = useState(meta.today);
  const [error, setError] = useState<string | null>(null);
  const t212 = useT212(reload);
  const syncing = !!t212.status?.running;
  const latest = history && history.length ? history[history.length - 1] : null;

  async function addValuation(e: React.FormEvent) {
    e.preventDefault();
    const pence = parseAmount(value);
    if (pence === null) return setError('Enter the value, e.g. 12450.00');
    try {
      await api.post(`/api/accounts/${account.id}/valuations`, { date, value: pence });
      setValue('');
      toast('Value saved');
      refresh();
      reload();
    } catch (err: any) { setError(err.message); }
  }

  return (
    <Modal title={account.name} onClose={onClose} wide>
      <div className="form">
        <div className="stats stats-3">
          <Stat label="Value" value={<Money value={account.balance} />} sub={account.valuationDate ? `as of ${shortDate(account.valuationDate)}` : 'No valuation yet'} />
          <Stat label="Paid in" value={<Money value={account.contributed ?? 0} />} />
          <Stat label="Growth" value={<Money value={account.growth ?? 0} sign />} tone={(account.growth ?? 0) >= 0 ? 'good' : 'bad'}
            sub={account.contributed && account.growth != null ? pct(account.growth / account.contributed, 1) : undefined} />
        </div>
        {history && history.length >= 2 && (
          <div>
            <span className="legend"><i className="lg-income" />Value <i className="lg-contrib" />Paid in</span>
            <ValueLine points={history} />
          </div>
        )}
        {latest?.details && latest.source === 'trading212' && (
          <div className="cash-split small">
            <div><span className="muted">Invested</span><strong><Money value={latest.details.investments ?? 0} /></strong></div>
            <div><span className="muted">Cash</span><strong><Money value={latest.details.cash ?? 0} /></strong></div>
            {latest.details.unrealisedProfitLoss != null && <div><span className="muted">Unrealised</span><strong><Money value={latest.details.unrealisedProfitLoss} sign /></strong></div>}
          </div>
        )}
        {t212.status?.cash?.nudge && account.id === t212.status.accountId && (
          <p className="tone-warn small"><Icon name="info" size={14} /> {money(t212.status.cash.amount)} has been sitting uninvested for {t212.status.cash.days} days.</p>
        )}
        {account.syncProvider === 'trading212' && (
          <button className="link-btn" style={{ alignSelf: 'flex-start' }} onClick={() => { onClose(); navigate('/investing'); }}>See holdings and pies →</button>
        )}
        {account.syncProvider === 'trading212' && (
          <div className="row gap">
            <button className="btn" onClick={() => t212.sync()} disabled={syncing || !meta.trading212.configured}><Icon name="refresh" size={16} /> {syncing ? 'Syncing…' : 'Sync now'}</button>
            <span className="muted small">{syncing ? `Reading ${t212.status?.step?.toLowerCase() ?? 'your account'}…` : <>{account.lastSyncedAt ? `Last synced ${timeAgo(account.lastSyncedAt)}. ` : ''}Syncs automatically every 6 hours while the app is running. Details in Settings.</>}</span>
            {!meta.trading212.configured && <span className="tone-bad small">{meta.desktop ? 'Add your API key in Settings → Trading 212' : 'No API key found in .env'}</span>}
          </div>
        )}
        <form className="row gap end" onSubmit={addValuation}>
          <Field label="Or enter the value yourself"><div className="amount-field"><span>£</span><input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder="12450.00" /></div></Field>
          <Field label="On"><input type="date" value={date} max={meta.today} onChange={(e) => setDate(e.target.value)} /></Field>
          <button className="btn" type="submit">Save value</button>
        </form>
        {error && <p className="form-error">{error}</p>}
        <p className="muted small">Money you transfer in counts as saving, not spending. Changes in value are growth, never income.</p>
      </div>
    </Modal>
  );
}

/** Accounts you've archived (closed cards, paid-off loans): hidden everywhere else, kept here with their history. */
function ArchivedAccounts() {
  const { refresh, toast } = useApp();
  const { data } = useData<Account[]>(() => api.get('/api/accounts?archived=1'), []);
  const [open, setOpen] = useState(false);
  const archived = (data ?? []).filter((a) => a.archived);
  if (!archived.length) return null;
  async function restore(a: Account) {
    await api.put(`/api/accounts/${a.id}`, { archived: false });
    toast(`${a.name} is back`);
    refresh();
  }
  return (
    <Card title={`Archived (${archived.length})`} pad={false} action={<button className="link-btn" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'}</button>}>
      {open ? (
        <ul className="acct-list">
          {archived.map((a) => (
            <li key={a.id} className="acct is-archived">
              <span className="acct-colour" style={{ background: a.colour }} />
              <button className="acct-main" onClick={() => navigate(`/transactions?accountId=${a.id}&month=all`)} title="See its transactions">
                <span className="acct-name">{a.name}</span>
                <span className="acct-meta">{ACCOUNT_TYPE_LABELS[a.type] ?? a.type}{a.isLiability ? (a.balance >= 0 ? ' · paid off' : ` · ${money(-a.balance)} owed`) : ` · ${money(a.balance)}`}</span>
              </button>
              <button className="btn btn-sm" onClick={() => restore(a)}><Icon name="undo" size={14} /> Unarchive</button>
            </li>
          ))}
        </ul>
      ) : <p className="muted small" style={{ padding: '0 20px 16px' }}>Paid-off loans and closed accounts. They're left out of balances and lists but keep their history.</p>}
    </Card>
  );
}
