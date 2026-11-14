import React, { useEffect, useState } from 'react';
import { api, qs } from '../api.ts';
import { addMonths, money, monthLabel, parseAmount, penceToInput, pct, shortDate } from '../format.ts';
import { AccountSelect, Badge, Card, Empty, Field, Modal, Money, Progress, Segmented, Stat, useApp, useConfirm, useData, usePageAdd } from '../components/ui.tsx';
import { Icon } from '../components/Icon.tsx';
import { navigate } from '../router.ts';

type DebtType = 'credit_card' | 'pay_in_3' | 'personal_loan' | 'student_loan' | 'bnpl' | 'car_finance' | 'overdraft' | 'personal' | 'other';
type Strategy = 'minimum' | 'snowball' | 'avalanche';
interface Statement { from: string; to: string; current: boolean; purchases: number; refunds: number; interest: number; payments: number; closing: number }

interface Details {
  debtType: DebtType; originalBalance: number; apr: number; promoApr: number | null; promoEnd: string | null; rateNow: number;
  minType: 'fixed' | 'card'; minFixed: number; minPercent: number; minFloor: number; dueDay: number | null; frequency: string;
  paysInFull: boolean; paymentAccountId: number | null; notes: string | null; paidOff: number; progress: number;
  interestNext: number; minimum: number; nextDue: string | null;
  startDate: string | null; instalments: number | null; provider: string | null; finalDate: string | null; overdue: boolean;
  schedule: { n: number; date: string; amount: number; paid: boolean; outstanding: number }[] | null;
  statementDay: number | null; statementDue: number | null; statements: Statement[] | null;
  atMinimum: { months: number | null; debtFree: string | null; totalInterest: number; never: boolean } | null;
}
interface DebtItem {
  accountId: number; name: string; colour: string; accountType: string; institution: string | null; owed: number; inCredit: number; group: 'card' | 'bnpl' | 'loan';
  uncounted: { postingId: number; transactionId: number; date: string; description: string; amount: number }[];
  balanceCheck: { confirmedOn: string; confirmedOwed: number; addedSince: number; paidSince: number; countSince: number; countBefore: number };
  details: Details | null; repayments: { id: number; date: string; amount: number; from: string | null }[];
  interestPaidYear: number; repaidYear: number; history: { month: string; owed: number }[]; hasRepayment: boolean;
}
interface DebtList {
  items: DebtItem[];
  totals: { owed: number; minimums: number; statements: number; monthlyCommitment: number; paidOff: number; progress: number | null; interestNext: number; interestPaidYear: number; missingDetails: number };
  history: { month: string; owed: number }[];
}
interface Sim { strategy: Strategy; months: number | null; debtFree: string | null; totalInterest: number; totalPaid: number; order: { id: number; name: string; month: string; months: number }[]; series: { month: string; total: number }[]; shortfall: boolean; never: boolean }
interface Plan { debts: { id: number; name: string; balance: number; apr: number }[]; minimumPayment: number; monthly: number; preferred: Strategy; strategies: Record<Strategy, Sim> }

export const DEBT_LABELS: Record<DebtType, string> = {
  credit_card: 'Credit card', pay_in_3: 'Pay in 3 (Klarna, PayPal…)', personal_loan: 'Personal loan', student_loan: 'Student loan', bnpl: 'Buy now, pay later',
  car_finance: 'Car finance', overdraft: 'Overdraft', personal: 'Money owed to someone', other: 'Other',
};

const aprText = (bp: number) => `${(bp / 100).toFixed(bp % 100 === 0 ? 0 : 2)}%`;

export function Debts() {
  const { data, error } = useData<DebtList>(() => api.get('/api/debts'), []);
  const [editing, setEditing] = useState<DebtItem | 'new' | 'new-pay3' | null>(null);
  usePageAdd('Add debt', () => setEditing('new'));
  if (error) return <Empty icon="alert" title="Couldn't load debts">{error}</Empty>;
  if (!data) return <div className="loading" />;
  const { items, totals } = data;
  const active = items.filter((i) => i.owed > 0 || i.details);
  const cards = items.filter((i) => i.group === 'card');
  const bnpl = active.filter((i) => i.group === 'bnpl');
  const loans = active.filter((i) => i.group === 'loan');
  const owedIn = (list: DebtItem[]) => list.reduce((s, i) => s + i.owed, 0);

  return (
    <div className="page">
      <div className="stats">
        <Stat label="Total owed" value={<Money value={totals.owed} />} tone={totals.owed > 0 ? 'bad' : undefined}
          sub={totals.interestNext > 0 ? `About ${money(totals.interestNext)} interest next month` : 'No interest being charged'} />
        <Stat label="Monthly payments" value={<Money value={totals.monthlyCommitment} />}
          sub={totals.statements > 0 ? `${money(totals.minimums, { compact: true })} minimums + ${money(totals.statements, { compact: true })} cleared in full` : 'Minimum payments due'} />
        <Stat label="Paid off so far" value={<Money value={totals.paidOff} />} sub={totals.progress != null ? `${pct(totals.progress)} of what you borrowed` : 'Add original balances to track this'} />
        <Stat label="Interest in the last year" value={<Money value={totals.interestPaidYear} />} sub="Interest and fees charged" />
      </div>

      {totals.missingDetails > 0 && (
        <div className="banner banner-info" style={{ cursor: 'default' }}>
          <Icon name="info" size={16} />
          <span>Add the APR and payment details for {totals.missingDetails} account{totals.missingDetails === 1 ? '' : 's'} to see payoff dates and interest.</span>
        </div>
      )}

      <div className="row gap" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={() => setEditing('new-pay3')}><Icon name="plus" size={16} /> Add pay in 3</button>
        <button className="btn btn-primary" onClick={() => setEditing('new')}><Icon name="plus" size={16} /> Add a loan or debt</button>
      </div>

      <DebtSection title="Credit cards" sub={cards.length ? `${money(owedIn(cards))} on ${cards.length} card${cards.length === 1 ? '' : 's'}` : undefined}
        empty="Add your credit cards on the Accounts page." items={cards} onEdit={setEditing} />
      <DebtSection title="Pay in 3 and buy now, pay later" sub={bnpl.length ? `${money(owedIn(bnpl))} left to pay` : undefined}
        empty={<>Nothing to pay. Track a Klarna, PayPal or Clearpay plan with <button className="link-btn" onClick={() => setEditing('new-pay3')}>Add pay in 3</button>.</>} items={bnpl} onEdit={setEditing} />
      <DebtSection title="Loans and other debts" sub={loans.length ? `${money(owedIn(loans))} owed` : undefined}
        empty="No loans. Add a loan, car finance or money you owe someone with “Add a loan or debt”." items={loans} onEdit={setEditing} />

      <Timeline />
      <PayoffPlanIfUseful hasDebts={items.some((i) => i.details && !i.details.paysInFull && i.owed > 0)} />

      {editing && <DebtForm item={typeof editing === 'string' ? null : editing} startType={editing === 'new-pay3' ? 'pay_in_3' : undefined} onClose={() => setEditing(null)} />}
    </div>
  );
}

