import { type DB, tx } from './db.ts';
import { ACCOUNT_TYPES, normaliseMerchant } from './ledger.ts';
import { loadRules, ruleMatches } from './importers/categorise.ts';
import { assertPence, ValidationError } from './money.ts';
import { isIsoDate, todayIso } from './dates.ts';

const HEX = /^#[0-9a-fA-F]{6}$/;

function str(v: unknown, field: string, max = 80): string {
  if (typeof v !== 'string' || !v.trim()) throw new ValidationError(`${field} is required`);
  if (v.trim().length > max) throw new ValidationError(`${field} is too long`);
  return v.trim();
}

// ---------- Accounts ----------

export interface AccountInput {
  name: string;
  type: string;
  institution?: string | null;
  parentId?: number | null;
  colour?: string;
  /** Known balance at the end of balanceDate (liabilities negative: owing £500 = -50000). */
  balance?: number;
  balanceDate?: string;
  archived?: boolean;
  sortOrder?: number;
  /** Investments: 'isa' counts towards the ISA allowance. */
  wrapper?: 'isa' | 'lisa' | 'sipp' | null;
  syncProvider?: 'trading212' | null;
}

function checkInvestment(type: string, wrapper: unknown, sync: unknown) {
  if (wrapper != null && !['isa', 'lisa', 'sipp'].includes(wrapper as string)) throw new ValidationError('Unknown tax wrapper');
  if (sync != null && sync !== 'trading212') throw new ValidationError('Unknown sync provider');
  if ((wrapper != null || sync != null) && type !== 'investment') throw new ValidationError('Only investment accounts can be an ISA or sync with Trading 212');
}

export function createAccount(db: DB, input: AccountInput): number {
  const name = str(input.name, 'Name');
  if (!(ACCOUNT_TYPES as readonly string[]).includes(input.type)) throw new ValidationError('Unknown account type');
  if (input.colour && !HEX.test(input.colour)) throw new ValidationError('Colour must be a hex value');
  const balance = input.balance === undefined ? 0 : assertPence(input.balance, 'Balance');
  const date = input.balanceDate ?? todayIso();
  if (!isIsoDate(date)) throw new ValidationError('Balance date is invalid');
  if (input.parentId != null && !db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(input.parentId)) {
    throw new ValidationError('Parent account not found');
  }
  checkInvestment(input.type, input.wrapper ?? null, input.syncProvider ?? null);
  const order = (db.prepare('SELECT IFNULL(MAX(sort_order), 0) + 1 AS n FROM accounts').get() as { n: number }).n;
  const res = db
    .prepare(
      'INSERT INTO accounts(name, type, institution, parent_id, colour, anchor_balance, anchor_date, sort_order, wrapper, sync_provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(name, input.type, input.institution?.trim() || null, input.parentId ?? null, input.colour ?? '#64748b', balance, date, order,
      input.wrapper ?? null, input.syncProvider ?? null);
  return Number(res.lastInsertRowid);
}

export function updateAccount(db: DB, id: number, input: Partial<AccountInput>) {
  const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as any;
  if (!acc) throw new ValidationError('Account not found');
  const name = input.name !== undefined ? str(input.name, 'Name') : acc.name;
  const type = input.type ?? acc.type;
  if (!(ACCOUNT_TYPES as readonly string[]).includes(type)) throw new ValidationError('Unknown account type');
  const colour = input.colour ?? acc.colour;
  if (!HEX.test(colour)) throw new ValidationError('Colour must be a hex value');
  if (input.parentId === id) throw new ValidationError('An account cannot be its own parent');
  let anchorBalance = acc.anchor_balance;
  let anchorDate = acc.anchor_date;
  if (input.balance !== undefined) {
    anchorBalance = assertPence(input.balance, 'Balance');
    anchorDate = input.balanceDate ?? todayIso();
    if (!isIsoDate(anchorDate)) throw new ValidationError('Balance date is invalid');
  }
  const wrapper = input.wrapper !== undefined ? input.wrapper : type === 'investment' ? acc.wrapper : null;
  const syncProvider = input.syncProvider !== undefined ? input.syncProvider : type === 'investment' ? acc.sync_provider : null;
  checkInvestment(type, wrapper, syncProvider);
  db.prepare(
    `UPDATE accounts SET name = ?, type = ?, institution = ?, parent_id = ?, colour = ?, anchor_balance = ?, anchor_date = ?,
       archived = ?, sort_order = ?, wrapper = ?, sync_provider = ? WHERE id = ?`,
  ).run(
    name,
    type,
    input.institution !== undefined ? input.institution?.trim() || null : acc.institution,
    input.parentId !== undefined ? input.parentId : acc.parent_id,
    colour,
    anchorBalance,
    anchorDate,
    input.archived !== undefined ? (input.archived ? 1 : 0) : acc.archived,
    input.sortOrder ?? acc.sort_order,
    wrapper,
    syncProvider,
    id,
  );
}

