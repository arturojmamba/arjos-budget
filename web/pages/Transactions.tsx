import React, { useEffect, useMemo, useState } from 'react';
import { api, qs, type Transaction } from '../api.ts';
import { amountsHidden, dayLabel, money, monthLabel, shortDate } from '../format.ts';
import { AccountSelect, Bubble, CategorySelect, Empty, Money, amountClass, useApp, useConfirm, Badge, Progress } from '../components/ui.tsx';
import { TransactionForm } from '../components/TransactionForm.tsx';
import { Icon } from '../components/Icon.tsx';
import { setParams } from '../router.ts';

const PAGE_SIZES = [25, 50, 100, 0] as const; // 0 = all
const PAGE_SIZE_KEY = 'finance.pageSize';
type MonthTotals = { month: string; count: number; in: number; out: number; saved: number };

function readPageSize(): number {
  try { const raw = localStorage.getItem(PAGE_SIZE_KEY); const v = raw === null ? 50 : Number(raw); return (PAGE_SIZES as readonly number[]).includes(v) ? v : 50; } catch { return 50; }
}

export function Transactions({ params }: { params: URLSearchParams }) {
  const { meta, version, toast, refresh, categories } = useApp();
  const [confirm, confirmNode] = useConfirm();
  const f = {
    // Opens on the current month; 'all' shows every month. A date range (from budgets) replaces the month.
    month: params.get('month') ?? (params.get('from') || params.get('to') ? 'all' : meta.currentMonth),
    accountId: params.get('accountId') ? Number(params.get('accountId')) : null,
    categoryId: params.get('categoryId') ? Number(params.get('categoryId')) : null,
    kind: params.get('kind') ?? '',
    search: params.get('search') ?? '',
    merchant: params.get('merchant') ?? '',
    uncategorised: params.get('uncategorised') === '1',
    budgetId: params.get('budgetId') ? Number(params.get('budgetId')) : null,
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
  };
  const page = Math.max(1, Number(params.get('page')) || 1);
  // Changing any filter goes back to the first page.
  const update = (patch: Partial<typeof f>) => setParams('/transactions', { ...f, ...patch });
  const goTo = (n: number) => { setParams('/transactions', { ...f, page: n > 1 ? n : undefined }); window.scrollTo({ top: 0 }); };
  const [pageSize, setPageSizeState] = useState(readPageSize);
  const setPageSize = (n: number) => {
    setPageSizeState(n);
    try { localStorage.setItem(PAGE_SIZE_KEY, String(n)); } catch { /* ignore */ }
    goTo(1);
  };

  const [searchText, setSearchText] = useState(f.search);
  useEffect(() => setSearchText(f.search), [f.search]);
  useEffect(() => {
    const t = setTimeout(() => searchText !== f.search && update({ search: searchText }), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchText]);

  const [items, setItems] = useState<Transaction[]>([]);
  const [total, setTotal] = useState(0);
  const [totals, setTotals] = useState({ in: 0, out: 0 });
  const [byCat, setByCat] = useState<{ categoryId: number | null; name: string; colour: string; amount: number }[]>([]);
  const [byMonth, setByMonth] = useState<MonthTotals[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Transaction | 'new' | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkCat, setBulkCat] = useState<number | null>(null);

  const monthQ = f.month === 'all' ? undefined : f.month;
  const query = qs({ ...f, month: monthQ, limit: pageSize || 'all', offset: pageSize ? (page - 1) * pageSize : undefined });
  useEffect(() => {
    let live = true;
    setLoading(true);
    api.get<{ items: Transaction[]; total: number; totals: { in: number; out: number }; byCategory: typeof byCat; byMonth: MonthTotals[] }>(`/api/transactions${query}`).then((r) => {
      if (!live) return;
      setItems(r.items);
      setTotal(r.total);
      setTotals(r.totals);
      setByCat(r.byCategory);
      setByMonth(r.byMonth);
      setLoading(false);
      setSelected(new Set());
    });
    return () => { live = false; };
  }, [query, version]);

  const pages = pageSize ? Math.max(1, Math.ceil(total / pageSize)) : 1;
  // A page past the end (e.g. after deleting) falls back to the last page.
  useEffect(() => { if (!loading && page > pages) goTo(pages); }, [loading, page, pages]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Months, each containing its days. */
  const months = useMemo(() => {
    const out: { month: string; days: { date: string; items: Transaction[] }[]; shown: number }[] = [];
    for (const t of items) {
      const m = t.date.slice(0, 7);
      if (!out.length || out[out.length - 1].month !== m) out.push({ month: m, days: [], shown: 0 });
      const cur = out[out.length - 1];
      cur.shown++;
      const last = cur.days[cur.days.length - 1];
      if (last && last.date === t.date) last.items.push(t);
      else cur.days.push({ date: t.date, items: [t] });
    }
    return out;
  }, [items]);
  const firstOnPage = pageSize ? (page - 1) * pageSize + 1 : 1;
  const lastOnPage = Math.min(total, firstOnPage + items.length - 1);
  const allOnPageSelected = items.length > 0 && items.every((t) => selected.has(t.id));

  const toggle = (id: number) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  async function bulkCategorise() {
    await api.post('/api/transactions/bulk-categorise', { ids: [...selected], categoryId: bulkCat });
    toast(`Updated ${selected.size} transactions`);
    refresh();
  }
  async function bulkDelete() {
    if (!(await confirm(`Delete ${selected.size} transactions? Balances will be recalculated.`))) return;
    await api.post('/api/transactions/bulk-delete', { ids: [...selected] });
    toast(`Deleted ${selected.size} transactions`);
    refresh();
  }

  const filtered = !!(f.month !== meta.currentMonth || f.accountId || f.categoryId || f.kind || f.search || f.merchant || f.uncategorised || f.budgetId || f.from);
  const catName = categories.find((c) => c.id === f.categoryId)?.name;
  const budgetName = useBudgetName(f.budgetId);

  return (
    <div className="page">
      <div className="toolbar">
        <div className="search">
          <Icon name="search" size={16} />
          <input placeholder="Search description, notes or amount" value={searchText} onChange={(e) => setSearchText(e.target.value)} aria-label="Search transactions" />
          {searchText && <button className="icon-btn sm" onClick={() => setSearchText('')} aria-label="Clear search"><Icon name="x" size={14} /></button>}
        </div>
        <select value={f.month} onChange={(e) => update({ month: e.target.value })} aria-label="Month">
          <option value="all">All months</option>
          {meta.months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
        </select>
        <AccountSelect allowAll value={f.accountId} onChange={(v) => update({ accountId: v })} />
        <CategorySelect value={f.categoryId} onChange={(v) => update({ categoryId: v, uncategorised: false })} noneLabel="All categories" />
        <select value={f.kind} onChange={(e) => update({ kind: e.target.value })} aria-label="Type">
          <option value="">All types</option>
          <option value="expense">Spending</option>
          <option value="income">Income</option>
          <option value="saving">Savings</option>
          <option value="transfer">Transfers</option>
        </select>
        <label className="chip-toggle">
          <input type="checkbox" checked={f.uncategorised} onChange={(e) => update({ uncategorised: e.target.checked, categoryId: null })} />
          Needs category
        </label>
        <span className="spacer" />
        <a className="btn" href={`/api/export/transactions.csv${qs({ month: monthQ, accountId: f.accountId, categoryId: f.categoryId, search: f.search })}`}>
          <Icon name="download" size={16} /> Export
        </a>
      </div>

      <div className="list-summary">
        <label className="check select-page" title="Select everything on this page">
          <input type="checkbox" checked={allOnPageSelected} onChange={() => setSelected(allOnPageSelected ? new Set() : new Set(items.map((t) => t.id)))} disabled={items.length === 0} />
        </label>
        <span>{total.toLocaleString('en-GB')} transaction{total === 1 ? '' : 's'}{f.merchant ? ` at ${f.merchant}` : ''}{catName ? ` in ${catName}` : ''}{budgetName ? ` in your ${budgetName} budget` : ''}{f.from && f.to ? ` from ${shortDate(f.from)} to ${shortDate(f.to)}` : ''}</span>
        <span className="muted">In <Money value={totals.in} className="amt-in" /></span>
        <span className="muted">Out <Money value={totals.out} /></span>
        {f.search && monthQ && <button className="link-btn" onClick={() => update({ month: 'all' })}>Search all months</button>}
        {f.merchant && <button className="link-btn" onClick={() => update({ merchant: '' })}>All places</button>}
        {filtered && <button className="link-btn" onClick={() => setParams('/transactions', {})}>Clear filters</button>}
        <span className="spacer" />
        <label className="page-size">Show
          <select value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))} aria-label="Transactions per page">
            {PAGE_SIZES.map((n) => <option key={n} value={n}>{n === 0 ? 'All' : n}</option>)}
          </select>
          per page
        </label>
      </div>

      <div className="cols-main-side">
      <div className="stack">
      {selected.size > 0 && (
        <div className="bulk-bar">
          <span><strong>{selected.size}</strong> selected</span>
          <CategorySelect value={bulkCat} onChange={setBulkCat} />
          <button className="btn" onClick={bulkCategorise}>Set category</button>
          <button className="btn btn-ghost-danger" onClick={bulkDelete}><Icon name="trash" size={16} /> Delete</button>
          <span className="spacer" />
          <button className="link-btn" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

      <section className="card">
        {loading && items.length === 0 ? <div className="loading" /> : items.length === 0 ? (
          <Empty icon="list" title={filtered ? 'No transactions match these filters' : `Nothing in ${monthLabel(f.month)} yet`}>
            {monthQ
              ? <button className="link-btn" onClick={() => update({ month: 'all' })}>Look in all months</button>
              : !filtered && 'Add one manually or import a CSV from your bank.'}
          </Empty>
        ) : (
          months.map((m) => {
            const mt = byMonth.find((x) => x.month === m.month);
            const partial = mt && mt.count > m.shown;
            return (
              <div key={m.month} className="month-group">
                <h2 className="month-head">
                  <span>{monthLabel(m.month)}{partial && <span className="muted small"> · showing {m.shown} of {mt!.count}</span>}</span>
                  {mt && (
                    <span className="month-head-totals">
                      <span className="muted small">{mt.count} transaction{mt.count === 1 ? '' : 's'}</span>
                      {mt.in > 0 && <span className="small">In <Money value={mt.in} className="amt-in" /></span>}
                      <span className="small">Spent <Money value={mt.out} /></span>
                      {mt.saved !== 0 && <span className="small">Saved <Money value={mt.saved} className="amt-saved" /></span>}
                    </span>
                  )}
                </h2>
                {m.days.map((g) => (
                  <div key={g.date} className="day-group">
                    <h3 className="day-head">
                      <span>{dayLabel(g.date, meta.today)}</span>
                      <span className="muted small">{dayTotal(g.items, f.accountId)}</span>
                    </h3>
                    <ul className="txn-list">
                      {g.items.map((t) => (
                        <TxnRow key={t.id} t={t} accountId={f.accountId} onClick={() => setEditing(t)} selectable selected={selected.has(t.id)} onSelect={() => toggle(t.id)} />
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            );
          })
        )}
        {total > 0 && (
          <Pager page={page} pages={pages} onPage={goTo} first={firstOnPage} last={lastOnPage} total={total} pageSize={pageSize} onPageSize={setPageSize} />
        )}
      </section>
      </div>
      <aside className="side-sticky">
        <section className="card card-pad">
          <header className="card-head"><h2>{monthQ ? monthLabel(monthQ) : filtered ? 'In this view' : 'All time'}</h2></header>
          <div className="side-totals">
            <div><span className="muted small">In</span><Money value={totals.in} className="amt-in" /></div>
            <div><span className="muted small">Out</span><Money value={totals.out} /></div>
            <div><span className="muted small">Net</span><Money value={totals.in - totals.out} /></div>
            {byMonth.some((m) => m.saved !== 0) && <div><span className="muted small">Saved</span><Money value={byMonth.reduce((t, m) => t + m.saved, 0)} className="amt-saved" /></div>}
          </div>
          {byCat.length === 0 ? <p className="muted small">No spending in this view.</p> : (
            <ul className="side-cats">
              {byCat.slice(0, 10).map((c) => (
                <li key={c.categoryId ?? 'none'}>
                  <button onClick={() => c.categoryId ? update({ categoryId: c.categoryId, uncategorised: false }) : update({ uncategorised: true, categoryId: null })} title={`Show ${c.name}`}>
                    <span className="dot" style={{ background: c.colour }} />
                    <span className="grow">{c.name}</span>
                    <Money value={c.amount} />
                  </button>
                  <Progress value={c.amount} max={byCat[0].amount} colour={c.colour} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </aside>
      </div>

      {editing && <TransactionForm transaction={editing === 'new' ? null : editing} defaults={{ accountId: f.accountId }} onClose={() => setEditing(null)} />}
      {confirmNode}
    </div>
  );
}

function dayTotal(items: Transaction[], accountId: number | null): string {
  const spent = items.filter((t) => t.kind === 'expense').reduce((s, t) => s - t.postings.reduce((a, p) => a + p.amount, 0), 0);
  void accountId;
  return spent > 0 ? `${money(spent)} spent` : '';
}

const SAVINGS_TYPES = ['savings', 'pot', 'investment'];
/** 'in' when money goes from an everyday account into savings or investments, 'out' when it comes back. */
export function savingDirection(t: Transaction): 'in' | 'out' | null {
  if (t.kind !== 'transfer') return null;
  const into = t.postings.find((p) => p.amount > 0);
  const from = t.postings.find((p) => p.amount < 0);
  if (!into || !from) return null;
  const sIn = SAVINGS_TYPES.includes(into.accountType), sOut = SAVINGS_TYPES.includes(from.accountType);
  if (sIn && !sOut) return 'in';
  if (sOut && !sIn && !into.accountIsLiability) return 'out';
  return null;
}

export function TxnRow({ t, accountId, onClick, selectable, selected, onSelect, showDate }: {
  t: Transaction; accountId?: number | null; onClick?: () => void; selectable?: boolean; selected?: boolean; onSelect?: () => void; showDate?: boolean;
}) {
  const { categories } = useApp();
  const p0 = t.postings[0];
  let amount: number;
  let subtitle: React.ReactNode;
  let bubble: React.ReactNode;
  if (t.kind === 'transfer') {
    const out = t.postings.find((p) => p.amount < 0) ?? p0;
    const inn = t.postings.find((p) => p.amount > 0) ?? p0;
    const mine = accountId ? t.postings.find((p) => p.accountId === accountId) : null;
    amount = mine ? mine.amount : inn.amount;
    subtitle = <>{out.accountName} <Icon name="chevron-right" size={12} /> {inn.accountName}</>;
    bubble = <Bubble colour={inn.accountIsLiability && !amountsHidden() ? '#dc2626' : '#64748b'} icon={inn.accountIsLiability ? 'percentage' : 'transfer'} />;
  } else {
    amount = t.postings.reduce((s, p) => s + p.amount, 0);
    const cat = categories.find((c) => c.id === p0.categoryId);
    const parent = cat?.parentId ? categories.find((c) => c.id === cat.parentId) : null;
    subtitle = (
      <>
        {cat ? (parent ? `${parent.name} › ${cat.name}` : cat.name) : <Badge tone="warn">Needs category</Badge>}
        <span className="sep">·</span>{p0.accountName}
      </>
    );
    bubble = <Bubble colour={cat?.colour ?? parent?.colour ?? '#94a3b8'} icon={cat?.icon ?? parent?.icon ?? null} label={t.description} />;
  }
  const isRepayment = t.kind === 'transfer' && t.postings.some((p) => p.amount > 0 && p.accountIsLiability);
  const saving = savingDirection(t);
  if (saving) bubble = <Bubble colour="#0ea5e9" icon={saving === 'in' ? '🐷' : '↩️'} />;
  return (
    <li className={`txn ${selected ? 'is-selected' : ''}`}>
      {selectable && (
        <input type="checkbox" className="txn-check" checked={!!selected} onChange={onSelect} aria-label={`Select ${t.description}`} />
      )}
      <button className="txn-main" onClick={onClick} disabled={!onClick}>
        {bubble}
        <span className="txn-text">
          <span className="txn-desc">{t.description}{t.notes && <Icon name="edit" size={12} className="muted" />}</span>
          <span className="txn-sub">
            {showDate && <>{shortDate(t.date)}<span className="sep">·</span></>}
            {isRepayment ? <>Debt repayment<span className="sep">·</span></>
              : saving === 'in' ? <><span className="amt-saved">Savings</span><span className="sep">·</span></>
              : saving === 'out' ? <>From savings<span className="sep">·</span></>
              : t.kind === 'transfer' ? <>Transfer<span className="sep">·</span></> : null}
            {subtitle}
            {t.period !== t.date.slice(0, 7) && <Badge tone="info">Counts in {monthLabel(t.period, true)}</Badge>}
          </span>
        </span>
        <span className={`txn-amt ${saving === 'in' && !accountId ? 'amt-saved' : amountClass(amount, t.kind)}`}>
          {t.kind === 'transfer' && !accountId ? money(Math.abs(amount)) : amount < 0 ? money(-amount) : money(amount, { sign: true })}
        </span>
      </button>
    </li>
  );
}

function useBudgetName(id: number | null): string | null {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    if (!id) { setName(null); return; }
    api.get<{ budgets: { id: number; name: string }[] }>('/api/budgets').then((r) => setName(r.budgets.find((b) => b.id === id)?.name ?? null)).catch(() => setName(null));
  }, [id]);
  return name;
}

function Pager({ page, pages, onPage, first, last, total, pageSize, onPageSize }: {
  page: number; pages: number; onPage: (n: number) => void; first: number; last: number; total: number; pageSize: number; onPageSize: (n: number) => void;
}) {
  // 1 … 4 5 [6] 7 8 … 20
  const nums: (number | '…')[] = [];
  for (let n = 1; n <= pages; n++) {
    if (n === 1 || n === pages || Math.abs(n - page) <= 2) nums.push(n);
    else if (nums[nums.length - 1] !== '…') nums.push('…');
  }
  return (
    <nav className="pager" aria-label="Pages">
      <span className="muted small">Showing {first.toLocaleString('en-GB')}–{last.toLocaleString('en-GB')} of {total.toLocaleString('en-GB')}</span>
      {pages > 1 && (
        <span className="pager-pages">
          <button className="icon-btn" onClick={() => onPage(page - 1)} disabled={page <= 1} aria-label="Previous page"><Icon name="chevron-left" size={16} /></button>
          {nums.map((n, i) => n === '…'
            ? <span key={`e${i}`} className="muted pager-gap">…</span>
            : <button key={n} className={`pager-num ${n === page ? 'on' : ''}`} onClick={() => onPage(n)} aria-current={n === page ? 'page' : undefined}>{n}</button>)}
          <button className="icon-btn" onClick={() => onPage(page + 1)} disabled={page >= pages} aria-label="Next page"><Icon name="chevron-right" size={16} /></button>
        </span>
      )}
      <label className="page-size">
        <select value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))} aria-label="Transactions per page">
          {PAGE_SIZES.map((n) => <option key={n} value={n}>{n === 0 ? 'All' : `${n} per page`}</option>)}
        </select>
      </label>
    </nav>
  );
}
