import React, { useMemo, useState } from 'react';
import { api, type Transaction } from '../api.ts';
import { parseAmount, penceToInput, monthLabel, addMonths, looksLikeTransfer } from '../format.ts';
import { AccountSelect, CategorySelect, Field, Modal, Segmented, useApp, useConfirm } from './ui.tsx';
import { Icon } from './Icon.tsx';

type Mode = 'expense' | 'income' | 'transfer' | 'repayment';

const LAST_ACCOUNT_KEY = 'finance.lastAccount';

function fromTransaction(t: Transaction | null, accounts: { id: number; isLiability: boolean }[]) {
  if (!t) return null;
  if (t.kind === 'transfer') {
    const out = t.postings.find((p) => p.amount < 0)!;
    const inn = t.postings.find((p) => p.amount > 0)!;
    const toLiab = accounts.find((a) => a.id === inn.accountId)?.isLiability;
    return { mode: (toLiab ? 'repayment' : 'transfer') as Mode, accountId: out.accountId, toAccountId: inn.accountId, amount: inn.amount, refund: false, categoryId: null };
  }
  const p = t.postings[0];
  const refund = t.kind === 'expense' ? p.amount > 0 : p.amount < 0;
  return { mode: t.kind as Mode, accountId: p.accountId, toAccountId: null, amount: Math.abs(p.amount), refund, categoryId: p.categoryId };
}

