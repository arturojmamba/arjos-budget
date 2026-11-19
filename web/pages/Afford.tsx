/**
 * Can I afford it? Simulate a purchase against your real figures before you commit
 * (see docs/specs/can-i-afford-it.md). Nothing here changes your data until you confirm a purchase.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.ts';
import { AccountSelect, Badge, Card, CategorySelect, Empty, Field, Modal, Segmented, useApp, useConfirm, useData, usePageAdd, usePaged } from '../components/ui.tsx';
import { Icon } from '../components/Icon.tsx';
import { LineChart, StackedBars, useHidden } from '../components/viz.tsx';
import { money, parseAmount, penceToInput, shortDate, monthLabel } from '../format.ts';
import { navigate, setParams } from '../router.ts';

// ---------------------------------------------------------------------------
// Types (as the server sends them)

type Kind = 'outright' | 'bnpl' | 'instalments' | 'finance' | 'card' | 'save';
type Level = 'comfortable' | 'adjust' | 'stretching' | 'not_affordable';
type Freq = 'weekly' | 'fortnightly' | 'monthly';

interface Option {
  id: string; kind: Kind; label?: string; preset?: 'pay_in_3' | 'pay_in_4' | 'pay_in_30';
  deposit?: number; payments?: number; frequency?: Freq; firstPayment?: string; apr?: number; upfrontFee?: number; paymentFee?: number; balloon?: number;
  cardId?: number; cardPlan?: 'full' | 'fixed' | 'minimum' | 'promo'; cardMonthly?: number; purchaseApr?: number | null; purchasePromoEnd?: string | null;
  saveMonthly?: number; saveStart?: string;
}
interface Purchase { name: string; price: number | null; date: string; categoryId: number | null; description: string; priority: 'essential' | 'important' | 'non_essential' }
interface Overrides { pay?: number | null; everyday?: number | null; saving?: number | null; floorPercent?: number | null; floorAmount?: number | null; accounts?: Record<string, { include: boolean; amount?: number | null }> }

interface Ctx {
  today: string; firstPayday: string | null;
  accounts: { id: number; name: string; type: string; colour: string; balance: number; emergency: number; goals: number; defaultIncluded: boolean; defaultAmount: number }[];
  cards: { accountId: number; name: string; owed: number; apr: number | null; promoApr: number | null; promoEnd: string | null; creditLimit: number | null; paysInFull: boolean; hasDetails: boolean }[];
  goals: { id: number; name: string; monthlyTarget: number; isEmergency: boolean; account: string | null }[];
  pay: { amount: number; name: string | null }; everyday: { average: number; months: number }; savingPerMonth: number;
  missing: { what: string; fix: string }[];
}
interface Row { n: number; date: string; label: string; payment: number; interest: number; fees: number; principal: number; remaining: number }
interface MonthRow { month: string; income: number; bills: number; debts: number; saving: number; everyday: number; purchase: number; cards: number; end: number; freeToSpend: number; floor: number }
interface Forecast { start: number; days: { date: string; balance: number }[]; months: MonthRow[]; lowest: { balance: number; date: string } }
interface Result {
  id: string; kind: Kind; label: string; classification: string; classificationLabel: string; schedule: Row[];
  upfront: number; regularPayment: number | null; frequency: Freq | null; payments: number; totalInterest: number; totalFees: number; totalPayable: number;
  firstDate: string | null; lastDate: string | null; warnings: string[]; blockers: string[];
  card?: { name: string; owedBefore: number; limit: number | null; available: number | null; rate: number; promoEnd: string | null };
  save?: { monthly: number; months: number; reached: string; alternatives: { monthly: number; months: number; reached: string }[] };
  assessment: { level: Level; title: string; reasons: string[]; adjustments: string[]; checks: { key: string; label: string; ok: boolean; detail: string }[] };
  forecast: Forecast; minFreeToSpend: number;
}
interface Sim { baseline: Forecast; options: Result[]; best: { id: string; why: string } | null; assumptions: { label: string; value: string; changed: boolean }[]; missing: { what: string; fix: string }[]; maxMonthlySaving: number; pool: { start: number } }
interface Saved {
  id: number; name: string; price: number; purchaseDate: string; status: 'planned' | 'bought' | 'dropped'; chosen: string | null; boughtAt: string | null; goalId: number | null; debtAccountId: number | null;
  inputs: { purchase: any; options: Option[]; overrides?: Overrides; chosen?: string | null };
  summary: { option: string; classification: string; level: Level; title: string; upfront: number; regularPayment: number | null; frequency: Freq | null; totalPayable: number; lowest: { balance: number; date: string }; minFreeToSpend: number } | null;
}

const LEVEL: Record<Level, { tone: 'good' | 'info' | 'warn' | 'bad'; icon: string; short: string }> = {
  comfortable: { tone: 'good', icon: 'check', short: 'Comfortable' },
  adjust: { tone: 'info', icon: 'info', short: 'With adjustments' },
  stretching: { tone: 'warn', icon: 'alert', short: 'Stretching' },
  not_affordable: { tone: 'bad', icon: 'x', short: 'Not affordable' },
};
const PRIORITY = [{ value: 'essential', label: 'Essential' }, { value: 'important', label: 'Important' }, { value: 'non_essential', label: 'Non-essential' }] as const;
const FREQ_WORD: Record<Freq, string> = { weekly: 'a week', fortnightly: 'a fortnight', monthly: 'a month' };

const newId = () => Math.random().toString(36).slice(2, 8);
const roundTo5 = (p: number) => Math.max(500, Math.ceil(p / 500) * 500);

export function newOption(kind: Kind, price: number | null, ctx: Ctx | null, preset?: Option['preset']): Option {
  const id = newId();
  if (kind === 'bnpl') return { id, kind, preset: preset ?? 'pay_in_3' };
  if (kind === 'instalments') return { id, kind, payments: 12, apr: 0, frequency: 'monthly' };
  if (kind === 'finance') return { id, kind, payments: 24, apr: 1990, frequency: 'monthly', deposit: 0 };
  if (kind === 'card') {
    const c = ctx?.cards.find((x) => x.hasDetails) ?? ctx?.cards[0];
    return { id, kind, cardId: c?.accountId, cardPlan: 'full' };
  }
  if (kind === 'save') return { id, kind, saveMonthly: price ? roundTo5(price / 6) : 10000 };
  return { id, kind };
}

const KIND_MENU: { kind: Kind; preset?: Option['preset']; label: string }[] = [
  { kind: 'outright', label: 'Pay outright' },
  { kind: 'bnpl', preset: 'pay_in_3', label: 'Pay in 3 (Klarna-style)' },
  { kind: 'bnpl', preset: 'pay_in_4', label: 'Pay in 4 (Clearpay-style)' },
  { kind: 'bnpl', preset: 'pay_in_30', label: 'Pay in 30 days' },
  { kind: 'instalments', label: 'Instalments' },
  { kind: 'finance', label: 'Finance agreement' },
  { kind: 'card', label: 'Credit card' },
  { kind: 'save', label: 'Save first' },
];

// ---------------------------------------------------------------------------
// Small inputs: pounds and percentages, typed freely and kept as pence / basis points.

function PoundsInput({ value, onChange, placeholder, id, ariaLabel }: { value: number | null | undefined; onChange: (p: number | null) => void; placeholder?: string; id?: string; ariaLabel?: string }) {
  const [text, setText] = useState(value != null ? penceToInput(value) : '');
  const last = useRef(value);
  useEffect(() => { if (value !== last.current) { last.current = value; setText(value != null ? penceToInput(value) : ''); } }, [value]);
  return (
    <div className="amount-field"><span>£</span>
      <input id={id} aria-label={ariaLabel} inputMode="decimal" value={text} placeholder={placeholder}
        onChange={(e) => { setText(e.target.value); const p = e.target.value.trim() === '' ? null : parseAmount(e.target.value); if (p !== null || e.target.value.trim() === '') { last.current = p; onChange(p); } }} />
    </div>
  );
}

function PercentInput({ value, onChange, id, ariaLabel }: { value: number | null | undefined; onChange: (bp: number | null) => void; id?: string; ariaLabel?: string }) {
  const [text, setText] = useState(value != null ? String(value / 100) : '');
  const last = useRef(value);
  useEffect(() => { if (value !== last.current) { last.current = value; setText(value != null ? String(value / 100) : ''); } }, [value]);
  return (
    <div className="amount-field">
      <input id={id} aria-label={ariaLabel} inputMode="decimal" value={text}
        onChange={(e) => {
          setText(e.target.value);
          const s = e.target.value.trim();
          if (s === '') { last.current = null; onChange(null); return; }
          if (/^\d{1,3}(\.\d{0,2})?$/.test(s)) { const bp = Math.round(parseFloat(s) * 100); last.current = bp; onChange(bp); }
        }} />
      <span>%</span>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function Afford({ params }: { params: URLSearchParams }) {
  const view = params.get('view') === 'saved' ? 'saved' : 'new';
  const planId = params.get('plan') ? Number(params.get('plan')) : null;
  const ctx = useData(() => api.get<Ctx>('/api/afford/context'), []);
  usePageAdd('New simulation', () => setParams('/afford', { fresh: Date.now() }));
  const saved = useData(() => api.get<Saved[]>('/api/afford/plans'), [view]);
  const planned = saved.data?.filter((s) => s.status === 'planned').length ?? 0;
  return (
    <div className="page afford">
      <div className="row gap between">
        <Segmented value={view} onChange={(v) => setParams('/afford', { view: v === 'saved' ? 'saved' : null })}
          options={[{ value: 'new', label: planId ? 'Simulation' : 'New simulation' }, { value: 'saved', label: `Saved${saved.data ? ` (${saved.data.length})` : ''}` }]} />
        {view === 'new' && planned > 0 && !planId && <span className="muted small">{planned} saved purchase{planned === 1 ? '' : 's'} planned</span>}
      </div>
      {!ctx.data ? <Card><p className="muted">Reading your figures…</p></Card>
        : view === 'saved' ? <SavedList list={saved.data ?? []} reload={saved.reload} />
        : <Simulator key={`${planId ?? 'new'}:${params.get('fresh') ?? ''}`} ctx={ctx.data} planId={planId} onSaved={saved.reload} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The simulator

function Simulator({ ctx, planId, onSaved }: { ctx: Ctx; planId: number | null; onSaved: () => void }) {
  const { toast } = useApp();
  const [purchase, setPurchase] = useState<Purchase>({ name: '', price: null, date: ctx.today, categoryId: null, description: '', priority: 'important' });
  const [options, setOptions] = useState<Option[]>(() => [
    newOption('outright', null, ctx), newOption('bnpl', null, ctx, 'pay_in_3'), newOption('instalments', null, ctx), newOption('save', null, ctx),
  ]);
  const [overrides, setOverrides] = useState<Overrides>({});
  const [selected, setSelected] = useState<string>(options[0].id);
  const [chosen, setChosen] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<number | null>(planId);
  const [status, setStatus] = useState<Saved['status']>('planned');
  const [loaded, setLoaded] = useState(!planId);
  const [sim, setSim] = useState<Sim | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Result | null>(null);

  // Open a saved simulation.
  useEffect(() => {
    if (!planId) return;
    api.get<Saved>(`/api/afford/plans/${planId}`).then((p) => {
      const i = p.inputs;
      setPurchase({ name: i.purchase.name, price: i.purchase.price, date: i.purchase.date, categoryId: i.purchase.categoryId ?? null, description: i.purchase.description ?? '', priority: i.purchase.priority ?? 'important' });
      setOptions(i.options);
      setOverrides(i.overrides ?? {});
      setChosen(p.chosen);
      setSelected(p.chosen ?? i.options[0].id);
      setStatus(p.status);
      setLoaded(true);
    }).catch((e) => { toast(e.message, 'error'); navigate('#/afford'); });
  }, [planId]); // eslint-disable-line

  // Save first's default amount follows the price until you change it.
  const touchedSave = useRef(false);
  useEffect(() => {
    if (touchedSave.current || !purchase.price) return;
    setOptions((os) => os.map((o) => (o.kind === 'save' ? { ...o, saveMonthly: roundTo5(purchase.price! / 6) } : o)));
  }, [purchase.price]);

  // Re-run the forecast as you type.
  const input = useMemo(() => ({
    purchase: { ...purchase, name: purchase.name.trim() || 'This purchase', price: purchase.price ?? 0, description: purchase.description || null },
    options, overrides, chosen,
  }), [purchase, options, overrides, chosen]);
  useEffect(() => {
    if (!loaded || !purchase.price || purchase.price <= 0) { setSim(null); return; }
    const t = setTimeout(() => {
      api.post<Sim>('/api/afford/simulate', input).then((r) => { setSim(r); setError(null); }).catch((e) => setError(e.message));
    }, 250);
    return () => clearTimeout(t);
  }, [JSON.stringify(input), loaded]); // eslint-disable-line

  const result = sim?.options.find((o) => o.id === selected) ?? sim?.options[0] ?? null;
  const update = (id: string, patch: Partial<Option>) => setOptions((os) => os.map((o) => (o.id === id ? { ...o, ...patch } : o)));
  const bought = status === 'bought';

  async function save(): Promise<number | null> {
    if (!purchase.name.trim()) { toast('Give the purchase a name first', 'error'); return null; }
    try {
      const body = { ...input, purchase: { ...input.purchase, name: purchase.name.trim() } };
      if (savedId) { await api.put(`/api/afford/plans/${savedId}`, body); toast('Simulation saved'); onSaved(); return savedId; }
      const r = await api.post<{ id: number }>('/api/afford/plans', body);
      setSavedId(r.id);
      // Show the saved simulation's address without reloading it (you're still working on it).
      window.history.replaceState(null, '', `#/afford?plan=${r.id}`);
      toast('Simulation saved');
      onSaved();
      return r.id;
    } catch (e: any) { toast(e.message, 'error'); return null; }
  }

  return (
    <>
      {ctx.missing.length > 0 && (
        <div className="hint-box hint-warn" role="note">
          <Icon name="alert" size={16} />
          <span><strong>Some of your figures are missing, so parts of this are rough:</strong>
            <ul className="afford-missing">{ctx.missing.map((m) => <li key={m.what}>{m.what}. {m.fix}</li>)}</ul>
          </span>
        </div>
      )}
      {bought && <div className="hint-box" role="note"><Icon name="check" size={16} /><span>You've bought this. The simulation is kept as it was so you can look back at it; it can't be changed.</span></div>}

      <Card title="What you want to buy" className="afford-purchase">
        <fieldset className="afford-form" disabled={bought}>
          <div className="grid-4">
            <Field label="Name"><input value={purchase.name} onChange={(e) => setPurchase({ ...purchase, name: e.target.value })} placeholder="e.g. New laptop" maxLength={120} /></Field>
            <Field label="Price"><PoundsInput value={purchase.price} onChange={(p) => setPurchase({ ...purchase, price: p })} placeholder="0.00" ariaLabel="Price" /></Field>
            <Field label="Category"><CategorySelect kind="expense" value={purchase.categoryId} onChange={(id) => setPurchase({ ...purchase, categoryId: id })} noneLabel="Choose a category" /></Field>
            <Field label="When you'd buy it"><input type="date" value={purchase.date} min={ctx.today} onChange={(e) => e.target.value && setPurchase({ ...purchase, date: e.target.value })} /></Field>
          </div>
          <div className="afford-form-row">
            <Field label="Priority"><Segmented value={purchase.priority} onChange={(v) => setPurchase({ ...purchase, priority: v })} options={PRIORITY as any} /></Field>
            <Field label="Notes (optional)"><input value={purchase.description} onChange={(e) => setPurchase({ ...purchase, description: e.target.value })} maxLength={500} placeholder="Why you want it, links, anything to remember" /></Field>
            {!bought && <button type="button" className="btn" onClick={save}><Icon name="archive" size={16} /> {savedId ? 'Save changes' : 'Save simulation'}</button>}
          </div>
          <p className="muted small afford-form-foot">Need a new category? <a href="#/categories">Add one in Categories</a>. {savedId ? <>Saved simulations are in <a href="#/afford?view=saved">Saved</a>.</> : 'Nothing here changes your money until you confirm a purchase.'}</p>
        </fieldset>
      </Card>
      <Verdict result={result} price={purchase.price} error={error} chosen={chosen} bought={bought}
        onChoose={(id) => setChosen(id)}
        onConfirm={async (r) => { const id = savedId ?? (await save()); if (id) { setSavedId(id); setConfirming(r); } }} />

      {purchase.price ? (
        <>
          <Card title="Ways to pay" className="afford-options" action={!bought && options.length < 8 ? <AddOption onAdd={(k, preset) => { const o = newOption(k, purchase.price, ctx, preset); setOptions([...options, o]); setSelected(o.id); }} /> : undefined}>
            {sim?.best && <p className="afford-best"><Icon name="sparkles" size={15} /> <span><strong>Best balance:</strong> {sim.best.why}</span></p>}
            {sim && !sim.best && options.length > 1 && <p className="afford-best bad"><Icon name="alert" size={15} /> <span>None of these work as things stand. Look at what would change it below each result, or try a later date.</span></p>}
            <OptionsTable options={options} results={sim?.options ?? []} selected={selected} chosen={chosen} onSelect={setSelected} best={sim?.best?.id ?? null}
              onRemove={bought ? undefined : (id) => { const rest = options.filter((o) => o.id !== id); setOptions(rest); if (selected === id) setSelected(rest[0].id); if (chosen === id) setChosen(null); }} />
          </Card>

          {result && (
            <Card title={`Set up: ${result.label}`} className="afford-editor">
              <fieldset disabled={bought}>
                <OptionEditor option={options.find((o) => o.id === result.id)!} result={result} ctx={ctx} price={purchase.price} purchaseDate={purchase.date}
                  maxSave={sim?.maxMonthlySaving ?? 0}
                  onChange={(patch) => { if ('saveMonthly' in patch) touchedSave.current = true; update(result.id, patch); }} />
              </fieldset>
              <Schedule result={result} />
            </Card>
          )}

          {sim && result && <Charts sim={sim} result={result} />}

          {sim && result && sim.options.length > 1 && <CompareCost sim={sim} selected={selected} />}
          {sim && result && <GoalsImpact ctx={ctx} result={result} purchaseName={purchase.name || 'this'} price={purchase.price} />}
          {sim && result && <Assumptions ctx={ctx} sim={sim} overrides={overrides} onChange={setOverrides} disabled={bought} />}
        </>
      ) : (
        <Card><Empty icon="target" title="Enter a price to see what it would do to your money">
          Coil works out each way to pay against your real balances, pay, bills, debts, saving and spending, day by day. Nothing changes until you confirm a purchase.
        </Empty></Card>
      )}

      {confirming && savedId && (
        <ConfirmPurchase planId={savedId} result={confirming} purchase={purchase} ctx={ctx} onClose={() => setConfirming(null)}
          onDone={() => { setConfirming(null); setStatus('bought'); onSaved(); }} />
      )}
    </>
  );
}

function AddOption({ onAdd }: { onAdd: (k: Kind, preset?: Option['preset']) => void }) {
  return (
    <select className="btn btn-sm add-option" aria-label="Add a way to pay" value="" onChange={(e) => { const m = KIND_MENU[Number(e.target.value)]; if (m) onAdd(m.kind, m.preset); }}>
      <option value="">Add a way to pay</option>
      {KIND_MENU.map((m, i) => <option key={i} value={i}>{m.label}</option>)}
    </select>
  );
}

// ---------------------------------------------------------------------------
// The verdict for the selected way to pay

function Verdict({ result, price, error, chosen, bought, onChoose, onConfirm }: {
  result: Result | null; price: number | null; error: string | null; chosen: string | null; bought: boolean;
  onChoose: (id: string) => void; onConfirm: (r: Result) => void;
}) {
  if (error) return <Card title="Can you afford it?"><p className="form-error">{error}</p></Card>;
  if (!price || !result) return <Card title="Can you afford it?"><p className="muted">Enter what it costs to see whether it fits.</p></Card>;
  const a = result.assessment;
  const l = LEVEL[a.level];
  return (
    <Card title="Can you afford it?" className={`afford-verdict verdict-${l.tone}`}>
      <div className="verdict-head">
        <span className={`verdict-icon tone-${l.tone}`}><Icon name={l.icon} size={20} /></span>
        <div>
          <div className="verdict-title">{a.title}</div>
          <div className="muted small">{result.label} · {result.classificationLabel}</div>
        </div>
      </div>
      <ul className="verdict-reasons">{a.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
      {a.adjustments.length > 0 && (
        <div className="verdict-adjust"><div className="field-label">What would make it work</div><ul>{a.adjustments.map((r, i) => <li key={i}>{r}</li>)}</ul></div>
      )}
      <ul className="verdict-checks">
        {a.checks.map((c) => (
          <li key={c.key} className={c.ok ? 'ok' : 'no'} title={c.detail}>
            <Icon name={c.ok ? 'check' : 'x'} size={14} /><span>{c.label}<span className="muted small"> — {c.detail}</span></span>
          </li>
        ))}
      </ul>
      {result.warnings.length > 0 && <div className="verdict-warn">{result.warnings.map((w, i) => <p key={i} className="small"><Icon name="info" size={13} /> {w}</p>)}</div>}
      {!bought && (
        <div className="row gap verdict-actions">
          {chosen === result.id
            ? <Badge tone="info">Your choice</Badge>
            : <button className="btn btn-sm" onClick={() => onChoose(result.id)}>Choose this way to pay</button>}
          {result.blockers.length === 0 && (
            <button className="btn btn-sm btn-primary" onClick={() => onConfirm(result)}>
              {result.kind === 'save' ? 'Save for this' : 'I’ve bought it'}
            </button>
          )}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Side by side

function OptionsTable({ options, results, selected, chosen, best, onSelect, onRemove }: {
  options: Option[]; results: Result[]; selected: string; chosen: string | null; best: string | null; onSelect: (id: string) => void; onRemove?: (id: string) => void;
}) {
  const byId = new Map(results.map((r) => [r.id, r]));
  return (
    <div className="table-wrap">
      <table className="rec-table keep-table afford-table">
        <thead><tr>
          <th>Way to pay</th><th className="num">Up front</th><th className="num">Then</th><th className="num">Total cost</th><th className="num">Interest and fees</th><th className="num">Lowest balance</th><th>Result</th>{onRemove && <th aria-label="Remove" />}
        </tr></thead>
        <tbody>
          {options.map((o) => {
            const r = byId.get(o.id);
            const l = r ? LEVEL[r.assessment.level] : null;
            return (
              <tr key={o.id} className={selected === o.id ? 'is-selected' : ''} onClick={() => onSelect(o.id)} aria-selected={selected === o.id}>
                <td>
                  <div className="opt-name">
                    <input type="radio" name="afford-opt" checked={selected === o.id} onChange={() => onSelect(o.id)} aria-label={r?.label ?? o.kind} />
                    <span>
                      <span className="opt-label">{r?.label ?? '…'}</span>
                      <span className="opt-tags">
                        {r && <span className={`kind-tag kind-${r.classification}`}>{r.classificationLabel}</span>}
                        {best === o.id && <Badge tone="good">Best balance</Badge>}
                        {chosen === o.id && <Badge tone="info">Your choice</Badge>}
                      </span>
                    </span>
                  </div>
                </td>
                <td className="num">{r ? money(r.upfront) : ''}</td>
                <td className="num">{r?.regularPayment != null && r.payments > 1 ? <>{money(r.regularPayment)} <span className="muted small">{FREQ_WORD[r.frequency ?? 'monthly']} × {r.schedule.filter((x) => x.n > 0 && !x.label.startsWith('Final')).length}</span></> : <span className="muted">—</span>}</td>
                <td className="num">{r ? money(r.totalPayable) : ''}</td>
                <td className="num">{r ? (r.totalInterest + r.totalFees > 0 ? <span className="bad-text">{money(r.totalInterest + r.totalFees)}</span> : <span className="muted">None</span>) : ''}</td>
                <td className="num">{r ? <span className={r.forecast.lowest.balance < 0 ? 'bad-text' : ''}>{money(r.forecast.lowest.balance)}</span> : ''}</td>
                <td>{r && l ? <Badge tone={l.tone}>{l.short}</Badge> : ''}</td>
                {onRemove && <td className="num">{options.length > 1 && <button className="icon-btn" aria-label="Remove this way to pay" onClick={(e) => { e.stopPropagation(); onRemove(o.id); }}><Icon name="x" size={14} /></button>}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Setting up one way to pay

function OptionEditor({ option: o, result, ctx, price, purchaseDate, maxSave, onChange }: {
  option: Option; result: Result; ctx: Ctx; price: number; purchaseDate: string; maxSave: number; onChange: (patch: Partial<Option>) => void;
}) {
  const card = ctx.cards.find((c) => c.accountId === o.cardId);
  return (
    <div className="afford-editor-body">
      {result.blockers.length > 0 && <div className="hint-box hint-warn"><Icon name="alert" size={16} /><span>{result.blockers.join(' ')}</span></div>}
      {o.kind === 'outright' && <p className="muted">Paid in full on {shortDate(purchaseDate)} from your available money.</p>}

      {(o.kind === 'bnpl' || o.kind === 'instalments' || o.kind === 'finance') && (
        <div className="grid-4">
          {o.kind === 'bnpl' && (
            <Field label="Plan">
              <select value={o.preset ?? 'pay_in_3'} onChange={(e) => onChange({ preset: e.target.value as Option['preset'], payments: undefined, frequency: undefined, firstPayment: undefined })}>
                <option value="pay_in_3">Pay in 3, monthly</option><option value="pay_in_4">Pay in 4, every 2 weeks</option><option value="pay_in_30">Pay in 30 days</option>
              </select>
            </Field>
          )}
          {o.kind !== 'bnpl' && (
            <Field label="Number of payments">
              <select value={[3, 4, 6, 12, 18, 24, 36, 48].includes(o.payments ?? 12) ? String(o.payments ?? 12) : 'custom'}
                onChange={(e) => onChange({ payments: e.target.value === 'custom' ? (o.payments ?? 12) + 1 : Number(e.target.value) })}>
                {[3, 4, 6, 12, 18, 24, 36, 48].map((n) => <option key={n} value={n}>{n}</option>)}<option value="custom">Custom</option>
              </select>
            </Field>
          )}
          {o.kind !== 'bnpl' && ![3, 4, 6, 12, 18, 24, 36, 48].includes(o.payments ?? 12) && (
            <Field label="Custom number"><input type="number" min={1} max={120} value={o.payments ?? ''} onChange={(e) => onChange({ payments: Math.max(1, Math.min(120, Number(e.target.value) || 1)) })} /></Field>
          )}
          <Field label="How often">
            <select value={o.frequency ?? result.frequency ?? 'monthly'} onChange={(e) => onChange({ frequency: e.target.value as Freq })}>
              <option value="monthly">Monthly</option><option value="fortnightly">Every 2 weeks</option><option value="weekly">Weekly</option>
            </select>
          </Field>
          <Field label="First payment"><input type="date" value={o.firstPayment ?? result.schedule.find((r) => r.n === 1)?.date ?? ''} min={purchaseDate} onChange={(e) => onChange({ firstPayment: e.target.value || undefined })} /></Field>
          <Field label="APR" hint={o.kind === 'bnpl' ? 'Usually 0%' : '0% for interest-free'}><PercentInput value={o.apr ?? 0} onChange={(v) => onChange({ apr: v ?? 0 })} ariaLabel="APR" /></Field>
          {o.kind !== 'bnpl' && <Field label="Deposit"><PoundsInput value={o.deposit ?? 0} onChange={(v) => onChange({ deposit: v ?? 0 })} ariaLabel="Deposit" /></Field>}
          <Field label="Arrangement fee"><PoundsInput value={o.upfrontFee ?? 0} onChange={(v) => onChange({ upfrontFee: v ?? 0 })} ariaLabel="Arrangement fee" /></Field>
          <Field label="Fee per payment"><PoundsInput value={o.paymentFee ?? 0} onChange={(v) => onChange({ paymentFee: v ?? 0 })} ariaLabel="Fee per payment" /></Field>
          {o.kind === 'finance' && <Field label="Final (balloon) payment" hint="PCP-style, optional"><PoundsInput value={o.balloon ?? 0} onChange={(v) => onChange({ balloon: v ?? 0 })} ariaLabel="Final payment" /></Field>}
          <Field label="Name (optional)"><input value={o.label ?? ''} onChange={(e) => onChange({ label: e.target.value || undefined })} placeholder={result.label} maxLength={60} /></Field>
        </div>
      )}

      {o.kind === 'card' && (
        <>
          {ctx.cards.length === 0 ? <p className="muted">You have no credit cards in Coil. Add one on <a href="#/accounts">Accounts</a> first.</p> : (
            <div className="grid-4">
              <Field label="Card">
                <select value={o.cardId ?? ''} onChange={(e) => onChange({ cardId: Number(e.target.value) })}>
                  {ctx.cards.map((c) => <option key={c.accountId} value={c.accountId}>{c.name}</option>)}
                </select>
              </Field>
              <Field label="How you'll pay it off">
                <select value={o.cardPlan ?? 'full'} onChange={(e) => onChange({ cardPlan: e.target.value as Option['cardPlan'] })}>
                  <option value="full">In full at the next statement</option>
                  <option value="fixed">A fixed amount each month</option>
                  <option value="promo">Before the 0% offer ends</option>
                  <option value="minimum">Minimum payments only</option>
                </select>
              </Field>
              {o.cardPlan === 'fixed' && <Field label="Each month"><PoundsInput value={o.cardMonthly ?? null} onChange={(v) => onChange({ cardMonthly: v ?? 0 })} ariaLabel="Each month" /></Field>}
              <Field label="Rate on this purchase" hint={card?.apr != null ? `Card APR ${(card.apr / 100).toFixed(1)}%` : 'No APR saved for this card'}>
                <PercentInput value={o.purchaseApr ?? card?.apr ?? 0} onChange={(v) => onChange({ purchaseApr: v })} ariaLabel="Rate on this purchase" />
              </Field>
              <Field label="0% offer on purchases until" hint={card?.promoEnd ? `Card offer ends ${shortDate(card.promoEnd)}` : 'Leave empty if none'}>
                <input type="date" value={o.purchasePromoEnd ?? ''} onChange={(e) => onChange({ purchasePromoEnd: e.target.value || null })} />
              </Field>
            </div>
          )}
          {card && (
            <p className="muted small">
              {card.name}: you owe {money(card.owed)}{card.creditLimit != null ? `, limit ${money(card.creditLimit)}, so ${money(Math.max(0, card.creditLimit - card.owed))} of credit left before this` : '. No credit limit saved: add it on the Debts page to check this fits'}
              {card.paysInFull ? '. You pay it in full each month.' : '.'}
            </p>
          )}
        </>
      )}

      {o.kind === 'save' && (
        <>
          <div className="grid-4">
            <Field label="Save each month"><PoundsInput value={o.saveMonthly ?? null} onChange={(v) => onChange({ saveMonthly: v ?? 0 })} ariaLabel="Save each month" /></Field>
            <Field label="Starting" hint={ctx.firstPayday ? 'Default: the day after payday' : undefined}><input type="date" value={o.saveStart ?? result.firstDate ?? ''} min={ctx.today} onChange={(e) => onChange({ saveStart: e.target.value || undefined })} /></Field>
          </div>
          {result.save && (
            <p className="afford-save-line">
              Saving {money(result.save.monthly)} a month, you'd have {money(price)} by <strong>{shortDate(result.save.reached)}</strong> ({result.save.months} month{result.save.months === 1 ? '' : 's'}).
              {' '}{maxSave > 0 ? <>The most you could put aside and keep Free to spend above your minimum is about <strong>{money(maxSave)}</strong> a month.</> : <>Right now there's no room to save more each month without dropping below your Free to spend minimum.</>}
            </p>
          )}
          {result.save && (
            <div className="save-alts" role="group" aria-label="Other monthly amounts">
              {result.save.alternatives.map((a) => (
                <button key={a.monthly} type="button" className={`btn btn-sm ${a.monthly === o.saveMonthly ? 'is-on' : ''}`} onClick={() => onChange({ saveMonthly: a.monthly })}>
                  {money(a.monthly)}/month · {a.months} months · {monthLabel(a.reached.slice(0, 7), true)}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Charts

const shortDay = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Keep a long daily series readable: the lowest day in each step, so dips still show. */
function thin(days: { date: string; balance: number }[], max = 160) {
  if (days.length <= max) return days.map((_, i) => i);
  const step = Math.ceil(days.length / max);
  const out: number[] = [];
  for (let i = 0; i < days.length; i += step) {
    let lo = i;
    for (let k = i; k < Math.min(days.length, i + step); k++) if (days[k].balance < days[lo].balance) lo = k;
    out.push(lo);
  }
  return out;
}

