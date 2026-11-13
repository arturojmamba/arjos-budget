import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { Icon } from './Icon.tsx';

interface LockStatus {
  enabled: boolean; locked: boolean; length: number | null; wait: number;
  name: string; avatar: string | null; appName: string; accent: string; theme: string; touchId: boolean; desktop: boolean;
}

/** Shows the lock screen until the passcode is entered; the app itself loads only after that. */
export function LockGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<LockStatus | null>(null);
  const [generation, setGeneration] = useState(0);
  const check = useCallback(async () => {
    try { setStatus(await api.get<LockStatus>('/api/lock/status')); } catch { setStatus(null); }
  }, []);
  useEffect(() => {
    check();
    const relock = () => check();
    const lockNow = async () => { try { await api.post('/api/lock/lock', {}); } finally { check(); } };
    window.addEventListener('ledger-locked', relock);
    window.addEventListener('ledger-lock-now', lockNow);
    return () => { window.removeEventListener('ledger-locked', relock); window.removeEventListener('ledger-lock-now', lockNow); };
  }, [check]);
  if (!status) return <div className="lock-boot" />;
  if (status.locked) return <LockScreen status={status} onUnlocked={() => { setStatus({ ...status, locked: false }); setGeneration((g) => g + 1); }} />;
  return <React.Fragment key={generation}>{children}</React.Fragment>;
}

function LockScreen({ status, onUnlocked }: { status: LockStatus; onUnlocked: () => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(status.wait ? `Too many tries. Wait ${status.wait} seconds.` : null);
  const [shake, setShake] = useState(false);
  const [busy, setBusy] = useState(false);
  const [help, setHelp] = useState(false);
  const length = status.length ?? 4;
  const triedTouch = useRef(false);

  useEffect(() => {
    const r = document.documentElement;
    r.style.setProperty('--accent', status.accent);
    if (status.theme === 'light' || status.theme === 'dark') r.setAttribute('data-theme', status.theme); else r.removeAttribute('data-theme');
  }, [status.accent, status.theme]);

  const submit = useCallback(async (value: string) => {
    if (busy || !value) return;
    setBusy(true);
    try {
      await api.post('/api/lock/unlock', { passcode: value });
      onUnlocked();
    } catch (e: any) {
      setError(e.message); setShake(true); setCode('');
      window.setTimeout(() => setShake(false), 450);
    } finally { setBusy(false); }
  }, [busy, onUnlocked]);

  const touch = useCallback(async () => {
    try { await api.post('/api/lock/touchid', {}); onUnlocked(); } catch (e: any) { if (!/cancel/i.test(e.message)) setError(e.message); }
  }, [onUnlocked]);
  // Offer Touch ID straight away on Macs that have it.
  useEffect(() => { if (status.touchId && !triedTouch.current) { triedTouch.current = true; touch(); } }, [status.touchId, touch]);

  const press = useCallback((d: string) => {
    setError(null);
    setCode((c) => {
      if (c.length >= 12) return c;
      const next = c + d;
      if (next.length === length) window.setTimeout(() => submit(next), 60);
      return next;
    });
  }, [length, submit]);
  const back = useCallback(() => setCode((c) => c.slice(0, -1)), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) { e.preventDefault(); press(e.key); }
      else if (e.key === 'Backspace') { e.preventDefault(); back(); }
      else if (e.key === 'Enter') { e.preventDefault(); submit(code); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [press, back, submit, code]);

  const initials = (status.name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  const first = status.name ? status.name.split(' ')[0] : '';
  return (
    <div className="lock-screen">
      <div className="lock-card">
        <div className="lock-brand"><span className="brand-mark">£</span> {status.appName || 'Ledger'}</div>
        {status.avatar ? <img className="lock-avatar" src={status.avatar} alt="" /> : <span className="lock-avatar lock-initials">{initials}</span>}
        <h1 className="lock-name">{first ? `Welcome back, ${first}` : 'Welcome back'}</h1>
        <p className="lock-hint">{error ?? 'Enter your passcode'}</p>
        <div className={`lock-dots ${shake ? 'shake' : ''} ${error ? 'bad' : ''}`} aria-label={`${code.length} of ${length} digits entered`}>
          {Array.from({ length: Math.max(length, code.length) }, (_, i) => <span key={i} className={i < code.length ? 'on' : ''} />)}
        </div>
        <div className="lock-pad">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => <button key={d} onClick={() => press(d)} disabled={busy}>{d}</button>)}
          {status.touchId ? <button className="lock-aux" onClick={touch} aria-label="Use Touch ID" title="Use Touch ID"><Icon name="fingerprint" size={24} /></button> : <span />}
          <button onClick={() => press('0')} disabled={busy}>0</button>
          <button className="lock-aux" onClick={back} aria-label="Delete" disabled={!code}><Icon name="backspace" size={22} /></button>
        </div>
        <button className="link-btn lock-forgot" onClick={() => setHelp((h) => !h)}>Forgot passcode?</button>
        {help && (
          <p className="lock-help">
            {status.touchId ? 'Use Touch ID to get in, then change it in Settings → Passcode. ' : ''}
            Otherwise, quit the app and delete <code>lock.json</code> from the app's data folder
            ({status.desktop ? 'on a Mac: ~/Library/Application Support/Ledger/data; on Windows: %APPDATA%\\Ledger\\data' : 'the data folder next to finance.db'}), then open it again. Your money data isn't touched.
          </p>
        )}
      </div>
    </div>
  );
}
