/**
 * Contributions: the money a person has put into an investment account themselves
 * (see GLOSSARY.md: Money put in, Contributions, Earlier-year transfer).
 *
 * One rule for where it comes from, used by every screen:
 *   - Trading 212's cash history, whenever the account is linked to Trading 212 and has any
 *     (a failed sync doesn't change the source);
 *   - otherwise the account's own ledger: its opening balance plus transfers in and out.
 * Deposits and transfers in add, withdrawals take away. Interest, dividends and fees never count.
 * Trading 212 timestamps are read as UK dates, so the tax-year cut-off is right.
 */
import { type DB, getSetting, setSetting } from './db.ts';
import { ukDate, todayIso } from './dates.ts';

export type ContributionSource = 'trading212' | 'bank';
export type ContributionType = 'deposit' | 'withdrawal' | 'transfer';
/** One movement of your own money: + into the account, − out of it. */
export interface Contribution { date: string; amount: number; type: ContributionType; reference: string }

export interface Contributions {
  source: ContributionSource;
  /** Money put in, up to and including a date (default today). */
  putIn(asOf?: string): number;
  /** Each movement in or out between two dates, inclusive, oldest first. */
  flows(from?: string, to?: string): Contribution[];
}

const T212_TYPES: Record<string, ContributionType> = { DEPOSIT: 'deposit', WITHDRAW: 'withdrawal', TRANSFER: 'transfer' };

export function contributions(db: DB, accountId: number): Contributions {
  const acc = db.prepare('SELECT sync_provider, anchor_balance, anchor_date FROM accounts WHERE id = ?').get(accountId) as
    { sync_provider: string | null; anchor_balance: number; anchor_date: string } | undefined;
  if (!acc) throw new Error(`No account ${accountId}`);

  const t212 = acc.sync_provider === 'trading212'
    ? (db.prepare("SELECT reference, type, amount, date_time FROM t212_cash WHERE account_id = ? AND type IN ('DEPOSIT','WITHDRAW','TRANSFER')")
      .all(accountId) as { reference: string; type: string; amount: number; date_time: string | null }[])
    : [];

  if (t212.length > 0) {
    const list = t212
      .filter((r) => r.date_time)
      .map((r) => ({ date: ukDate(r.date_time!), amount: r.amount, type: T212_TYPES[r.type], reference: r.reference }))
      .sort((a, b) => a.date.localeCompare(b.date) || a.reference.localeCompare(b.reference));
    return {
      source: 'trading212',
      putIn: (asOf = todayIso()) => list.reduce((n, c) => (c.date <= asOf ? n + c.amount : n), 0),
      flows: (from = '0000-00-00', to = '9999-12-31') => list.filter((c) => c.date >= from && c.date <= to),
    };
  }

  // The ledger: transfers into and out of the account, from its opening balance.
  const moves = (db.prepare(
    `SELECT t.id, t.date, p.amount FROM postings p JOIN transactions t ON t.id = p.transaction_id
     WHERE p.account_id = ? AND t.kind = 'transfer' ORDER BY t.date, t.id`,
  ).all(accountId) as { id: number; date: string; amount: number }[]);
  return {
    source: 'bank',
    putIn: (asOf = todayIso()) => {
      // Same as the account's ledger balance on that date: the opening balance, moved forward or back.
      let n = acc.anchor_balance;
      for (const m of moves) {
        if (m.date > acc.anchor_date && m.date <= asOf) n += m.amount;
        else if (m.date > asOf && m.date <= acc.anchor_date) n -= m.amount;
      }
      return n;
    },
    flows: (from = '0000-00-00', to = '9999-12-31') => moves
      .filter((m) => m.date >= from && m.date <= to)
      .map((m) => ({ date: m.date, amount: m.amount, type: m.amount < 0 ? 'withdrawal' as const : 'deposit' as const, reference: `tx:${m.id}` })),
  };
}

// Earlier-year transfers: ISA transfers in that hold earlier tax years' money, so they don't use this year's allowance.
const EARLIER_YEAR_KEY = 'isa_earlier_year_transfers';

export function earlierYearTransfers(db: DB): Set<string> {
  try { return new Set(JSON.parse(getSetting(db, EARLIER_YEAR_KEY, '[]')) as string[]); } catch { return new Set(); }
}

export function setEarlierYearTransfer(db: DB, reference: string, on: boolean) {
  const set = earlierYearTransfers(db);
  if (on) set.add(reference); else set.delete(reference);
  setSetting(db, EARLIER_YEAR_KEY, JSON.stringify([...set]));
}
