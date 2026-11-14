import React, { useEffect, useMemo, useState } from 'react';
import { api, type Category, type Rule } from '../api.ts';
import { Bubble, Card, CategorySelect, AccountSelect, Field, Modal, Segmented, useApp, useConfirm, useData, Empty, Badge } from '../components/ui.tsx';
import { SuggestedRules, type RuleSuggestion } from '../components/RuleSuggestions.tsx';
import { setParams, useRoute } from '../router.ts';
import { Icon, CatGlyph } from '../components/Icon.tsx';
import { looksLikeTransfer, shortDate } from '../format.ts';

const COLOURS = ['#16a34a', '#f97316', '#0ea5e9', '#ec4899', '#8b5cf6', '#6366f1', '#eab308', '#b45309', '#14b8a6', '#06b6d4', '#f43f5e', '#3b82f6', '#dc2626', '#059669', '#d946ef', '#64748b'];

export const EMOJI_GROUPS: { name: string; emojis: string[] }[] = [
  { name: 'Food and drink', emojis: ['🛒', '🍽️', '🍔', '🍕', '🍣', '🌮', '🥗', '🍜', '🥡', '☕', '🧋', '🍺', '🍷', '🍸', '🥐', '🍰', '🍫', '🧃'] },
  { name: 'Home and bills', emojis: ['🏠', '🏡', '🔑', '⚡', '💡', '🔥', '💧', '📶', '📱', '📺', '🧾', '🛋️', '🧹', '🧺', '🔧', '🪴', '🛡️', '🏛️'] },
  { name: 'Getting around', emojis: ['🚌', '🚇', '🚆', '🚕', '🚗', '⛽', '🅿️', '🚲', '🛴', '✈️', '🧳', '🏨', '🗺️', '⛴️'] },
  { name: 'Shopping', emojis: ['🛍️', '👕', '👟', '👜', '💄', '💅', '💇', '🧴', '🎁', '📦', '🖥️', '🎧', '📷', '⌚'] },
  { name: 'Fun and health', emojis: ['🎬', '🎮', '🎵', '🎟️', '🎨', '📚', '🎓', '💪', '🏋️', '🧘', '⚽', '🎾', '💊', '🩺', '🦷', '❤️', '🐾', '🍼'] },
  { name: 'Goals', emojis: ['🎯', '🛡️', '🏖️', '🌴', '🏝️', '💍', '🏡', '🚙', '👶', '🎄', '🎓', '🧳', '🛟', '🌱', '🚀', '🏆'] },
  { name: 'Money', emojis: ['💼', '💻', '💷', '💵', '💰', '🪙', '💳', '🏦', '📈', '📉', '🐷', '🎯', '💸', '🧮', '🔁', '🤝', '🎉', '📌'] },
];

