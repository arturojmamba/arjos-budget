import crypto from 'node:crypto';
import { type DB, tx } from '../db.ts';
import { ValidationError } from '../money.ts';
import { addDays, daysBetween, isIsoDate } from '../dates.ts';
import { createTransaction, isLiability, normaliseMerchant, type Kind } from '../ledger.ts';
import { parseCsv } from './csv.ts';
import { PRESETS, applyMapping, detectPreset, findHeaderRow, guessMapping, type Mapping, type RawRow } from './presets.ts';
import { loadRules, suggest } from './categorise.ts';
import { smartCategory } from './smart.ts';

const MATCH_WINDOW_DAYS = 4;

export type RowStatus = 'new' | 'duplicate' | 'possible_duplicate' | 'transfer_match' | 'error';
export type RowAction = 'create' | 'skip' | 'link' | 'merge_transfer';

export interface PreviewRow {
  index: number;
  date: string | null;
  description: string;
  bankDescription: string;
  amount: number | null;
  balance: number | null;
  hash: string | null;
  status: RowStatus;
  error?: string;
  /** Existing transaction this row duplicates / should link to / pairs with. */
  match?: { transactionId: number; postingId: number; date: string; description: string; accountName: string };
  action: RowAction;
  kind: Kind;
  categoryId: number | null;
  transferAccountId: number | null;
  suggestionSource: 'rule' | 'history' | 'smart' | 'match' | 'none';
  /** For smart suggestions: the word that matched (e.g. "mcdonald"). */
  smartMatch?: string;
}

export interface PreviewResult {
  presetId: string | null;
  presetLabel: string;
  presetNote?: string;
  mapping: Mapping | null;
  headers: string[];
  rows: PreviewRow[];
  anchor: { date: string; balance: number } | null;
  summary: Record<RowStatus, number>;
  dateRange: { from: string; to: string } | null;
}

export interface PreviewInput {
  accountId: number;
  csv: string;
  presetId?: string | null;
  mapping?: Mapping | null;
  flip?: boolean;
}

