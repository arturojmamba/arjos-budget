import React, { useRef, useState } from 'react';
import { api, type Appearance } from '../api.ts';
import { applyAppearance, Avatar } from '../App.tsx';
import { Badge, Card, Field, Segmented, useApp, useConfirm, useData } from '../components/ui.tsx';
import { navigate, setParams, useRoute } from '../router.ts';
import { Icon } from '../components/Icon.tsx';
import { T212Card } from '../components/T212.tsx';
import { money } from '../format.ts';

type TabKey = 'profile' | 'appearance' | 'display' | 'budgeting' | 'trading212' | 'data';
const TABS: { key: TabKey; label: string; icon: string; hint: string }[] = [
  { key: 'profile', label: 'Profile', icon: 'heart', hint: 'Your name, picture and the app’s name' },
  { key: 'appearance', label: 'Appearance', icon: 'sparkles', hint: 'Theme, colour, text size and layout' },
  { key: 'display', label: 'Numbers & privacy', icon: 'eye', hint: 'Pence, start page and hiding amounts' },
  { key: 'budgeting', label: 'Budgeting', icon: 'calendar', hint: 'How months and paydays line up' },
  { key: 'trading212', label: 'Trading 212', icon: 'trending-up', hint: 'Sync status and permissions' },
  { key: 'data', label: 'Data', icon: 'archive', hint: 'Health checks, backups and export' },
];

export function Settings() {
  const { params } = useRoute();
  const raw = params.get('tab') as TabKey | null;
  const tab: TabKey = TABS.some((t) => t.key === raw) ? raw! : 'profile';
  const health = useData(() => api.get<unknown[]>('/api/health'), []);
  const issues = health.data?.length ?? 0;
  const current = TABS.find((t) => t.key === tab)!;
  return (
    <div className="page settings-page">
      <nav className="settings-tabs" role="tablist" aria-label="Settings sections">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={t.key === tab} className={`settings-tab ${t.key === tab ? 'on' : ''}`}
            onClick={() => setParams('/settings', { tab: t.key === 'profile' ? null : t.key })}>
            <Icon name={t.icon} size={17} />
            <span>{t.label}</span>
            {t.key === 'data' && issues > 0 && <span className="settings-dot" aria-label={`${issues} to look at`}>{issues}</span>}
          </button>
        ))}
      </nav>
      <section className="settings-body" role="tabpanel" aria-label={current.label}>
        <header className="settings-head">
          <h2>{current.label}</h2>
          <p className="muted">{current.hint}</p>
        </header>
        {tab === 'profile' && <ProfileCard />}
        {tab === 'appearance' && <AppearanceCard />}
        {tab === 'display' && <DisplayCard />}
        {tab === 'budgeting' && <BudgetingCard />}
        {tab === 'trading212' && <T212Card />}
        {tab === 'data' && <><HealthPanel /><DataCard /></>}
      </section>
    </div>
  );
}

function BudgetingCard() {
  const { meta, refresh, toast } = useApp();
  const [days, setDays] = useState(String(meta.settings.rollforwardDays));
  async function saveDays() {
    try {
      await api.put('/api/settings', { rollforwardDays: Number(days) });
      toast('Saved. Applies to new and edited salary transactions');
      refresh();
    } catch (e: any) { toast(e.message, 'error'); }
  }
  return (
    <Card title="Monthly budget period">
      <p className="muted">Months follow the calendar. Because you're paid on the last working day, salary that lands in the last few days of a month counts towards the <em>next</em> month, so October's payday funds November.</p>
      <div className="row gap end">
        <Field label="Days before month end" hint="0 turns this off. Applies to income categories marked “paid at the end of the month”.">
          <input type="number" min={0} max={10} value={days} onChange={(e) => setDays(e.target.value)} />
        </Field>
        <button className="btn" onClick={saveDays} disabled={days === String(meta.settings.rollforwardDays)}>Save</button>
      </div>
    </Card>
  );
}