export function Categories() {
  const { categories, refresh, toast } = useApp();
  const [editing, setEditing] = useState<{ cat: Category | null; kind: 'expense' | 'income'; parentId?: number | null } | null>(null);
  const [drag, setDrag] = useState<{ id: number; group: string } | null>(null);
  const [over, setOver] = useState<number | null>(null);

  async function saveOrder(ids: number[]) {
    try {
      await api.put('/api/categories/order', { ids });
      refresh();
    } catch (e: any) { toast(e.message, 'error'); }
  }
  /** Move one category up or down (or onto another's place) within its own list. */
  function move(list: Category[], id: number, to: number) {
    const ids = list.map((c) => c.id);
    const from = ids.indexOf(id);
    if (from < 0 || to < 0 || to >= ids.length || from === to) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    saveOrder(ids);
  }
  const groupOf = (c: Category) => `${c.kind}:${c.parentId ?? 0}`;
  const dragProps = (c: Category, list: Category[]) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(c.id)); setDrag({ id: c.id, group: groupOf(c) }); },
    onDragOver: (e: React.DragEvent) => { if (drag && drag.group === groupOf(c)) { e.preventDefault(); setOver(c.id); } },
    onDragLeave: () => setOver((o) => (o === c.id ? null : o)),
    onDrop: (e: React.DragEvent) => { e.preventDefault(); if (drag && drag.group === groupOf(c)) move(list, drag.id, list.findIndex((x) => x.id === c.id)); setDrag(null); setOver(null); },
    onDragEnd: () => { setDrag(null); setOver(null); },
  });
  const arrows = (c: Category, list: Category[]) => {
    const i = list.findIndex((x) => x.id === c.id);
    return (
      <span className="reorder">
        <button className="icon-btn" disabled={i === 0} onClick={() => move(list, c.id, i - 1)} aria-label={`Move ${c.name} up`}><Icon name="chevron-up" size={15} /></button>
        <button className="icon-btn" disabled={i === list.length - 1} onClick={() => move(list, c.id, i + 1)} aria-label={`Move ${c.name} down`}><Icon name="chevron-down" size={15} /></button>
      </span>
    );
  };

  const column = (kind: 'expense' | 'income') => {
    const parents = categories.filter((c) => c.kind === kind && c.parentId === null);
    return (
      <Card title={kind === 'expense' ? 'Spending categories' : 'Income categories'} pad={false}
        action={<button className="btn btn-sm" onClick={() => setEditing({ cat: null, kind })}><Icon name="plus" size={14} /> New</button>}>
        <p className="muted small cat-hint">Drag to reorder, or use the arrows. This is the order used in pickers and lists.</p>
        <ul className="cat-manage">
          {parents.map((p) => {
            const subs = categories.filter((c) => c.parentId === p.id);
            return (
            <React.Fragment key={p.id}>
              <li className={`${p.archived ? 'is-archived' : ''} ${drag?.id === p.id ? 'dragging' : ''} ${over === p.id && drag?.id !== p.id ? 'drop-target' : ''}`} {...dragProps(p, parents)}>
                <span className="drag-handle" aria-hidden="true"><Icon name="grip" size={16} strokeWidth={3} /></span>
                <Bubble colour={p.colour} icon={p.icon} size={32} />
                <span className="grow">
                  {p.name} {p.isFixed && <span className="tag">Fixed</span>} {p.rollForward && <span className="tag">Counts next month if paid late</span>}
                  {p.archived && <Badge>Archived</Badge>}
                  {p.kind === 'expense' && looksLikeTransfer(p.name) && <span title="Payments in this category count as spending. Card repayments and moves between your own accounts should be transfers instead."><Badge tone="warn">Counts as spending</Badge></span>}
                </span>
                <span className="muted small">{p.transactionCount}</span>
                {arrows(p, parents)}
                <button className="icon-btn" title="Add subcategory" aria-label={`Add subcategory to ${p.name}`} onClick={() => setEditing({ cat: null, kind, parentId: p.id })}><Icon name="plus" size={16} /></button>
                <button className="icon-btn" aria-label={`Edit ${p.name}`} onClick={() => setEditing({ cat: p, kind })}><Icon name="edit" size={16} /></button>
              </li>
              {subs.map((c) => (
                <li key={c.id} className={`sub ${c.archived ? 'is-archived' : ''} ${drag?.id === c.id ? 'dragging' : ''} ${over === c.id && drag?.id !== c.id ? 'drop-target' : ''}`} {...dragProps(c, subs)}>
                  <span className="drag-handle" aria-hidden="true"><Icon name="grip" size={14} strokeWidth={3} /></span>
                  {c.icon ? <CatGlyph icon={c.icon} className="sub-emoji" /> : <span className="dot" style={{ background: c.colour }} />}
                  <span className="grow">{c.name}{c.archived && <Badge>Archived</Badge>}</span>
                  <span className="muted small">{c.transactionCount}</span>
                  {subs.length > 1 && arrows(c, subs)}
                  <button className="icon-btn" aria-label={`Edit ${c.name}`} onClick={() => setEditing({ cat: c, kind })}><Icon name="edit" size={16} /></button>
                </li>
              ))}
            </React.Fragment>
            );
          })}
        </ul>
      </Card>
    );
  };

  return (
    <div className="page">
      <CatTabs tab="categories" />
      <div className="grid-2-cards">
        {column('expense')}
        {column('income')}
      </div>
      {editing && <CategoryForm {...editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

/** Categories and Rules share the page; the tab is in the URL (?tab=rules). */
export function CategoriesPage() {
  const { params } = useRoute();
  return params.get('tab') === 'rules' ? <div className="page"><CatTabs tab="rules" /><Rules /></div> : <Categories />;
}

function CatTabs({ tab }: { tab: 'categories' | 'rules' }) {
  const { data: rules } = useData<Rule[]>(() => api.get('/api/rules'), []);
  return (
    <div className="row gap">
      <Segmented value={tab} onChange={(t) => setParams('/categories', { tab: t === 'rules' ? 'rules' : null })}
        options={[{ value: 'categories', label: 'Categories' }, { value: 'rules', label: `Auto-categorise rules${rules ? ` (${rules.length})` : ''}` }]} />
    </div>
  );
}

function CategoryForm({ cat, kind, parentId, onClose }: { cat: Category | null; kind: 'expense' | 'income'; parentId?: number | null; onClose: () => void }) {
  const { categories, refresh, toast } = useApp();
  const parent = categories.find((c) => c.id === (cat?.parentId ?? parentId));
  const [name, setName] = useState(cat?.name ?? '');
  const [colour, setColour] = useState(cat?.colour ?? parent?.colour ?? COLOURS[0]);
  const [icon, setIcon] = useState<string | null>(cat?.icon ?? (parent ? null : '📦'));
  const [isFixed, setFixed] = useState(cat?.isFixed ?? false);
  const [rollForward, setRollForward] = useState(cat?.rollForward ?? false);
  const [reassign, setReassign] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    try {
      const body = { name, kind, parentId: cat ? undefined : parentId ?? null, colour, icon, isFixed, rollForward };
      if (cat) await api.put(`/api/categories/${cat.id}`, body);
      else await api.post('/api/categories', body);
      toast(cat ? 'Category updated' : 'Category created');
      refresh();
      onClose();
    } catch (err: any) { setError(err.message); }
  }

  async function remove() {
    if (!cat) return;
    try {
      await api.del(`/api/categories/${cat.id}${reassign ? `?reassignTo=${reassign}` : ''}`);
      toast('Category deleted');
      refresh();
      onClose();
    } catch (err: any) { setError(err.message); }
  }

  async function toggleArchive() {
    if (!cat) return;
    await api.put(`/api/categories/${cat.id}`, { archived: !cat.archived });
    refresh();
    onClose();
  }

  return (
    <Modal title={cat ? `Edit ${cat.name}` : parent ? `New subcategory of ${parent.name}` : 'New category'} onClose={onClose}
      footer={!deleting ? <>
        {cat && <button type="button" className="btn btn-ghost-danger" onClick={() => setDeleting(true)}><Icon name="trash" size={16} /> Delete</button>}
        {cat && <button type="button" className="btn btn-ghost" onClick={toggleArchive}>{cat.archived ? 'Unarchive' : 'Archive'}</button>}
        <span className="spacer" />
        <button type="button" className="btn" onClick={onClose}>Cancel</button>
        <button type="submit" form="cat-form" className="btn btn-primary">Save</button>
      </> : <>
        <span className="spacer" />
        <button type="button" className="btn" onClick={() => setDeleting(false)}>Back</button>
        <button type="button" className="btn btn-danger" onClick={remove}>Delete category</button>
      </>}>
      {deleting && cat ? (
        <div className="form">
          <p>{cat.transactionCount} transactions use <strong>{cat.name}</strong>{categories.some((c) => c.parentId === cat.id) ? ' (subcategories are deleted too)' : ''}. Move them to:</p>
          <CategorySelect kind={cat.kind} value={reassign} onChange={setReassign} noneLabel="Uncategorised" />
          {error && <p className="form-error">{error}</p>}
        </div>
      ) : (
        <form id="cat-form" className="form" onSubmit={save}>
          <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Colour">
            <div className="swatches">
              {COLOURS.map((c) => <button type="button" key={c} className={`swatch ${c === colour ? 'on' : ''}`} style={{ background: c }} onClick={() => setColour(c)} aria-label={`Colour ${c}`} />)}
            </div>
          </Field>
          <Field label={parent ? 'Emoji (optional)' : 'Emoji'}>
            <EmojiPicker value={icon} onChange={setIcon} colour={colour} allowNone={!!parent} />
          </Field>
          {kind === 'expense' && looksLikeTransfer(name) && (
            <p className="hint-box hint-warn"><Icon name="alert" size={16} />
              <span>Anything in a spending category counts as spending. Card and loan repayments, savings and moves between your own accounts don't need a category. Record them as a <strong>Transfer</strong> or <strong>Debt repayment</strong> instead, so they aren't counted twice.</span></p>
          )}
          {kind === 'expense' && !parent && (
            <label className="check"><input type="checkbox" checked={isFixed} onChange={(e) => setFixed(e.target.checked)} />
              <span>Fixed cost (rent, bills, subscriptions). Shown separately from day-to-day spending.</span></label>
          )}
          {kind === 'income' && !parent && (
            <label className="check"><input type="checkbox" checked={rollForward} onChange={(e) => setRollForward(e.target.checked)} />
              <span>Paid at the end of the month for the next month (like your salary)</span></label>
          )}
          {error && <p className="form-error">{error}</p>}
        </form>
      )}
    </Modal>
  );
}

type RuleSort = 'order' | 'az' | 'matches' | 'newest' | 'unused';
const PAGE = 25;

function Rules() {
  const { toast, refresh, categories, accounts } = useApp();
  const { data: rules, reload } = useData<Rule[]>(() => api.get('/api/rules'), []);
  const { data: suggestions, reload: reloadSuggestions } = useData<RuleSuggestion[]>(() => api.get('/api/rules/suggestions'), []);
  const [editing, setEditing] = useState<Rule | 'new' | null>(null);
  const [confirm, confirmNode] = useConfirm();
  const [q, setQ] = useState('');
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [accountId, setAccountId] = useState<number | null>(null);
  const [sort, setSort] = useState<RuleSort>('order');
  const [page, setPage] = useState(0);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [test, setTest] = useState('');
  const [testResult, setTestResult] = useState<{ winner: number | null; matches: number[] } | null>(null);

  // Test a bank description as you type.
  useEffect(() => {
    if (!test.trim()) { setTestResult(null); return; }
    const t = setTimeout(() => { api.post<{ winner: number | null; matches: number[] }>('/api/rules/test', { description: test }).then(setTestResult).catch(() => setTestResult(null)); }, 200);
    return () => clearTimeout(t);
  }, [test, rules]);

  const filtered = useMemo(() => {
    if (!rules) return [];
    const needle = q.trim().toLowerCase();
    let list = rules.filter((r) =>
      (!needle || [r.pattern, r.renameTo, r.categoryName, r.transferAccountName, r.accountName].some((x) => x?.toLowerCase().includes(needle)))
      && (categoryId == null || r.categoryId === categoryId)
      && (accountId == null || r.accountId === accountId));
    if (testResult) list = list.filter((r) => testResult.matches.includes(r.id));
    const by: Record<RuleSort, ((a: Rule, b: Rule) => number) | null> = {
      order: null,
      az: (a, b) => a.pattern.localeCompare(b.pattern),
      matches: (a, b) => b.matches - a.matches,
      newest: (a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || b.id - a.id,
      unused: (a, b) => a.matches - b.matches || a.pattern.localeCompare(b.pattern),
    };
    if (testResult) list.sort((a, b) => testResult.matches.indexOf(a.id) - testResult.matches.indexOf(b.id));
    else if (by[sort]) list = [...list].sort(by[sort]!);
    return list;
  }, [rules, q, categoryId, accountId, sort, testResult]);

  useEffect(() => { setPage(0); }, [q, categoryId, accountId, sort, test]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const shown = filtered.slice(page * PAGE, page * PAGE + PAGE);
  const unused = (rules ?? []).filter((r) => r.matches === 0).length;
  const reloadAll = () => { reload(); reloadSuggestions(); refresh(); };

  async function remove(r: Rule) {
    if (!(await confirm(`Stop automatically handling "${r.pattern}"? Existing transactions won't change.`, { label: 'Delete rule', danger: true }))) return;
    await api.del(`/api/rules/${r.id}`);
    toast('Rule deleted');
    reloadAll();
  }
  async function removePicked() {
    const ids = [...picked];
    if (!(await confirm(`Delete ${ids.length} rule${ids.length === 1 ? '' : 's'}? Existing transactions won't change.`, { label: 'Delete', danger: true }))) return;
    for (const id of ids) await api.del(`/api/rules/${id}`);
    setPicked(new Set());
    toast(`${ids.length} rule${ids.length === 1 ? '' : 's'} deleted`);
    reloadAll();
  }
  const toggle = (id: number) => setPicked((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const filtering = q || categoryId != null || accountId != null;

  return (
    <>
      {suggestions && suggestions.length > 0 && <SuggestedRules list={suggestions} onDone={reloadAll} />}
      <div className="rules-top">
        <Card title="Try a bank description" className="rules-test">
          <input value={test} onChange={(e) => setTest(e.target.value)} placeholder="e.g. CITY TRANSIT TRAVEL CHARGE" aria-label="Bank description to test" />
          {testResult && (
            <p className="small" style={{ margin: '8px 0 0' }}>
              {testResult.winner == null ? <span className="muted">No rule matches. The app would guess from past transactions instead.</span> : (() => {
                const w = rules?.find((r) => r.id === testResult.winner);
                return <>Filed by <code>{w?.pattern}</code> → <strong>{w?.categoryName ?? (w?.transferAccountName ? `transfer ⇄ ${w.transferAccountName}` : w?.renameTo)}</strong>
                  {testResult.matches.length > 1 && <span className="muted"> · {testResult.matches.length - 1} other rule{testResult.matches.length > 2 ? 's' : ''} also match but come later</span>}</>;
              })()}
            </p>
          )}
        </Card>
        <div className="rules-stats">
          <div><strong>{rules?.length ?? '–'}</strong><span className="muted small">rules</span></div>
          <div><strong>{unused}</strong><span className="muted small">never matched</span></div>
          <button className="btn btn-primary" onClick={() => setEditing('new')}><Icon name="plus" size={16} /> New rule</button>
        </div>
      </div>

      <Card pad={false}>
        <div className="rules-filters">
          <div className="search"><Icon name="search" size={16} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search text, category or account" aria-label="Search rules" />{q && <button className="icon-btn" onClick={() => setQ('')} aria-label="Clear search"><Icon name="x" size={14} /></button>}</div>
          <CategorySelect value={categoryId} onChange={setCategoryId} noneLabel="All categories" />
          <select value={accountId ?? ''} onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : null)} aria-label="Account">
            <option value="">All accounts</option>
            {accounts.filter((a) => !a.archived).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <select value={sort} onChange={(e) => setSort(e.target.value as RuleSort)} aria-label="Sort" disabled={!!testResult}>
            <option value="order">Order they're applied</option><option value="az">A to Z</option><option value="matches">Most used</option><option value="newest">Newest</option><option value="unused">Unused first</option>
          </select>
        </div>
        {picked.size > 0 && (
          <div className="rules-bulk"><span>{picked.size} selected</span><button className="link-btn" onClick={() => setPicked(new Set())}>Clear</button><span className="spacer" /><button className="btn btn-sm btn-danger" onClick={removePicked}><Icon name="trash" size={14} /> Delete selected</button></div>
        )}
        {!rules ? <div className="loading" /> : rules.length === 0 ? (
          <Empty icon="tag" title="No rules yet">When you import, tick “Remember” on a row to create one automatically.</Empty>
        ) : filtered.length === 0 ? (
          <Empty icon="search" title={testResult ? 'No rule matches that description' : 'No rules match'}>{filtering && <button className="link-btn" onClick={() => { setQ(''); setCategoryId(null); setAccountId(null); }}>Clear filters</button>}</Empty>
        ) : (
          <ul className="rules-list">
            {shown.map((r) => (
              <li key={r.id} className={testResult?.winner === r.id ? 'winner' : ''}>
                <input type="checkbox" checked={picked.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Select rule ${r.pattern}`} />
                <button className="rule-main" onClick={() => setEditing(r)}>
                  <span className="rule-when">
                    <code>{r.pattern}</code>
                    <span className="muted small">{r.matchType === 'contains' ? 'contains' : r.matchType.replace('_', ' ')}{r.accountName ? ` · ${r.accountName} only` : ''}</span>
                  </span>
                  <span className="rule-then">
                    {r.categoryName ? <><span className="dot" style={{ background: r.categoryColour ?? '#999' }} /> {categories.find((c) => c.id === r.categoryId)?.icon ?? ''} {r.categoryName}</>
                      : r.transferAccountName ? <>Transfer ⇄ {r.transferAccountName}</> : <span className="muted">No category</span>}
                    {r.renameTo && <span className="muted small"> · renamed “{r.renameTo}”</span>}
                  </span>
                  <span className="rule-use small">{r.matches ? <span className="muted">{r.matches} match{r.matches === 1 ? '' : 'es'}{r.lastMatch ? ` · last ${shortDate(r.lastMatch)}` : ''}</span> : <Badge tone="warn">Never matched</Badge>}</span>
                </button>
                {testResult?.winner === r.id && <Badge tone="good">Wins</Badge>}
                <button className="icon-btn" onClick={() => remove(r)} aria-label={`Delete rule ${r.pattern}`}><Icon name="trash" size={16} /></button>
              </li>
            ))}
          </ul>
        )}
        {filtered.length > PAGE && (
          <div className="pager">
            <span className="muted small">{page * PAGE + 1}–{Math.min(filtered.length, page * PAGE + PAGE)} of {filtered.length}</span>
            <span className="spacer" />
            <button className="btn btn-sm" disabled={page === 0} onClick={() => setPage(page - 1)}><Icon name="chevron-left" size={14} /> Previous</button>
            <button className="btn btn-sm" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>Next <Icon name="chevron-right" size={14} /></button>
          </div>
        )}
        <p className="muted small rules-foot">Rules are checked from the top: longer, more specific text wins over shorter text. Only new imports are affected; editing a rule doesn't change past transactions.</p>
      </Card>
      {editing && <RuleForm rule={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={reloadAll} />}
      {confirmNode}
    </>
  );
}

function RuleForm({ rule, onClose, onSaved }: { rule: Rule | null; onClose: () => void; onSaved: () => void }) {
  const { toast } = useApp();
  const [pattern, setPattern] = useState(rule?.pattern ?? '');
  const [matchType, setMatchType] = useState(rule?.matchType ?? 'contains');
  const [accountId, setAccountId] = useState<number | null>(rule?.accountId ?? null);
  const [action, setAction] = useState<'category' | 'transfer'>(rule?.transferAccountId ? 'transfer' : 'category');
  const [categoryId, setCategoryId] = useState<number | null>(rule?.categoryId ?? null);
  const [transferAccountId, setTransfer] = useState<number | null>(rule?.transferAccountId ?? null);
  const [renameTo, setRenameTo] = useState(rule?.renameTo ?? '');
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    try {
      const body = {
        pattern, matchType, accountId, renameTo: renameTo || null, priority: rule?.priority ?? 0,
        categoryId: action === 'category' ? categoryId : null,
        transferAccountId: action === 'transfer' ? transferAccountId : null,
      };
      if (rule) await api.put(`/api/rules/${rule.id}`, body); else await api.post('/api/rules', body);
      toast(rule ? 'Rule saved' : 'Rule created');
      onSaved();
      onClose();
    } catch (err: any) { setError(err.message); }
  }

  return (
    <Modal title={rule ? 'Edit rule' : 'New rule'} onClose={onClose} footer={<><span className="spacer" /><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="rule-form" type="submit">Save</button></>}>
      <form id="rule-form" className="form" onSubmit={save}>
        <div className="grid-2">
          <Field label="When the description"><select value={matchType} onChange={(e) => setMatchType(e.target.value)}>
            <option value="contains">contains</option><option value="starts_with">starts with</option><option value="exact">is exactly</option><option value="regex">matches regex</option>
          </select></Field>
          <Field label="Text"><input value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="travel charge" /></Field>
        </div>
        <Field label="On account"><AccountSelect allowAll allLabel="Any account" value={accountId} onChange={setAccountId} /></Field>
        <Field label="Then">
          <select value={action} onChange={(e) => setAction(e.target.value as 'category' | 'transfer')}>
            <option value="category">Set category</option><option value="transfer">Treat as a transfer to/from…</option>
          </select>
        </Field>
        {action === 'category'
          ? <Field label="Category"><CategorySelect value={categoryId} onChange={setCategoryId} noneLabel="Choose a category…" /></Field>
          : <Field label="Other account"><AccountSelect value={transferAccountId} onChange={setTransfer} /></Field>}
        <Field label="Rename to (optional)"><input value={renameTo} onChange={(e) => setRenameTo(e.target.value)} placeholder="Transport for London" /></Field>
        {error && <p className="form-error">{error}</p>}
      </form>
    </Modal>
  );
}

export function EmojiPicker({ value, onChange, colour, allowNone }: { value: string | null; onChange: (v: string | null) => void; colour: string; allowNone?: boolean }) {
  const [custom, setCustom] = useState('');
  const known = EMOJI_GROUPS.some((g) => g.emojis.includes(value ?? ''));
  return (
    <div className="emoji-picker">
      <div className="emoji-current">
        <Bubble colour={colour} icon={value} label="?" size={44} />
        <div className="stack" style={{ gap: 4 }}>
          <span className="small muted">Pick one below, or type or paste any emoji (Ctrl ⌘ Space on a Mac).</span>
          <div className="row gap">
            <input className="emoji-input" value={custom} maxLength={8} placeholder={value && !known ? value : '😀'}
              onChange={(e) => { setCustom(e.target.value); if (e.target.value.trim()) onChange(e.target.value.trim()); }} aria-label="Type an emoji" />
            {allowNone && value && <button type="button" className="link-btn" onClick={() => { onChange(null); setCustom(''); }}>No emoji</button>}
          </div>
        </div>
      </div>
      {EMOJI_GROUPS.map((g) => (
        <div key={g.name}>
          <p className="emoji-group">{g.name}</p>
          <div className="emoji-grid">
            {g.emojis.map((e) => (
              <button type="button" key={e} className={`emoji-pick ${e === value ? 'on' : ''}`} onClick={() => { onChange(e); setCustom(''); }}
                aria-label={e} aria-pressed={e === value} style={e === value ? { borderColor: colour, background: `${colour}1a` } : undefined}>{e}</button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
