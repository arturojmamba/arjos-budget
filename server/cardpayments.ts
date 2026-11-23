/**
 * Card payments recorded twice.
 *
 * A payment to a card shows on two statements: your bank's ("AMERICAN EXPRESS £49.47") and the card's
 * ("PAYMENT RECEIVED – THANK YOU £49.47"). Importing the bank first can file it to the wrong card
 * (both Amex cards look the same on a bank statement). Importing the card's statement then can't see it
 * as the same payment, so it records a second transfer with a guessed bank side.
 *
 * Coil finds these pairs and you confirm each: the bank's row is kept (it's the real money leaving),
 * moved to the card whose statement shows the payment, and the card's copy is removed.
 */
import type { DB } from './db.ts';
import { tx } from './db.ts';
import { ValidationError } from './money.ts';

const CARD_TYPES = "('credit_card','loan','other_liability')";
/** Bank and card dates differ by a day or two (a direct debit leaves on the 17th, Amex posts it on the 15th). */
const WINDOW_DAYS = 5;

export interface DoubledPayment {
  keepId: number; dropId: number; amount: number;
  bankAccount: string; bankDate: string; bankDescription: string;
  /** The card the bank row is filed to now, and the card whose statement shows the payment. */
  filedTo: string; paidTo: string; paidToId: number; cardDate: string;
  /** The account the card's copy guessed the money came from. */
  guessedFrom: string;
}

interface Side { tx: number; date: string; posting: number; account: number; account_name: string; amount: number; hashed: number; other_posting: number; other_account: number; other_name: string; other_hashed: number; description: string }

/** Transfers between an account and a card where exactly one side came from a statement. */
function halfImported(db: DB): Side[] {
  return db.prepare(
    `SELECT t.id AS tx, t.date, t.description, card.id AS posting, card.account_id AS account, ca.name AS account_name, card.amount,
            card.import_hash IS NOT NULL AS hashed, other.id AS other_posting, other.account_id AS other_account, oa.name AS other_name,
            other.import_hash IS NOT NULL AS other_hashed
     FROM transactions t
     JOIN postings card ON card.transaction_id = t.id AND card.amount > 0
     JOIN accounts ca ON ca.id = card.account_id AND ca.type IN ${CARD_TYPES}
     JOIN postings other ON other.transaction_id = t.id AND other.id != card.id
     JOIN accounts oa ON oa.id = other.account_id
     WHERE t.kind = 'transfer' AND (SELECT COUNT(*) FROM postings x WHERE x.transaction_id = t.id) = 2
       AND (card.import_hash IS NULL) != (other.import_hash IS NULL)`,
  ).all() as unknown as Side[];
}

export function findDoubledPayments(db: DB): DoubledPayment[] {
  const sides = halfImported(db);
  // From a bank statement: the bank side is real, the card side was a guess.
  const fromBank = sides.filter((s) => s.other_hashed && !s.hashed);
  // From a card statement: the card side is real, the bank side was a guess.
  const fromCard = sides.filter((s) => s.hashed && !s.other_hashed);
  const used = new Set<number>();
  const out: DoubledPayment[] = [];
  const days = (a: string, b: string) => Math.abs(Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86400000;
  for (const c of fromCard.sort((a, b) => a.date.localeCompare(b.date))) {
    const match = fromBank
      .filter((b) => !used.has(b.tx) && b.amount === c.amount && days(b.date, c.date) <= WINDOW_DAYS)
      .sort((x, y) => days(x.date, c.date) - days(y.date, c.date))[0];
    if (!match) continue;
    used.add(match.tx);
    out.push({
      keepId: match.tx, dropId: c.tx, amount: c.amount,
      bankAccount: match.other_name, bankDate: match.date, bankDescription: match.description,
      filedTo: match.account_name, paidTo: c.account_name, paidToId: c.account, cardDate: c.date, guessedFrom: c.other_name,
    });
  }
  return out;
}

/** Keep the bank's row, file it to the card that was paid, and remove the card's copy. */
export function mergeDoubledPayment(db: DB, keepId: number, dropId: number) {
  const pair = findDoubledPayments(db).find((p) => p.keepId === keepId && p.dropId === dropId);
  if (!pair) throw new ValidationError('Those payments have already been sorted out — refresh to check again');
  tx(db, () => {
    const drop = db.prepare(
      `SELECT p.import_hash, p.bank_description FROM postings p WHERE p.transaction_id = ? AND p.account_id = ? AND p.import_hash IS NOT NULL`,
    ).get(dropId, pair.paidToId) as { import_hash: string; bank_description: string | null };
    // Anything linked to the card's copy (a bill ticked off with it) moves to the kept one.
    db.prepare('UPDATE OR IGNORE recurring_payments SET transaction_id = ? WHERE transaction_id = ?').run(keepId, dropId);
    db.prepare('DELETE FROM transactions WHERE id = ?').run(dropId);
    db.prepare(
      `UPDATE postings SET account_id = ?, import_hash = ?, bank_description = ? WHERE transaction_id = ? AND amount > 0 AND import_hash IS NULL`,
    ).run(pair.paidToId, drop.import_hash, drop.bank_description, keepId);
    db.prepare("UPDATE transactions SET updated_at = datetime('now') WHERE id = ?").run(keepId);
  });
}

/**
 * Payments filed to a card whose own statements (imported, and covering that date) don't show them:
 * usually filed to the wrong card. Returns the transaction, card and date.
 */
export function notOnCardStatement(db: DB): { txId: number; card: string; cardId: number; date: string; amount: number; from: string }[] {
  const doubled = new Set(findDoubledPayments(db).map((p) => p.keepId));
  return (db.prepare(
    `SELECT t.id AS txId, ca.name AS card, ca.id AS cardId, t.date, card.amount, oa.name AS "from"
     FROM transactions t
     JOIN postings card ON card.transaction_id = t.id AND card.amount > 0 AND card.import_hash IS NULL
     JOIN accounts ca ON ca.id = card.account_id AND ca.type = 'credit_card'
     JOIN postings other ON other.transaction_id = t.id AND other.id != card.id AND other.import_hash IS NOT NULL
     JOIN accounts oa ON oa.id = other.account_id
     WHERE t.kind = 'transfer'
       -- the card's imported statements reach at least a week past the payment
       AND (SELECT MAX(t2.date) FROM postings p2 JOIN transactions t2 ON t2.id = p2.transaction_id
            WHERE p2.account_id = ca.id AND p2.import_hash IS NOT NULL) >= date(t.date, '+7 days')
       AND (SELECT MIN(t2.date) FROM postings p2 JOIN transactions t2 ON t2.id = p2.transaction_id
            WHERE p2.account_id = ca.id AND p2.import_hash IS NOT NULL) <= t.date
     ORDER BY t.date DESC`,
  ).all() as any[]).filter((r) => !doubled.has(r.txId));
}