export function deleteAccount(db: DB, id: number) {
  const used = db.prepare('SELECT COUNT(*) AS n FROM postings WHERE account_id = ?').get(id) as { n: number };
  if (used.n > 0) throw new ValidationError('This account has transactions. Archive it instead to keep your history accurate.');
  const children = db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE parent_id = ?').get(id) as { n: number };
  if (children.n > 0) throw new ValidationError('Move or delete the pots inside this account first');
  const recurring = db.prepare('SELECT COUNT(*) AS n FROM recurring WHERE account_id = ? OR transfer_account_id = ?').get(id, id) as { n: number };
  if (recurring.n > 0) throw new ValidationError('Bills or income use this account. Change or delete them first.');
  tx(db, () => {
    db.prepare('DELETE FROM import_batches WHERE account_id = ?').run(id);
    db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  });
}

// ---------- Categories ----------

export interface CategoryInput {
  name: string;
  kind: 'expense' | 'income';
  parentId?: number | null;
  colour?: string;
  icon?: string | null;
  isFixed?: boolean;
  rollForward?: boolean;
  archived?: boolean;
}

export function createCategory(db: DB, input: CategoryInput): number {
  const name = str(input.name, 'Name', 60);
  if (input.kind !== 'expense' && input.kind !== 'income') throw new ValidationError('Kind must be expense or income');
  let colour = input.colour ?? '#64748b';
  if (input.parentId != null) {
    const parent = db.prepare('SELECT * FROM categories WHERE id = ?').get(input.parentId) as any;
    if (!parent) throw new ValidationError('Parent category not found');
    if (parent.parent_id != null) throw new ValidationError('Subcategories can only be one level deep');
    if (parent.kind !== input.kind) throw new ValidationError('A subcategory must be the same kind as its parent');
    if (!input.colour) colour = parent.colour;
  }
  if (!HEX.test(colour)) throw new ValidationError('Colour must be a hex value');
  try {
    const res = db
      .prepare(
        `INSERT INTO categories(name, kind, parent_id, colour, icon, is_fixed, roll_forward, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT IFNULL(MAX(sort_order), -1) + 1 FROM categories WHERE kind = ? AND IFNULL(parent_id, 0) = ?))`,
      )
      .run(name, input.kind, input.parentId ?? null, colour, iconValue(input.icon), input.isFixed ? 1 : 0, input.rollForward ? 1 : 0, input.kind, input.parentId ?? 0);
    return Number(res.lastInsertRowid);
  } catch (e: any) {
    if (String(e.message).includes('UNIQUE')) throw new ValidationError('A category with that name already exists');
    throw e;
  }
}

export function updateCategory(db: DB, id: number, input: Partial<CategoryInput>) {
  const cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(id) as any;
  if (!cat) throw new ValidationError('Category not found');
  const colour = input.colour ?? cat.colour;
  if (!HEX.test(colour)) throw new ValidationError('Colour must be a hex value');
  try {
    db.prepare('UPDATE categories SET name = ?, colour = ?, icon = ?, is_fixed = ?, roll_forward = ?, archived = ? WHERE id = ?').run(
      input.name !== undefined ? str(input.name, 'Name', 60) : cat.name,
      colour,
      input.icon !== undefined ? iconValue(input.icon) : cat.icon,
      input.isFixed !== undefined ? (input.isFixed ? 1 : 0) : cat.is_fixed,
      input.rollForward !== undefined ? (input.rollForward ? 1 : 0) : cat.roll_forward,
      input.archived !== undefined ? (input.archived ? 1 : 0) : cat.archived,
      id,
    );
  } catch (e: any) {
    if (String(e.message).includes('UNIQUE')) throw new ValidationError('A category with that name already exists');
    throw e;
  }
}

