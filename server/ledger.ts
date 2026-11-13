import { type DB, tx, getSetting } from './db.ts';
import { assertPence, ValidationError, type Pence } from './money.ts';
import { isIsoDate, monthOf, addMonths, daysInMonth } from './dates.ts';

export type Kind = 'expense' | 'income' | 'transfer';

export const ASSET_TYPES = ['current', 'savings', 'cash', 'pot', 'investment', 'other_asset'] as const;
export const LIABILITY_TYPES = ['credit_card', 'loan', 'other_liability'] as const;
export const ACCOUNT_TYPES = [...ASSET_TYPES, ...LIABILITY_TYPES] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export function isLiability(type: string): boolean {
  return (LIABILITY_TYPES as readonly string[]).includes(type);
}

export interface PostingInput {
  accountId: number;
  /** Signed pence: + money into the account, - money out of it. */
  amount: Pence;
  categoryId?: number | null;
  importHash?: string | null;
  bankDescription?: string | null;
}

export interface TransactionInput {
  date: string;
  description: string;
  kind: Kind;
  notes?: string | null;
  /** Override the month this transaction counts towards (YYYY-MM). */
  period?: string | null;
  postings: PostingInput[];
  importBatchId?: number | null;
}

/**
 * Friendlier shape used by the UI.
 *  - expense: amount is what you spent (positive). Set refund=true for money back.
 *  - income:  amount received (positive).
 *  - transfer: amount moved from accountId to toAccountId (positive). Paying a
 *    credit card or putting money in savings is a transfer.
 */
export interface SimpleTransactionInput {
  date: string;
  description: string;
  kind: Kind;
  accountId: number;
  amount: Pence;
  categoryId?: number | null;
  toAccountId?: number | null;
  refund?: boolean;
  notes?: string | null;
  period?: string | null;
}

export function simpleToPostings(input: SimpleTransactionInput): TransactionInput {
  const amount = assertPence(input.amount);
  if (amount <= 0) throw new ValidationError('Amount must be greater than zero');
  const base = {
    date: input.date,
    description: input.description,
    kind: input.kind,
    notes: input.notes ?? null,
    period: input.period ?? null,
  };
  switch (input.kind) {
    case 'expense':
      return {
        ...base,
        postings: [{ accountId: input.accountId, amount: input.refund ? amount : -amount, categoryId: input.categoryId ?? null }],
      };
    case 'income':
      return {
        ...base,
        postings: [{ accountId: input.accountId, amount: input.refund ? -amount : amount, categoryId: input.categoryId ?? null }],
      };
    case 'transfer':
      if (!input.toAccountId) throw new ValidationError('Choose the account the money is going to');
      return {
        ...base,
        postings: [
          { accountId: input.accountId, amount: -amount },
          { accountId: input.toAccountId, amount },
        ],
      };
    default:
      throw new ValidationError('Unknown transaction type');
  }
}

interface AccountRow { id: number; type: string; archived: number; name: string }
interface CategoryRow { id: number; kind: string; roll_forward: number }

function validate(db: DB, input: TransactionInput) {
  if (!isIsoDate(input.date)) throw new ValidationError('Date must be a valid YYYY-MM-DD date');
  if (typeof input.description !== 'string' || input.description.trim() === '') {
    throw new ValidationError('Description is required');
  }
  if (!['expense', 'income', 'transfer'].includes(input.kind)) throw new ValidationError('Unknown transaction type');
  if (input.period != null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(input.period)) {
    throw new ValidationError('Period must be YYYY-MM');
  }
  if (!Array.isArray(input.postings) || input.postings.length === 0) {
    throw new ValidationError('A transaction needs at least one posting');
  }

  const getAcc = db.prepare('SELECT id, type, archived, name FROM accounts WHERE id = ?');
  const getCat = db.prepare('SELECT id, kind, roll_forward FROM categories WHERE id = ?');
  for (const p of input.postings) {
    assertPence(p.amount);
    if (p.amount === 0) throw new ValidationError('Amounts cannot be zero');
    const acc = getAcc.get(p.accountId) as AccountRow | undefined;
    if (!acc) throw new ValidationError(`Account ${p.accountId} does not exist`);
    if (p.categoryId != null) {
      const cat = getCat.get(p.categoryId) as CategoryRow | undefined;
      if (!cat) throw new ValidationError(`Category ${p.categoryId} does not exist`);
      if (input.kind === 'transfer') throw new ValidationError('Transfers cannot have a category — they are not income or spending');
      if (cat.kind !== input.kind) throw new ValidationError(`That is an ${cat.kind} category, but this is an ${input.kind}`);
    }
  }

  if (input.kind === 'transfer') {
    if (input.postings.length !== 2) throw new ValidationError('A transfer moves money between exactly two accounts');
    const [a, b] = input.postings;
    if (a.accountId === b.accountId) throw new ValidationError('A transfer needs two different accounts');
    if (a.amount + b.amount !== 0) throw new ValidationError('Transfer amounts must balance');
  } else {
    const accounts = new Set(input.postings.map((p) => p.accountId));
    if (accounts.size !== 1) throw new ValidationError('Split income/expenses must all come from one account');
  }
}