function DataCard() {
  const { toast } = useApp();
  const [backupFile, setBackupFile] = useState<string | null>(null);
  async function backup() {
    try {
      const r = await api.post<{ file: string }>('/api/backup', {});
      setBackupFile(r.file);
      toast('Backup created');
    } catch (e: any) { toast(e.message, 'error'); }
  }
  const { meta } = useApp();
  const folderWord = meta.desktop?.platform === 'darwin' ? 'Finder' : meta.desktop?.platform === 'win32' ? 'Explorer' : 'your file manager';
  return (
    <Card title="Your data">
      {meta.desktop ? (
        <p className="muted">Everything is stored in one file on this computer, in <code>{meta.desktop.dataDir}</code>. A backup is taken automatically each day, and the last 30 are kept in its <code>backups</code> folder. <button className="link-btn" onClick={() => api.post('/api/desktop/open-data', {})}>Show in {folderWord}</button></p>
      ) : (
        <p className="muted">Everything is stored in one SQLite file on this computer (<code>data/finance.db</code>). A backup is taken automatically each day, and the last 30 are kept in <code>data/backups</code>.</p>
      )}
      <div className="row gap wrap">
        <button className="btn" onClick={backup}><Icon name="archive" size={16} /> Back up now</button>
        <a className="btn" href="/api/backup/download"><Icon name="download" size={16} /> Download a backup</a>
        <a className="btn" href="/api/export/transactions.csv"><Icon name="download" size={16} /> Export all transactions (CSV)</a>
      </div>
      {backupFile && <p className="muted small">Saved to <code>{backupFile}</code></p>}
      <Restore />
    </Card>
  );
}