export function previewImport(db: DB, input: PreviewInput): PreviewResult {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(input.accountId) as any;
  if (!account) throw new ValidationError('Choose an account to import into');
  const all = parseCsv(input.csv ?? '');
  if (all.length < 2) throw new ValidationError('That file has no rows');
  const headerIdx = findHeaderRow(all);
  const headers = all[headerIdx];
  const body = all.slice(headerIdx + 1);

  let preset = input.presetId ? PRESETS.find((p) => p.id === input.presetId) ?? null : null;
  let mapping: Mapping | null = input.mapping ?? null;
  if (!mapping) {
    if (!preset && input.presetId !== 'custom') preset = detectPreset(headers, account.institution);
    mapping = preset?.mapping ?? guessMapping(headers);
  }
  if (!mapping) {
    return {
      presetId: null, presetLabel: 'Unknown format', mapping: null, headers, rows: [], anchor: null,
      summary: { new: 0, duplicate: 0, possible_duplicate: 0, transfer_match: 0, error: 0 }, dateRange: null,
    };
  }

  let raw: RawRow[];
  try {
    raw = applyMapping(headers, body, mapping, !!input.flip);
  } catch (e: any) {
    throw new ValidationError(e.message);
  }

  const rules = loadRules(db);
  const otherAccounts = db.prepare('SELECT id, name, type, institution FROM accounts WHERE id != ? AND archived = 0').all(input.accountId) as any[];
  const occurrences = new Map<string, number>();
  const usedPostings = new Set<number>();
  const rows: PreviewRow[] = [];

  for (const r of raw) {
    const base = {
      index: r.index,
      date: r.date,
      description: r.description,
      bankDescription: r.bankDescription,
      amount: r.amount,
      balance: r.balance,
    };
    if (r.error || r.date === null || r.amount === null) {
      rows.push({ ...base, hash: null, status: 'error', error: r.error ?? 'Invalid row', action: 'skip', kind: 'expense', categoryId: null, transferAccountId: null, suggestionSource: 'none' });
      continue;
    }
    const hash = rowHash(input.accountId, r, occurrences);

    // 1. Already imported (exact fingerprint).
    const dup = db
      .prepare(
        `SELECT p.id AS posting_id, t.id, t.date, t.description FROM postings p JOIN transactions t ON t.id = p.transaction_id
         WHERE p.account_id = ? AND p.import_hash = ?`,
      )
      .get(input.accountId, hash) as any;
    if (dup) {
      rows.push({
        ...base, hash, status: 'duplicate', action: 'skip', kind: 'expense', categoryId: null, transferAccountId: null, suggestionSource: 'none',
        match: { transactionId: dup.id, postingId: dup.posting_id, date: dup.date, description: dup.description, accountName: account.name },
      });
      continue;
    }

    // 2. Entered by hand (or created as the other side of a transfer) but not yet imported.
    const manual = db
      .prepare(
        `SELECT p.id AS posting_id, t.id, t.date, t.description, t.kind FROM postings p JOIN transactions t ON t.id = p.transaction_id
         WHERE p.account_id = ? AND p.amount = ? AND p.import_hash IS NULL AND t.date BETWEEN ? AND ?
         ORDER BY ABS(julianday(t.date) - julianday(?)) LIMIT 5`,
      )
      .all(input.accountId, r.amount, addDays(r.date, -MATCH_WINDOW_DAYS), addDays(r.date, MATCH_WINDOW_DAYS), r.date) as any[];
    const m = manual.find((x) => !usedPostings.has(x.posting_id));
    if (m) {
      usedPostings.add(m.posting_id);
      rows.push({
        ...base, hash, status: 'possible_duplicate', action: 'link', kind: m.kind, categoryId: null, transferAccountId: null, suggestionSource: 'match',
        match: { transactionId: m.id, postingId: m.posting_id, date: m.date, description: m.description, accountName: account.name },
      });
      continue;
    }

    // 3. Other side of a transfer already recorded on another account
    //    (e.g. the card's "PAYMENT RECEIVED" ↔ the current account's card-payment debit).
    const counter = db
      .prepare(
        `SELECT p.id AS posting_id, t.id, t.date, t.description, a.name AS account_name
         FROM postings p JOIN transactions t ON t.id = p.transaction_id JOIN accounts a ON a.id = p.account_id
         WHERE p.account_id != ? AND p.amount = ? AND t.kind != 'transfer' AND t.date BETWEEN ? AND ?
           AND (SELECT COUNT(*) FROM postings p2 WHERE p2.transaction_id = t.id) = 1
         ORDER BY ABS(julianday(t.date) - julianday(?)) LIMIT 5`,
      )
      .all(input.accountId, -r.amount, addDays(r.date, -MATCH_WINDOW_DAYS), addDays(r.date, MATCH_WINDOW_DAYS), r.date) as any[];
    const sugg = suggest(db, rules, input.accountId, r.description, r.amount);
    const c = counter.find((x) => !usedPostings.has(x.posting_id) && looksLikeTransfer(r, sugg.kind, account, x));
    if (c) {
      usedPostings.add(c.posting_id);
      rows.push({
        ...base, hash, status: 'transfer_match', action: 'merge_transfer', kind: 'transfer', categoryId: null, transferAccountId: null, suggestionSource: 'match',
        match: { transactionId: c.id, postingId: c.posting_id, date: c.date, description: c.description, accountName: c.account_name },
      });
      continue;
    }

    // 4. New transaction.
    let { kind, categoryId, transferAccountId, source } = { ...sugg, source: sugg.source as PreviewRow['suggestionSource'] };
    if (source === 'none') {
      const hinted = transferHint(r.description, r.amount, account, otherAccounts);
      if (hinted !== undefined) {
        kind = 'transfer';
        transferAccountId = hinted;
      }
    }
    // 5. No rule, no history, not a transfer: a well-known merchant or tell-tale word.
    let smartMatch: string | undefined;
    if (source === 'none' && kind !== 'transfer' && !categoryId) {
      const smart = smartCategory(db, sugg.description, r.amount);
      if (smart) { kind = smart.kind; categoryId = smart.categoryId; source = 'smart'; smartMatch = smart.matched; }
    }
    rows.push({
      ...base, description: sugg.description, hash, status: 'new', action: 'create', kind, categoryId, transferAccountId, suggestionSource: source, smartMatch,
    });
  }

  const summary = { new: 0, duplicate: 0, possible_duplicate: 0, transfer_match: 0, error: 0 };
  for (const r of rows) summary[r.status]++;
  const dated = raw.filter((r) => r.date) as (RawRow & { date: string })[];
  const dates = dated.map((r) => r.date).sort();
  return {
    presetId: preset?.id ?? (input.mapping ? 'custom' : null),
    presetLabel: preset?.label ?? 'Custom columns',
    presetNote: preset?.note,
    mapping,
    headers,
    rows,
    anchor: latestBalance(dated),
    summary,
    dateRange: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null,
  };
}