/** Work out the reporting month. Late-month salary funds next month. */
export function resolvePeriod(db: DB, input: TransactionInput): string {
  if (input.period) return input.period;
  const month = monthOf(input.date);
  if (input.kind !== 'income') return month;
  const days = parseInt(getSetting(db, 'rollforward_days', '5'), 10);
  if (!days) return month;
  const rolls = input.postings.some((p) => {
    if (p.categoryId == null || p.amount <= 0) return false;
    const c = db.prepare('SELECT roll_forward FROM categories WHERE id = ?').get(p.categoryId) as { roll_forward: number } | undefined;
    return c?.roll_forward === 1;
  });
  if (!rolls) return month;
  const day = parseInt(input.date.slice(8, 10), 10);
  return day > daysInMonth(month) - days ? addMonths(month, 1) : month;
}

export function normaliseMerchant(description: string): string {
  return description
    .toUpperCase()
    .replace(/\b(CARD PAYMENT TO|PAYMENT TO|DIRECT DEBIT TO|DD|SO|FPO|FPI|BGC|DEB|POS|CPT|VIS|CONTACTLESS|APPLEPAY|APPLE PAY|GOOGLE PAY)\b/g, ' ')
    .replace(/\bON \d{2}[A-Z]{3}\b/g, ' ')
    .replace(/\d{2}[\/\-]\d{2}([\/\-]\d{2,4})?/g, ' ')
    .replace(/[*#]/g, ' ')
    .replace(/\b[A-Z0-9]*\d[A-Z0-9]{5,}\b/g, ' ') // reference codes
    .replace(/\b(GB|GBR|UK|LONDON)\b/g, ' ')
    .replace(/[^A-Z0-9&' ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function createTransaction(db: DB, input: TransactionInput): number {
  validate(db, input);
  return tx(db, () => {
    const period = resolvePeriod(db, input);
    const res = db
      .prepare(
        'INSERT INTO transactions(date, period, description, merchant, kind, notes, import_batch_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        input.date,
        period,
        input.description.trim(),
        normaliseMerchant(input.description),
        input.kind,
        input.notes?.trim() || null,
        input.importBatchId ?? null,
      );
    const id = Number(res.lastInsertRowid);
    insertPostings(db, id, input.postings);
    return id;
  });
}

function insertPostings(db: DB, txnId: number, postings: PostingInput[]) {
  const ins = db.prepare(
    'INSERT INTO postings(transaction_id, account_id, amount, category_id, import_hash, bank_description) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const p of postings) {
    ins.run(txnId, p.accountId, p.amount, p.categoryId ?? null, p.importHash ?? null, p.bankDescription ?? null);
  }
}

/**
 * Replace a transaction's details and postings. Import hashes on existing
 * postings are kept (matched by account) so re-importing the same CSV still
 * detects duplicates after you edit something.
 */
export function updateTransaction(db: DB, id: number, input: TransactionInput) {
  validate(db, input);
  tx(db, () => {
    const existing = db.prepare('SELECT id FROM transactions WHERE id = ?').get(id);
    if (!existing) throw new ValidationError('Transaction not found');
    const oldPostings = db
      .prepare('SELECT account_id, import_hash, bank_description FROM postings WHERE transaction_id = ?')
      .all(id) as { account_id: number; import_hash: string | null; bank_description: string | null }[];
    const period = resolvePeriod(db, input);
    db.prepare(
      "UPDATE transactions SET date = ?, period = ?, description = ?, merchant = ?, kind = ?, notes = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(input.date, period, input.description.trim(), normaliseMerchant(input.description), input.kind, input.notes?.trim() || null, id);
    db.prepare('DELETE FROM postings WHERE transaction_id = ?').run(id);
    const postings = input.postings.map((p) => {
      const old = oldPostings.find((o) => o.account_id === p.accountId && o.import_hash);
      return {
        ...p,
        importHash: p.importHash ?? old?.import_hash ?? null,
        bankDescription: p.bankDescription ?? old?.bank_description ?? null,
      };
    });
    insertPostings(db, id, postings);
  });
}

export function deleteTransaction(db: DB, id: number) {
  const res = db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
  if (res.changes === 0) throw new ValidationError('Transaction not found');
}

/**
 * Merge two single-sided transactions (e.g. an imported "CARD PAYMENT" debit on
 * the current account and the matching "PAYMENT RECEIVED" credit on the card) into one
 * transfer. This is what stops a card repayment being counted twice.
 */
export function mergeIntoTransfer(db: DB, outId: number, inId: number): number {
  return tx(db, () => {
    const getP = db.prepare('SELECT * FROM postings WHERE transaction_id = ?');
    const outP = getP.all(outId) as any[];
    const inP = getP.all(inId) as any[];
    if (outP.length !== 1 || inP.length !== 1) throw new ValidationError('Can only merge single-account transactions');
    const [o, i] = [outP[0], inP[0]];
    if (o.amount >= 0 || i.amount <= 0 || o.amount + i.amount !== 0) {
      throw new ValidationError('Amounts must be equal and opposite to merge into a transfer');
    }
    if (o.account_id === i.account_id) throw new ValidationError('Both sides are on the same account');
    const outTxn = db.prepare('SELECT * FROM transactions WHERE id = ?').get(outId) as any;
    db.prepare("UPDATE transactions SET kind = 'transfer', period = ?, updated_at = datetime('now') WHERE id = ?").run(
      monthOf(outTxn.date),
      outId,
    );
    db.prepare('UPDATE postings SET category_id = NULL WHERE transaction_id = ?').run(outId);
    db.prepare('UPDATE postings SET transaction_id = ?, category_id = NULL WHERE id = ?').run(outId, i.id);
    db.prepare('DELETE FROM transactions WHERE id = ?').run(inId);
    return outId;
  });
}
