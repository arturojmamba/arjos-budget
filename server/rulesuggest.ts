/**
 * Rules from your habits: places you go often and always put in the same category
 * become categorisation rules, so future imports are filed automatically.
 */
import { shareMatches } from './shares.ts';
import { type DB, tx } from './db.ts';
import { ValidationError } from './money.ts';
import { addMonths, monthOf, todayIso } from './dates.ts';
import { normaliseMerchant } from './ledger.ts';
import { loadRules, ruleMatches } from './importers/categorise.ts';
import { rulePatternFor } from './importers/import.ts';
import { createRule } from './admin.ts';

export interface RuleSuggestion {
  merchant: string;
  pattern: string;
  categoryId: number;
  categoryName: string;
  colour: string;
  icon: string | null;
  kind: 'expense' | 'income';
  visits: number;
  /** Share of the categorised visits already in this category. */
  share: number;
  /** Visits with no category yet that the rule would fill in. */
  uncategorised: number;
  last: string;
}

/** True if `pattern` (contains) would catch this description, the same way imports test rules. */
function catches(pattern: string, description: string): boolean {
  const r = { pattern, match_type: 'contains' } as any;
  return ruleMatches(r, description) || ruleMatches(r, normaliseMerchant(description));
}

export function suggestRules(db: DB, opts: { months?: number; minVisits?: number; today?: string } = {}): RuleSuggestion[] {
  const today = opts.today ?? todayIso();
  const since = `${addMonths(monthOf(today), -(opts.months ?? 12) + 1)}-01`;
  const minVisits = opts.minVisits ?? 3;
  const rows = db.prepare(
    `SELECT t.id, t.date, t.kind, t.description, t.merchant, p.category_id AS cat, c.name AS cat_name, c.colour, c.icon, c.kind AS cat_kind,
            (SELECT COUNT(*) FROM postings x WHERE x.transaction_id = t.id) AS n
     FROM transactions t JOIN postings p ON p.transaction_id = t.id LEFT JOIN categories c ON c.id = p.category_id
     WHERE t.kind IN ('expense', 'income') AND t.date >= ?`,
  ).all(since) as any[];
  const rules = loadRules(db);
  // People paying you back for a shared bill are handled by its "Shared with" list, not by a rule.
  const sharers = db.prepare('SELECT name, match_pattern FROM recurring_shares').all() as { name: string; match_pattern: string | null }[];
  const isSharer = (desc: string) => sharers.some((x) => shareMatches(x.match_pattern || x.name, desc));

  // Group visits by place (the same grouping as Reports → Merchants).
  const groups = new Map<string, any[]>();
  for (const r of rows) {
    if (r.n !== 1) continue; // split transactions aren't a single place's category
    if (isSharer(r.description)) continue;
    const key = rulePatternFor(r.merchant || r.description).toLowerCase();
    if (!key || key.length < 3) continue;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }

  const out: RuleSuggestion[] = [];
  for (const [pattern, visits] of groups) {
    if (visits.length < minVisits) continue;
    // The pattern must catch (nearly) every visit, and an existing rule mustn't already cover the place.
    const caught = visits.filter((v) => catches(pattern, v.description)).length;
    if (caught / visits.length < 0.9) continue;
    if (rules.some((rule) => visits.filter((v) => ruleMatches(rule, v.description) || ruleMatches(rule, normaliseMerchant(v.description))).length >= visits.length / 2)) continue;
    const categorised = visits.filter((v) => v.cat != null);
    if (categorised.length < 2) continue;
    const counts = new Map<number, number>();
    for (const v of categorised) counts.set(v.cat, (counts.get(v.cat) ?? 0) + 1);
    const [topCat, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const share = topCount / categorised.length;
    if (share < 0.8) continue; // not consistent enough to automate
    const sample = categorised.find((v) => v.cat === topCat)!;
    out.push({
      merchant: pattern.replace(/\b([a-z])/g, (m) => m.toUpperCase()),
      pattern,
      categoryId: topCat,
      categoryName: sample.cat_name,
      colour: sample.colour,
      icon: sample.icon,
      kind: sample.cat_kind,
      visits: visits.length,
      share,
      uncategorised: visits.length - categorised.length,
      last: visits.reduce((m, v) => (v.date > m ? v.date : m), ''),
    });
  }
  return out.sort((a, b) => b.visits - a.visits);
}

/**
 * Create rules (pattern → category). With `fillIn`, past transactions those rules
 * catch that have no category yet get it too; ones you've already categorised are left alone.
 */
export function createRules(db: DB, items: { pattern: string; categoryId: number }[], fillIn = true) {
  if (!Array.isArray(items) || !items.length) throw new ValidationError('Choose at least one rule');
  return tx(db, () => {
    let created = 0, filled = 0;
    for (const it of items) {
      const cat = db.prepare('SELECT id, kind FROM categories WHERE id = ?').get(it.categoryId) as { id: number; kind: string } | undefined;
      if (!cat) throw new ValidationError('Category not found');
      const pattern = String(it.pattern ?? '').trim().toLowerCase();
      if (pattern.length < 3) throw new ValidationError('Patterns need at least 3 characters');
      if (!db.prepare("SELECT 1 FROM rules WHERE pattern = ? AND account_id IS NULL AND match_type = 'contains'").get(pattern)) {
        createRule(db, { pattern, categoryId: cat.id });
        created++;
      }
      if (!fillIn) continue;
      const open = db.prepare(
        `SELECT p.id, t.description FROM transactions t JOIN postings p ON p.transaction_id = t.id
         WHERE t.kind = ? AND p.category_id IS NULL AND (SELECT COUNT(*) FROM postings x WHERE x.transaction_id = t.id) = 1`,
      ).all(cat.kind) as { id: number; description: string }[];
      for (const o of open) {
        if (!catches(pattern, o.description)) continue;
        db.prepare('UPDATE postings SET category_id = ? WHERE id = ?').run(cat.id, o.id);
        filled++;
      }
    }
    return { created, filled };
  });
}