/**
 * Stable fingerprint for an imported row. The occurrence counter keeps two
 * genuinely identical rows (two £3.20 coffees on the same day) distinct, while
 * still matching when the same file — or an overlapping one — is re-imported.
 */
function rowHash(accountId: number, r: RawRow, occurrences: Map<string, number>): string {
  const key = `${accountId}|${r.date}|${r.amount}|${normaliseMerchant(r.bankDescription) || r.bankDescription.toUpperCase()}`;
  const n = (occurrences.get(key) ?? 0) + 1;
  occurrences.set(key, n);
  return crypto.createHash('sha1').update(`${key}|${n}`).digest('hex').slice(0, 20);
}

/** Use the bank's running balance column (if any) to anchor the account balance. */
function latestBalance(rows: (RawRow & { date: string })[]): { date: string; balance: number } | null {
  const withBal = rows.filter((r) => r.balance !== null);
  if (withBal.length === 0) return null;
  const first = withBal[0];
  const last = withBal[withBal.length - 1];
  // Banks export newest-first or oldest-first; the newest row's balance is the end-of-day balance.
  const newest = first.date > last.date ? first : first.date < last.date ? last : first;
  return { date: newest.date, balance: newest.balance! };
}

const TRANSFER_WORDS = /\b(payment|thank you|transfer|tfr|to a\/c|from a\/c|repayment|direct debit|dd|savings|pot|space|top ?up)\b/i;

function looksLikeTransfer(r: RawRow, suggestedKind: Kind, account: any, counter: any): boolean {
  // Card repayments and transfers are rarely categorised as normal spending by
  // rules; accept a match when the wording looks like a transfer or one side is a card.
  if (suggestedKind === 'transfer') return true;
  if (isLiability(account.type)) return true;
  if (TRANSFER_WORDS.test(r.description) || TRANSFER_WORDS.test(counter.description)) return true;
  return Math.abs(daysBetween(r.date!, counter.date)) <= 1;
}

function transferHint(description: string, amount: number, account: any, others: any[]): number | null | undefined {
  const d = description.toLowerCase();
  // Money arriving on a card is almost always a repayment from one of your accounts.
  if (isLiability(account.type) && amount > 0 && TRANSFER_WORDS.test(description)) return null;
  for (const o of others) {
    const words = [o.institution, o.name].filter(Boolean).map((s: string) => s.toLowerCase());
    if (o.institution?.toLowerCase().includes('american express')) words.push('amex', 'american exp');
    if (o.institution?.toLowerCase().includes('trading 212')) words.push('trading212', 'trading 212');
    const savingsLike = ['savings', 'investment', 'pot'].includes(o.type) && amount < 0;
    if (words.some((w: string) => w.length >= 4 && d.includes(w)) && (isLiability(o.type) || savingsLike || TRANSFER_WORDS.test(description))) {
      return o.id;
    }
  }
  return undefined;
}

