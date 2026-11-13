import React, { useState } from 'react';
import { api } from '../api.ts';
import { Card, CategorySelect, useApp } from './ui.tsx';

export interface RuleSuggestion { merchant: string; pattern: string; categoryId: number; categoryName: string; colour: string; icon: string | null; kind: 'expense' | 'income'; visits: number; share: number; uncategorised: number; last: string }
export interface RuleRow { id: number; pattern: string; account_id: number | null; category_id: number | null; category_name: string | null; category_colour: string | null }

/** Places you visit often and always file the same way, offered as rules for future imports. */
export function SuggestedRules({ list, onDone }: { list: RuleSuggestion[]; onDone: () => void }) {
  const { refresh, toast } = useApp();
  const [on, setOn] = useState<Set<string>>(() => new Set(list.map((s) => s.pattern)));
  const [cats, setCats] = useState<Record<string, number>>(() => Object.fromEntries(list.map((s) => [s.pattern, s.categoryId])));
  const [fillIn, setFillIn] = useState(true);
  const [open, setOpen] = useState(list.length <= 6);
  const [busy, setBusy] = useState(false);
  const shown = open ? list : list.slice(0, 6);
  const picked = list.filter((s) => on.has(s.pattern));
  const fills = picked.reduce((t, s) => t + s.uncategorised, 0);
  async function create() {
    setBusy(true);
    try {
      const r = await api.post<{ created: number; filled: number }>('/api/rules/bulk', { items: picked.map((s) => ({ pattern: s.pattern, categoryId: cats[s.pattern] })), fillIn });
      toast(`Created ${r.created} rule${r.created === 1 ? '' : 's'}${r.filled ? ` and categorised ${r.filled} past transaction${r.filled === 1 ? '' : 's'}` : ''}`);
      refresh();
      onDone();
    } catch (e: any) { toast(e.message, 'error'); } finally { setBusy(false); }
  }
  return (
    <Card title={`Suggested rules (${list.length})`} pad={false}
      action={<span className="muted small">Places you visit often and always put in the same category. Future imports will be filed automatically.</span>}>
      <ul className="rule-suggest">
        {shown.map((s) => (
          <li key={s.pattern}>
            <input type="checkbox" checked={on.has(s.pattern)} aria-label={`Make a rule for ${s.merchant}`}
              onChange={() => setOn((x) => { const n = new Set(x); n.has(s.pattern) ? n.delete(s.pattern) : n.add(s.pattern); return n; })} />
            <span className="grow">
              <strong>{s.merchant}</strong>
              <span className="muted small">{s.visits} visits · {Math.round(s.share * 100)}% already in {s.categoryName}{s.uncategorised ? ` · ${s.uncategorised} without a category` : ''}</span>
              <span className="muted small rule-pattern">Matches anything containing “{s.pattern}”</span>
            </span>
            <span className="rule-arrow">→</span>
            <CategorySelect kind={s.kind} value={cats[s.pattern]} allowNone={false} onChange={(v) => v && setCats((c) => ({ ...c, [s.pattern]: v }))} />
          </li>
        ))}
      </ul>
      <div className="rule-suggest-foot">
        {list.length > 6 && <button className="link-btn small" onClick={() => setOpen(!open)}>{open ? 'Show fewer' : `Show all ${list.length}`}</button>}
        <label className="check small"><input type="checkbox" checked={fillIn} onChange={(e) => setFillIn(e.target.checked)} /> Also fill in past transactions without a category{fills ? ` (${fills})` : ''}</label>
        <span className="spacer" />
        <button className="btn btn-primary" disabled={!picked.length || busy} onClick={create}>Create {picked.length} rule{picked.length === 1 ? '' : 's'}</button>
      </div>
    </Card>
  );
}