function DebtSection({ title, sub, empty, items, onEdit }: { title: string; sub?: string; empty: React.ReactNode; items: DebtItem[]; onEdit: (d: DebtItem) => void }) {
  return (
    <section className="stack" style={{ gap: 12 }}>
      <div className="section-head"><h2>{title}</h2>{sub && <span className="muted small">{sub}</span>}</div>
      {items.length === 0
        ? <p className="muted small debt-empty">{empty}</p>
        : <div className="debt-grid">{items.map((d) => d.details?.schedule ? <PayInCard key={d.accountId} d={d} onEdit={() => onEdit(d)} /> : <DebtCard key={d.accountId} d={d} onEdit={() => onEdit(d)} />)}</div>}
    </section>
  );
}

/** A split payment: what's paid, what's next and the full schedule. */
function PayInCard({ d, onEdit }: { d: DebtItem; onEdit: () => void }) {
  const { refresh, toast, meta } = useApp();
  const det = d.details!;
  const sched = det.schedule!;
  const paidCount = sched.filter((s) => s.paid).length;
  const next = sched.find((s) => !s.paid);
  const [linking, setLinking] = useState(false);
  async function addRepayment() {
    try {
      await api.post(`/api/debts/${d.accountId}/repayment`, {});
      toast('Payments added to Bills and income');
      refresh();
    } catch (e: any) { toast(e.message, 'error'); }
  }
  return (
    <div className="card card-pad debt">
      <div className="debt-top">
        <span className="acct-colour" style={{ background: d.colour, height: 36 }} />
        <div className="grow">
          <div className="budget-name">{d.name}
            {d.owed === 0 ? <Badge tone="good">Paid off</Badge> : det.overdue ? <Badge tone="bad">Payment late</Badge> : null}
          </div>
          <div className="budget-cats">{det.provider ?? 'Pay in 3'} · {sched.length} {det.frequency === 'monthly' ? 'monthly' : det.frequency === 'fortnightly' ? 'fortnightly' : 'weekly'} payments · started {shortDate(det.startDate!)}</div>
        </div>
        {d.owed === 0 ? <ArchiveButton d={d} /> : <button className="btn btn-sm" onClick={onEdit}><Icon name="edit" size={14} /> Edit</button>}
      </div>
      <div className="budget-figures">
        <span className="budget-left">{money(d.owed)} <span className="muted small" style={{ fontWeight: 500, letterSpacing: 0 }}>left</span></span>
        <span className="muted small">{money(det.paidOff)} paid of {money(det.originalBalance)}</span>
      </div>
      <Progress value={det.paidOff} max={det.originalBalance} tone="good" />
      <dl className="debt-facts">
        <div><dt>Next payment</dt><dd className={det.overdue ? 'tone-bad' : ''}>{next ? <>{money(next.outstanding)} · {relativeShort(next.date, meta.today)}</> : '—'}</dd></div>
        <div><dt>Payments made</dt><dd>{paidCount} of {sched.length}</dd></div>
        <div><dt>Final payment</dt><dd>{det.finalDate ? shortDate(det.finalDate) : '—'}</dd></div>
        <div><dt>Interest</dt><dd>£0.00</dd></div>
      </dl>
      <ol className="instalments">
        {sched.map((s) => (
          <li key={s.n} className={s.paid ? 'paid' : s.date < meta.today ? 'late' : s === next ? 'next' : ''}>
            <span className="inst-mark">{s.paid ? <Icon name="check" size={13} /> : s.n}</span>
            <span className="grow">{shortDate(s.date)}</span>
            <Money value={s.amount} />
          </li>
        ))}
      </ol>
      <div className="budget-foot">
        <span>{d.repayments[0] ? <>Last paid {money(d.repayments[0].amount)} on {shortDate(d.repayments[0].date)}</> : 'Payments show here when you record or import them'}</span>
        <span className="row gap">
          <button className="link-btn" onClick={() => setLinking(true)}>Link a payment</button>
          {!d.hasRepayment && det.paymentAccountId && d.owed > 0 && <button className="link-btn" onClick={addRepayment}>Add to bills</button>}
          <button className="link-btn" onClick={() => navigate(`/transactions${qs({ accountId: d.accountId, month: 'all' })}`)}>Transactions</button>
        </span>
      </div>
      <Uncounted d={d} />
      <BalanceNote d={d} />
      {linking && <LinkPayments d={d} onClose={() => setLinking(false)} />}
    </div>
  );
}