export function TransactionForm({ transaction, onClose, defaults }: {
  transaction?: Transaction | null; onClose: () => void; defaults?: { accountId?: number | null };
}) {
  const { accounts, categories, meta, refresh, toast } = useApp();
  const [confirm, confirmNode] = useConfirm();
  const existing = useMemo(() => fromTransaction(transaction ?? null, accounts), [transaction, accounts]);
  const isSplit = !!transaction && transaction.kind !== 'transfer' && transaction.postings.length > 1;

  const lastAccount = Number(localStorageGet(LAST_ACCOUNT_KEY)) || null;
  const [mode, setMode] = useState<Mode>(existing?.mode ?? 'expense');
  const [amount, setAmount] = useState(existing ? penceToInput(existing.amount) : '');
  const [description, setDescription] = useState(transaction?.description ?? '');
  const [date, setDate] = useState(transaction?.date ?? meta.today);
  const [accountId, setAccountId] = useState<number | null>(existing?.accountId ?? defaults?.accountId ?? (accounts.some((a) => a.id === lastAccount) ? lastAccount : accounts[0]?.id ?? null));
  const [toAccountId, setToAccountId] = useState<number | null>(existing?.toAccountId ?? null);
  const [categoryId, setCategoryId] = useState<number | null>(existing?.categoryId ?? null);
  const [refund, setRefund] = useState(existing?.refund ?? false);
  const [notes, setNotes] = useState(transaction?.notes ?? '');
  const [period, setPeriod] = useState<string>(transaction && transaction.period !== transaction.date.slice(0, 7) ? transaction.period : '');
  const [showMore, setShowMore] = useState(!!period || !!transaction?.notes);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const isTransfer = mode === 'transfer' || mode === 'repayment';
  const month = date.slice(0, 7);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const pence = parseAmount(amount);
    if (!pence) return setError('Enter an amount greater than £0.00');
    if (!description.trim()) return setError('Add a description');
    if (!accountId) return setError('Choose an account');
    if (isTransfer && !toAccountId) return setError(mode === 'repayment' ? 'Choose the card or loan you paid' : 'Choose where the money went');
    const body = {
      kind: isTransfer ? 'transfer' : mode,
      date, description: description.trim(), accountId, amount: pence,
      toAccountId: isTransfer ? toAccountId : null,
      categoryId: isTransfer ? null : categoryId,
      refund: isTransfer ? false : refund,
      notes: notes.trim() || null,
      period: period || null,
    };
    setSaving(true);
    try {
      if (transaction) await api.put(`/api/transactions/${transaction.id}`, body);
      else await api.post('/api/transactions', body);
      localStorageSet(LAST_ACCOUNT_KEY, String(accountId));
      toast(transaction ? 'Transaction updated' : 'Transaction added');
      refresh();
      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!transaction) return;
    if (!(await confirm('This transaction will be deleted and balances recalculated.'))) return;
    try {
      await api.del(`/api/transactions/${transaction.id}`);
      toast('Transaction deleted');
      refresh();
      onClose();
    } catch (err: any) {
      setError(err.message);
    }
  }

  if (isSplit) {
    return (
      <Modal title="Split transaction" onClose={onClose}>
        <p className="muted">This transaction is split across categories. Split editing arrives in a later phase; you can delete and re-enter it for now.</p>
      </Modal>
    );
  }

  return (
    <Modal
      title={transaction ? 'Edit transaction' : 'Add transaction'}
      onClose={onClose}
      footer={
        <>
          {transaction && <button type="button" className="btn btn-ghost-danger" onClick={remove}><Icon name="trash" size={16} /> Delete</button>}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form="txn-form" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        </>
      }
    >
      <form id="txn-form" onSubmit={save} className="form">
        <Segmented<Mode>
          value={mode}
          onChange={(m) => { setMode(m); setCategoryId(null); if (m === 'repayment') setToAccountId(null); }}
          options={[
            { value: 'expense', label: 'Expense' },
            { value: 'income', label: 'Income' },
            { value: 'transfer', label: 'Transfer' },
            { value: 'repayment', label: 'Debt repayment' },
          ]}
        />
        {isTransfer && (
          <p className="hint-box"><Icon name="info" size={16} />
            {mode === 'repayment'
              ? 'Paying off a card or loan reduces what you owe. It is not counted as spending; the purchases already were.'
              : 'Moving money between your own accounts (including into savings) is not counted as income or spending.'}
          </p>
        )}
        <div className="amount-input">
          <span>£</span>
          <input inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount" autoFocus />
        </div>
        <Field label="Description">
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={mode === 'income' ? 'ACME Ltd salary' : mode === 'repayment' ? 'Credit card payment' : isTransfer ? 'Monthly savings' : 'Supermarket'} />
        </Field>
        <div className="grid-2">
          <Field label="Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></Field>
          <Field label={isTransfer ? 'From' : mode === 'income' ? 'Paid into' : 'Paid with'}>
            <AccountSelect value={accountId} onChange={setAccountId} filter={isTransfer ? (a) => !a.isLiability || mode === 'transfer' : undefined} />
          </Field>
        </div>
        {isTransfer ? (
          <Field label={mode === 'repayment' ? 'Card or loan paid' : 'To'}>
            <AccountSelect value={toAccountId} onChange={setToAccountId} exclude={accountId} filter={mode === 'repayment' ? (a) => a.isLiability : (a) => !a.isLiability} />
          </Field>
        ) : (
          <Field label="Category">
            <CategorySelect kind={mode as 'expense' | 'income'} value={categoryId} onChange={setCategoryId} />
          </Field>
        )}
        {mode === 'expense' && categoryId != null && looksLikeTransfer(categories.find((c) => c.id === categoryId)?.name ?? '') && (
          <p className="hint-box hint-warn"><Icon name="alert" size={16} />
            <span>This would count as <strong>spending</strong>. If it's paying off a card or loan, use <button type="button" className="link-btn" onClick={() => { setMode('repayment'); setCategoryId(null); }}>Debt repayment</button>. If it's money to another of your own accounts, use <button type="button" className="link-btn" onClick={() => { setMode('transfer'); setCategoryId(null); }}>Transfer</button>. Paying a friend back? Add what you owe them under Debts, then record it as a debt repayment.</span></p>
        )}
        {!isTransfer && (
          <label className="check">
            <input type="checkbox" checked={refund} onChange={(e) => setRefund(e.target.checked)} />
            <span>{mode === 'expense' ? 'This is a refund (money back, reduces spending)' : 'This is a reversal (money taken back)'}</span>
          </label>
        )}
        {!showMore ? (
          <button type="button" className="link-btn" onClick={() => setShowMore(true)}>Add notes or change the month it counts towards</button>
        ) : (
          <>
            <Field label="Notes"><textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
            <Field label="Counts towards" hint="Salary paid in the last few days of a month automatically counts towards the next month.">
              <select value={period} onChange={(e) => setPeriod(e.target.value)}>
                <option value="">Automatic</option>
                {[-1, 0, 1].map((n) => {
                  const m = addMonths(month, n);
                  return <option key={m} value={m}>{monthLabel(m)}</option>;
                })}
              </select>
            </Field>
          </>
        )}
        {error && <p className="form-error">{error}</p>}
      </form>
      {confirmNode}
    </Modal>
  );
}

function localStorageGet(k: string): string | null {
  try { return localStorage.getItem(k); } catch { return null; }
}
function localStorageSet(k: string, v: string) {
  try { localStorage.setItem(k, v); } catch { /* ignore */ }
}
