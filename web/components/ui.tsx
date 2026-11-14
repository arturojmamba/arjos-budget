import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon, iconFor } from './Icon.tsx';
import { money, initials } from '../format.ts';
import type { Account, Category, Meta } from '../api.ts';

// ---------- App data context ----------

export interface AppData {
  meta: Meta;
  accounts: Account[];
  categories: Category[];
  /** Bumps after any change so pages reload their data. */
  version: number;
  refresh: () => void;
  toast: (msg: string, kind?: 'ok' | 'error') => void;
  /** Balances hidden (privacy mode). */
  hidden: boolean;
}

export const AppContext = createContext<AppData>(null as unknown as AppData);
export const useApp = () => useContext(AppContext);

/** Load data and reload whenever deps or the global version change. */
export function useData<T>(load: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const { version } = useApp();
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    load()
      .then((data) => live && setState({ data, error: null, loading: false }))
      .catch((e) => live && setState((s) => ({ data: s.data, error: e.message, loading: false })));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, version, tick]);
  return { ...state, reload: useCallback(() => setTick((t) => t + 1), []) };
}

// ---------- Primitives ----------

export function Money({ value, sign, className, abs, compact }: { value: number; sign?: boolean; className?: string; abs?: boolean; compact?: boolean }) {
  return <span className={`money ${className ?? ''}`}>{money(value, { sign, abs, compact })}</span>;
}

/** Built-in line icons are named like 'shopping-cart'; anything else (an emoji) is shown as text. */
export const isIconName = (s: string) => /^[a-z0-9-]+$/.test(s);

