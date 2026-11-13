import React, { useMemo, useRef, useState } from 'react';
import { api } from '../api.ts';
import { money, shortDate } from '../format.ts';
import { AccountSelect, Badge, Card, CategorySelect, Empty, Field, Modal, Money, Segmented, useApp, useConfirm, useData } from '../components/ui.tsx';
import { Icon } from '../components/Icon.tsx';
import { navigate } from '../router.ts';

type Kind = 'expense' | 'income' | 'transfer';
type Action = 'create' | 'skip' | 'link' | 'merge_transfer';
interface Mapping { date: string; dateFormat?: 'DMY' | 'YMD' | 'MDY'; description: string[]; amount?: string; invert?: boolean; debit?: string; credit?: string; balance?: string }
interface Row {
  index: number; date: string | null; description: string; bankDescription: string; amount: number | null; balance: number | null; hash: string | null;
  status: 'new' | 'duplicate' | 'possible_duplicate' | 'transfer_match' | 'error'; error?: string;
  match?: { transactionId: number; postingId: number; date: string; description: string; accountName: string };
  action: Action; kind: Kind; categoryId: number | null; transferAccountId: number | null; suggestionSource: string; remember?: boolean;
  /** Category copied from the row with this index (same place). Changing that row again updates this one too. */
  filledFrom?: number | null;
  /** Edited during this import: stays in "Needs attention" so a misclick can still be put right. */
  touched?: boolean;
}
interface Preview {
  presetId: string | null; presetLabel: string; presetNote?: string; mapping: Mapping | null; headers: string[]; rows: Row[];
  anchor: { date: string; balance: number } | null; summary: Record<Row['status'], number>; dateRange: { from: string; to: string } | null;
}
interface ImportRecord { id: number; accountName: string; filename: string | null; importedAt: string; rowCount: number; created: number; matched: number; skipped: number }

const merchantKey = (s: string) => s.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();

