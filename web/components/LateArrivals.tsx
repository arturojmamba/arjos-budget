/**
 * Transactions that came in after you confirmed an account's balance but are dated on or before it
 * (usually card charges that were still pending). You choose whether that balance already had them.
 */
import React, { useState } from 'react';
import { api } from '../api.ts';
import { money, shortDate } from '../format.ts';
import { useApp } from './ui.tsx';

export interface LateItem { postingId: number; transactionId: number; date: string; description: string; amount: number }

export function LateArrivals({ accountId, name, isLiability, confirmedOn, items }: {
  accountId: number; name: string; isLiability: boolean; confirmedOn: string; items: LateItem[];
}) {
  const { refresh, toast } = useApp();
  const [busy, setBusy] = useState(false);
  if (!items.length) return null;
  const total = items.reduce((s, u) => s + u.amount, 0);
  const one = items.length === 1;
  // What counting them does, in the account's own terms.
  const effect = isLiability
    ? (total < 0 ? `${money(-total)} more owed` : `${money(total)} less owed`)
    : (total < 0 ? `${money(-total)} less` : `${money(total)} more`);
  async function review(apply: boolean) {
    setBusy(true);
    try {
      await api.post(`/api/debts/${accountId}/review`, { postingIds: items.map((u) => u.postingId), apply });
      toast(apply ? `${name}: counted (${effect})` : `${name}: left as it is`);
      refresh();
    } catch (e: any) { toast(e.message, 'error'); } finally { setBusy(false); }
  }
  return (
    <div className="uncounted">
      <p className="small">
        <strong>{one ? `${money(Math.abs(total))} on ${shortDate(items[0].date)}` : `${items.length} transactions (${money(Math.abs(total))})`}</strong>{' '}
        {one ? 'is' : 'are'} dated on or before {shortDate(confirmedOn)}, when you confirmed {name}'s balance, but came in afterwards.
        This is usually a card charge that was still pending. Did that balance already include {one ? 'it' : 'them'}?
      </p>
      {!one && <ul className="small muted">{items.map((u) => <li key={u.postingId}>{shortDate(u.date)} · {u.description} · {money(u.amount, { sign: true })}</li>)}</ul>}
      {one && <p className="small muted">{items[0].description} · {money(items[0].amount, { sign: true })}</p>}
      <div className="row gap">
        <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => review(true)}>No, count {one ? 'it' : 'them'} ({effect})</button>
        <button className="btn btn-sm" disabled={busy} onClick={() => review(false)}>Yes, already included</button>
      </div>
    </div>
  );
}
