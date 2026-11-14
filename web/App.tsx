import { UpdateBanner } from './components/Updates.tsx';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type Account, type Appearance, type Category, type Meta, type Profile, APP_NAME } from './api.ts';
import { AppContext, useCurrentPageAdd } from './components/ui.tsx';
import { Icon } from './components/Icon.tsx';
import { TransactionForm } from './components/TransactionForm.tsx';
import { useRoute, navigate, setParams } from './router.ts';
import { BrandMark } from './components/BrandMark.tsx';
import { addMonths, monthLabel, setAmountsHidden, setShowPence } from './format.ts';
import { Budgets } from './pages/Budgets.tsx';
import { Debts } from './pages/Debts.tsx';
import { Overview } from './pages/Overview.tsx';
import { Transactions } from './pages/Transactions.tsx';
import { Accounts } from './pages/Accounts.tsx';
import { CategoriesPage } from './pages/Categories.tsx';
import { Import } from './pages/Import.tsx';
import { Settings } from './pages/Settings.tsx';
import { Investing } from './pages/Investing.tsx';
import { Payday } from './pages/Payday.tsx';
import { Bills } from './pages/Bills.tsx';
import { Goals } from './pages/Goals.tsx';
import { Reports } from './pages/Reports.tsx';

const TAB_PATHS = ['/', '/transactions', '/budgets', '/bills'];

/** The sidebar, in sections. Order within a section is the order you'd usually use them. */
const NAV_GROUPS: { label: string | null; items: { path: string; label: string; icon: string }[] }[] = [
  { label: null, items: [
    { path: '/', label: 'Overview', icon: 'dashboard' },
    { path: '/reports', label: 'Reports', icon: 'trending-up' },
  ] },
  { label: 'Everyday', items: [
    { path: '/transactions', label: 'Transactions', icon: 'list' },
    { path: '/bills', label: 'Bills and income', icon: 'calendar' },
    { path: '/import', label: 'Import', icon: 'upload' },
  ] },
  { label: 'Plan', items: [
    { path: '/payday', label: 'Payday', icon: 'cash' },
    { path: '/budgets', label: 'Budgets', icon: 'piggy-bank' },
    { path: '/goals', label: 'Goals', icon: 'gift' },
  ] },
  { label: 'Wealth', items: [
    { path: '/accounts', label: 'Accounts', icon: 'wallet' },
    { path: '/investing', label: 'Investing', icon: 'chart-pie' },
    { path: '/debts', label: 'Debts', icon: 'percentage' },
  ] },
  { label: 'Set up', items: [
    { path: '/categories', label: 'Categories', icon: 'tag' },
    { path: '/settings', label: 'Settings', icon: 'settings' },
  ] },
];
const NAV = NAV_GROUPS.flatMap((g) => g.items);

/** "g" then a letter jumps to a page. */
const JUMP: Record<string, string> = { o: '/', t: '/transactions', b: '/budgets', g: '/goals', i: '/bills', p: '/payday', d: '/debts', r: '/reports', v: '/investing', a: '/accounts', c: '/categories', m: '/import', s: '/settings' };
const SHORTCUTS: [string, string][] = [
  ['N', 'Add a transaction'], ['H', 'Hide or show amounts'], ['/', 'Search transactions'], ['?', 'Show these shortcuts'],
  ['G then O', 'Overview'], ['G then T', 'Transactions'], ['G then B', 'Budgets'], ['G then G', 'Goals'], ['G then I', 'Bills and income'], ['G then P', 'Payday'],
  ['G then D', 'Debts'], ['G then R', 'Reports'], ['G then V', 'Investing'], ['G then A', 'Accounts'], ['G then C', 'Categories'], ['G then M', 'Import'], ['G then S', 'Settings'],
];

