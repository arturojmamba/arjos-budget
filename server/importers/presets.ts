import { parseMoney } from '../money.ts';
import { parseBankDate } from '../dates.ts';

/**
 * Column mapping for a bank's CSV export.
 * Amount conventions differ by bank, so every mapping is normalised to:
 *   amount > 0 → money INTO the account (or debt going DOWN on a card)
 *   amount < 0 → money OUT of the account (or debt going UP on a card)
 */
export interface Mapping {
  date: string;
  dateFormat?: 'DMY' | 'YMD' | 'MDY';
  description: string[];
  /** Single signed amount column. */
  amount?: string;
  /** Set when the bank shows purchases as positive numbers (typical for credit cards). */
  invert?: boolean;
  /** Separate money-out / money-in columns. */
  debit?: string;
  credit?: string;
  balance?: string;
  /** Extra columns kept in the bank description for reference (not used in matching). */
  extra?: string[];
}

export interface Preset {
  id: string;
  label: string;
  /** Header names that identify this export (case-insensitive). */
  signature: string[];
  mapping: Mapping;
  note?: string;
}

export const PRESETS: Preset[] = [
  {
    id: 'lloyds_current',
    label: 'Lloyds current account',
    signature: ['transaction date', 'transaction type', 'sort code', 'transaction description', 'debit amount', 'credit amount'],
    mapping: {
      date: 'Transaction Date',
      description: ['Transaction Description'],
      debit: 'Debit Amount',
      credit: 'Credit Amount',
      balance: 'Balance',
      extra: ['Transaction Type'],
    },
  },
  {
    id: 'lloyds_credit_card',
    label: 'Lloyds credit card',
    signature: ['date', 'date entered', 'reference', 'description', 'amount'],
    mapping: { date: 'Date', description: ['Description'], amount: 'Amount', invert: true, extra: ['Reference'] },
    note: 'Purchases are shown as positive amounts in Lloyds card exports.',
  },
  {
    id: 'amex',
    label: 'American Express',
    signature: ['date', 'description', 'amount'],
    mapping: {
      date: 'Date',
      description: ['Description'],
      amount: 'Amount',
      invert: true,
      extra: ['Appears On Your Statement As', 'Category', 'Card Member'],
    },
    note: 'Amex shows purchases as positive amounts and payments as negative.',
  },
  {
    id: 'starling',
    label: 'Starling',
    signature: ['date', 'counter party', 'reference', 'type', 'amount (gbp)'],
    mapping: {
      date: 'Date',
      description: ['Counter Party'],
      amount: 'Amount (GBP)',
      balance: 'Balance (GBP)',
      extra: ['Reference', 'Type', 'Spending Category'],
    },
  },
  {
    id: 'chase',
    label: 'Chase UK',
    signature: ['date', 'transaction description', 'amount'],
    mapping: { date: 'Date', description: ['Transaction Description'], amount: 'Amount', balance: 'Balance' },
    note: 'Best-guess layout — check the preview and adjust the columns if needed.',
  },
];

const norm = (s: string) => s.trim().toLowerCase();

/** Pick the preset whose signature columns best match the CSV headers. */
export function detectPreset(headers: string[], institution?: string | null): Preset | null {
  const set = new Set(headers.map(norm));
  const inst = (institution ?? '').toLowerCase();
  let best: { preset: Preset; score: number } | null = null;
  for (const p of PRESETS) {
    const hits = p.signature.filter((h) => set.has(h)).length;
    if (hits < p.signature.length) continue; // require every signature column
    let score = hits * 10 - (set.size - hits); // prefer the tightest fit
    // Prefer the preset for the bank this account belongs to.
    const bank = p.label.toLowerCase().split(' ')[0];
    if (inst && (inst.includes(bank) || (bank === 'american' && inst.includes('amex')))) score += 5;
    if (!best || score > best.score) best = { preset: p, score };
  }
  return best?.preset ?? null;
}

/** Best-effort mapping for an unknown export, by looking at header names. */
export function guessMapping(headers: string[]): Mapping | null {
  const find = (...needles: RegExp[]) => headers.find((h) => needles.some((n) => n.test(h)));
  const date = find(/^(transaction )?date$/i, /date/i);
  const description = find(/description|narrative|details|merchant|payee|counter ?party|name/i);
  const debit = find(/debit|paid out|money out|withdrawal/i);
  const credit = find(/credit|paid in|money in|deposit/i);
  const amount = find(/^amount/i, /amount|value/i);
  const balance = find(/balance/i);
  if (!date || !description) return null;
  if (debit && credit) return { date, description: [description], debit, credit, balance };
  if (amount) return { date, description: [description], amount, balance };
  return null;
}

/** Find the header row — some banks put account info lines above it. */
export function findHeaderRow(rows: string[][]): number {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const cells = rows[i].map(norm);
    if (cells.some((c) => c.includes('date')) && cells.some((c) => /amount|debit|credit|paid|value/.test(c))) return i;
  }
  return 0;
}

export interface RawRow {
  index: number;
  date: string | null;
  description: string;
  bankDescription: string;
  amount: number | null;
  balance: number | null;
  error?: string;
}

export function applyMapping(headers: string[], rows: string[][], mapping: Mapping, flip = false): RawRow[] {
  const col = (name?: string) => (name ? headers.findIndex((h) => norm(h) === norm(name)) : -1);
  const iDate = col(mapping.date);
  const iDesc = mapping.description.map(col).filter((i) => i >= 0);
  const iAmount = col(mapping.amount);
  const iDebit = col(mapping.debit);
  const iCredit = col(mapping.credit);
  const iBalance = col(mapping.balance);
  const iExtra = (mapping.extra ?? []).map(col).filter((i) => i >= 0);
  if (iDate < 0) throw new Error(`Column "${mapping.date}" not found`);
  if (iDesc.length === 0) throw new Error('Description column not found');
  if (iAmount < 0 && (iDebit < 0 || iCredit < 0)) throw new Error('Amount column(s) not found');

  return rows.map((r, index) => {
    const description = iDesc.map((i) => r[i] ?? '').filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    const extras = iExtra.map((i) => r[i]).filter(Boolean);
    const date = parseBankDate(r[iDate] ?? '', mapping.dateFormat ?? 'DMY');
    let amount: number | null;
    if (iAmount >= 0) {
      amount = parseMoney(r[iAmount]);
      if (amount !== null && mapping.invert) amount = -amount;
    } else {
      const out = parseMoney(r[iDebit] || '0') ?? 0;
      const inn = parseMoney(r[iCredit] || '0') ?? 0;
      amount = (r[iDebit] || r[iCredit]) ? inn - Math.abs(out) : null;
    }
    if (amount !== null && flip) amount = -amount;
    const balance = iBalance >= 0 && r[iBalance] ? parseMoney(r[iBalance]) : null;
    const row: RawRow = {
      index,
      date,
      description: description || '(no description)',
      bankDescription: [description, ...extras].join(' | '),
      amount: amount === 0 ? null : amount,
      balance,
    };
    if (!date) row.error = `Unrecognised date "${r[iDate] ?? ''}"`;
    else if (amount === null) row.error = 'No amount';
    else if (amount === 0) row.error = 'Zero amount';
    return row;
  });
}