function HealthPanel() {
  const { data } = useData<HealthIssue[]>(() => api.get('/api/health'), []);
  if (!data) return null;
  return (
    <Card title="Data health" action={data.length ? <Badge tone="warn">{data.length} to look at</Badge> : <Badge tone="good"><Icon name="check" size={12} /> All good</Badge>}>
      {data.length === 0 ? <p className="muted">No duplicates, stale accounts or loose ends found.</p> : (
        <ul className="health-list">
          {data.map((h) => (
            <li key={h.id} className={`health-${h.level}`}>
              <Icon name={h.level === 'warn' ? 'alert' : 'info'} size={16} />
              <span className="grow"><strong>{h.title}</strong><span className="muted small">{h.detail}</span></span>
              <button className="btn btn-sm" onClick={() => navigate(h.link)}>{h.linkLabel}</button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Restore() {
  const { toast, meta } = useApp();
  const [confirm, confirmNode] = useConfirm();
  const input = useRef<HTMLInputElement>(null);
  const { data: status, reload } = useData<{ pending: boolean }>(() => api.get('/api/backup/restore'), []);
  async function pick(file: File) {
    if (!(await confirm(`Restore from “${file.name}”? Your current data is kept as a backup first. The restore happens when you next restart the app.`, { label: 'Restore' }))) return;
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    try {
      const r = await api.post<{ transactions: number; accounts: number }>('/api/backup/restore', { data: btoa(bin) });
      toast(`Backup checked: ${r.transactions.toLocaleString('en-GB')} transactions, ${r.accounts} accounts. Restart the app to finish.`);
      reload();
    } catch (e: any) { toast(e.message, 'error'); }
  }
  async function cancel() {
    await api.del('/api/backup/restore');
    toast('Restore cancelled');
    reload();
  }
  return (
    <div className="restore">
      {status?.pending ? (
        meta.desktop ? (
          <p className="hint-box"><Icon name="info" size={16} /><span>A backup is ready to restore. Your current data is saved to the <code>backups</code> folder first. <button className="btn btn-sm btn-primary" onClick={() => api.post('/api/desktop/relaunch', {})}>Restart now</button> <button className="link-btn" onClick={cancel}>Cancel</button></span></p>
        ) : (
          <p className="hint-box"><Icon name="info" size={16} /><span>A backup is ready to restore. <strong>Stop the app and run <code>npm start</code> again</strong> to finish. Your current data is saved to <code>data/backups</code> first. <button className="link-btn" onClick={cancel}>Cancel</button></span></p>
        )
      ) : (
        <p className="muted small">To restore, choose a backup file (from {meta.desktop ? 'the backups folder' : <code>data/backups</code>} or one you downloaded). <button className="link-btn" onClick={() => input.current?.click()}>Restore from a backup…</button></p>
      )}
      <input ref={input} type="file" accept=".db,.sqlite,application/vnd.sqlite3" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) pick(f); e.target.value = ''; }} />
      {confirmNode}
    </div>
  );
}

const ACCENTS = ['#ff5b45', '#f97316', '#eab308', '#16a34a', '#0d9488', '#0ea5e9', '#2563eb', '#6366f1', '#8b5cf6', '#db2777', '#e11d48', '#475569'];
const START_PAGES: [string, string][] = [['/', 'Overview'], ['/transactions', 'Transactions'], ['/budgets', 'Budgets'], ['/goals', 'Goals'], ['/bills', 'Bills and income'], ['/debts', 'Debts'], ['/investing', 'Investing'], ['/reports', 'Reports'], ['/accounts', 'Accounts']];

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return <label className="switch" aria-label={label}><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /><span /></label>;
}

function ProfileCard() {
  const { meta, refresh, toast } = useApp();
  const [name, setName] = useState(meta.profile.name);
  const [appName, setAppName] = useState(meta.profile.appName);
  const file = useRef<HTMLInputElement>(null);
  async function save() {
    try { await api.put('/api/profile', { name, appName }); toast('Profile saved'); refresh(); } catch (e: any) { toast(e.message, 'error'); }
  }
  async function pick(f: File) {
    try {
      const dataUrl = await squareImage(f, 256);
      await api.put('/api/profile/avatar', { dataUrl });
      toast('Picture updated');
      refresh();
    } catch (e: any) { toast(e.message || "Couldn't read that picture", 'error'); }
  }
  async function removePicture() { await api.put('/api/profile/avatar', { dataUrl: null }); refresh(); }
  return (
    <Card title="Profile">
      <div className="profile-edit">
        <div className="stack" style={{ alignItems: 'center', gap: 8, flex: '0 0 auto', minWidth: 0 }}>
          <Avatar profile={{ ...meta.profile, name }} size={84} />
          <div className="row gap">
            <button className="link-btn small" onClick={() => file.current?.click()}>{meta.profile.avatar ? 'Change' : 'Add picture'}</button>
            {meta.profile.avatar && <button className="link-btn small" onClick={removePicture}>Remove</button>}
          </div>
          <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/heic" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) pick(f); e.target.value = ''; }} />
        </div>
        <div className="stack" style={{ gap: 10 }}>
          <Field label="Your name" hint="Used for the greeting on Overview."><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Alex" maxLength={40} /></Field>
          <Field label="App name" hint="Shown in the sidebar and the browser tab."><input value={appName} onChange={(e) => setAppName(e.target.value)} placeholder="Ledger" maxLength={30} /></Field>
          <div><button className="btn" onClick={save} disabled={name === meta.profile.name && appName === meta.profile.appName}>Save</button></div>
        </div>
      </div>
    </Card>
  );
}

/** Crop to a centred square and shrink, so the saved picture stays small. */
function squareImage(f: File, size: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => {
      const s = Math.min(img.width, img.height);
      const c = document.createElement('canvas');
      c.width = c.height = size;
      c.getContext('2d')!.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.86));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file isn't a picture this browser can read")); };
    img.src = url;
  });
}

/** Appearance settings with instant apply and save. */
function useAppearance() {
  const { meta, refresh, toast } = useApp();
  const [a, setA] = useState<Appearance>(meta.appearance);
  async function set<K extends keyof Appearance>(k: K, v: Appearance[K]) {
    const next = { ...a, [k]: v };
    setA(next);
    applyAppearance(next, meta.profile); // see it straight away
    try { await api.put('/api/appearance', { [k]: v }); refresh(); } catch (e: any) { toast(e.message, 'error'); }
  }
  return { a, set };
}