function Charts({ sim, result }: { sim: Sim; result: Result }) {
  const [hiddenF, toggleF] = useHidden();
  const [hiddenM, toggleM] = useHidden();
  const f = result.forecast;
  const idx = thin(f.days);
  const months = f.months.filter((m) => m.month <= (result.lastDate ?? '').slice(0, 7) || f.months.indexOf(m) < 4).slice(0, 25);
  const base = new Map(sim.baseline.months.map((m) => [m.month, m]));
  return (
    <>
      <Card title="Your available money, day by day" className="afford-balance">
        <p className="muted small chart-note">
          With {result.label.toLowerCase()}, your lowest point is <strong className={f.lowest.balance < 0 ? 'bad-text' : ''}>{money(f.lowest.balance)}</strong> on {shortDate(f.lowest.date)}
          {' '}(without it: {money(sim.baseline.lowest.balance)} on {shortDate(sim.baseline.lowest.date)}). Pay arrives on its real dates, so the line dips before each payday.
        </p>
        <LineChart labels={idx.map((i) => shortDay(f.days[i].date))} titles={idx.map((i) => new Date(f.days[i].date + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }))}
          series={[
            { key: 'with', label: `With ${result.label.toLowerCase()}`, colour: 'var(--purchase)', values: idx.map((i) => f.days[i].balance) },
            { key: 'without', label: 'Without the purchase', colour: 'var(--spend)', values: idx.map((i) => sim.baseline.days[i]?.balance ?? null), dashed: true },
          ]}
          reference={{ value: 0, label: '£0' }} height={240} />
      </Card>
      <div className="grid-2-cards">
        <Card title="Free to spend each month">
          <p className="muted small chart-note">What's left after bills, debts, saving, day-to-day spending and this purchase. The line is your minimum.</p>
          <StackedBars grouped labels={months.map((m) => monthLabel(m.month, true))} titles={months.map((m) => monthLabel(m.month))}
            series={[
              { key: 'before', label: 'Before', colour: 'var(--spend)', values: months.map((m) => base.get(m.month)?.freeToSpend ?? 0) },
              { key: 'after', label: 'After', colour: 'var(--purchase)', values: months.map((m) => m.freeToSpend) },
            ]}
            line={{ label: 'Your minimum', colour: 'var(--warn)', values: months.map((m) => m.floor) }}
            hidden={hiddenF} onToggle={toggleF} height={230} barHint="" />
        </Card>
        <Card title="Where each month's money goes">
          <p className="muted small chart-note">With {result.label.toLowerCase()}. The line is the month's income.</p>
          <StackedBars labels={months.map((m) => monthLabel(m.month, true))} titles={months.map((m) => monthLabel(m.month))}
            series={[
              { key: 'bills', label: 'Bills', colour: 'var(--bills)', values: months.map((m) => m.bills) },
              { key: 'debts', label: 'Debt repayments', colour: 'var(--bad)', values: months.map((m) => m.debts) },
              { key: 'saving', label: 'Saving and investing', colour: 'var(--saved)', values: months.map((m) => m.saving) },
              { key: 'everyday', label: 'Everyday spending', colour: 'var(--spend)', values: months.map((m) => m.everyday) },
              { key: 'purchase', label: 'This purchase', colour: 'var(--purchase)', values: months.map((m) => m.purchase) },
            ]}
            line={{ label: 'Income', colour: 'var(--income)', values: months.map((m) => m.income) }}
            hidden={hiddenM} onToggle={toggleM} height={230} barHint="" />
        </Card>
      </div>
    </>
  );
}

