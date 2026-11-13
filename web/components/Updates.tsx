import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.ts';
import { Badge, Card, Modal, useApp } from './ui.tsx';
import { Icon } from './Icon.tsx';
import { shortDate } from '../format.ts';

interface Available { version: string; tag: string; notes: string; publishedAt: string; page: string }
type State =
  | { status: 'idle' | 'checking' | 'none' }
  | { status: 'downloading'; available: Available; received: number; total: number }
  | { status: 'ready'; available: Available }
  | { status: 'manual'; available: Available; reason: string }
  | { status: 'error'; message: string; available?: Available };
interface UpdateInfo { supported: boolean; version: string | null; auto?: boolean; checkedAt?: string | null; state?: State }

function useUpdates(poll = 0) {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const load = useCallback(async () => { try { setInfo(await api.get<UpdateInfo>('/api/desktop/update')); } catch { /* optional */ } }, []);
  useEffect(() => {
    load();
    if (!poll) return;
    const t = window.setInterval(load, poll);
    return () => window.clearInterval(t);
  }, [load, poll]);
  return { info, setInfo, load };
}

async function restartToUpdate(toast: (m: string, k?: 'ok' | 'error') => void) {
  try {
    await api.post('/api/desktop/update/install', {});
    toast('Updating… Ledger will reopen in a moment.');
  } catch (e: any) { toast(e.message, 'error'); }
}

