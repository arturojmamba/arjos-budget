import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { seed, ensureDefaults } from './seed.ts';

export type DB = DatabaseSync;

/**
 * Schema notes
 * ------------
 * - Money is INTEGER pence everywhere.
 * - A transaction is a header + one or more postings. A posting moves money
 *   into (+) or out of (-) one of YOUR accounts.
 * - Only postings that carry a category count as income or spending.
 *   Transfers (incl. credit card repayments and savings contributions) are
 *   two postings between your own accounts with no category, so they can
 *   never be counted as income or expenses.
 * - Liability accounts (credit cards, loans) carry negative balances: a card
 *   purchase is an expense posting on the card account (debt goes up), a
 *   repayment is a transfer from the bank to the card (debt goes down).
 * - `period` is the month a transaction counts towards in reports/budgets.
 *   It defaults to the date's month, but salary paid on the last working day
 *   rolls forward to the month it is meant to fund.
 */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE accounts (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('current','savings','credit_card','loan','cash','pot','other_asset','other_liability')),
    institution TEXT,
    parent_id INTEGER REFERENCES accounts(id),
    currency TEXT NOT NULL DEFAULT 'GBP',
    anchor_balance INTEGER NOT NULL DEFAULT 0,
    anchor_date TEXT NOT NULL,
    colour TEXT NOT NULL DEFAULT '#64748b',
    archived INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE categories (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('expense','income')),
    parent_id INTEGER REFERENCES categories(id),
    colour TEXT NOT NULL DEFAULT '#64748b',
    icon TEXT,
    is_fixed INTEGER NOT NULL DEFAULT 0,
    roll_forward INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE UNIQUE INDEX categories_unique ON categories(kind, IFNULL(parent_id, 0), name COLLATE NOCASE);

  CREATE TABLE import_batches (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    filename TEXT,
    preset TEXT,
    imported_at TEXT NOT NULL DEFAULT (datetime('now')),
    row_count INTEGER NOT NULL DEFAULT 0,
    created_count INTEGER NOT NULL DEFAULT 0,
    matched_count INTEGER NOT NULL DEFAULT 0,
    skipped_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE transactions (
    id INTEGER PRIMARY KEY,
    date TEXT NOT NULL,
    period TEXT NOT NULL,
    description TEXT NOT NULL,
    merchant TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL CHECK (kind IN ('expense','income','transfer')),
    notes TEXT,
    import_batch_id INTEGER REFERENCES import_batches(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX transactions_date ON transactions(date);
  CREATE INDEX transactions_period ON transactions(period);

  CREATE TABLE postings (
    id INTEGER PRIMARY KEY,
    transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    amount INTEGER NOT NULL,
    category_id INTEGER REFERENCES categories(id),
    import_hash TEXT,
    bank_description TEXT
  );
  CREATE INDEX postings_txn ON postings(transaction_id);
  CREATE INDEX postings_account ON postings(account_id);
  CREATE INDEX postings_category ON postings(category_id);
  CREATE INDEX postings_hash ON postings(account_id, import_hash);

  CREATE TABLE rules (
    id INTEGER PRIMARY KEY,
    pattern TEXT NOT NULL,
    match_type TEXT NOT NULL DEFAULT 'contains' CHECK (match_type IN ('contains','starts_with','exact','regex')),
    account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
    category_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
    transfer_account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
    rename_to TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
    hits INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // v2 — investment accounts, valuations, recurring payments.
  // SQLite can't alter a CHECK constraint, so accounts is rebuilt.
  `
  CREATE TABLE accounts_new (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('current','savings','credit_card','loan','cash','pot','investment','other_asset','other_liability')),
    institution TEXT,
    parent_id INTEGER REFERENCES accounts(id),
    currency TEXT NOT NULL DEFAULT 'GBP',
    anchor_balance INTEGER NOT NULL DEFAULT 0,
    anchor_date TEXT NOT NULL,
    colour TEXT NOT NULL DEFAULT '#64748b',
    archived INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    wrapper TEXT CHECK (wrapper IS NULL OR wrapper IN ('isa','lisa','sipp')),
    funding_account_id INTEGER REFERENCES accounts(id),
    sync_provider TEXT CHECK (sync_provider IS NULL OR sync_provider IN ('trading212')),
    last_synced_at TEXT,
    sync_error TEXT
  );
  INSERT INTO accounts_new (id, name, type, institution, parent_id, currency, anchor_balance, anchor_date, colour, archived, sort_order, created_at)
    SELECT id, name, type, institution, parent_id, currency, anchor_balance, anchor_date, colour, archived, sort_order, created_at FROM accounts;
  DROP TABLE accounts;
  ALTER TABLE accounts_new RENAME TO accounts;

  CREATE TABLE valuations (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    value INTEGER NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    details TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (account_id, date)
  );

  CREATE TABLE recurring (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('bill','subscription','income','saving')),
    amount INTEGER NOT NULL CHECK (amount > 0),
    variable INTEGER NOT NULL DEFAULT 0,
    frequency TEXT NOT NULL CHECK (frequency IN ('weekly','fortnightly','four_weekly','monthly','quarterly','annually')),
    start_date TEXT NOT NULL,
    schedule TEXT NOT NULL DEFAULT 'fixed' CHECK (schedule IN ('fixed','last_working_day')),
    end_date TEXT,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    transfer_account_id INTEGER REFERENCES accounts(id),
    match_pattern TEXT,
    notes TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE recurring_payments (
    id INTEGER PRIMARY KEY,
    recurring_id INTEGER NOT NULL REFERENCES recurring(id) ON DELETE CASCADE,
    due_date TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('paid','skipped')),
    transaction_id INTEGER REFERENCES transactions(id) ON DELETE CASCADE,
    amount INTEGER,
    paid_date TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (recurring_id, due_date)
  );
  CREATE INDEX recurring_payments_txn ON recurring_payments(transaction_id);

  -- Expected amount over time; a new row is added when a price changes.
  CREATE TABLE recurring_amounts (
    id INTEGER PRIMARY KEY,
    recurring_id INTEGER NOT NULL REFERENCES recurring(id) ON DELETE CASCADE,
    effective_date TEXT NOT NULL,
    amount INTEGER NOT NULL,
    detected INTEGER NOT NULL DEFAULT 0
  );
  `,
  // v3 — budgets.
  `
  CREATE TABLE budgets (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    period TEXT NOT NULL CHECK (period IN ('weekly','monthly','annual')),
    rollover INTEGER NOT NULL DEFAULT 0,
    start_date TEXT NOT NULL,
    colour TEXT NOT NULL DEFAULT '#64748b',
    icon TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE budget_categories (
    budget_id INTEGER NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    PRIMARY KEY (budget_id, category_id)
  );
  -- Limit over time, so changing a budget doesn't rewrite past months.
  CREATE TABLE budget_amounts (
    id INTEGER PRIMARY KEY,
    budget_id INTEGER NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
    effective_date TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK (amount > 0),
    UNIQUE (budget_id, effective_date)
  );
  `,
  // v4 — budgets as a % of take-home pay; debt details for card and loan accounts.
  `
  ALTER TABLE budgets ADD COLUMN percent INTEGER CHECK (percent IS NULL OR (percent > 0 AND percent <= 10000));

  CREATE TABLE debts (
    account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    debt_type TEXT NOT NULL CHECK (debt_type IN ('credit_card','personal_loan','student_loan','bnpl','personal','car_finance','overdraft','other')),
    original_balance INTEGER NOT NULL CHECK (original_balance >= 0),
    apr INTEGER NOT NULL DEFAULT 0 CHECK (apr >= 0 AND apr <= 20000),
    promo_apr INTEGER CHECK (promo_apr IS NULL OR (promo_apr >= 0 AND promo_apr <= 20000)),
    promo_end TEXT,
    min_type TEXT NOT NULL DEFAULT 'fixed' CHECK (min_type IN ('fixed','card')),
    min_fixed INTEGER NOT NULL DEFAULT 0 CHECK (min_fixed >= 0),
    min_percent INTEGER NOT NULL DEFAULT 100 CHECK (min_percent >= 0 AND min_percent <= 10000),
    min_floor INTEGER NOT NULL DEFAULT 2500 CHECK (min_floor >= 0),
    due_day INTEGER CHECK (due_day IS NULL OR (due_day BETWEEN 1 AND 31)),
    frequency TEXT NOT NULL DEFAULT 'monthly' CHECK (frequency IN ('weekly','fortnightly','four_weekly','monthly')),
    pays_in_full INTEGER NOT NULL DEFAULT 0,
    payment_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  // v5 — bonuses paid with end-of-month pay count towards the same month as the salary.
  `
  UPDATE categories SET roll_forward = 1 WHERE kind = 'income' AND name = 'Bonuses' AND parent_id IS NULL;
  `,
  // v6 — emoji category icons and ranking, savings-goal budgets, pay-in-3 debts.
  `
  UPDATE categories SET icon = CASE icon WHEN 'shopping-cart' THEN '🛒' WHEN 'tools-kitchen-2' THEN '🍽️' WHEN 'coffee' THEN '☕' WHEN 'bus' THEN '🚌' WHEN 'car' THEN '🚗' WHEN 'shopping-bag' THEN '🛍️' WHEN 'device-tv' THEN '📺' WHEN 'repeat' THEN '🔁' WHEN 'bolt' THEN '⚡' WHEN 'home' THEN '🏠' WHEN 'heartbeat' THEN '💪' WHEN 'plane' THEN '✈️' WHEN 'sparkles' THEN '💅' WHEN 'school' THEN '🎓' WHEN 'book' THEN '📚' WHEN 'percentage' THEN '💸' WHEN 'briefcase' THEN '💼' WHEN 'code' THEN '💻' WHEN 'gift' THEN '🎁' WHEN 'heart' THEN '💝' WHEN 'trending-up' THEN '📈' WHEN 'cash' THEN '💵' WHEN 'piggy-bank' THEN '🐷' WHEN 'phone' THEN '📱' WHEN 'shield' THEN '🛡️' WHEN 'paw' THEN '🐾' WHEN 'baby' THEN '🍼' WHEN 'dots' THEN '📦' ELSE icon END;
  UPDATE budgets SET icon = CASE icon WHEN 'shopping-cart' THEN '🛒' WHEN 'tools-kitchen-2' THEN '🍽️' WHEN 'coffee' THEN '☕' WHEN 'bus' THEN '🚌' WHEN 'car' THEN '🚗' WHEN 'shopping-bag' THEN '🛍️' WHEN 'device-tv' THEN '📺' WHEN 'repeat' THEN '🔁' WHEN 'bolt' THEN '⚡' WHEN 'home' THEN '🏠' WHEN 'heartbeat' THEN '💪' WHEN 'plane' THEN '✈️' WHEN 'sparkles' THEN '💅' WHEN 'school' THEN '🎓' WHEN 'book' THEN '📚' WHEN 'percentage' THEN '💸' WHEN 'briefcase' THEN '💼' WHEN 'code' THEN '💻' WHEN 'gift' THEN '🎁' WHEN 'heart' THEN '💝' WHEN 'trending-up' THEN '📈' WHEN 'cash' THEN '💵' WHEN 'piggy-bank' THEN '🐷' WHEN 'phone' THEN '📱' WHEN 'shield' THEN '🛡️' WHEN 'paw' THEN '🐾' WHEN 'baby' THEN '🍼' WHEN 'dots' THEN '📦' ELSE icon END;
  UPDATE categories SET sort_order = (
    SELECT COUNT(*) FROM categories c2 WHERE c2.kind = categories.kind AND IFNULL(c2.parent_id, 0) = IFNULL(categories.parent_id, 0)
      AND (CASE WHEN categories.parent_id IS NULL THEN c2.id < categories.id ELSE (c2.name < categories.name OR (c2.name = categories.name AND c2.id < categories.id)) END));

  ALTER TABLE budgets ADD COLUMN kind TEXT NOT NULL DEFAULT 'spending' CHECK (kind IN ('spending','saving'));
  ALTER TABLE budgets ADD COLUMN account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE;

  CREATE TABLE debts_new (
    account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
    debt_type TEXT NOT NULL CHECK (debt_type IN ('credit_card','personal_loan','student_loan','bnpl','pay_in_3','personal','car_finance','overdraft','other')),
    original_balance INTEGER NOT NULL CHECK (original_balance >= 0),
    apr INTEGER NOT NULL DEFAULT 0 CHECK (apr >= 0 AND apr <= 20000),
    promo_apr INTEGER CHECK (promo_apr IS NULL OR (promo_apr >= 0 AND promo_apr <= 20000)),
    promo_end TEXT,
    min_type TEXT NOT NULL DEFAULT 'fixed' CHECK (min_type IN ('fixed','card')),
    min_fixed INTEGER NOT NULL DEFAULT 0 CHECK (min_fixed >= 0),
    min_percent INTEGER NOT NULL DEFAULT 100 CHECK (min_percent >= 0 AND min_percent <= 10000),
    min_floor INTEGER NOT NULL DEFAULT 2500 CHECK (min_floor >= 0),
    due_day INTEGER CHECK (due_day IS NULL OR (due_day BETWEEN 1 AND 31)),
    frequency TEXT NOT NULL DEFAULT 'monthly' CHECK (frequency IN ('weekly','fortnightly','four_weekly','monthly')),
    pays_in_full INTEGER NOT NULL DEFAULT 0,
    payment_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    start_date TEXT,
    instalments INTEGER CHECK (instalments IS NULL OR (instalments BETWEEN 2 AND 60)),
    provider TEXT
  );
  INSERT INTO debts_new (account_id, debt_type, original_balance, apr, promo_apr, promo_end, min_type, min_fixed, min_percent, min_floor, due_day, frequency, pays_in_full, payment_account_id, notes, created_at) SELECT account_id, debt_type, original_balance, apr, promo_apr, promo_end, min_type, min_fixed, min_percent, min_floor, due_day, frequency, pays_in_full, payment_account_id, notes, created_at FROM debts;
  DROP TABLE debts;
  ALTER TABLE debts_new RENAME TO debts;
  `,
  // v7 — credit card statement periods (the day each statement closes).
  `
  ALTER TABLE debts ADD COLUMN statement_day INTEGER CHECK (statement_day IS NULL OR (statement_day BETWEEN 1 AND 31));
  `,
  // v8 — keep rows skipped during an import so they can be brought back later.
  `
  CREATE TABLE import_skipped (
    id INTEGER PRIMARY KEY,
    batch_id INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    description TEXT NOT NULL,
    bank_description TEXT NOT NULL,
    amount INTEGER NOT NULL,
    hash TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT 'skipped' CHECK (reason IN ('skipped','possible_duplicate'))
  );
  CREATE INDEX import_skipped_account ON import_skipped(account_id, date);
  `,
  // v9 — goals. One account can hold several: "share" goals have money set aside for them,
  // and at most one "rest" goal per account gets whatever is left. Monthly savings targets
  // (previously savings budgets) move onto the goals.
  `
  CREATE TABLE goals (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT,
    colour TEXT NOT NULL DEFAULT '#0ea5e9',
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    mode TEXT NOT NULL DEFAULT 'rest' CHECK (mode IN ('rest','share')),
    target INTEGER CHECK (target IS NULL OR target > 0),
    deadline TEXT,
    monthly_target INTEGER CHECK (monthly_target IS NULL OR monthly_target > 0),
    monthly_percent INTEGER CHECK (monthly_percent IS NULL OR (monthly_percent > 0 AND monthly_percent <= 10000)),
    is_emergency INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX goals_one_rest ON goals(account_id) WHERE mode = 'rest' AND archived = 0;
  CREATE TABLE goal_moves (
    id INTEGER PRIMARY KEY,
    goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK (amount != 0),
    note TEXT,
    -- Money already in the account when the goal started: not counted as "added" that month.
    opening INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX goal_moves_goal ON goal_moves(goal_id, date);

  INSERT INTO goals (name, icon, colour, account_id, mode, monthly_target, monthly_percent, is_emergency, sort_order)
  SELECT b.name, b.icon, b.colour, b.account_id,
    CASE WHEN b.id = (SELECT MIN(b2.id) FROM budgets b2 WHERE b2.kind = 'saving' AND b2.archived = 0 AND b2.account_id = b.account_id) THEN 'rest' ELSE 'share' END,
    (SELECT ba.amount FROM budget_amounts ba WHERE ba.budget_id = b.id ORDER BY ba.effective_date DESC, ba.id DESC LIMIT 1),
    b.percent,
    CASE WHEN lower(b.name) LIKE '%emergency%' THEN 1 ELSE 0 END,
    b.sort_order
  FROM budgets b WHERE b.kind = 'saving' AND b.archived = 0 AND b.account_id IS NOT NULL;
  DELETE FROM budget_amounts WHERE budget_id IN (SELECT id FROM budgets WHERE kind = 'saving');
  DELETE FROM budget_categories WHERE budget_id IN (SELECT id FROM budgets WHERE kind = 'saving');
  DELETE FROM budgets WHERE kind = 'saving';
  `,
  // v10 — remember when an account's confirmed balance was set, so repayments linked or added
  // afterwards but dated on/before that day can be offered as "not yet taken off".
  `
  ALTER TABLE accounts ADD COLUMN anchor_set_at TEXT;
  UPDATE accounts SET anchor_set_at = created_at;
  CREATE TRIGGER accounts_anchor_insert AFTER INSERT ON accounts WHEN NEW.anchor_set_at IS NULL
  BEGIN UPDATE accounts SET anchor_set_at = datetime('now') WHERE id = NEW.id; END;
  CREATE TRIGGER accounts_anchor_update AFTER UPDATE OF anchor_balance, anchor_date ON accounts
    WHEN NEW.anchor_balance IS NOT OLD.anchor_balance OR NEW.anchor_date IS NOT OLD.anchor_date
  BEGIN UPDATE accounts SET anchor_set_at = datetime('now') WHERE id = NEW.id; END;
  CREATE TABLE debt_reviewed (
    posting_id INTEGER PRIMARY KEY REFERENCES postings(id) ON DELETE CASCADE,
    applied INTEGER NOT NULL,
    reviewed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  // v11 — Trading 212 data kept locally (read-only copy of what the API returns).
  // Money is pence in the account currency; share quantities and prices are REAL as T212 sends them.
  `
  CREATE TABLE t212_sync (
    endpoint TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'never' CHECK (status IN ('never','ok','denied','error','unavailable')),
    message TEXT,
    last_ok_at TEXT,
    last_try_at TEXT,
    items INTEGER NOT NULL DEFAULT 0,
    backfilled INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE t212_instruments (
    ticker TEXT PRIMARY KEY,
    name TEXT, short_name TEXT, isin TEXT, currency TEXT, type TEXT, added_on TEXT
  );
  CREATE TABLE t212_positions (
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    ticker TEXT NOT NULL,
    name TEXT, isin TEXT, currency TEXT,
    quantity REAL NOT NULL,
    quantity_in_pies REAL,
    average_price REAL,
    current_price REAL,
    value INTEGER,
    cost INTEGER,
    unrealised INTEGER,
    fx_impact INTEGER,
    opened_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (account_id, ticker)
  );
  CREATE TABLE t212_orders (
    id TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    order_id TEXT,
    ticker TEXT, name TEXT, isin TEXT,
    side TEXT, type TEXT, status TEXT,
    quantity REAL, price REAL, instrument_currency TEXT,
    net_value INTEGER, realised INTEGER, taxes INTEGER, fx_rate REAL,
    created_at TEXT, filled_at TEXT,
    initiated_from TEXT
  );
  CREATE INDEX t212_orders_date ON t212_orders(account_id, filled_at);
  CREATE TABLE t212_pending (
    id TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    ticker TEXT, name TEXT, side TEXT, type TEXT, status TEXT,
    quantity REAL, value INTEGER, limit_price REAL, stop_price REAL, created_at TEXT
  );
  CREATE TABLE t212_dividends (
    reference TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    ticker TEXT, name TEXT, isin TEXT,
    amount INTEGER NOT NULL, currency TEXT,
    gross_per_share REAL, quantity REAL, type TEXT,
    paid_on TEXT
  );
  CREATE INDEX t212_dividends_date ON t212_dividends(account_id, paid_on);
  CREATE TABLE t212_cash (
    reference TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    amount INTEGER NOT NULL, currency TEXT,
    date_time TEXT
  );
  CREATE INDEX t212_cash_date ON t212_cash(account_id, date_time);
  CREATE TABLE t212_pies (
    id TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name TEXT, cash INTEGER, invested INTEGER, value INTEGER, result INTEGER,
    dividends_gained INTEGER, status TEXT, goal INTEGER,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `,
  // v12 — people who pay you back for a shared bill or subscription (e.g. a family plan).
  `
  CREATE TABLE recurring_shares (
    id INTEGER PRIMARY KEY,
    recurring_id INTEGER NOT NULL REFERENCES recurring(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    match_pattern TEXT,
    amount INTEGER NOT NULL CHECK (amount > 0),
    account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX recurring_shares_r ON recurring_shares(recurring_id);
  `,
  // v13 — which holdings are in which Trading 212 pie, with target and current share.
  `
  CREATE TABLE t212_pie_instruments (
    pie_id TEXT NOT NULL REFERENCES t212_pies(id) ON DELETE CASCADE,
    ticker TEXT NOT NULL,
    owned_quantity REAL,
    expected_share REAL,
    current_share REAL,
    invested INTEGER, value INTEGER, result INTEGER,
    PRIMARY KEY (pie_id, ticker)
  );
  `,
  // v14 — the payday routine: your own extra steps, what's ticked off each payday, and a log of each one.
  `
  CREATE TABLE payday_items (
    id INTEGER PRIMARY KEY,
    text TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE payday_checks (
    cycle TEXT NOT NULL,
    key TEXT NOT NULL,
    at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (cycle, key)
  );
  CREATE TABLE payday_logs (
    cycle TEXT PRIMARY KEY,
    period TEXT NOT NULL,
    completed_at TEXT NOT NULL DEFAULT (datetime('now')),
    snapshot TEXT NOT NULL
  );
  `,
  // v15 — the app is now Coil, in navy and champagne gold: the old default accent (coral) and the
  // old default name become the new ones. A colour or name you chose yourself is kept.
  `
  UPDATE settings SET value = replace(value, '"accent":"#ff5b45"', '"accent":"#d9c08e"') WHERE key = 'appearance';
  UPDATE settings SET value = replace(value, '"appName":"Ledger"', '"appName":""') WHERE key = 'profile';
  `,
];

export function openDb(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  migrate(db, file);
  seed(db);
  ensureDefaults(db);
  return db;
}

function migrate(db: DB, file: string) {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  let version = row.user_version;
  if (version >= MIGRATIONS.length) return;
  // Snapshot an existing database before changing its structure.
  if (version > 0 && file !== ':memory:') {
    const dir = path.join(path.dirname(file), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, `before-upgrade-v${version}-to-v${MIGRATIONS.length}-${Date.now()}.db`);
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    console.log(`  Database upgraded; previous version saved to ${target}`);
  }
  // Table rebuilds need foreign keys off (can only be toggled outside a transaction).
  db.exec('PRAGMA foreign_keys = OFF;');
  try {
    while (version < MIGRATIONS.length) {
      tx(db, () => {
        db.exec(MIGRATIONS[version]);
        const broken = db.prepare('PRAGMA foreign_key_check').all();
        if (broken.length) throw new Error(`Migration ${version + 1} broke ${broken.length} references`);
        db.exec(`PRAGMA user_version = ${version + 1}`);
      });
      version++;
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON;');
  }
}

/** Run fn inside a transaction; rolls back on error. Supports nesting via savepoints. */
let depth = 0;
export function tx<T>(db: DB, fn: () => T): T {
  const sp = `sp${depth}`;
  db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
  depth++;
  try {
    const result = fn();
    depth--;
    db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
    return result;
  } catch (err) {
    depth--;
    db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
    throw err;
  }
}

export function getSetting(db: DB, key: string, fallback: string): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : fallback;
}

export function setSetting(db: DB, key: string, value: string) {
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function backup(db: DB, dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(dir, `finance-${stamp}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  return file;
}