function Schedule({ result }: { result: Result }) {
  const { rows, pager } = usePaged(result.schedule, 6, result.id + result.schedule.length);
  return (
    <section className="afford-schedule" aria-label={result.kind === 'save' ? 'Saving plan' : 'Payment schedule'}>
      <div className="field-label sched-head">{result.kind === 'save' ? 'Saving plan' : 'Payment schedule'}</div>
      {result.schedule.length === 0 ? <p className="muted">No payments set up yet.</p> : (
        <>
          <div className="table-wrap"><table className="rec-table keep-table sched-table">
            <thead><tr><th>Date</th><th>Payment</th><th className="num">Amount</th><th className="num">Interest and fees</th><th className="num">{result.kind === 'save' ? 'Still to save' : 'Left to pay'}</th></tr></thead>
            <tbody>{rows.map((r, i) => (
              <tr key={i}><td>{shortDate(r.date)}</td><td>{r.label}</td><td className="num">{money(r.payment)}</td><td className="num">{r.interest + r.fees ? money(r.interest + r.fees) : <span className="muted">—</span>}</td><td className="num">{money(r.remaining)}</td></tr>
            ))}</tbody>
          </table></div>
          {pager}
          <p className="sched-total small">Total {money(result.totalPayable)}{result.totalInterest ? `, of which ${money(result.totalInterest)} interest` : ''}{result.totalFees ? ` and ${money(result.totalFees)} fees` : ''}.</p>
        </>
      )}
    </section>
  );
}