function relativeShort(iso: string, today: string): string {
  const days = Math.round((Date.parse(`${iso}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days < 0) return `${shortDate(iso)} (late)`;
  return days <= 14 ? `in ${days} days` : shortDate(iso);
}

function DebtCard({ d, onEdit }: { d: DebtItem; onEdit: () => void }) {
  const { refresh, toast } = useApp();
  const [linking, setLinking] = useState(false);
  const det = d.details;
  const max = Math.max(1, ...d.history.map((h) => h.owed));
  async function addRepayment() {
    try {
      await api.post(`/api/debts/${d.accountId}/repayment`, {});
      toast('Repayment added to Bills and income');
      refresh();
    } catch (e: any) { toast(e.message, 'error'); }
  }
  return (
    <div className="card card-pad debt">
      <div className="debt-top">
        <span className="acct-colour" style={{ background: d.colour, height: 36 }} />
        <div className="grow">
          <div className="budget-name">{d.name}
            {det?.paysInFull && <Badge tone="good">Paid in full monthly</Badge>}
            {det?.promoApr != null && det.promoEnd && det.rateNow === det.promoApr && <Badge tone="info">{aprText(det.promoApr)} until {shortDate(det.promoEnd)}</Badge>}
          </div>
          <div className="budget-cats">{det ? DEBT_LABELS[det.debtType] : 'Debt'}{d.institution ? ` · ${d.institution}` : ''}</div>
        </div>
        {d.owed === 0 && d.group !== 'card' ? <ArchiveButton d={d} />
          : <button className="btn btn-sm" onClick={onEdit}>{det ? <><Icon name="edit" size={14} /> Edit</> : <><Icon name="plus" size={14} /> Add details</>}</button>}
      </div>

      <div className="budget-figures">
        <span className="budget-left">{money(d.owed)} <span className="muted small" style={{ fontWeight: 500, letterSpacing: 0 }}>owed</span></span>
        {det && det.originalBalance > 0 && <span className="muted small">{money(det.paidOff)} paid off of {money(Math.max(det.originalBalance, d.owed))}</span>}
      </div>
      {det && det.originalBalance > 0 && <Progress value={det.paidOff} max={Math.max(det.originalBalance, d.owed)} tone="good" />}

      {det ? (
        <dl className="debt-facts">
          <div><dt>APR</dt><dd>{aprText(det.rateNow)}{det.rateNow !== det.apr && <span className="muted small"> then {aprText(det.apr)}</span>}</dd></div>
          <div><dt>{det.paysInFull ? 'Statement' : 'Minimum'}</dt><dd>{money(det.minimum)}</dd></div>
          <div><dt>Next due</dt><dd>{det.nextDue ? shortDate(det.nextDue) : <button className="link-btn" onClick={onEdit}>Set date</button>}</dd></div>
          <div><dt>Interest next month</dt><dd>{det.paysInFull ? '£0.00' : money(det.interestNext)}</dd></div>
        </dl>
      ) : null}

      {det && !det.paysInFull && det.atMinimum && d.owed > 0 && (
        <p className={`small ${det.atMinimum.never ? 'tone-bad' : 'muted'}`}>
          {det.atMinimum.never
            ? 'At the minimum payment this debt never clears. The payment is less than the interest.'
            : <>Paying the minimum: debt-free in <strong>{monthLabel(det.atMinimum.debtFree!)}</strong> ({det.atMinimum.months} months), costing {money(det.atMinimum.totalInterest)} in interest.</>}
        </p>
      )}

      {det?.statements ? <Statements accountId={d.accountId} list={det.statements} due={det.statementDue} nextDue={det.nextDue} />
        : d.accountType === 'credit_card' && det ? <p className="muted small">Add your statement dates (Edit) to see each statement and its transactions.</p> : null}

      {d.history.length >= 2 ? (
        <div className="debt-history" aria-label="Balance at the end of each month">
          {d.history.map((h) => (
            <span key={h.month} title={`${monthLabel(h.month)}: ${money(h.owed)}`} style={{ height: `${Math.max(2, (h.owed / max) * 36)}px` }} />
          ))}
        </div>
      ) : <p className="muted small">Balance history builds up as you import statements.</p>}

      <div className="budget-foot">
        <span>{d.repayments[0] ? <>Last repayment {money(d.repayments[0].amount)} on {shortDate(d.repayments[0].date)}{d.repaidYear ? ` · ${money(d.repaidYear, { compact: true })} this year` : ''}</> : 'No repayments recorded yet'}</span>
        <span className="row gap">
          <button className="link-btn" onClick={() => setLinking(true)}>Link a payment</button>
          {det && !d.hasRepayment && det.paymentAccountId && d.owed > 0 && <button className="link-btn" onClick={addRepayment}>Add to bills</button>}
          <button className="link-btn" onClick={() => navigate(`/transactions${qs({ accountId: d.accountId, month: 'all' })}`)}>Transactions</button>
        </span>
      </div>
      <Uncounted d={d} />
      <BalanceNote d={d} />
      {linking && <LinkPayments d={d} onClose={() => setLinking(false)} />}
    </div>
  );
}

/**
 * Repayments dated on or before the day you confirmed the balance, added after you confirmed it.
 * The app can't tell whether your figure already allowed for them, so it asks.
 */
function Uncounted({ d }: { d: DebtItem }) {
  const { refresh, toast } = useApp();
  if (!d.uncounted.length) return null;
  const total = d.uncounted.reduce((s, u) => s + u.amount, 0);
  const one = d.uncounted.length === 1;
  async function review(apply: boolean) {
    try {
      await api.post(`/api/debts/${d.accountId}/review`, { postingIds: d.uncounted.map((u) => u.postingId), apply });
      toast(apply ? `Took ${money(total)} off ${d.name}` : 'Left the balance as it is');
      refresh();
    } catch (e: any) { toast(e.message, 'error'); }
  }
  return (
    <div className="uncounted">
      <p className="small">
        <strong>{one ? `${money(total)} repayment on ${shortDate(d.uncounted[0].date)}` : `${d.uncounted.length} repayments (${money(total)})`}</strong>{' '}
        {one && d.uncounted[0].date === d.balanceCheck.confirmedOn ? 'is from the same day you set the amount owed' : `${one ? 'is' : 'are'} from before ${shortDate(d.balanceCheck.confirmedOn)}, when you set the amount owed`}, so {one ? "it hasn't" : "they haven't"} been taken off yet.
        Should {one ? 'it' : 'they'} come off {money(d.owed)}?
      </p>
      {!one && <ul className="small muted">{d.uncounted.map((u) => <li key={u.postingId}>{shortDate(u.date)} · {u.description} · {money(u.amount)}</li>)}</ul>}
      <div className="row gap">
        <button className="btn btn-sm btn-primary" onClick={() => review(true)}>Take {money(total)} off</button>
        <button className="btn btn-sm" onClick={() => review(false)}>No, it was already included</button>
      </div>
    </div>
  );
}

/** Shows how "owed" is worked out, so it's clear why a purchase did or didn't change it. */
function BalanceNote({ d }: { d: DebtItem }) {
  const { meta } = useApp();
  const b = d.balanceCheck;
  const [open, setOpen] = useState(false);
  return (
    <div className="balance-note small">
      <button className="link-btn small" onClick={() => setOpen(!open)}>{open ? 'Hide breakdown' : `How is ${money(d.owed)} worked out?`}</button>
      {open && (
        <div className="muted">
          <div className="bn-row"><span>Balance you confirmed on {shortDate(b.confirmedOn)}</span><Money value={b.confirmedOwed} /></div>
          <div className="bn-row"><span>+ Spent on it since ({b.countSince ? `${b.countSince} transaction${b.countSince === 1 ? '' : 's'}` : 'none yet'})</span><Money value={b.addedSince} /></div>
          <div className="bn-row"><span>− Paid off since</span><Money value={b.paidSince} /></div>
          <div className="bn-row strong" style={{ color: 'var(--text)' }}><span>Owed now</span><Money value={d.owed} /></div>
          <p style={{ marginTop: 6 }}>
            Every purchase on {d.name} adds to what you owe and every repayment takes it off.
            {b.countBefore > 0 && <> The {b.countBefore} transaction{b.countBefore === 1 ? '' : 's'} dated on or before {shortDate(b.confirmedOn)} {b.countBefore === 1 ? 'is' : 'are'} already part of the confirmed balance{b.confirmedOn === meta.today ? ' (you set it today), so they don\'t move it again' : ''}.</>}
            If the balance is wrong, update it on the Accounts page with the figure from your app or statement.
          </p>
        </div>
      )}
    </div>
  );
}

interface Candidate { id: number; date: string; description: string; kind: string; amount: number; accountName: string; categoryName: string | null; linkedTo: string | null }

/** Pick payments recorded as spending (or against the wrong debt) and make them repayments of this one. */
function LinkPayments({ d, onClose }: { d: DebtItem; onClose: () => void }) {
  const { refresh, toast } = useApp();
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  // Pay-in-3 plans usually include past payments in "Already paid"; other debts usually don't.
  const [takeOff, setTakeOff] = useState(!d.details?.schedule);
  useEffect(() => { const t = setTimeout(() => setQ(search), 250); return () => clearTimeout(t); }, [search]);
  const { data } = useData<Candidate[]>(() => api.get(`/api/debts/${d.accountId}/candidates${qs({ search: q || undefined })}`), [q]);
  const toggle = (id: number) => setPicked((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const confirmed = d.balanceCheck.confirmedOn;
  const early = (data ?? []).filter((c) => picked.has(c.id) && c.date <= confirmed);
  const needsChoice = early.length > 0 && d.accountType !== 'credit_card';
  async function save() {
    try {
      await api.post(`/api/debts/${d.accountId}/link`, { transactionIds: [...picked], takeOff: needsChoice ? takeOff : undefined });
      toast(`Linked ${picked.size} payment${picked.size === 1 ? '' : 's'} to ${d.name}`);
      refresh();
      onClose();
    } catch (e: any) { setError(e.message); }
  }
  return (
    <Modal title={`Link payments to ${d.name}`} onClose={onClose}
      footer={<><span className="muted small">They'll count as repayments, not spending.</span><span className="spacer" /><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={picked.size === 0} onClick={save}>Link {picked.size || ''} payment{picked.size === 1 ? '' : 's'}</button></>}>
      <div className="form">
        <div className="search-field">
          <Icon name="search" size={16} />
          <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search, e.g. paypal or klarna" />
        </div>
        {!data ? <div className="loading" /> : data.length === 0 ? <p className="muted small">No payments found{q ? ` matching “${q}”` : ''}.</p> : (
          <ul className="link-list">
            {data.map((c) => (
              <li key={c.id}>
                <label className="check">
                  <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} />
                  <span className="grow">
                    <span>{c.description}</span>
                    <span className="muted small">{shortDate(c.date)} · {c.accountName} · {c.linkedTo ? `now linked to ${c.linkedTo}` : c.categoryName ?? 'Uncategorised'}</span>
                  </span>
                  <Money value={c.amount} />
                </label>
              </li>
            ))}
          </ul>
        )}
        {needsChoice && (
          <label className="check"><input type="checkbox" checked={takeOff} onChange={(e) => setTakeOff(e.target.checked)} />
            <span><strong>Take {money(early.reduce((t, c) => t + c.amount, 0))} off what I owe</strong><br />
              <span className="muted small">{early.length === 1 ? 'This payment is' : `${early.length} of these are`} from on or before {shortDate(confirmed)}, when you set the amount owed. Untick if that amount already allowed for {early.length === 1 ? 'it' : 'them'}.</span></span>
          </label>
        )}
        {error && <p className="form-error">{error}</p>}
      </div>
    </Modal>
  );
}

function Statements({ accountId, list, due, nextDue }: { accountId: number; list: Statement[]; due: number | null; nextDue: string | null }) {
  const [open, setOpen] = useState(false);
  const cur = list[0];
  const last = list.find((s) => !s.current);
  const view = (s: Statement) => navigate(`/transactions${qs({ accountId, from: s.from, to: s.to })}`);
  const range = (s: Statement) => `${shortDate(s.from)} – ${shortDate(s.to)}`;
  return (
    <div className="statements">
      <div className="stmt-now">
        {last && (
          <div className="stmt-box">
            <span className="muted small">Last statement · {range(last)}</span>
            <span className="strong"><Money value={last.closing} /></span>
            <span className="small">{due != null && due > 0 ? <>{money(due)} to pay{nextDue ? ` by ${shortDate(nextDue)}` : ''}</> : <span className="tone-good">Paid</span>}</span>
            <button className="link-btn small" onClick={() => view(last)}>View transactions</button>
          </div>
        )}
        <div className="stmt-box">
          <span className="muted small">This statement · {range(cur)}</span>
          <span className="strong"><Money value={cur.purchases - cur.refunds} /> <span className="muted small" style={{ fontWeight: 500 }}>spent so far</span></span>
          <span className="small muted">{cur.payments ? `${money(cur.payments)} paid in` : 'No payments yet'}</span>
          <button className="link-btn small" onClick={() => view(cur)}>View transactions</button>
        </div>
      </div>
      <button className="link-btn small" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'} past statements</button>
      {open && (
        <table className="stmt-table">
          <thead><tr><th>Statement</th><th>Spent</th><th>Paid in</th><th>Balance</th><th /></tr></thead>
          <tbody>
            {list.filter((s) => !s.current).map((s) => (
              <tr key={s.to}>
                <td>{range(s)}</td>
                <td><Money value={s.purchases - s.refunds + s.interest} /></td>
                <td className="muted">{s.payments ? money(s.payments) : '—'}</td>
                <td><Money value={s.closing} /></td>
                <td><button className="link-btn small" onClick={() => view(s)}>Transactions</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function PayoffPlan({ hasDebts }: { hasDebts: boolean }) {
  const { toast, version } = useApp();
  const [monthly, setMonthly] = useState<string>('');
  const [applied, setApplied] = useState<number | null>(null);
  const { data: plan } = useData<Plan>(() => api.get(`/api/debts/plan${qs({ monthly: applied ?? undefined })}`), [applied]);
  const [strategy, setStrategy] = useState<Strategy>('avalanche');
  useEffect(() => { if (plan) { setStrategy(plan.preferred === 'minimum' ? 'avalanche' : plan.preferred); if (!monthly) setMonthly(penceToInput(plan.monthly)); } }, [plan?.preferred, version]); // eslint-disable-line

  if (!hasDebts) return null;
  if (!plan) return <div className="loading" />;
  const s = plan.strategies;
  const chosen = s[strategy];

  async function apply() {
    const p = parseAmount(monthly);
    if (p === null) return toast('Enter a monthly amount', 'error');
    setApplied(p);
    await api.put('/api/debts/plan', { monthly: p, strategy });
    toast('Plan saved');
  }

  const cols: { key: Strategy; title: string; note: string }[] = [
    { key: 'minimum', title: 'Minimums only', note: 'What happens if you only ever pay the minimum' },
    { key: 'snowball', title: 'Snowball', note: 'Smallest balance first: quick wins' },
    { key: 'avalanche', title: 'Avalanche', note: 'Highest interest first: cheapest overall' },
  ];

  return (
    <Card title="Payoff plan">
      <div className="plan-controls">
        <Field label="Put towards debts each month" hint={`Minimums next month: ${money(plan.minimumPayment)}`}>
          <div className="row gap">
            <div className="amount-field" style={{ width: 160 }}><span>£</span><input inputMode="decimal" value={monthly} onChange={(e) => setMonthly(e.target.value)} /></div>
            <button className="btn" onClick={apply}>Update</button>
          </div>
        </Field>
        <Field label="Strategy">
          <Segmented<Strategy> value={strategy} onChange={(v) => { setStrategy(v); api.put('/api/debts/plan', { strategy: v }); }}
            options={[{ value: 'avalanche', label: 'Avalanche' }, { value: 'snowball', label: 'Snowball' }]} />
        </Field>
      </div>

      {chosen.shortfall && <p className="form-error">That's less than the minimum payments. Minimums are still paid, so this is the same as minimums only.</p>}

      <div className="strategy-grid">
        {cols.map((c) => {
          const r = s[c.key];
          const saves = s.minimum.totalInterest - r.totalInterest;
          return (
            <div key={c.key} className={`strategy ${c.key === strategy ? 'on' : ''} ${c.key === 'minimum' ? 'baseline' : ''}`}>
              <p className="strategy-title">{c.title}</p>
              <p className="muted small">{c.note}</p>
              <p className="strategy-date">{r.never ? 'Never' : r.debtFree ? monthLabel(r.debtFree) : '—'}</p>
              <p className="muted small">{r.never ? 'Payments don’t cover the interest' : `${r.months} months · ${money(r.totalInterest)} interest`}</p>
              {c.key !== 'minimum' && !r.never && saves > 0 && <Badge tone="good">Saves {money(saves)}{s.minimum.months && r.months ? ` and ${s.minimum.months - r.months} months` : ''}</Badge>}
            </div>
          );
        })}
      </div>

      <div className="cols-2" style={{ marginTop: 18 }}>
        <div>
          <p className="field-label" style={{ marginBottom: 8 }}>Order you'll clear them ({strategy})</p>
          <ol className="payoff-order">
            {chosen.order.map((o) => (
              <li key={o.id}><span className="grow">{o.name}</span><span className="muted small">{monthLabel(o.month)} · {o.months} month{o.months === 1 ? '' : 's'}</span></li>
            ))}
            {chosen.never && <li className="tone-bad small">Some debts never clear at this amount.</li>}
          </ol>
        </div>
        <div>
          <span className="legend"><i style={{ background: 'var(--text-3)' }} />Minimums <i style={{ background: '#f59e0b' }} />Snowball <i style={{ background: 'var(--good)' }} />Avalanche</span>
          <PayoffChart series={[
            { colour: 'var(--text-3)', points: s.minimum.series, dashed: true },
            { colour: '#f59e0b', points: s.snowball.series },
            { colour: 'var(--good)', points: s.avalanche.series },
          ]} />
        </div>
      </div>
      <p className="muted small" style={{ marginTop: 12 }}>Estimates assume no new spending on these debts, monthly interest at the APR, and rates staying the same. Cards paid in full each month aren't included.</p>
    </Card>
  );
}

function PayoffChart({ series }: { series: { colour: string; points: { month: string; total: number }[]; dashed?: boolean }[] }) {
  // Scale to the planned strategies (not the much longer minimums-only line), with some room after.
  const longest = Math.max(...series.map((s) => s.points.length));
  const planned = Math.max(...series.filter((s) => !s.dashed).map((s) => s.points.length));
  const cap = Math.min(longest, Math.max(12, Math.round(planned * 1.6)));
  const max = Math.max(1, ...series.flatMap((s) => s.points.map((p) => p.total)));
  const x = (i: number) => (i / Math.max(1, cap - 1)) * 100;
  const y = (v: number) => 100 - (v / max) * 96;
  const first = series[0].points[0]?.month;
  const lastMonth = series.reduce((a, s) => (s.points.length > a.length ? s.points : a), series[0].points)[Math.min(cap, longest) - 1]?.month;
  return (
    <div className="value-line">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ height: 170 }} role="img" aria-label="Total owed over time by strategy">
        {series.map((s, i) => (
          <path key={i} d={s.points.slice(0, cap).map((p, j) => `${j ? 'L' : 'M'}${x(j)},${y(p.total)}`).join(' ')}
            fill="none" stroke={s.colour} strokeWidth={i === 1 ? 3.5 : 2} strokeOpacity={i === 1 ? 0.7 : 1} strokeDasharray={s.dashed ? '4 3' : undefined} vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      <div className="bars-labels">
        <span style={{ width: '50%', textAlign: 'left' }}>{first ? monthLabel(first) : ''}</span>
        <span style={{ width: '50%', textAlign: 'right' }}>{lastMonth ? monthLabel(lastMonth) : ''}{longest > cap ? ' (minimums only continues beyond)' : ''}</span>
      </div>
    </div>
  );
}

function nextDueFromDay(day: number | null, today: string): string {
  if (!day) return '';
  let m = today.slice(0, 7);
  if (day < Number(today.slice(8, 10))) m = addMonths(m, 1);
  const [y, mo] = m.split('-').map(Number);
  const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return `${m}-${String(Math.min(day, dim)).padStart(2, '0')}`;
}

const PROVIDERS = ['Klarna', 'PayPal', 'Clearpay', 'Monzo Flex', 'Zilch', 'Other'];

function DebtForm({ item, startType, onClose }: { item: DebtItem | null; startType?: DebtType; onClose: () => void }) {
  const { accounts, refresh, toast } = useApp();
  const [confirm, confirmNode] = useConfirm();
  const det = item?.details;
  const defaultType: DebtType = item ? (item.accountType === 'credit_card' ? 'credit_card' : item.accountType === 'loan' ? 'personal_loan' : 'other') : 'personal_loan';
  const [name, setName] = useState('');
  const [owed, setOwed] = useState('');
  const { meta } = useApp();
  const [debtType, setDebtType] = useState<DebtType>(det?.debtType ?? startType ?? defaultType);
  const isPay3 = debtType === 'pay_in_3';
  const [provider, setProvider] = useState(det?.provider ?? item?.institution ?? 'Klarna');
  const [instalments, setInstalments] = useState(String(det?.instalments ?? 3));
  const [startDate, setStartDate] = useState(det?.startDate ?? meta.today);
  const [paidSoFar, setPaidSoFar] = useState(det && item ? penceToInput(Math.max(0, det.originalBalance - item.owed)) : '');
  const [dueDate, setDueDate] = useState(det?.nextDue ?? nextDueFromDay(det?.dueDay ?? null, meta.today));
  const lastStmt = det?.statements?.find((s) => !s.current);
  const [stmtFrom, setStmtFrom] = useState(lastStmt?.from ?? '');
  const [stmtTo, setStmtTo] = useState(lastStmt?.to ?? '');
  const [original, setOriginal] = useState(det ? penceToInput(det.originalBalance) : item ? penceToInput(item.owed) : '');
  const [apr, setApr] = useState(det ? String(det.apr / 100) : '');
  const [hasPromo, setHasPromo] = useState(det?.promoApr != null);
  const [promoApr, setPromoApr] = useState(det?.promoApr != null ? String(det.promoApr / 100) : '0');
  const [promoEnd, setPromoEnd] = useState(det?.promoEnd ?? '');
  const isCard = debtType === 'credit_card';
  const [minType, setMinType] = useState<'fixed' | 'card'>(det?.minType ?? (isCard ? 'card' : 'fixed'));
  const [minFixed, setMinFixed] = useState(det && det.minFixed ? penceToInput(det.minFixed) : '');
  const [minPercent, setMinPercent] = useState(det ? String(det.minPercent / 100) : '1');
  const [minFloor, setMinFloor] = useState(det ? penceToInput(det.minFloor) : '25.00');
  const [frequency, setFrequency] = useState(det?.frequency ?? 'monthly');
  const [paysInFull, setPaysInFull] = useState(det?.paysInFull ?? false);
  const [payFrom, setPayFrom] = useState<number | null>(det?.paymentAccountId ?? accounts.find((a) => a.type === 'current')?.id ?? null);
  const [notes, setNotes] = useState(det?.notes ?? '');
  const [addRepayment, setAddRepayment] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const bp = (s: string) => { const n = Number(s.replace('%', '')); return Number.isFinite(n) ? Math.round(n * 100) : NaN; };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (isPay3) {
      const total = parseAmount(original);
      if (!total) return setError('Enter the total you are paying');
      const paid = parseAmount(paidSoFar || '0') ?? 0;
      const body3 = {
        debtType, originalBalance: total, apr: 0, minType: 'fixed', instalments: Number(instalments), startDate, frequency,
        provider: provider === 'Other' ? null : provider, paymentAccountId: payFrom, notes, paidSoFar: paid,
      };
      try {
        if (item) await api.put(`/api/debts/${item.accountId}`, body3);
        else await api.post('/api/debts', { ...body3, name: name || provider, addRepayment: addRepayment && !!payFrom });
        toast(item ? 'Saved' : 'Pay in 3 added');
        refresh();
        onClose();
      } catch (err: any) { setError(err.message); }
      return;
    }
    const body: any = {
      debtType, originalBalance: parseAmount(original) ?? 0, apr: bp(apr || '0'),
      promoApr: hasPromo ? bp(promoApr || '0') : null, promoEnd: hasPromo ? promoEnd || null : null,
      minType: isCard ? minType : 'fixed', minFixed: parseAmount(minFixed) ?? 0, minPercent: bp(minPercent || '0'), minFloor: parseAmount(minFloor) ?? 0,
      dueDay: dueDate ? Number(dueDate.slice(8, 10)) : null, statementDay: isCard && stmtTo ? Number(stmtTo.slice(8, 10)) : null, frequency: minType === 'fixed' || !isCard ? frequency : 'monthly',
      paysInFull: isCard && paysInFull, paymentAccountId: payFrom, notes,
    };
    if ([body.apr, body.minPercent].some((v) => Number.isNaN(v))) return setError('Rates should be numbers, e.g. 24.9');
    try {
      if (item) await api.put(`/api/debts/${item.accountId}`, body);
      else {
        const o = parseAmount(owed);
        if (o === null) return setError('Enter how much you owe');
        await api.post('/api/debts', { ...body, name, owed: o, originalBalance: parseAmount(original) ?? o, addRepayment: addRepayment && !!payFrom });
      }
      toast(item ? 'Saved' : 'Debt added');
      refresh();
      onClose();
    } catch (err: any) { setError(err.message); }
  }

  async function remove() {
    if (!item) return;
    if (!(await confirm(`Remove the debt details for ${item.name}? The account and its transactions stay.`))) return;
    await api.del(`/api/debts/${item.accountId}`);
    toast('Details removed');
    refresh();
    onClose();
  }

  return (
    <Modal title={item ? `${item.name}: ${isPay3 ? 'pay in 3' : 'debt details'}` : isPay3 ? 'Add pay in 3' : 'Add a debt'} onClose={onClose}
      footer={<>
        {item && det && <button type="button" className="btn btn-ghost-danger" onClick={remove}><Icon name="trash" size={16} /> Remove details</button>}
        <span className="spacer" />
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="submit" form="debt-form" className="btn btn-primary">Save</button>
      </>}>
      <form id="debt-form" className="form" onSubmit={save}>
        {isPay3 ? (
          <PayInFields {...{ item, name, setName, provider, setProvider, original, setOriginal, instalments, setInstalments, startDate, setStartDate, frequency, setFrequency, paidSoFar, setPaidSoFar }} today={meta.today} />
        ) : (<>
        <div className="grid-2">
          {!item && <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Car loan" /></Field>}
          <Field label="Type">
            <select value={debtType} onChange={(e) => { const t = e.target.value as DebtType; setDebtType(t); setMinType(t === 'credit_card' ? 'card' : 'fixed'); if (t === 'pay_in_3') setFrequency('monthly'); }}>
              {(Object.keys(DEBT_LABELS) as DebtType[]).map((t) => <option key={t} value={t}>{DEBT_LABELS[t]}</option>)}
            </select>
          </Field>
          {!item && <Field label="Owed now"><div className="amount-field"><span>£</span><input inputMode="decimal" value={owed} onChange={(e) => setOwed(e.target.value)} placeholder="4500.00" /></div></Field>}
          <Field label="Original balance" hint="What you borrowed, to show progress">
            <div className="amount-field"><span>£</span><input inputMode="decimal" value={original} onChange={(e) => setOriginal(e.target.value)} placeholder="6000.00" /></div>
          </Field>
        </div>
        {isCard && (
          <label className="check"><input type="checkbox" checked={paysInFull} onChange={(e) => setPaysInFull(e.target.checked)} />
            <span><strong>I pay the full balance every month</strong><br /><span className="muted small">No interest, and it's left out of payoff plans. Charge cards work like this.</span></span></label>
        )}
        {isCard && (
          <Field label="Latest statement" hint="From your last statement. Each one runs to the same day every month, starting the day after the previous one ends.">
            <div className="row gap">
              <input type="date" aria-label="Statement from" value={stmtFrom} style={{ maxWidth: 180 }}
                onChange={(e) => { setStmtFrom(e.target.value); if (e.target.value) setStmtTo(shiftDays(shiftMonth(e.target.value, 1), -1)); }} />
              <span className="muted small">to</span>
              <input type="date" aria-label="Statement to" value={stmtTo} style={{ maxWidth: 180 }}
                onChange={(e) => { setStmtTo(e.target.value); if (e.target.value) setStmtFrom(shiftDays(shiftMonth(e.target.value, -1), 1)); }} />
              {stmtTo && <button type="button" className="link-btn" onClick={() => { setStmtFrom(''); setStmtTo(''); }}>Clear</button>}
            </div>
          </Field>
        )}
        <Field label={isCard ? 'Next payment due' : 'Next payment date'} hint="It repeats on the same day each month. Your statement shows the date.">
          <div className="row gap">
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} style={{ maxWidth: 200 }} />
            {dueDate && <button type="button" className="link-btn" onClick={() => setDueDate('')}>Clear</button>}
          </div>
        </Field>
        {!(isCard && paysInFull) && (
          <>
            <Field label="APR"><div className="amount-field" style={{ maxWidth: 200 }}><input inputMode="decimal" value={apr} onChange={(e) => setApr(e.target.value)} placeholder="24.9" /><span>%</span></div></Field>
            <label className="check"><input type="checkbox" checked={hasPromo} onChange={(e) => setHasPromo(e.target.checked)} /><span>Promotional rate (e.g. 0% balance transfer)</span></label>
            {hasPromo && (
              <div className="grid-2">
                <Field label="Promo rate"><div className="amount-field"><input inputMode="decimal" value={promoApr} onChange={(e) => setPromoApr(e.target.value)} /><span>%</span></div></Field>
                <Field label="Until"><input type="date" value={promoEnd} onChange={(e) => setPromoEnd(e.target.value)} /></Field>
              </div>
            )}
            {isCard ? (
              <>
                <Field label="Minimum payment">
                  <Segmented value={minType} onChange={setMinType} options={[{ value: 'card', label: '% of balance + interest' }, { value: 'fixed', label: 'Fixed amount' }]} />
                </Field>
                {minType === 'card' ? (
                  <div className="grid-2">
                    <Field label="Percent of balance"><div className="amount-field"><input inputMode="decimal" value={minPercent} onChange={(e) => setMinPercent(e.target.value)} /><span>%</span></div></Field>
                    <Field label="Or at least"><div className="amount-field"><span>£</span><input inputMode="decimal" value={minFloor} onChange={(e) => setMinFloor(e.target.value)} /></div></Field>
                  </div>
                ) : (
                  <Field label="Monthly payment"><div className="amount-field"><span>£</span><input inputMode="decimal" value={minFixed} onChange={(e) => setMinFixed(e.target.value)} /></div></Field>
                )}
              </>
            ) : (
              <div className="grid-2">
                <Field label="Payment"><div className="amount-field"><span>£</span><input inputMode="decimal" value={minFixed} onChange={(e) => setMinFixed(e.target.value)} placeholder="250.00" /></div></Field>
                <Field label="Every">
                  <select value={frequency} onChange={(e) => setFrequency(e.target.value)}>
                    <option value="monthly">Month</option><option value="four_weekly">4 weeks</option><option value="fortnightly">2 weeks</option><option value="weekly">Week</option>
                  </select>
                </Field>
              </div>
            )}
          </>
        )}
        </>)}
        <Field label="Paid from"><AccountSelect value={payFrom} onChange={setPayFrom} filter={(a) => !a.isLiability} /></Field>
        {!item && payFrom && <label className="check"><input type="checkbox" checked={addRepayment} onChange={(e) => setAddRepayment(e.target.checked)} /><span>Add the repayment to Bills and income (so it counts as committed money each month)</span></label>}
        {debtType === 'student_loan' && <p className="hint-box"><Icon name="info" size={16} />UK student loans are usually repaid through your payslip. Use your monthly deduction as the payment, or leave it at £0 to just track the balance.</p>}
        <Field label="Notes"><input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Balance transfer fee 3%" /></Field>
        {error && <p className="form-error">{error}</p>}
      </form>
      {confirmNode}
    </Modal>
  );
}

function PayInFields(p: {
  item: DebtItem | null; today: string;
  name: string; setName: (v: string) => void; provider: string; setProvider: (v: string) => void;
  original: string; setOriginal: (v: string) => void; instalments: string; setInstalments: (v: string) => void;
  startDate: string; setStartDate: (v: string) => void; frequency: string; setFrequency: (v: string) => void;
  paidSoFar: string; setPaidSoFar: (v: string) => void;
}) {
  const total = parseAmount(p.original) ?? 0;
  const n = Math.max(2, Math.min(60, Number(p.instalments) || 3));
  const base = Math.floor(total / n);
  const amounts = Array.from({ length: n }, (_, i) => (i === 0 ? total - base * (n - 1) : base));
  const dates = amounts.map((_, i) => stepDate(p.startDate || p.today, p.frequency, i));
  const paid = parseAmount(p.paidSoFar || '0') ?? 0;
  // Quick fill: everything due up to today counts as paid.
  const dueByToday = amounts.reduce((s, a, i) => s + (dates[i] <= p.today ? a : 0), 0);
  let left = paid;
  return (
    <>
      <div className="grid-2">
        {!p.item && <Field label="What's it for?"><input value={p.name} onChange={(e) => p.setName(e.target.value)} placeholder="Klarna – Currys TV" /></Field>}
        <Field label="Provider">
          <select value={p.provider} onChange={(e) => p.setProvider(e.target.value)}>{PROVIDERS.map((x) => <option key={x}>{x}</option>)}</select>
        </Field>
        <Field label="Total amount"><div className="amount-field"><span>£</span><input inputMode="decimal" value={p.original} onChange={(e) => p.setOriginal(e.target.value)} placeholder="450.00" /></div></Field>
        <Field label="Number of payments"><input type="number" min={2} max={60} value={p.instalments} onChange={(e) => p.setInstalments(e.target.value)} /></Field>
        <Field label="First payment (date started)"><input type="date" value={p.startDate} onChange={(e) => p.setStartDate(e.target.value)} /></Field>
        <Field label="Then every">
          <select value={p.frequency} onChange={(e) => p.setFrequency(e.target.value)}>
            <option value="monthly">Month</option><option value="fortnightly">2 weeks</option><option value="weekly">Week</option>
          </select>
        </Field>
      </div>
      <Field label="Already paid" hint={total > 0 ? `${money(Math.max(0, total - paid))} left to pay` : undefined}>
        <div className="row gap">
          <div className="amount-field" style={{ maxWidth: 200 }}><span>£</span><input inputMode="decimal" value={p.paidSoFar} onChange={(e) => p.setPaidSoFar(e.target.value)} placeholder="0.00" /></div>
          {total > 0 && dueByToday > 0 && <button type="button" className="link-btn" onClick={() => p.setPaidSoFar(penceToInput(dueByToday))}>Everything due so far ({money(dueByToday)})</button>}
        </div>
      </Field>
      {total > 0 && (
        <div className="hint-box" style={{ display: 'block' }}>
          <p className="small strong" style={{ marginBottom: 6 }}>Schedule · interest-free</p>
          <ol className="instalments compact">
            {amounts.map((a, i) => {
              const covered = Math.min(a, Math.max(0, left)); left -= covered;
              return (
                <li key={i} className={covered >= a ? 'paid' : ''}>
                  <span className="inst-mark">{covered >= a ? <Icon name="check" size={13} /> : i + 1}</span>
                  <span className="grow">{shortDate(dates[i])}</span>
                  <span className="money">{money(a)}</span>
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </>
  );
}

function stepDate(start: string, freq: string, i: number): string {
  if (freq === 'monthly') {
    const m = addMonths(start.slice(0, 7), i);
    const [y, mo] = m.split('-').map(Number);
    const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    return `${m}-${String(Math.min(Number(start.slice(8, 10)), dim)).padStart(2, '0')}`;
  }
  const d = new Date(`${start}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + i * (freq === 'fortnightly' ? 14 : 7));
  return d.toISOString().slice(0, 10);
}

function shiftMonth(iso: string, n: number): string {
  const m = addMonths(iso.slice(0, 7), n);
  const [y, mo] = m.split('-').map(Number);
  const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return `${m}-${String(Math.min(Number(iso.slice(8, 10)), dim)).padStart(2, '0')}`;
}
function shiftDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Paid off: move it out of the way. It stays in Accounts → Archived with its history. */
function ArchiveButton({ d }: { d: DebtItem }) {
  const { refresh, toast } = useApp();
  const [confirm, confirmNode] = useConfirm();
  async function go() {
    if (!(await confirm(`Archive ${d.name}? It's paid off, so it moves to Accounts → Archived (with its history) and its repayments stop showing on Bills and income.`, { label: 'Archive' }))) return;
    try {
      await api.post(`/api/debts/${d.accountId}/archive`, {});
      toast(`${d.name} archived`);
      refresh();
    } catch (e: any) { toast(e.message, 'error'); }
  }
  return <><button className="btn btn-sm" onClick={go}><Icon name="archive" size={14} /> Archive</button>{confirmNode}</>;
}

interface TimelineData {
  debts: { accountId: number; name: string; colour: string; group: string; owed: number; apr: number | null; source: 'bills' | 'schedule' | 'minimum' | 'none'; payments: { date: string; amount: number }[]; finalDate: string | null; unscheduled: number }[];
  byMonth: { month: string; total: number }[];
  debtFree: string | null; scheduledEnd: string | null; monthlyNow: number; unscheduled: string[]; interestBearing: boolean;
}

/** When each debt is cleared, from what's actually scheduled, and what that frees up. */
function Timeline() {
  const { data } = useData<TimelineData>(() => api.get('/api/debts/timeline'), []);
  if (!data || data.debts.length === 0) return null;
  const max = Math.max(1, ...data.byMonth.map((m) => m.total));
  const after = data.debtFree ? addMonths(data.debtFree.slice(0, 7), 1) : null;
  return (
    <Card title="When you'll be debt-free" action={<span className="muted small">Loans, pay in 3 and money owed. Cards you clear in full each month aren't included.</span>}>
      <div className="tl-head">
        <div>
          <span className="muted small">{data.debtFree ? 'Debt-free after' : 'Last scheduled payment'}</span>
          <strong className="tl-date">{data.debtFree || data.scheduledEnd ? shortDate((data.debtFree ?? data.scheduledEnd)!) : 'Not scheduled yet'}</strong>
          {after && data.monthlyNow > 0 && <span className="small">From {monthLabel(after)}, <Money value={data.monthlyNow} className="strong amt-saved" /> a month is free for savings</span>}
          {data.unscheduled.length > 0 && <span className="small tone-warn">{data.unscheduled.join(', ')} {data.unscheduled.length === 1 ? 'has' : 'have'} no repayments set. Add them on Bills and income, or give a monthly payment in Edit.</span>}
        </div>
        <div className="tl-bars" aria-label="Debt payments by month">
          {data.byMonth.slice(0, 12).map((m) => (
            <div key={m.month} className="tl-bar" title={`${monthLabel(m.month)}: ${money(m.total)}`}>
              <span style={{ height: `${(m.total / max) * 100}%` }} />
              <i>{monthLabel(m.month, true)}</i>
            </div>
          ))}
          {after && <div className="tl-bar tl-free" title="Nothing left to pay"><span style={{ height: '6%' }} /><i>{monthLabel(after, true)}</i></div>}
        </div>
      </div>
      <ul className="tl-list">
        {data.debts.map((d) => (
          <li key={d.accountId}>
            <span className="dot dot-debt" style={{ background: d.colour }} />
            <span className="grow"><strong>{d.name}</strong>
              <span className="muted small"> · <Money value={d.owed} /> left · {d.payments.length} payment{d.payments.length === 1 ? '' : 's'}{d.payments.length ? ` (next ${money(d.payments[0].amount)} on ${shortDate(d.payments[0].date)})` : ''}</span>
            </span>
            {d.finalDate
              ? <span className="small">Cleared <strong>{shortDate(d.finalDate)}</strong></span>
              : <Badge tone="warn">{d.unscheduled ? `${money(d.unscheduled)} not scheduled` : 'No payments set'}</Badge>}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Snowball/avalanche only helps when something charges interest; otherwise it's tucked away. */
function PayoffPlanIfUseful({ hasDebts }: { hasDebts: boolean }) {
  const { data } = useData<TimelineData>(() => api.get('/api/debts/timeline'), []);
  const [show, setShow] = useState(false);
  if (!data) return null;
  if (data.interestBearing) return <PayoffPlan hasDebts={hasDebts} />;
  return (
    <div>
      <button className="link-btn small" onClick={() => setShow(!show)}>{show ? 'Hide payoff plan' : 'Show payoff plan (snowball and avalanche)'}</button>
      {!show && <p className="muted small">None of your debts charge interest, so the order you pay them in doesn't change the cost.</p>}
      {show && <PayoffPlan hasDebts={hasDebts} />}
    </div>
  );
}
