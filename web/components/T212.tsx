import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, type T212Status } from '../api.ts';
import { money, timeAgo } from '../format.ts';
import { Badge, Card, useApp, useConfirm } from './ui.tsx';
import { Icon } from './Icon.tsx';

/** Trading 212 sync status, with "Sync now" that runs in the background and polls until done. */
export function useT212(onDone?: () => void) {
  const { refresh, toast } = useApp();
  const [status, setStatus] = useState<T212Status | null>(null);
  const timer = useRef<number | null>(null);
  const was = useRef(false);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  const load = useCallback(async () => {
    try {
      const s = await api.get<T212Status>('/api/t212/status');
      setStatus(s);
      if (was.current && !s.running) {
        refresh();
        doneRef.current?.();
        if (s.lastRunError) toast(s.lastRunError, 'error');
        else {
          const bad = s.endpoints.filter((e) => e.status === 'denied' || e.status === 'error');
          toast(bad.length ? `Synced, but couldn't read: ${bad.map((b) => b.label.toLowerCase()).join(', ')}` : 'Trading 212 synced');
        }
      }
      was.current = s.running;
      if (timer.current) window.clearTimeout(timer.current);
      if (s.running) timer.current = window.setTimeout(load, 1500);
    } catch { /* status is best-effort */ }
  }, [refresh, toast]);

  useEffect(() => { load(); return () => { if (timer.current) window.clearTimeout(timer.current); }; }, [load]);

  const sync = async (force = false) => {
    try {
      await api.post('/api/t212/sync', { force });
      was.current = true;
      setStatus((s) => (s ? { ...s, running: true, step: null } : s));
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(load, 800);
    } catch (e: any) { toast(e.message, 'error'); }
  };
  /** Clear everything synced from Trading 212 (the server backs up first) and sync again. */
  const reset = async () => {
    try {
      const r = await api.post<{ backup: string; started: boolean }>('/api/t212/reset', {});
      toast(r.started ? 'Cleared. Downloading your Trading 212 history again…' : 'Cleared. Sync to download your history again.');
      was.current = r.started;
      refresh();
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(load, 800);
    } catch (e: any) { toast(e.message, 'error'); }
  };
  return { status, sync, reset, reload: load };
}

const TONE = { ok: 'good', denied: 'warn', error: 'bad', unavailable: 'neutral', never: 'neutral' } as const;
const WORD = { ok: 'Working', denied: 'No permission', error: 'Problem', unavailable: 'Not offered', never: 'Not synced yet' } as const;

export function T212Card() {
  const { meta } = useApp();
  const { status, sync, reset } = useT212();
  const [confirm, confirmNode] = useConfirm();
  const askReset = async () => {
    if (await confirm('This clears everything downloaded from Trading 212: orders, dividends, deposits and withdrawals, holdings, pies and the daily values the sync recorded. Then it downloads your history again using the key in your .env file. A backup is saved first. Values you typed in yourself and your bank transactions are kept. Use this if the wrong API key was ever used.', { label: 'Reset and re-sync', danger: true })) reset();
  };

  if (!meta.trading212.configured) {
    return (
      <Card title="Trading 212">
        <p className="muted">To sync your ISA automatically, create a <code>.env</code> file in the app folder (next to <code>package.json</code>) with:</p>
        <pre className="code-block">T212_API_KEY=your-key{'\n'}T212_API_SECRET=your-secret</pre>
        <p className="muted small">Then restart the app. The app only ever reads from Trading 212. It never places, changes or cancels orders. The key stays in that file and is never stored in the database or shown here.</p>
      </Card>
    );
  }

  const errs = (status?.endpoints ?? []).filter((e) => e.status === 'error' && e.message);
  const shared = errs.length >= 2 && errs.every((e) => e.message === errs[0].message) ? errs[0].message : null;
  const last = status?.endpoints.map((e) => e.lastTryAt).filter(Boolean).sort().pop() ?? null;
  return (
    <Card title="Trading 212" action={
      <button className="btn btn-sm" onClick={() => sync()} disabled={!status || status.running || status.accountId === null}>
        <Icon name="refresh" size={14} /> {status?.running ? 'Syncing…' : 'Sync now'}
      </button>}>
      <p className="row gap wrap">
        <span className="badge badge-good"><Icon name="check" size={12} /> API key found{status?.environment === 'demo' ? ' (demo account)' : ''}</span>
        <span className="muted small">
          {status?.running ? `Reading ${status.step?.toLowerCase() ?? 'your account'}…` : last ? `Last checked ${timeAgo(last)}. ` : ''}
          {!status?.running && 'Syncs every 6 hours while the app is running. Read-only: never places orders.'}
        </span>
      </p>
      {status?.accountId === null && <p className="tone-bad small">No account is set to sync. Edit your ISA under Accounts and tick “Get the value from Trading 212”.</p>}
      {status?.lastRunError && !status.running ? <p className="form-error">{status.lastRunError}</p>
        : shared && !status?.running && <p className="form-error">{shared}</p>}
      {status?.cash && status.cash.amount > 0 && (
        <p className={`small ${status.cash.nudge ? 'tone-warn' : 'muted'}`}>
          {money(status.cash.amount)} uninvested cash{status.cash.nudge ? `, sitting there for ${status.cash.days} days` : ''}.
        </p>
      )}
      <table className="t212-perms">
        <thead><tr><th>What</th><th>Key permission</th><th>Status</th><th className="num">Items</th></tr></thead>
        <tbody>
          {(status?.endpoints ?? []).map((e) => (
            <tr key={e.key} title={e.message ?? undefined}>
              <td>{e.label}{e.message && e.status !== 'ok' && !(shared && e.message === shared) && <div className="muted small">{e.status === 'denied' ? 'Create a new key with this permission ticked.' : e.message}</div>}</td>
              <td className="muted small">{e.permission}</td>
              <td><Badge tone={TONE[e.status]}>{WORD[e.status]}</Badge>{e.lastOkAt && <div className="muted small">{e.status === 'ok' ? '' : 'worked '}{timeAgo(e.lastOkAt)}</div>}</td>
              <td className="num">{e.status === 'never' ? '–' : e.items.toLocaleString('en-GB')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">The first sync reads your whole history, a page at a time within Trading 212's limits, so it can take a few minutes. After that only new items are fetched.</p>
      <div className="row gap wrap t212-account">
        <span className="muted small grow">
          {status?.accountNumber ? <>Synced with Trading 212 account ending <strong>{status.accountNumber.slice(-4)}</strong>. A key for a different account is refused, so its data can't mix with yours.</> : 'The account number is recorded on the next sync.'}
        </span>
        <button className="btn btn-sm btn-danger-outline" onClick={askReset} disabled={!status || status.running || status.accountId === null}>Reset Trading 212 data</button>
      </div>
      {confirmNode}
    </Card>
  );
}