export function App() {
  const { path, params } = useRoute();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [version, setVersion] = useState(0);
  const [toasts, setToasts] = useState<{ id: number; msg: string; kind: 'ok' | 'error' }[]>([]);
  const [fatal, setFatal] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const pageAdd = useCurrentPageAdd();
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem('finance.hidden') === '1'; } catch { return false; } });
  // Set before children render so every money() call this pass sees it.
  setAmountsHidden(hidden);
  // Private mode also drops the green/red colours that would give away whether things are up or down.
  if (typeof document !== 'undefined') document.documentElement.classList.toggle('private', hidden);
  const toggleHidden = useCallback(() => setHidden((h) => {
    try { localStorage.setItem('finance.hidden', h ? '0' : '1'); } catch { /* ignore */ }
    return !h;
  }), []);

  const firstLoad = React.useRef(true);
  useEffect(() => {
    Promise.all([api.get<Meta>('/api/meta'), api.get<Account[]>('/api/accounts'), api.get<Category[]>('/api/categories')])
      .then(([m, a, c]) => {
        applyAppearance(m.appearance, m.profile);
        if (firstLoad.current) {
          firstLoad.current = false;
          if (m.appearance.startHidden) setHidden(true);
          // Open on your chosen start page when the app is opened fresh.
          if ((!window.location.hash || window.location.hash === '#/' || window.location.hash === '#') && m.appearance.startPage !== '/') navigate(m.appearance.startPage);
        }
        setMeta(m); setAccounts(a); setCategories(c); setFatal(null);
      })
      .catch((e) => setFatal(e.message));
  }, [version]);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);
  const toast = useCallback((msg: string, kind: 'ok' | 'error' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
  }, []);

  const [help, setHelp] = useState(false);
  const [more, setMore] = useState(false);
  // Keyboard shortcuts (press ? to see them).
  useEffect(() => {
    let pendingG = 0;
    const on = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (e.metaKey || e.ctrlKey || e.altKey || ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || (e.target as HTMLElement).isContentEditable) return;
      if (document.querySelector('.modal')) { if (e.key === 'Escape') setHelp(false); return; }
      const k = e.key.toLowerCase();
      if (pendingG && Date.now() - pendingG < 1200 && JUMP[k]) { e.preventDefault(); pendingG = 0; navigate(JUMP[k]); return; }
      pendingG = 0;
      if (k === 'g') { pendingG = Date.now(); return; }
      if (k === 'n') { e.preventDefault(); setAdding(true); }
      if (k === 'h') { e.preventDefault(); toggleHidden(); }
      if (e.key === '?') { e.preventDefault(); setHelp(true); }
      if (e.key === '/') {
        e.preventDefault();
        if (!window.location.hash.startsWith('#/transactions')) navigate('/transactions');
        setTimeout(() => (document.querySelector('.search input') as HTMLInputElement | null)?.focus(), 80);
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [toggleHidden]);

  const ctx = useMemo(() => (meta ? { meta, accounts, categories, version, refresh, toast, hidden } : null), [meta, accounts, categories, version, refresh, toast, hidden]);

  if (fatal) return <div className="fatal"><Icon name="alert" size={28} /><p>Can't reach the finance server.</p><p className="muted small">{fatal}. Is <code>npm start</code> running?</p></div>;
  if (!ctx || !meta) return <div className="loading full" />;

  const month = params.get('m') || meta.currentMonth;
  const page = NAV.find((n) => n.path === path) ?? NAV[0];
  const showMonth = path === '/' || path === '/budgets';

  return (
    <AppContext.Provider value={ctx}>
      <div className="shell">
        <aside className="sidebar">
          <div className="brand"><BrandMark /><span>{APP_NAME}</span></div>
          <nav>
            {NAV_GROUPS.map((g, gi) => (
              <div key={gi} className="nav-group" role="group" aria-label={g.label ?? 'Main'}>
                {g.label && <span className="nav-group-label">{g.label}</span>}
                {g.items.map((n) => (
                  <a key={n.path} href={`#${n.path}`} className={page.path === n.path ? 'active' : ''} aria-current={page.path === n.path ? 'page' : undefined}>
                    <Icon name={n.icon} size={18} /><span>{n.label}</span>
                  </a>
                ))}
              </div>
            ))}
          </nav>
          <button className="nav-help" onClick={() => setHelp(true)}><Icon name="info" size={16} /> Keyboard shortcuts <kbd>?</kbd></button>
          <div className="profile-row">
            <a className="profile-chip" href="#/settings" title="Profile and appearance">
              <Avatar profile={meta.profile} size={30} />
              <span className="grow">{meta.profile.name || 'Add your name'}<br /><span className="muted small">Profile and appearance</span></span>
            </a>
            {meta.lockEnabled && <button className="btn btn-icon lock-now" title="Lock" aria-label="Lock the app" onClick={() => window.dispatchEvent(new Event('ledger-lock-now'))}><Icon name="lock" size={16} /></button>}
          </div>
        </aside>

        <main className="main">
          <UpdateBanner />
          <header className="topbar">
            <h1>{page.path === '/' && meta.profile.name ? greeting(meta.profile.name) : page.label}</h1>
            {showMonth && (
              <div className="month-nav">
                <button className="icon-btn" aria-label="Previous month" onClick={() => setParams(page.path, { m: addMonths(month, -1) })}><Icon name="chevron-left" /></button>
                <span>{monthLabel(month)}</span>
                <button className="icon-btn" aria-label="Next month" onClick={() => setParams(page.path, { m: addMonths(month, 1) })} disabled={month >= meta.currentMonth}><Icon name="chevron-right" /></button>
              </div>
            )}
            <span className="spacer" />
            <button className={`icon-btn privacy-btn ${hidden ? 'on' : ''}`} onClick={toggleHidden} aria-pressed={hidden}
              aria-label={hidden ? 'Show balances' : 'Hide balances'} title={`${hidden ? 'Show' : 'Hide'} balances (H)`}>
              <Icon name={hidden ? 'eye-off' : 'eye'} size={19} />
            </button>
            <button className="btn btn-primary add-btn" onClick={() => (pageAdd ? pageAdd.run() : setAdding(true))} title={pageAdd ? pageAdd.label : 'Add transaction (N)'} aria-label={pageAdd ? pageAdd.label : 'Add transaction'}><Icon name="plus" size={16} /> <span>{pageAdd ? pageAdd.label : 'Add transaction'}</span></button>
          </header>

          {page.path === '/' && <Overview month={month} />}
          {page.path === '/transactions' && <Transactions params={params} />}
          {page.path === '/bills' && <Bills />}
          {page.path === '/budgets' && <Budgets month={month} />}
          {page.path === '/debts' && <Debts />}
          {page.path === '/goals' && <Goals />}
          {page.path === '/reports' && <Reports params={params} />}
          {page.path === '/accounts' && <Accounts />}
          {page.path === '/categories' && <CategoriesPage />}
          {page.path === '/import' && <Import />}
          {page.path === '/settings' && <Settings />}
          {page.path === '/investing' && <Investing />}
          {page.path === '/payday' && <Payday params={params} />}
        </main>

        <nav className="tabbar">
          {NAV.filter((n) => TAB_PATHS.includes(n.path)).map((n) => (
            <a key={n.path} href={`#${n.path}`} className={page.path === n.path ? 'active' : ''} onClick={() => setMore(false)}><Icon name={n.icon} size={20} /><span>{n.path === '/bills' ? 'Bills' : n.label}</span></a>
          ))}
          <button className={!TAB_PATHS.includes(page.path) || more ? 'active' : ''} onClick={() => setMore(!more)} aria-expanded={more}><Icon name="dots" size={20} /><span>More</span></button>
        </nav>
        {more && (
          <div className="more-sheet" onClick={() => setMore(false)}>
            <div className="more-panel" onClick={(e) => e.stopPropagation()}>
              {NAV_GROUPS.map((g) => ({ ...g, items: g.items.filter((n) => !TAB_PATHS.includes(n.path)) })).filter((g) => g.items.length).map((g, gi) => (
                <React.Fragment key={gi}>

                  {g.items.map((n) => (
                    <a key={n.path} href={`#${n.path}`} className={page.path === n.path ? 'active' : ''} onClick={() => setMore(false)}><Icon name={n.icon} size={20} /><span>{n.label}</span></a>
                  ))}
                </React.Fragment>
              ))}
            </div>
          </div>
        )}
      </div>
      {adding && <TransactionForm onClose={() => setAdding(false)} />}
      {help && (
        <div className="overlay" onClick={() => setHelp(false)}>
          <div className="modal" role="dialog" aria-label="Keyboard shortcuts" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><h2>Keyboard shortcuts</h2><button className="icon-btn" onClick={() => setHelp(false)} aria-label="Close"><Icon name="x" /></button></div>
            <div className="modal-body"><table className="shortcuts">{SHORTCUTS.map(([k, d]) => <tr key={k}><td><kbd>{k}</kbd></td><td>{d}</td></tr>)}</table></div>
          </div>
        </div>
      )}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => <div key={t.id} className={`toast toast-${t.kind}`}>{t.kind === 'ok' ? <Icon name="check" size={16} /> : <Icon name="alert" size={16} />}{t.msg}</div>)}
      </div>
    </AppContext.Provider>
  );
}