/** An emoji (or short symbol) shown for the category. */
function iconValue(v: unknown): string | null {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || [...v].length > 8) throw new ValidationError('Choose an emoji for the icon');
  return v.trim();
}

/** Put categories that share a parent (or top-level categories of one kind) in the given order. */
export function reorderCategories(db: DB, ids: number[]) {
  if (!Array.isArray(ids) || ids.some((i) => !Number.isInteger(i))) throw new ValidationError('Send a list of category ids');
  const rows = ids.map((id) => db.prepare('SELECT kind, parent_id FROM categories WHERE id = ?').get(id) as { kind: string; parent_id: number | null } | undefined);
  if (rows.some((r) => !r)) throw new ValidationError('Category not found');
  if (new Set(rows.map((r) => `${r!.kind}:${r!.parent_id ?? 0}`)).size > 1) throw new ValidationError('Only categories in the same list can be reordered together');
  tx(db, () => ids.forEach((id, i) => db.prepare('UPDATE categories SET sort_order = ? WHERE id = ?').run(i, id)));
}

/** Delete a category, moving its transactions (and subcategories' transactions) to another category or to uncategorised. */
export function deleteCategory(db: DB, id: number, reassignTo: number | null) {
  const cat = db.prepare('SELECT * FROM categories WHERE id = ?').get(id) as any;
  if (!cat) throw new ValidationError('Category not found');
  if (reassignTo != null) {
    const target = db.prepare('SELECT * FROM categories WHERE id = ?').get(reassignTo) as any;
    if (!target) throw new ValidationError('Target category not found');
    if (target.kind !== cat.kind) throw new ValidationError('Can only move transactions to a category of the same kind');
    if (target.id === id || target.parent_id === id) throw new ValidationError('Choose a category outside the one being deleted');
  }
  tx(db, () => {
    const ids = [id, ...(db.prepare('SELECT id FROM categories WHERE parent_id = ?').all(id) as { id: number }[]).map((r) => r.id)];
    for (const cid of ids) {
      db.prepare('UPDATE postings SET category_id = ? WHERE category_id = ?').run(reassignTo, cid);
      db.prepare('DELETE FROM rules WHERE category_id = ?').run(cid);
    }
    db.prepare('DELETE FROM categories WHERE parent_id = ?').run(id);
    db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  });
}

/** Re-categorise many transactions at once (used by bulk edit). */
export function bulkCategorise(db: DB, transactionIds: number[], categoryId: number | null) {
  tx(db, () => {
    const cat = categoryId == null ? null : (db.prepare('SELECT * FROM categories WHERE id = ?').get(categoryId) as any);
    if (categoryId != null && !cat) throw new ValidationError('Category not found');
    for (const id of transactionIds) {
      const t = db.prepare('SELECT kind FROM transactions WHERE id = ?').get(id) as { kind: string } | undefined;
      if (!t || t.kind === 'transfer') continue;
      if (cat && cat.kind !== t.kind) continue;
      db.prepare('UPDATE postings SET category_id = ? WHERE transaction_id = ?').run(categoryId, id);
    }
  });
}

// ---------- Rules ----------

export interface RuleInput {
  pattern: string;
  matchType?: 'contains' | 'starts_with' | 'exact' | 'regex';
  accountId?: number | null;
  categoryId?: number | null;
  transferAccountId?: number | null;
  renameTo?: string | null;
  priority?: number;
}