/** Plain-text release notes: "- item" lines become a list. */
function Notes({ text }: { text: string }) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return <p className="muted">No notes for this version.</p>;
  return (
    <ul className="update-notes">
      {lines.map((l, i) => /^[-*] /.test(l) ? <li key={i}>{l.slice(2)}</li> : <li key={i} className="plain">{l.replace(/^#+\s*/, '')}</li>)}
    </ul>
  );
}

/** Desktop app only: "Ledger 1.2.1 is ready · What's new · Restart to update", shown after you unlock. */
export function UpdateBanner() {
  const { meta, toast } = useApp();
  const { info } = useUpdates(meta.desktop ? 5 * 60_000 : 0);
  const [hidden, setHidden] = useState<string | null>(null);
  const [notes, setNotes] = useState(false);
  if (!meta.desktop || !info?.supported || info.state?.status !== 'ready') return null;
  const a = info.state.available;
  if (hidden === a.version) return null;
  return (
    <>
      <div className="update-banner" role="status">
        <Icon name="download" size={16} />
        <span className="grow"><strong>Ledger {a.version} is ready.</strong> <button className="link-btn" onClick={() => setNotes(true)}>What's new</button></span>
        <button className="btn btn-sm btn-primary" onClick={() => restartToUpdate(toast)}>Restart to update</button>
        <button className="btn btn-icon btn-sm" aria-label="Later" title="Later" onClick={() => setHidden(a.version)}><Icon name="x" size={14} /></button>
      </div>
      {notes && (
        <Modal title={`What's new in ${a.version}`} onClose={() => setNotes(false)}
          footer={<><button className="btn" onClick={() => setNotes(false)}>Later</button><button className="btn btn-primary" onClick={() => restartToUpdate(toast)}>Restart to update</button></>}>
          <Notes text={a.notes} />
          <p className="muted small">Released {shortDate(a.publishedAt.slice(0, 10))}. Your data isn't touched, and a backup is taken first.</p>
        </Modal>
      )}
    </>
  );
}

/** Settings → About & updates. */
export function AboutCard() {
  const { meta, toast } = useApp();
  const { info, setInfo, load } = useUpdates();
  const [busy, setBusy] = useState(false);
  const [notes, setNotes] = useState(false);
  const checked = React.useRef(false);
  useEffect(() => {
    if (checked.current || !info?.supported || !info.state) return;
    checked.current = true;
    if (info.state.status === 'idle' || info.state.status === 'none' || info.state.status === 'error') {
      api.post<UpdateInfo>('/api/desktop/update/check', {}).then(setInfo).catch(() => {});
    }
  }, [info, setInfo]);
  useEffect(() => {
    if (info?.state?.status !== 'downloading' && info?.state?.status !== 'checking') return;
    const t = window.setTimeout(load, 1000);
    return () => window.clearTimeout(t);
  }, [info, load]);

  if (!meta.desktop) {
    return (
      <Card title="About">
        <p className="muted">You're running Ledger from its source folder (<code>npm start</code>). To update, pull the latest code and restart: <code>git pull && npm start</code>. The desktop app updates itself.</p>
      </Card>
    );
  }
  const check = async () => {
    setBusy(true);
    try { setInfo(await api.post<UpdateInfo>('/api/desktop/update/check', {})); } catch (e: any) { toast(e.message, 'error'); } finally { setBusy(false); }
  };
  const setAuto = async (on: boolean) => { try { setInfo(await api.put<UpdateInfo>('/api/desktop/update/auto', { on })); } catch (e: any) { toast(e.message, 'error'); } };
  const s = info?.state;
  const pct = s?.status === 'downloading' && s.total ? Math.round((s.received / s.total) * 100) : 0;
  return (
    <Card title="About & updates" action={<Badge>Version {meta.desktop.version}</Badge>}>
      {!info?.supported ? (
        <p className="muted">Updates work in the installed app.</p>
      ) : (
        <>
          <div className="update-status">
            {s?.status === 'checking' && <p className="muted"><Icon name="refresh" size={14} /> Checking for updates…</p>}
            {s?.status === 'none' && <p><Icon name="check" size={14} /> You're up to date.{info.checkedAt && <span className="muted small"> Checked {new Date(info.checkedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}.</span>}</p>}
            {s?.status === 'idle' && <p className="muted">Not checked yet.</p>}
            {s?.status === 'downloading' && (
              <div><p>Downloading Ledger {s.available.version}… {pct}%</p><span className="week-bar"><span style={{ width: `${pct}%`, background: 'var(--accent)' }} /></span></div>
            )}
            {s?.status === 'ready' && (
              <div className="row gap wrap">
                <span className="grow"><strong>Ledger {s.available.version} is ready.</strong> <button className="link-btn" onClick={() => setNotes(true)}>What's new</button></span>
                <button className="btn btn-primary" onClick={() => restartToUpdate(toast)}>Restart to update</button>
              </div>
            )}
            {s?.status === 'manual' && (
              <div className="hint-box"><Icon name="info" size={16} /><span>Ledger {s.available.version} is downloaded but can't be installed automatically: {s.reason} <button className="link-btn" onClick={() => api.post('/api/desktop/update/open', {})}>Open the installer</button></span></div>
            )}
            {s?.status === 'error' && <p className="tone-bad small">{s.message}</p>}
          </div>
          <div className="row gap wrap" style={{ marginTop: 12 }}>
            <button className="btn" onClick={check} disabled={busy || s?.status === 'checking' || s?.status === 'downloading'}><Icon name="refresh" size={16} /> Check for updates</button>
            <label className="check"><input type="checkbox" checked={!!info.auto} onChange={(e) => setAuto(e.target.checked)} /><span>Check automatically (when the app opens and once a day)</span></label>
          </div>
          <p className="muted small" style={{ marginTop: 12 }}>Updates come from the app's GitHub releases. Each download is checked against the checksum GitHub publishes, a backup is taken before installing, and your data is never touched. It only restarts when you say so.</p>
        </>
      )}
      {notes && s?.status === 'ready' && (
        <Modal title={`What's new in ${s.available.version}`} onClose={() => setNotes(false)}
          footer={<><button className="btn" onClick={() => setNotes(false)}>Later</button><button className="btn btn-primary" onClick={() => restartToUpdate(toast)}>Restart to update</button></>}>
          <Notes text={s.available.notes} />
        </Modal>
      )}
    </Card>
  );
}
