import type { DB } from '../db.ts';
import { normaliseMerchant } from '../ledger.ts';
import { shareCategoryFor } from '../shares.ts';

export interface Suggestion {
  kind: 'expense' | 'income' | 'transfer';
  categoryId: number | null;
  transferAccountId: number | null;
  description: string;
  source: 'rule' | 'history' | 'none';
  ruleId?: number;
}

interface RuleRow {
  id: number;
  pattern: string;
  match_type: string;
  account_id: number | null;
  category_id: number | null;
  transfer_account_id: number | null;
  rename_to: string | null;
  cat_kind: string | null;
}

export function loadRules(db: DB): RuleRow[] {
  return db
    .prepare(
      `SELECT r.*, c.kind AS cat_kind FROM rules r LEFT JOIN categories c ON c.id = r.category_id
       ORDER BY r.priority DESC, LENGTH(r.pattern) DESC, r.id DESC`,
    )
    .all() as unknown as RuleRow[];
}

export function ruleMatches(rule: RuleRow, description: string): boolean {
  const d = description.toLowerCase();
  const p = rule.pattern.toLowerCase();
  switch (rule.match_type) {
    case 'exact':
      return d === p;
    case 'starts_with':
      return d.startsWith(p);
    case 'regex':
      try {
        return new RegExp(rule.pattern, 'i').test(description);
      } catch {
        return false;
      }
    default:
      return d.includes(p);
  }
}

/**
 * Suggest how to record an imported row:
 *  1. user rules (most specific first),
 *  2. how you categorised the same merchant last time,
 *  3. fall back to income/expense by sign, uncategorised.
 */
export function suggest(db: DB, rules: RuleRow[], accountId: number, description: string, amount: number): Suggestion {
  // Someone paying you back for a shared bill: a refund against that bill's category.
  const shared = shareCategoryFor(db, accountId, description, amount);
  if (shared) return { kind: 'expense', categoryId: shared, transferAccountId: null, description, source: 'rule' };

  const merchantForRules = normaliseMerchant(description);
  for (const rule of rules) {
    if (rule.account_id != null && rule.account_id !== accountId) continue;
    if (!ruleMatches(rule, description) && !ruleMatches(rule, merchantForRules)) continue;
    const desc = rule.rename_to || description;
    if (rule.transfer_account_id && rule.transfer_account_id !== accountId) {
      return { kind: 'transfer', categoryId: null, transferAccountId: rule.transfer_account_id, description: desc, source: 'rule', ruleId: rule.id };
    }
    if (rule.category_id && rule.cat_kind) {
      // An expense category on money coming in is a refund; still an expense.
      return { kind: rule.cat_kind as 'expense' | 'income', categoryId: rule.category_id, transferAccountId: null, description: desc, source: 'rule', ruleId: rule.id };
    }
    if (rule.rename_to) description = rule.rename_to;
  }

  const merchant = normaliseMerchant(description);
  if (merchant) {
    const prev = db
      .prepare(
        `SELECT t.kind, p.category_id, t.description,
                (SELECT p2.account_id FROM postings p2 WHERE p2.transaction_id = t.id AND p2.account_id != ? LIMIT 1) AS other_account
         FROM transactions t JOIN postings p ON p.transaction_id = t.id
         WHERE t.merchant = ? AND p.account_id = ? AND (p.category_id IS NOT NULL OR t.kind = 'transfer')
         ORDER BY t.date DESC, t.id DESC LIMIT 1`,
      )
      .get(accountId, merchant, accountId) as { kind: string; category_id: number | null; other_account: number | null } | undefined;
    if (prev) {
      if (prev.kind === 'transfer' && prev.other_account) {
        return { kind: 'transfer', categoryId: null, transferAccountId: prev.other_account, description, source: 'history' };
      }
      if (prev.category_id) {
        return { kind: prev.kind as 'expense' | 'income', categoryId: prev.category_id, transferAccountId: null, description, source: 'history' };
      }
    }
    // Same merchant on a different account (e.g. a supermarket on a card, then on the current account).
    const any = db
      .prepare(
        `SELECT t.kind, p.category_id FROM transactions t JOIN postings p ON p.transaction_id = t.id
         WHERE t.merchant = ? AND p.category_id IS NOT NULL AND t.kind = ? ORDER BY t.date DESC LIMIT 1`,
      )
      .get(merchant, amount < 0 ? 'expense' : 'income') as { kind: string; category_id: number } | undefined;
    if (any) return { kind: any.kind as 'expense' | 'income', categoryId: any.category_id, transferAccountId: null, description, source: 'history' };
  }

  return { kind: amount < 0 ? 'expense' : 'income', categoryId: null, transferAccountId: null, description, source: 'none' };
}