function cleanRule(db: DB, input: RuleInput) {
  const pattern = str(input.pattern, 'Pattern', 200);
  const matchType = input.matchType ?? 'contains';
  if (!['contains', 'starts_with', 'exact', 'regex'].includes(matchType)) throw new ValidationError('Unknown match type');
  if (matchType === 'regex') {
    try { new RegExp(pattern, 'i'); } catch { throw new ValidationError('Invalid regular expression'); }
  }
  if (!input.categoryId && !input.transferAccountId && !input.renameTo) {
    throw new ValidationError('A rule needs a category, a transfer account or a new name');
  }
  if (input.categoryId && input.transferAccountId) throw new ValidationError('A rule can set a category or a transfer, not both');
  if (input.categoryId && !db.prepare('SELECT 1 FROM categories WHERE id = ?').get(input.categoryId)) throw new ValidationError('Category not found');
  return [pattern, matchType, input.accountId ?? null, input.categoryId ?? null, input.transferAccountId ?? null, input.renameTo?.trim() || null, input.priority ?? 0] as const;
}

export function createRule(db: DB, input: RuleInput): number {
  const res = db
    .prepare('INSERT INTO rules(pattern, match_type, account_id, category_id, transfer_account_id, rename_to, priority) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(...cleanRule(db, input));
  return Number(res.lastInsertRowid);
}

export function updateRule(db: DB, id: number, input: RuleInput) {
  const vals = cleanRule(db, input);
  const r = db.prepare('UPDATE rules SET pattern = ?, match_type = ?, account_id = ?, category_id = ?, transfer_account_id = ?, rename_to = ?, priority = ? WHERE id = ?').run(...vals, id);
  if (!r.changes) throw new ValidationError('Rule not found');
}

/**
 * Which rule would handle this description, in the same order imports use.
 * Also lists any other rules that match but lose, so overlaps are visible.
 */
export function testRules(db: DB, description: string, accountId?: number | null) {
  const d = str(description, 'Description', 200);
  const merchant = normaliseMerchant(d);
  const ordered = loadRules(db);
  const hits = ordered.filter((r) => (r.account_id == null || accountId == null || r.account_id === accountId) && (ruleMatches(r, d) || ruleMatches(r, merchant)));
  return { winner: hits[0]?.id ?? null, matches: hits.map((r) => r.id) };
}

export function deleteRule(db: DB, id: number) {
  db.prepare('DELETE FROM rules WHERE id = ?').run(id);
}

export function listRules(db: DB) {
  // How many existing transactions each rule matches, and the latest one, so unused rules stand out.
  const txns = db.prepare(
    `SELECT t.date, t.description, (SELECT MIN(p.account_id) FROM postings p WHERE p.transaction_id = t.id) AS account_id FROM transactions t`,
  ).all() as { date: string; description: string; account_id: number }[];
  const prepared = txns.map((t) => ({ ...t, merchant: normaliseMerchant(t.description) }));
  const usage = (r: any) => {
    let matches = 0; let lastMatch: string | null = null;
    for (const t of prepared) {
      if (r.account_id != null && r.account_id !== t.account_id) continue;
      if (!ruleMatches(r, t.description) && !ruleMatches(r, t.merchant)) continue;
      matches++;
      if (!lastMatch || t.date > lastMatch) lastMatch = t.date;
    }
    return { matches, lastMatch, createdAt: r.created_at };
  };
  return (
    db
      .prepare(
        `SELECT r.*, c.name AS category_name, c.colour AS category_colour, a.name AS transfer_account_name, src.name AS account_name
         FROM rules r LEFT JOIN categories c ON c.id = r.category_id LEFT JOIN accounts a ON a.id = r.transfer_account_id
         LEFT JOIN accounts src ON src.id = r.account_id
         ORDER BY r.priority DESC, LENGTH(r.pattern) DESC, r.id DESC`,
      )
      .all() as any[]
  ).map((r) => ({
    ...usage(r),
    id: r.id,
    pattern: r.pattern,
    matchType: r.match_type,
    accountId: r.account_id,
    accountName: r.account_name,
    categoryId: r.category_id,
    categoryName: r.category_name,
    categoryColour: r.category_colour,
    transferAccountId: r.transfer_account_id,
    transferAccountName: r.transfer_account_name,
    renameTo: r.rename_to,
    priority: r.priority,
    hits: r.hits,
  }));
}