/** A rule pattern that survives store numbers and references: "TESCO STORES 3297" → "tesco stores". */
export function rulePatternFor(description: string): string {
  const cleaned = normaliseMerchant(description).replace(/\b\S*\d\S*\b/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || description.trim();
}

// ---------------------------------------------------------------------------

export interface CommitRow {
  index: number;
  date: string;
  description: string;
  bankDescription: string;
  amount: number;
  hash: string;
  action: RowAction;
  kind: Kind;
  categoryId: number | null;
  transferAccountId: number | null;
  matchTransactionId?: number | null;
  matchPostingId?: number | null;
  /** Create a rule so future rows from this merchant are handled the same way. */
  remember?: boolean;
  /** Preview status; rows skipped by choice (not exact duplicates) are kept so they can be restored. */
  status?: RowStatus;
}

export interface CommitInput {
  accountId: number;
  filename?: string;
  presetId?: string | null;
  rows: CommitRow[];
  anchor?: { date: string; balance: number } | null;
}

export function commitImport(db: DB, input: CommitInput) {
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(input.accountId) as any;
  if (!account) throw new ValidationError('Account not found');
  if (!Array.isArray(input.rows)) throw new ValidationError('No rows to import');

  return tx(db, () => {
    const batchId = Number(
      db.prepare('INSERT INTO import_batches(account_id, filename, preset, row_count) VALUES (?, ?, ?, ?)')
        .run(input.accountId, input.filename ?? null, input.presetId ?? null, input.rows.length).lastInsertRowid,
    );
    let created = 0, matched = 0, skipped = 0, rulesCreated = 0;
    const hashTaken = db.prepare('SELECT 1 FROM postings WHERE account_id = ? AND import_hash = ?');
    const keepSkipped = db.prepare('INSERT INTO import_skipped (batch_id, account_id, date, description, bank_description, amount, hash, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');

    for (const row of input.rows) {
      if (row.action === 'skip') {
        skipped++;
        if (row.status !== 'duplicate' && row.status !== 'error' && isIsoDate(row.date) && Number.isSafeInteger(row.amount) && row.amount !== 0 && row.hash
          && !hashTaken.get(input.accountId, row.hash)) {
          keepSkipped.run(batchId, input.accountId, row.date, String(row.description || row.bankDescription || ''), String(row.bankDescription ?? ''),
            row.amount, row.hash, row.status === 'possible_duplicate' ? 'possible_duplicate' : 'skipped');
        }
        continue;
      }
      if (!isIsoDate(row.date) || !Number.isSafeInteger(row.amount) || row.amount === 0) {
        throw new ValidationError(`Row ${row.index + 1} is invalid`);
      }
      // Safety net: never import the same bank row twice, whatever the UI sent.
      if (hashTaken.get(input.accountId, row.hash)) { skipped++; continue; }

      if (row.action === 'link') {
        const p = db.prepare('SELECT * FROM postings WHERE id = ? AND account_id = ? AND amount = ? AND import_hash IS NULL')
          .get(row.matchPostingId ?? -1, input.accountId, row.amount);
        if (!p) throw new ValidationError(`Row ${row.index + 1}: the matching transaction changed — preview again`);
        db.prepare('UPDATE postings SET import_hash = ?, bank_description = ? WHERE id = ?').run(row.hash, row.bankDescription, row.matchPostingId!);
        matched++;
        continue;
      }

      if (row.action === 'merge_transfer') {
        const p = db.prepare('SELECT * FROM postings WHERE id = ? AND amount = ?').get(row.matchPostingId ?? -1, -row.amount) as any;
        const n = p && (db.prepare('SELECT COUNT(*) AS n FROM postings WHERE transaction_id = ?').get(p.transaction_id) as any).n;
        if (!p || n !== 1 || p.account_id === input.accountId) {
          throw new ValidationError(`Row ${row.index + 1}: the matching transaction changed — preview again`);
        }
        // Turn the existing one-sided transaction into a transfer: drop its
        // category (it is not spending/income) and add this side's posting.
        const existing = db.prepare('SELECT date FROM transactions WHERE id = ?').get(p.transaction_id) as { date: string };
        db.prepare("UPDATE transactions SET kind = 'transfer', period = substr(?, 1, 7), updated_at = datetime('now') WHERE id = ?")
          .run(existing.date < row.date ? existing.date : row.date, p.transaction_id);
        db.prepare('UPDATE postings SET category_id = NULL WHERE transaction_id = ?').run(p.transaction_id);
        db.prepare('INSERT INTO postings(transaction_id, account_id, amount, category_id, import_hash, bank_description) VALUES (?, ?, ?, NULL, ?, ?)')
          .run(p.transaction_id, input.accountId, row.amount, row.hash, row.bankDescription);
        matched++;
        continue;
      }

      // create
      const postings =
        row.kind === 'transfer'
          ? (() => {
              if (!row.transferAccountId) throw new ValidationError(`Row ${row.index + 1}: choose which account this transfer is with`);
              return [
                { accountId: input.accountId, amount: row.amount, importHash: row.hash, bankDescription: row.bankDescription },
                { accountId: row.transferAccountId, amount: -row.amount },
              ];
            })()
          : [{ accountId: input.accountId, amount: row.amount, categoryId: row.categoryId, importHash: row.hash, bankDescription: row.bankDescription }];
      createTransaction(db, {
        date: row.date,
        description: row.description || row.bankDescription,
        kind: row.kind,
        postings,
        importBatchId: batchId,
      });
      created++;

      if (row.remember && (row.categoryId || row.transferAccountId)) {
        const pattern = rulePatternFor(row.bankDescription.split(' | ')[0]);
        const exists = db.prepare('SELECT 1 FROM rules WHERE pattern = ? AND IFNULL(account_id, 0) = ?').get(pattern.toLowerCase(), input.accountId);
        if (pattern && !exists) {
          db.prepare('INSERT INTO rules(pattern, match_type, account_id, category_id, transfer_account_id, rename_to) VALUES (?, ?, ?, ?, ?, ?)')
            .run(pattern.toLowerCase(), 'contains', input.accountId, row.kind === 'transfer' ? null : row.categoryId, row.kind === 'transfer' ? row.transferAccountId : null,
              row.description !== row.bankDescription.split(' | ')[0] ? row.description : null);
          rulesCreated++;
        }
      }
    }

    if (input.anchor && isIsoDate(input.anchor.date) && Number.isSafeInteger(input.anchor.balance)) {
      // Bank balances on cards are shown as amount owed; store liabilities as negative.
      const balance = isLiability(account.type) ? -Math.abs(input.anchor.balance) : input.anchor.balance;
      db.prepare('UPDATE accounts SET anchor_balance = ?, anchor_date = ? WHERE id = ?').run(balance, input.anchor.date, input.accountId);
    }

    db.prepare('UPDATE import_batches SET created_count = ?, matched_count = ?, skipped_count = ? WHERE id = ?').run(created, matched, skipped, batchId);
    return { batchId, created, matched, skipped, rulesCreated };
  });
}

/** Undo an import: delete transactions it created and unlink rows it matched. */
export function undoImport(db: DB, batchId: number) {
  tx(db, () => {
    const batch = db.prepare('SELECT * FROM import_batches WHERE id = ?').get(batchId) as any;
    if (!batch) throw new ValidationError('Import not found');
    db.prepare('DELETE FROM transactions WHERE import_batch_id = ?').run(batchId);
    db.prepare('DELETE FROM import_batches WHERE id = ?').run(batchId);
  });
}

/** Rows you skipped while importing, newest first. */
export function listSkipped(db: DB) {
  return (db.prepare(
    `SELECT s.*, a.name AS account_name, b.filename FROM import_skipped s JOIN accounts a ON a.id = s.account_id JOIN import_batches b ON b.id = s.batch_id
     ORDER BY s.date DESC, s.id DESC`,
  ).all() as any[]).map((s) => ({
    id: s.id, batchId: s.batch_id, accountId: s.account_id, accountName: s.account_name, filename: s.filename,
    date: s.date, description: s.description, bankDescription: s.bank_description, amount: s.amount, reason: s.reason,
  }));
}

/** Import a previously skipped row as a transaction (it stays part of its original import, so undo still works). */
export function restoreSkipped(db: DB, id: number, input: { kind?: Kind; categoryId?: number | null; transferAccountId?: number | null }) {
  const s = db.prepare('SELECT * FROM import_skipped WHERE id = ?').get(id) as any;
  if (!s) throw new ValidationError('That row has already been restored or dismissed');
  return tx(db, () => {
    if (db.prepare('SELECT 1 FROM postings WHERE account_id = ? AND import_hash = ?').get(s.account_id, s.hash)) {
      db.prepare('DELETE FROM import_skipped WHERE id = ?').run(id);
      throw new ValidationError('That row is already in your transactions');
    }
    const kind: Kind = input.kind ?? (s.amount < 0 ? 'expense' : 'income');
    if (kind === 'transfer' && !input.transferAccountId) throw new ValidationError('Choose which account this transfer is with');
    const postings = kind === 'transfer'
      ? [{ accountId: s.account_id, amount: s.amount, importHash: s.hash, bankDescription: s.bank_description }, { accountId: input.transferAccountId!, amount: -s.amount }]
      : [{ accountId: s.account_id, amount: s.amount, categoryId: input.categoryId ?? null, importHash: s.hash, bankDescription: s.bank_description }];
    const txId = createTransaction(db, { date: s.date, description: s.description, kind, postings, importBatchId: s.batch_id });
    db.prepare('DELETE FROM import_skipped WHERE id = ?').run(id);
    db.prepare('UPDATE import_batches SET created_count = created_count + 1, skipped_count = MAX(0, skipped_count - 1) WHERE id = ?').run(s.batch_id);
    return txId;
  });
}

export function dismissSkipped(db: DB, id: number) {
  db.prepare('DELETE FROM import_skipped WHERE id = ?').run(id);
}

export function listImports(db: DB) {
  return (db.prepare(
    `SELECT b.*, a.name AS account_name FROM import_batches b JOIN accounts a ON a.id = b.account_id ORDER BY b.id DESC LIMIT 50`,
  ).all() as any[]).map((b) => ({
    id: b.id, accountId: b.account_id, accountName: b.account_name, filename: b.filename, preset: b.preset,
    importedAt: b.imported_at, rowCount: b.row_count, created: b.created_count, matched: b.matched_count, skipped: b.skipped_count,
  }));
}