/** A little sample so theme and accent changes are visible right here. */
function AppearancePreview() {
  return (
    <div className="appearance-preview" aria-hidden="true">
      <div className="ap-card">
        <div className="ap-row"><span className="ap-bubble">🛒</span><span>Groceries</span><span className="spacer" /><strong>{money(-4235)}</strong></div>
        <div className="ap-bar"><span style={{ width: '62%' }} /></div>
        <div className="ap-row muted small"><span>{money(26000)} of {money(42000)} budget</span><span className="spacer" /><span className="tone-good">On track</span></div>
      </div>
      <div className="ap-actions"><span className="btn btn-primary btn-sm">Primary</span><span className="btn btn-sm">Secondary</span><span className="link-btn">A link</span></div>
    </div>
  );
}

function DisplayCard() {
  const { a, set } = useAppearance();
  return (
    <>
      <Card title="Numbers">
        <div className="pref-row">
          <div><strong>Show pence</strong><span className="muted small">Off shows whole pounds, e.g. £1,235 instead of £1,234.56. Amounts are still stored to the penny.</span></div>
          <Toggle checked={a.showPence} onChange={(v) => set('showPence', v)} label="Show pence" />
        </div>
        <div className="pref-row">
          <div><strong>Open on</strong><span className="muted small">The page you see when you open the app.</span></div>
          <select value={a.startPage} onChange={(e) => set('startPage', e.target.value)} aria-label="Start page">{START_PAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </div>
      </Card>
      <Card title="Privacy">
        <div className="pref-row">
          <div><strong>Start with amounts hidden</strong><span className="muted small">Handy if people can see your screen. Press H, or the eye button, to show them.</span></div>
          <Toggle checked={a.startHidden} onChange={(v) => set('startHidden', v)} label="Start with amounts hidden" />
        </div>
      </Card>
    </>
  );
}

function AppearanceCard() {
  const { a, set } = useAppearance();
  return (
    <>
    <Card title="Theme and colour">
      <div className="pref-row">
        <div><strong>Theme</strong><span className="muted small">System follows your computer's light or dark setting.</span></div>
        <Segmented value={a.theme} onChange={(v) => set('theme', v)} options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
      </div>
      <div className="pref-row" style={{ flexWrap: 'wrap' }}>
        <div><strong>Accent colour</strong><span className="muted small">Buttons, links and highlights.</span></div>
        <div className="swatches">
          {ACCENTS.map((c) => <button key={c} className={`swatch ${a.accent.toLowerCase() === c ? 'on' : ''}`} style={{ background: c }} onClick={() => set('accent', c)} aria-label={`Accent ${c}`} />)}
          <label className={`swatch swatch-custom ${ACCENTS.includes(a.accent.toLowerCase()) ? '' : 'on'}`} title="Pick any colour">
            <input type="color" value={a.accent} onChange={(e) => set('accent', e.target.value)} aria-label="Custom accent colour" />
          </label>
        </div>
      </div>
      <AppearancePreview />
    </Card>
    <Card title="Layout">
      <div className="pref-row">
        <div><strong>Text size</strong></div>
        <Segmented value={a.textSize} onChange={(v) => set('textSize', v)} options={[{ value: 'small', label: 'Small' }, { value: 'normal', label: 'Normal' }, { value: 'large', label: 'Large' }]} />
      </div>
      <div className="pref-row">
        <div><strong>Density</strong><span className="muted small">Compact fits more on screen.</span></div>
        <Segmented value={a.density} onChange={(v) => set('density', v)} options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]} />
      </div>
      <div className="pref-row">
        <div><strong>Reduce motion</strong><span className="muted small">Turns off animations.</span></div>
        <Toggle checked={a.reduceMotion} onChange={(v) => set('reduceMotion', v)} label="Reduce motion" />
      </div>
    </Card>
    </>
  );
}