export function Bubble({ colour, icon, label, size = 36 }: { colour: string; icon?: string | null; label?: string; size?: number }) {
  return (
    <span className="bubble" style={{ width: size, height: size, background: `${colour}1f`, color: `color-mix(in srgb, ${colour} 80%, var(--text))` }}>
      {iconFor(icon) ? <Icon name={iconFor(icon)!} size={Math.round(size * 0.5)} />
        : icon ? <span className="bubble-emoji" style={{ fontSize: Math.round(size * 0.52) }}>{icon}</span>
        : <span style={{ fontSize: size * 0.36 }}>{initials(label ?? '?')}</span>}
    </span>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info'; children: React.ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

/**
 * A bar. Against a limit (no tone or colour), it says how it's going: green, amber from 85%, red when
 * over. `colour` is for a share of something (a category's part of the spending), which is neither
 * good nor bad. `info` is for money being saved or moved.
 */
export function Progress({ value, max, tone, colour }: { value: number; max: number; tone?: 'good' | 'warn' | 'bad' | 'info'; colour?: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const t = tone ?? (pct >= 100 ? 'bad' : pct >= 85 ? 'warn' : 'good');
  return (
    <div className="progress" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      {colour ? <span className="progress-cat" style={{ width: `${pct}%`, background: colour }} /> : <span className={`progress-${t}`} style={{ width: `${pct}%` }} />}
    </div>
  );
}

export function Card({ title, action, children, className, pad = true }: { title?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={`card ${pad ? 'card-pad' : ''} ${className ?? ''}`}>
      {(title || action) && (
        <header className="card-head">
          {title && <h2>{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Empty({ icon = 'info', title, children }: { icon?: string; title: string; children?: React.ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-icon"><Icon name={icon} size={22} /></span>
      <p className="empty-title">{title}</p>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="tablist">
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={value === o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: React.ReactNode; error?: string | null; children: React.ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    const first = ref.current?.querySelector<HTMLElement>('input:not([type=checkbox]), select, textarea');
    first?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

/** Category <select> grouped by kind with subcategories indented. */
export function CategorySelect({ value, onChange, kind, allowNone = true, noneLabel = 'Uncategorised', id }: {
  value: number | null; onChange: (id: number | null) => void; kind?: 'expense' | 'income'; allowNone?: boolean; noneLabel?: string; id?: string;
}) {
  const { categories } = useApp();
  const groups: ('expense' | 'income')[] = kind ? [kind] : ['expense', 'income'];
  return (
    <select id={id} aria-label={id ? undefined : 'Category'} value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      {allowNone && <option value="">{noneLabel}</option>}
      {groups.map((k) => (
        <optgroup key={k} label={k === 'expense' ? 'Spending' : 'Income'}>
          {categories
            .filter((c) => c.kind === k && c.parentId === null && (!c.archived || c.id === value))
            .flatMap((parent) => [
              <option key={parent.id} value={parent.id}>{parent.name}</option>,
              ...categories
                .filter((c) => c.parentId === parent.id && (!c.archived || c.id === value))
                .map((c) => <option key={c.id} value={c.id}>{'   '}{c.name}</option>),
            ])}
        </optgroup>
      ))}
    </select>
  );
}

export function AccountSelect({ value, onChange, exclude, allowAll, allLabel = 'All accounts', id, filter }: {
  value: number | null; onChange: (id: number | null) => void; exclude?: number | null; allowAll?: boolean; allLabel?: string; id?: string;
  filter?: (a: Account) => boolean;
}) {
  const { accounts } = useApp();
  const list = accounts.filter((a) => a.id !== exclude && (!filter || filter(a)));
  return (
    <select id={id} aria-label={id ? undefined : 'Account'} value={value ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
      {allowAll ? <option value="">{allLabel}</option> : value == null && <option value="">Choose an account…</option>}
      <optgroup label="Money">
        {list.filter((a) => !a.isLiability).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </optgroup>
      <optgroup label="Cards and loans">
        {list.filter((a) => a.isLiability).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </optgroup>
    </select>
  );
}

export function useConfirm(): [(msg: string, opts?: { label?: string; danger?: boolean }) => Promise<boolean>, React.ReactNode] {
  const [state, setState] = useState<{ msg: string; label: string; danger: boolean; resolve: (v: boolean) => void } | null>(null);
  const ask = useCallback((msg: string, opts?: { label?: string; danger?: boolean }) =>
    new Promise<boolean>((resolve) => setState({ msg, label: opts?.label ?? 'Delete', danger: opts?.danger ?? !opts?.label, resolve })), []);
  const close = (v: boolean) => { state?.resolve(v); setState(null); };
  const node = state ? (
    <Modal title="Are you sure?" onClose={() => close(false)}
      footer={<><button className="btn" onClick={() => close(false)}>Cancel</button><button className={`btn ${state.danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => close(true)}>{state.label}</button></>}>
      <p className="muted">{state.msg}</p>
    </Modal>
  ) : null;
  return [ask, node];
}

export function amountClass(p: number, kind?: string): string {
  if (kind === 'transfer') return 'amt-transfer';
  return p > 0 ? 'amt-in' : 'amt-out';
}

export function Stat({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: 'good' | 'bad' }) {
  return (
    <div className="stat">
      <p className="stat-label">{label}</p>
      <p className={`stat-value ${tone ? `tone-${tone}` : ''}`}>{value}</p>
      {sub && <p className="stat-sub">{sub}</p>}
    </div>
  );
}

export { money };

/** Paging for a list inside a card: "11–20 of 23" with previous / next arrows. Hidden when it all fits. */
export function usePaged<T>(list: T[], size: number, resetKey: string) {
  const [page, setPage] = React.useState(0);
  React.useEffect(() => setPage(0), [resetKey]);
  const pages = Math.max(1, Math.ceil(list.length / size));
  const at = Math.min(page, pages - 1);
  const rows = list.slice(at * size, (at + 1) * size);
  const pager = pages > 1 ? (
    <nav className="card-pager" aria-label="Pages">
      <span className="muted small">{at * size + 1}–{at * size + rows.length} of {list.length}</span>
      <span className="row">
        <button className="icon-btn" onClick={() => setPage(at - 1)} disabled={at === 0} aria-label={`Previous ${size}`}><Icon name="chevron-left" size={16} /></button>
        <button className="icon-btn" onClick={() => setPage(at + 1)} disabled={at >= pages - 1} aria-label={`Next ${size}`}><Icon name="chevron-right" size={16} /></button>
      </span>
    </nav>
  ) : null;
  return { rows, pager };
}

/**
 * How many rows fit in a .fit-row card (one that takes its height from the card beside it), so a
 * list fills the space and pages instead of scrolling. Put the ref on the .fit-fill element holding
 * the list; mark a header with data-fit-head and each row with data-fit-row. When the card isn't
 * height-bound (one column, on narrow windows) it uses `fallback`.
 */
export function useFitRows(total: number, fallback: number, { pagerHeight = 52, min = 3 } = {}) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const card = el.parentElement;
      if (!card || !getComputedStyle(card).contain.includes('size')) { setSize(fallback); return; }
      const head = el.querySelector<HTMLElement>('[data-fit-head]');
      const row = el.querySelector<HTMLElement>('[data-fit-row]');
      const rowH = row?.getBoundingClientRect().height || 52;
      const room = el.clientHeight - (head?.getBoundingClientRect().height ?? 0) - 8;
      // Everything fits: no pager. Otherwise leave room for the pager under the rows.
      const next = total * rowH <= room ? Math.max(total, 1) : Math.max(min, Math.floor((room - pagerHeight) / rowH));
      setSize((cur) => (cur === next ? cur : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [total, fallback, pagerHeight, min]);
  return { ref, size };
}


/**
 * The top-right Add button follows the page: Bills adds a bill, Budgets a budget, and so on. A page
 * registers its own "add" with usePageAdd; anywhere else the button adds a transaction.
 */
type PageAdd = { label: string; run: () => void };
let pageAdd: PageAdd | null = null;
const pageAddListeners = new Set<() => void>();
const announcePageAdd = () => pageAddListeners.forEach((f) => f());
export function usePageAdd(label: string, run: () => void) {
  const latest = useRef(run);
  latest.current = run;
  useEffect(() => {
    const me: PageAdd = { label, run: () => latest.current() };
    pageAdd = me;
    announcePageAdd();
    return () => { if (pageAdd === me) { pageAdd = null; announcePageAdd(); } };
  }, [label]);
}
export function useCurrentPageAdd(): PageAdd | null {
  const [, bump] = useState(0);
  useEffect(() => {
    const f = () => bump((n) => n + 1);
    pageAddListeners.add(f);
    return () => { pageAddListeners.delete(f); };
  }, []);
  return pageAdd;
}