export { navigate };

/** Theme, accent, density and size are applied to <html>; also cached so the next load paints correctly at once. */
export function applyAppearance(a: Appearance, p?: Profile) {
  const r = document.documentElement;
  if (a.theme === 'system') r.removeAttribute('data-theme'); else r.setAttribute('data-theme', a.theme);
  r.style.setProperty('--accent', a.accent);
  // Text on the accent, and the accent as text, chosen so they stay readable whatever accent you pick.
  r.style.setProperty('--accent-ink', contrast(a.accent, '#0f1a2e') >= contrast(a.accent, '#ffffff') ? '#0f1a2e' : '#ffffff');
  r.style.setProperty('--accent-text-light', readableOn(a.accent, '#fffdf8', '#000000'));
  r.style.setProperty('--accent-text-dark', readableOn(a.accent, '#111c30', '#ffffff'));
  r.classList.toggle('density-compact', a.density === 'compact');
  r.classList.toggle('text-small', a.textSize === 'small');
  r.classList.toggle('text-large', a.textSize === 'large');
  r.classList.toggle('reduce-motion', a.reduceMotion);
  setShowPence(a.showPence);
  const title = `${APP_NAME} · Personal finance`;
  document.title = title;
  try { localStorage.setItem('finance.appearance', JSON.stringify(a)); localStorage.setItem('finance.title', title); } catch { /* ignore */ }
}

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const hex = (c: number[]) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
function luminance(h: string) {
  const [r, g, b] = rgb(h).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}
/** The colour, mixed towards `toward` just enough to be readable as text on `bg` (4.5:1). */
function readableOn(colour: string, bg: string, toward: string) {
  const a = rgb(colour), t = rgb(toward);
  for (let k = 0; k <= 1; k += 0.05) {
    const c = hex(a.map((v, i) => v + (t[i] - v) * k));
    if (contrast(c, bg) >= 4.6) return c;
  }
  return toward;
}

function greeting(name: string): string {
  const h = new Date().getHours();
  const part = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  return `${part}, ${name.split(' ')[0]}`;
}

export function Avatar({ profile, size = 32 }: { profile: Profile; size?: number }) {
  if (profile.avatar) return <img className="avatar" src={profile.avatar} alt="" style={{ width: size, height: size }} />;
  const initials = (profile.name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return <span className="avatar-initials" style={{ width: size, height: size, fontSize: size * 0.4 }}>{initials}</span>;
}