export function Import() {
  const { meta, accounts, refresh, toast } = useApp();
  const [accountId, setAccountId] = useState<number | null>(null);
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [presetId, setPresetId] = useState<string>('');
  const [flip, setFlip] = useState(false);
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [useAnchor, setUseAnchor] = useState(true);
  const [filter, setFilter] = useState<'all' | 'attention' | 'new' | 'dupes'>('all');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ created: number; matched: number; skipped: number; rulesCreated: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const account = accounts.find((a) => a.id === accountId);

  async function runPreview(opts: { file?: { name: string; text: string }; presetId?: string; flip?: boolean; mapping?: Mapping | null; accountId?: number | null } = {}) {
    const f = opts.file ?? file;
    const acc = opts.accountId !== undefined ? opts.accountId : accountId;
    if (!f || !acc) return;
    setError(null);
    setBusy(true);
    try {
      const p = await api.post<Preview>('/api/import/preview', {
        accountId: acc, csv: f.text,
        presetId: (opts.presetId ?? presetId) || null,
        flip: opts.flip ?? flip,
        mapping: opts.mapping !== undefined ? opts.mapping : null,
      });
      setPreview(p);
      setRows(p.rows);
      if (!opts.mapping) setMapping(p.mapping);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  function onFile(f: File | undefined) {
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const next = { name: f.name, text: String(reader.result) };
      setFile(next);
      setResult(null);
      // Guess the account from the filename if none chosen yet.
      let acc = accountId;
      if (!acc) {
        const n = f.name.toLowerCase();
        acc = accounts.find((a) => a.institution && n.includes(a.institution.toLowerCase().split(' ')[0]))?.id ?? null;
        if (acc) setAccountId(acc);
      }
      runPreview({ file: next, accountId: acc });
    };
    reader.readAsText(f);
  }

  function updateRow(index: number, patch: Partial<Row>, applyToSimilar = false) {
    setRows((prev) => {
      const target = prev.find((r) => r.index === index)!;
      const key = merchantKey(target.description);
      const setsCategory = 'categoryId' in patch;
      return prev.map((r) => {
        // A row you change yourself is yours: it no longer follows the row it was copied from.
        if (r.index === index) return { ...r, ...patch, touched: true, filledFrom: setsCategory ? null : r.filledFrom };
        if (!applyToSimilar || target.filledFrom != null) return r;
        // Categorising a row also fills in the other rows for the same place that have no category yet, and
        // re-applies to the rows it filled in earlier, so a misclick can be corrected by picking again.
        // Categories from your rules or history, and rows you changed yourself, are left alone.
        const copiedFromHere = r.filledFrom === index;
        const sameUncategorised = r.status === 'new' && r.action === 'create' && r.suggestionSource === 'none' && r.kind === target.kind && !r.categoryId
          && merchantKey(r.description) === key && Math.sign(r.amount ?? 0) === Math.sign(target.amount ?? 0);
        if (copiedFromHere && r.action === 'create' && r.kind === target.kind) return { ...r, ...patch, remember: false, touched: true };
        if (sameUncategorised) return { ...r, ...patch, remember: false, touched: true, filledFrom: index };
        return r;
      });
    });
  }

  const toImport = rows.filter((r) => r.action !== 'skip' && r.status !== 'error');
  const problems = toImport.filter((r) => r.action === 'create' && r.kind === 'transfer' && !r.transferAccountId);
  const uncategorised = toImport.filter((r) => r.action === 'create' && r.kind !== 'transfer' && !r.categoryId);

  async function commit() {
    if (!preview || !accountId) return;
    if (problems.length) return setError(`Choose the other account for ${problems.length} transfer${problems.length === 1 ? '' : 's'}`);
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ created: number; matched: number; skipped: number; rulesCreated: number }>('/api/import/commit', {
        accountId, filename: file?.name, presetId: preview.presetId,
        anchor: useAnchor ? preview.anchor : null,
        rows: rows.filter((r) => r.status !== 'error' && r.date && r.amount !== null && r.hash).map((r) => ({
          index: r.index, date: r.date, description: r.description, bankDescription: r.bankDescription, amount: r.amount, hash: r.hash,
          action: r.action, kind: r.kind, categoryId: r.kind === 'transfer' ? null : r.categoryId, transferAccountId: r.kind === 'transfer' ? r.transferAccountId : null,
          matchTransactionId: r.match?.transactionId ?? null, matchPostingId: r.match?.postingId ?? null, remember: !!r.remember, status: r.status,
        })),
      });
      setResult(res);
      setPreview(null);
      setFile(null);
      toast(`Imported ${res.created} new, linked ${res.matched}`);
      refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const visible = useMemo(() => rows.filter((r) => {
    if (filter === 'attention') return r.touched || r.status === 'error' || (r.action === 'create' && ((r.kind === 'transfer' && !r.transferAccountId) || (r.kind !== 'transfer' && !r.categoryId))) || r.status === 'possible_duplicate' || r.status === 'transfer_match';
    if (filter === 'new') return r.status === 'new';
    if (filter === 'dupes') return r.status === 'duplicate' || r.status === 'possible_duplicate';
    return true;
  }), [rows, filter]);

  return (
    <div className="page">
      {!preview && (
        <Card>
          <div className="import-start">
            <div className="grid-2">
              <Field label="Import into">
                <AccountSelect value={accountId} onChange={(v) => { setAccountId(v); if (file) runPreview({ accountId: v }); }} />
              </Field>
              <Field label="File format">
                <select value={presetId} onChange={(e) => setPresetId(e.target.value)}>
                  <option value="">Detect automatically</option>
                  {meta.presets.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
              </Field>
            </div>
            <div
              className={`dropzone ${dragging ? 'on' : ''}`}
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => { e.preventDefault(); setDragging(false); onFile(e.dataTransfer.files[0]); }}
              onClick={() => inputRef.current?.click()}
              role="button" tabIndex={0}
            >
              <Icon name="upload" size={28} />
              <p><strong>Drop a CSV export here</strong> or click to choose a file</p>
              <p className="muted small">Lloyds, Amex, Chase and Starling export layouts are recognised automatically. Other layouts can be mapped by hand.</p>
              <input ref={inputRef} type="file" accept=".csv,text/csv" hidden onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
            </div>
            {file && !accountId && <p className="form-error">Choose which account this file is for.</p>}
            {busy && <div className="loading" />}
            {error && <p className="form-error">{error}</p>}
            {result && (
              <div className="banner banner-good">
                <Icon name="check" size={16} />
                <span>Imported {result.created} new transactions, linked {result.matched} to existing ones, skipped {result.skipped}.{result.rulesCreated ? ` Created ${result.rulesCreated} rules.` : ''}</span>
                <button className="link-btn" onClick={() => navigate('/transactions')}>View transactions</button>
              </div>
            )}
          </div>
        </Card>
      )}

      {preview && (
        <>
          <Card>
            <div className="import-head">
              <div>
                <h2 className="import-title"><Icon name="file" size={18} /> {file?.name}</h2>
                <p className="muted small">
                  {preview.presetLabel} → {account?.name}
                  {preview.dateRange && <> · {shortDate(preview.dateRange.from)} to {shortDate(preview.dateRange.to)}</>}
                  {' · '}{rows.length} rows
                </p>
                {preview.presetNote && <p className="muted small">{preview.presetNote}</p>}
              </div>
              <div className="row gap">
                <label className="chip-toggle" title="Use this if spending shows as money in">
                  <input type="checkbox" checked={flip} onChange={(e) => { setFlip(e.target.checked); runPreview({ flip: e.target.checked, mapping: preview.presetId === 'custom' ? mapping : undefined }); }} />
                  Flip signs
                </label>
                <button className="btn" onClick={() => { setPreview(null); setFile(null); }}>Cancel</button>
              </div>
            </div>

            {(!preview.mapping || preview.presetId === 'custom' || preview.presetId === null) && (
              <MappingEditor headers={preview.headers} mapping={mapping} onApply={(m) => { setMapping(m); runPreview({ mapping: m, presetId: 'custom' }); }} />
            )}

            <div className="import-chips">
              <Badge tone="good">{preview.summary.new} new</Badge>
              {preview.summary.transfer_match > 0 && <Badge tone="info">{preview.summary.transfer_match} matched transfers</Badge>}
              {preview.summary.possible_duplicate > 0 && <Badge tone="info">{preview.summary.possible_duplicate} match existing entries</Badge>}
              {preview.summary.duplicate > 0 && <Badge>{preview.summary.duplicate} already imported</Badge>}
              {preview.summary.error > 0 && <Badge tone="bad">{preview.summary.error} unreadable</Badge>}
            </div>

            {preview.anchor && (
              <label className="check">
                <input type="checkbox" checked={useAnchor} onChange={(e) => setUseAnchor(e.target.checked)} />
                <span>Set {account?.name} balance to <strong>{money(preview.anchor.balance)}</strong> at the end of {shortDate(preview.anchor.date)} (from the bank's balance column)</span>
              </label>
            )}
          </Card>

          <div className="toolbar">
            <div className="segmented">
              {([['all', 'All'], ['attention', 'Needs attention'], ['new', 'New'], ['dupes', 'Duplicates']] as const).map(([k, l]) => (
                <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{l}</button>
              ))}
            </div>
            <span className="spacer" />
            {uncategorised.length > 0 && <span className="muted small">{uncategorised.length} without a category (you can categorise later)</span>}
            <button className="btn btn-primary" disabled={busy || toImport.length === 0} onClick={commit}>
              <Icon name="check" size={16} /> Import {toImport.length} row{toImport.length === 1 ? '' : 's'}
            </button>
          </div>
          {error && <p className="form-error">{error}</p>}

          <section className="card">
            {visible.length === 0 ? <Empty icon="check" title="Nothing here" /> : (
              <table className="import-table">
                <thead>
                  <tr><th>Date</th><th>Description</th><th className="num">Amount</th><th>How to record it</th><th>Remember</th></tr>
                </thead>
                <tbody>
                  {visible.map((r) => <ImportRow key={r.index} r={r} accountId={accountId!} onChange={updateRow} source={r.filledFrom != null ? rows.find((x) => x.index === r.filledFrom) : undefined} />)}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}

      {!preview && <SkippedRows />}
      {!preview && <ImportHistory />}
    </div>
  );
}

function ImportRow({ r, accountId, onChange, source }: { r: Row; accountId: number; onChange: (index: number, patch: Partial<Row>, similar?: boolean) => void; source?: Row }) {
  const skipped = r.action === 'skip';
  if (r.status === 'error') {
    return <tr className="row-error"><td colSpan={5}><Icon name="alert" size={14} /> Row {r.index + 1}: {r.error}</td></tr>;
  }
  return (
    <tr className={skipped ? 'row-skipped' : ''}>
      <td className="nowrap">{r.date ? shortDate(r.date) : '—'}</td>
      <td>
        <input className="cell-input" value={r.description} onChange={(e) => onChange(r.index, { description: e.target.value })} disabled={r.action !== 'create'} aria-label="Description" />
        {r.bankDescription !== r.description && <div className="muted tiny" title={r.bankDescription}>{r.bankDescription.slice(0, 60)}</div>}
      </td>
      <td className={`num nowrap ${r.amount! > 0 ? 'amt-in' : ''}`}>{r.amount! > 0 ? money(r.amount!, { sign: true }) : money(-r.amount!)}</td>
      <td>
        {r.status === 'duplicate' && <span className="muted small"><Icon name="check" size={14} /> Already imported</span>}
        {r.status === 'possible_duplicate' && (
          <div className="match">
            <select value={r.action} onChange={(e) => onChange(r.index, { action: e.target.value as Action })}>
              <option value="link">Link to existing</option><option value="create">Import as new</option><option value="skip">Skip</option>
            </select>
            <span className="muted small">“{r.match?.description}” on {r.match && shortDate(r.match.date)}</span>
          </div>
        )}
        {r.status === 'transfer_match' && (
          <div className="match">
            <select value={r.action} onChange={(e) => onChange(r.index, { action: e.target.value as Action, kind: e.target.value === 'create' ? (r.amount! < 0 ? 'expense' : 'income') : 'transfer' })}>
              <option value="merge_transfer">Pair as one transfer</option><option value="create">Import separately</option><option value="skip">Skip</option>
            </select>
            <span className="muted small"><Icon name="link" size={12} /> {r.match?.accountName}: “{r.match?.description}” {r.match && shortDate(r.match.date)}</span>
          </div>
        )}
        {(r.status === 'new' || (r.action === 'create' && r.status !== 'duplicate')) && (
          <div className="treat">
            <select value={r.action === 'skip' ? 'skip' : r.kind} onChange={(e) => {
              const v = e.target.value;
              if (v === 'skip') onChange(r.index, { action: 'skip' });
              else onChange(r.index, { action: 'create', kind: v as Kind, categoryId: null, transferAccountId: null });
            }}>
              <option value="expense">{r.amount! < 0 ? 'Spending' : 'Refund'}</option>
              <option value="income">Income</option>
              <option value="transfer">Transfer</option>
              <option value="skip">Skip</option>
            </select>
            {!skipped && (r.kind === 'transfer' ? (
              <span className={!r.transferAccountId ? 'needs' : ''}>
                <AccountSelect value={r.transferAccountId} exclude={accountId} onChange={(v) => onChange(r.index, { transferAccountId: v })} />
              </span>
            ) : (
              <span className={!r.categoryId ? 'needs-soft' : ''}>
                <CategorySelect kind={r.kind as 'expense' | 'income'} value={r.categoryId} onChange={(v) => onChange(r.index, { categoryId: v, suggestionSource: r.suggestionSource }, true)} />
              </span>
            ))}
            {r.suggestionSource === 'rule' && <Badge tone="info">Rule</Badge>}
            {r.suggestionSource === 'history' && <Badge>Like last time</Badge>}
            {source && r.categoryId ? <span className="muted tiny" title="Copied from another row for the same place. Change that row to change them all, or this one to change only this row.">same as {source.date ? shortDate(source.date) : 'another row'}</span> : null}
          </div>
        )}
      </td>
      <td className="center">
        {r.action === 'create' && r.suggestionSource !== 'rule' && (r.categoryId || r.transferAccountId) ? (
          <input type="checkbox" checked={!!r.remember} onChange={(e) => onChange(r.index, { remember: e.target.checked })} aria-label="Remember for next time" title="Create a rule for this merchant" />
        ) : null}
      </td>
    </tr>
  );
}

function MappingEditor({ headers, mapping, onApply }: { headers: string[]; mapping: Mapping | null; onApply: (m: Mapping) => void }) {
  const [m, setM] = useState<Mapping>(mapping ?? { date: headers[0] ?? '', description: [headers[1] ?? ''], amount: headers[2] ?? '', dateFormat: 'DMY' });
  const [mode, setMode] = useState<'single' | 'split'>(mapping?.debit ? 'split' : 'single');
  const col = (value: string | undefined, set: (v: string) => void, label: string) => (
    <Field label={label}>
      <select value={value ?? ''} onChange={(e) => set(e.target.value)}>
        <option value="">—</option>
        {headers.map((h) => <option key={h} value={h}>{h}</option>)}
      </select>
    </Field>
  );
  return (
    <div className="mapping">
      <p className="small"><Icon name="info" size={14} /> This layout wasn't recognised. Tell me which columns to use:</p>
      <div className="grid-4">
        {col(m.date, (v) => setM({ ...m, date: v }), 'Date')}
        <Field label="Date format">
          <select value={m.dateFormat ?? 'DMY'} onChange={(e) => setM({ ...m, dateFormat: e.target.value as Mapping['dateFormat'] })}>
            <option value="DMY">31/12/2026</option><option value="YMD">2026-12-31</option><option value="MDY">12/31/2026</option>
          </select>
        </Field>
        {col(m.description[0], (v) => setM({ ...m, description: [v] }), 'Description')}
        <Field label="Amounts">
          <select value={mode} onChange={(e) => setMode(e.target.value as 'single' | 'split')}>
            <option value="single">One amount column</option><option value="split">Money out / money in columns</option>
          </select>
        </Field>
        {mode === 'single' ? (
          <>
            {col(m.amount, (v) => setM({ ...m, amount: v, debit: undefined, credit: undefined }), 'Amount')}
            <label className="check"><input type="checkbox" checked={!!m.invert} onChange={(e) => setM({ ...m, invert: e.target.checked })} /><span>Spending is shown as positive</span></label>
          </>
        ) : (
          <>
            {col(m.debit, (v) => setM({ ...m, debit: v, amount: undefined }), 'Money out')}
            {col(m.credit, (v) => setM({ ...m, credit: v, amount: undefined }), 'Money in')}
          </>
        )}
        {col(m.balance, (v) => setM({ ...m, balance: v || undefined }), 'Balance (optional)')}
      </div>
      <button className="btn" onClick={() => onApply(m)}>Apply columns</button>
    </div>
  );
}

function ImportHistory() {
  const { refresh, toast } = useApp();
  const { data } = useData<ImportRecord[]>(() => api.get('/api/imports'), []);
  const [confirm, confirmNode] = useConfirm();
  if (!data || data.length === 0) return null;
  async function undo(b: ImportRecord) {
    if (!(await confirm(`Undo this import? The ${b.created} transactions it created will be deleted. Rows it linked to existing transactions stay linked.`))) return;
    await api.del(`/api/imports/${b.id}`);
    toast('Import undone');
    refresh();
  }
  return (
    <Card title="Recent imports" pad={false}>
      <ul className="cat-manage">
        {data.map((b) => (
          <li key={b.id}>
            <Icon name="file" size={16} />
            <span className="grow">{b.filename ?? 'Import'} <span className="muted small">→ {b.accountName}</span></span>
            <span className="muted small">{b.created} new · {b.matched} linked · {b.skipped} skipped · {new Date(b.importedAt + 'Z').toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</span>
            {b.created > 0 && <button className="btn btn-sm" onClick={() => undo(b)}><Icon name="undo" size={14} /> Undo</button>}
          </li>
        ))}
      </ul>
      {confirmNode}
    </Card>
  );
}

interface SkippedRow { id: number; batchId: number; accountId: number; accountName: string; filename: string | null; date: string; description: string; bankDescription: string; amount: number; reason: 'skipped' | 'possible_duplicate' }

/** Rows skipped during imports, with a way to bring them back. */
function SkippedRows() {
  const { refresh, toast } = useApp();
  const { data } = useData<SkippedRow[]>(() => api.get('/api/skipped'), []);
  const [restoring, setRestoring] = useState<SkippedRow | null>(null);
  const [showAll, setShowAll] = useState(false);
  if (!data || data.length === 0) return null;
  async function dismiss(s: SkippedRow) {
    await api.del(`/api/skipped/${s.id}`);
    toast('Removed from the list');
    refresh();
  }
  const shown = showAll ? data : data.slice(0, 8);
  return (
    <Card title={`Skipped rows (${data.length})`} pad={false} action={<span className="muted small">Not in your transactions. Bring one back if you skipped it by mistake.</span>}>
      <ul className="cat-manage">
        {shown.map((s) => (
          <li key={s.id}>
            <span className="muted small" style={{ minWidth: 86 }}>{shortDate(s.date)}</span>
            <span className="grow">
              {s.description}
              <span className="muted small"> · {s.accountName}{s.filename ? ` · ${s.filename}` : ''}</span>
              {s.reason === 'possible_duplicate' && <> <Badge tone="warn">Looked like a duplicate</Badge></>}
            </span>
            <Money value={s.amount} className={s.amount > 0 ? 'amt-in' : ''} />
            <button className="btn btn-sm" onClick={() => setRestoring(s)}><Icon name="undo" size={14} /> Restore</button>
            <button className="icon-btn" onClick={() => dismiss(s)} aria-label={`Remove ${s.description} from this list`} title="Remove from this list"><Icon name="x" size={16} /></button>
          </li>
        ))}
      </ul>
      {data.length > 8 && <div style={{ padding: '0 20px 14px' }}><button className="link-btn" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show fewer' : `Show all ${data.length}`}</button></div>}
      {restoring && <RestoreModal row={restoring} onClose={() => setRestoring(null)} />}
    </Card>
  );
}

function RestoreModal({ row, onClose }: { row: SkippedRow; onClose: () => void }) {
  const { refresh, toast } = useApp();
  const [kind, setKind] = useState<Kind>(row.amount < 0 ? 'expense' : 'income');
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [transferAccountId, setTransfer] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    try {
      await api.post(`/api/skipped/${row.id}/restore`, { kind, categoryId: kind === 'transfer' ? null : categoryId, transferAccountId: kind === 'transfer' ? transferAccountId : null });
      toast('Added to your transactions');
      refresh();
      onClose();
    } catch (e: any) { setError(e.message); }
  }
  return (
    <Modal title="Restore skipped row" onClose={onClose}
      footer={<><span className="spacer" /><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={save}>Add to transactions</button></>}>
      <div className="form">
        <p><strong>{row.description}</strong> <span className="muted">· {shortDate(row.date)} · {row.accountName}</span> · <Money value={row.amount} /></p>
        <Field label="Type">
          <Segmented<Kind> value={kind} onChange={setKind} options={[{ value: 'expense', label: 'Spending' }, { value: 'income', label: 'Income' }, { value: 'transfer', label: 'Transfer or repayment' }]} />
        </Field>
        {kind === 'transfer'
          ? <Field label="Other account"><AccountSelect value={transferAccountId} onChange={setTransfer} filter={(a) => a.id !== row.accountId} /></Field>
          : <Field label="Category"><CategorySelect kind={kind} value={categoryId} onChange={setCategoryId} noneLabel="Leave uncategorised" /></Field>}
        {error && <p className="form-error">{error}</p>}
      </div>
    </Modal>
  );
}