function CompareCost({ sim, selected }: { sim: Sim; selected: string }) {
  const [hidden, toggle] = useHidden();
  const opts = sim.options.filter((o) => o.blockers.length === 0);
  return (
    <Card title="What each way costs">
      <p className="muted small chart-note">The price plus any interest and fees, for each way to pay.</p>
      <StackedBars labels={opts.map((o) => (o.label.length > 16 ? o.label.slice(0, 15) + '…' : o.label))} titles={opts.map((o) => o.label)}
        series={[
          { key: 'price', label: 'Price', colour: 'var(--spend)', values: opts.map((o) => o.totalPayable - o.totalInterest - o.totalFees) },
          { key: 'interest', label: 'Interest', colour: 'var(--bad)', values: opts.map((o) => o.totalInterest) },
          { key: 'fees', label: 'Fees', colour: 'var(--nw-cards)', values: opts.map((o) => o.totalFees) },
        ]}
        selected={opts.findIndex((o) => o.id === selected)} hidden={hidden} onToggle={toggle} height={230} barHint="" />
    </Card>
  );
}

function GoalsImpact({ ctx, result, purchaseName, price }: { ctx: Ctx; result: Result; purchaseName: string; price: number }) {
  const pausing = result.assessment.adjustments.join(' ');
  return (
    <Card title="Your goals">
      {result.save && (
        <div className="goal-new">
          <div className="row gap between"><strong>New goal: {purchaseName}</strong><span className="muted small">{money(result.save.monthly)} a month</span></div>
          <p className="muted small">Saving for it from {shortDate(result.firstDate ?? ctx.today)}, reaching {money(price)} by {shortDate(result.save.reached)}. Pressing “Save for this” adds it to Goals.</p>
        </div>
      )}
      {ctx.goals.length === 0 && !result.save ? <p className="muted">You have no goals with a monthly amount.</p> : (
        <ul className="goal-impact">
          {ctx.goals.map((g) => {
            const paused = pausing.includes(g.name);
            const at = result.assessment.level === 'not_affordable' || result.assessment.level === 'stretching';
            return (
              <li key={g.id}>
                <span><strong>{g.name}</strong>{g.isEmergency && <span className="muted small"> · emergency fund</span>}<br /><span className="muted small">{money(g.monthlyTarget)} a month{g.account ? ` into ${g.account}` : ''}</span></span>
                {paused ? <Badge tone="warn">Pause to make it work</Badge> : at ? <Badge tone="warn">At risk</Badge> : <Badge tone="good">Carries on</Badge>}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function Assumptions({ ctx, sim, overrides, onChange, disabled }: { ctx: Ctx; sim: Sim; overrides: Overrides; onChange: (o: Overrides) => void; disabled: boolean }) {
  const [editing, setEditing] = useState(Object.keys(overrides).length > 0);
  const acc = (id: number) => overrides.accounts?.[String(id)];
  const setAcc = (id: number, v: { include: boolean; amount?: number | null } | null) => {
    const next = { ...(overrides.accounts ?? {}) };
    if (v) next[String(id)] = v; else delete next[String(id)];
    onChange({ ...overrides, accounts: Object.keys(next).length ? next : undefined });
  };
  const floorMode = overrides.floorAmount != null ? 'amount' : 'percent';
  return (
    <Card title="What this is based on" action={!disabled ? <button className="link-btn" onClick={() => setEditing(!editing)}>{editing ? 'Hide' : 'Change figures'}</button> : undefined}>
      <ul className="assumptions">
        {sim.assumptions.map((a) => <li key={a.label}><span className="field-label">{a.label}</span><span>{a.value} {a.changed && <Badge tone="info">Changed</Badge>}</span></li>)}
      </ul>
      {editing && (
        <fieldset className="overrides" disabled={disabled}>
          <p className="muted small">Changes here only apply to this simulation.</p>
          <div className="grid-2">
            <Field label="Your pay each payday" hint={`Usually ${money(ctx.pay.amount)}`}><PoundsInput value={overrides.pay ?? null} placeholder={penceToInput(ctx.pay.amount)} onChange={(v) => onChange({ ...overrides, pay: v })} ariaLabel="Pay" /></Field>
            <Field label="Day-to-day spending a month" hint={`Your average: ${money(ctx.everyday.average)}`}><PoundsInput value={overrides.everyday ?? null} placeholder={penceToInput(ctx.everyday.average)} onChange={(v) => onChange({ ...overrides, everyday: v })} ariaLabel="Day-to-day spending" /></Field>
            <Field label="Saving and investing a month" hint={`Usually ${money(ctx.savingPerMonth)}`}><PoundsInput value={overrides.saving ?? null} placeholder={penceToInput(ctx.savingPerMonth)} onChange={(v) => onChange({ ...overrides, saving: v })} ariaLabel="Saving" /></Field>
            <Field label="Free to spend minimum">
              <div className="row gap">
                <Segmented value={floorMode} onChange={(m) => onChange({ ...overrides, floorAmount: m === 'amount' ? (overrides.floorAmount ?? Math.round(ctx.pay.amount / 10)) : null })} options={[{ value: 'percent', label: '%' }, { value: 'amount', label: '£' }]} />
                {floorMode === 'percent'
                  ? <PercentInput value={overrides.floorPercent ?? 1000} onChange={(v) => onChange({ ...overrides, floorPercent: v })} ariaLabel="Minimum percent" />
                  : <PoundsInput value={overrides.floorAmount ?? null} onChange={(v) => onChange({ ...overrides, floorAmount: v ?? 0 })} ariaLabel="Minimum amount" />}
              </div>
            </Field>
          </div>
          <div className="field-label acc-head">Money you could use</div>
          <ul className="acc-pool">
            {ctx.accounts.map((a) => {
              const o = acc(a.id);
              const on = o ? o.include : a.defaultIncluded;
              const protectedText = [a.emergency && `${money(a.emergency)} emergency fund`, a.goals && `${money(a.goals)} goal money`].filter(Boolean).join(', ');
              return (
                <li key={a.id}>
                  <label className="check"><input type="checkbox" checked={on} onChange={(e) => setAcc(a.id, e.target.checked === a.defaultIncluded && !o?.amount ? null : { include: e.target.checked })} />
                    <span>{a.name}<br /><span className="muted small">{money(a.balance)}{protectedText ? ` (${protectedText})` : ''}{a.type === 'investment' ? ' · investments' : ''}</span></span>
                  </label>
                  {on && <PoundsInput value={o?.amount ?? (a.defaultIncluded ? a.defaultAmount : Math.max(0, a.balance))} onChange={(v) => setAcc(a.id, { include: true, amount: v })} ariaLabel={`Amount of ${a.name}`} />}
                </li>
              );
            })}
          </ul>
          <button className="btn btn-sm" onClick={() => onChange({})}>Use my usual figures</button>
        </fieldset>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Saved simulations

function SavedList({ list, reload }: { list: Saved[]; reload: () => void }) {
  const { toast } = useApp();
  const [confirm, confirmNode] = useConfirm();
  const { rows, pager } = usePaged(list, 10, String(list.length));
  if (!list.length) return <Card><Empty icon="target" title="No saved simulations yet">Try a purchase in New simulation and press Save simulation to keep it here.</Empty></Card>;
  async function setStatus(s: Saved, status: 'planned' | 'dropped') {
    try { await api.put(`/api/afford/plans/${s.id}/status`, { status }); reload(); } catch (e: any) { toast(e.message, 'error'); }
  }
  async function remove(s: Saved) {
    const extra = s.status === 'bought' ? ' What it added (a debt, goal or bills) stays.' : '';
    if (!(await confirm(`Delete the “${s.name}” simulation?${extra}`, { label: 'Delete' }))) return;
    try { await api.del(`/api/afford/plans/${s.id}`); toast('Simulation deleted'); reload(); } catch (e: any) { toast(e.message, 'error'); }
  }
  return (
    <Card title="Saved purchases" pad={false}>
      {confirmNode}
      <p className="muted small saved-note">Each planned purchase is worked out again against today's figures, so you can compare them as things change.</p>
      <div className="table-wrap">
        <table className="rec-table keep-table saved-table">
          <thead><tr><th>Purchase</th><th>When</th><th>Way to pay</th><th className="num">Then</th><th className="num">Total cost</th><th className="num">Lowest balance</th><th>Result</th><th aria-label="Actions" /></tr></thead>
          <tbody>
            {rows.map((s) => {
              const sm = s.summary;
              return (
                <tr key={s.id} onClick={() => navigate(`#/afford?plan=${s.id}`)} className={s.status !== 'planned' ? 'is-inactive' : ''}>
                  <td><strong>{s.name}</strong><br /><span className="muted small">{money(s.price)}</span></td>
                  <td>{shortDate(s.purchaseDate)}</td>
                  <td>{s.status === 'bought' ? <Badge tone="good">Bought{s.boughtAt ? ` ${shortDate(s.boughtAt)}` : ''}</Badge> : s.status === 'dropped' ? <Badge>Dropped</Badge> : sm ? <>{sm.option}<br /><span className="muted small">{sm.classification}</span></> : <span className="muted">Open to update</span>}</td>
                  <td className="num">{sm?.regularPayment != null ? `${money(sm.regularPayment)} ${FREQ_WORD[sm.frequency ?? 'monthly']}` : sm ? money(sm.upfront) : ''}</td>
                  <td className="num">{sm ? money(sm.totalPayable) : ''}</td>
                  <td className="num">{sm ? <span className={sm.lowest.balance < 0 ? 'bad-text' : ''}>{money(sm.lowest.balance)}</span> : ''}</td>
                  <td>{sm ? <Badge tone={LEVEL[sm.level].tone}>{LEVEL[sm.level].short}</Badge> : ''}</td>
                  <td className="num" onClick={(e) => e.stopPropagation()}>
                    <span className="row gap end-row">
                      {s.status === 'planned' && <button className="btn btn-sm" onClick={() => setStatus(s, 'dropped')}>Drop</button>}
                      {s.status === 'dropped' && <button className="btn btn-sm" onClick={() => setStatus(s, 'planned')}>Plan again</button>}
                      <button className="icon-btn" aria-label={`Delete ${s.name}`} onClick={() => remove(s)}><Icon name="trash" size={15} /></button>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {pager}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Confirming a purchase: the only step that changes your records.

function ConfirmPurchase({ planId, result, purchase, ctx, onClose, onDone }: {
  planId: number; result: Result; purchase: Purchase; ctx: Ctx; onClose: () => void; onDone: () => void;
}) {
  const { toast, accounts, refresh } = useApp() as any;
  const everyday = accounts.filter((a: any) => ['current', 'cash'].includes(a.type) && !a.archived);
  const [from, setFrom] = useState<number | null>(everyday[0]?.id ?? null);
  const [savingsAccount, setSavingsAccount] = useState<number | null>(accounts.find((a: any) => ['savings', 'pot'].includes(a.type) && !a.archived)?.id ?? null);
  const [provider, setProvider] = useState(result.kind === 'bnpl' ? (result.label.includes('Clearpay') ? 'Clearpay' : 'Klarna') : '');
  const financed = ['bnpl', 'instalments', 'finance'].includes(result.kind);
  const [boughtOn, setBoughtOn] = useState(financed && purchase.date > ctx.today ? ctx.today : purchase.date);
  const [shop, setShop] = useState(purchase.name);
  const [busy, setBusy] = useState(false);
  const what: string[] = [];
  if (result.kind === 'outright') what.push(`A one-off payment of ${money(purchase.price!)} on ${shortDate(boughtOn)} in Bills and income. It's ticked off when the transaction comes in with your next import, so it's only counted once.`);
  if (result.kind === 'bnpl' || result.kind === 'instalments' || result.kind === 'finance') {
    const deposit = result.schedule.find((r) => r.label === 'Deposit');
    what.push(`A debt for ${purchase.name || 'this purchase'} on the Debts page, with its ${result.payments} payments and any interest.`);
    what.push(`The purchase, recorded once on ${shortDate(boughtOn)} as spending in its category.`);
    what.push(`The repayments in Bills and income, stopping after the last one. When each is matched, its interest and fees are split out as spending.`);
    if (deposit) what.push(`A one-off deposit payment of ${money(deposit.payment)} on ${shortDate(deposit.date)}.`);
    const balloon = result.schedule.find((r) => r.label.startsWith('Final'));
    if (balloon) what.push(`A one-off final payment of ${money(balloon.payment)} on ${shortDate(balloon.date)}.`);
  }
  if (result.kind === 'card') {
    const card = ctx.cards.find((c) => c.name === result.card?.name);
    what.push(`A one-off payment of ${money(purchase.price!)} on ${result.card?.name ?? 'the card'} on ${shortDate(boughtOn)} in Bills and income, ticked off when your card statement comes in.`);
    if (card?.paysInFull && result.payments <= 1) what.push('Nothing extra to pay: it goes with your usual full payment of the card.');
    else what.push(`${result.payments === 1 ? 'An extra card payment' : `Extra card payments of about ${money(result.regularPayment ?? 0)} a month`} in Bills and income, ending when it's paid off.`);
  }
  if (result.kind === 'save') what.push(`A goal, “${purchase.name}”, for ${money(purchase.price!)}, saving ${money(result.save?.monthly ?? 0)} a month, reached by ${shortDate(result.save?.reached ?? ctx.today)}.`);

  async function go() {
    setBusy(true);
    try {
      await api.post(`/api/afford/plans/${planId}/confirm`, { optionId: result.id, fromAccountId: from, savingsAccountId: savingsAccount, provider: provider || null, boughtOn, shop: shop || null });
      toast(result.kind === 'save' ? 'Goal added' : 'Purchase recorded');
      refresh?.();
      onDone();
    } catch (e: any) { toast(e.message, 'error'); } finally { setBusy(false); }
  }
  return (
    <Modal title={result.kind === 'save' ? 'Save for this' : 'Confirm the purchase'} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || (result.kind === 'save' ? !savingsAccount : !from)} onClick={go}>{result.kind === 'save' ? 'Add the goal' : 'Record it'}</button></>}>
      <div className="form">
      <p>{result.label}. This will add:</p>
      <ul className="confirm-list">{what.map((w, i) => <li key={i}>{w}</li>)}</ul>
      {result.kind !== 'save' && (
        <div className="grid-2">
          <Field label={financed ? 'Bought on' : 'Date'}><input type="date" value={boughtOn} max={financed ? ctx.today : undefined} onChange={(e) => e.target.value && setBoughtOn(e.target.value)} /></Field>
          <Field label="Shop name on your statement" hint="So the payment is matched when it comes in"><input value={shop} onChange={(e) => setShop(e.target.value)} maxLength={60} /></Field>
        </div>
      )}
      {result.kind === 'save'
        ? <Field label="Save into"><AccountSelect value={savingsAccount} onChange={setSavingsAccount} filter={(a: any) => ['savings', 'pot', 'current'].includes(a.type) && !a.archived} /></Field>
        : <Field label={result.kind === 'card' ? 'Pay the card from' : 'Pay from'}><AccountSelect value={from} onChange={setFrom} filter={(a: any) => ['current', 'cash', 'savings'].includes(a.type) && !a.archived} /></Field>}
      {(result.kind === 'bnpl' || result.kind === 'instalments' || result.kind === 'finance') && (
        <Field label="Who it's with (optional)" hint="Also how its payments show on your statement"><input value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="e.g. Klarna, the shop, the lender" maxLength={40} /></Field>
      )}
      <p className="muted small">The simulation is kept, marked as bought, so you can look back at it.</p>
      </div>
    </Modal>
  );
}
