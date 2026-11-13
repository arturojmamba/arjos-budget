import type { DB } from './db.ts';
import { todayIso } from './dates.ts';

type Cat = { name: string; colour: string; icon: string; fixed?: boolean; rollForward?: boolean };

export const DEFAULT_EXPENSE_CATEGORIES: Cat[] = [
  { name: 'Groceries', colour: '#16a34a', icon: '🛒' },
  { name: 'Eating Out', colour: '#f97316', icon: '🍽️' },
  { name: 'Transport', colour: '#0ea5e9', icon: '🚌' },
  { name: 'Shopping', colour: '#ec4899', icon: '🛍️' },
  { name: 'Entertainment', colour: '#8b5cf6', icon: '📺' },
  { name: 'Subscriptions', colour: '#6366f1', icon: '🔁', fixed: true },
  { name: 'Bills & Utilities', colour: '#eab308', icon: '⚡', fixed: true },
  { name: 'Rent / Housing', colour: '#b45309', icon: '🏠', fixed: true },
  { name: 'Health & Fitness', colour: '#14b8a6', icon: '💪' },
  { name: 'Travel', colour: '#06b6d4', icon: '✈️' },
  { name: 'Personal Care', colour: '#f43f5e', icon: '💅' },
  { name: 'Education', colour: '#3b82f6', icon: '🎓' },
  { name: 'Interest & Fees', colour: '#dc2626', icon: '💸' },
  { name: 'Miscellaneous', colour: '#64748b', icon: '📦' },
];

export const DEFAULT_INCOME_CATEGORIES: Cat[] = [
  { name: 'Salary', colour: '#059669', icon: '💼', rollForward: true },
  { name: 'Freelance', colour: '#0891b2', icon: '💻' },
  { name: 'Bonuses', colour: '#65a30d', icon: '🎁', rollForward: true },
  { name: 'Gifts', colour: '#d946ef', icon: '💝' },
  { name: 'Interest', colour: '#0d9488', icon: '📈' },
  { name: 'Other Income', colour: '#64748b', icon: '💵' },
];

/** A neutral starting set for a brand-new database. Rename, add or archive them under Accounts. */
const DEFAULT_ACCOUNTS = [
  { name: 'Current account', type: 'current', institution: null, colour: '#2563eb' },
  { name: 'Credit card', type: 'credit_card', institution: null, colour: '#7c3aed' },
  { name: 'Savings', type: 'savings', institution: null, colour: '#0d9488' },
];

/** One-off additions for features added after the first release. */
export function ensureDefaults(db: DB) {
  const done = db.prepare("SELECT value FROM settings WHERE key = 'isa_seeded'").get();
  if (done) return;
  db.prepare(
    `INSERT INTO accounts (name, type, institution, colour, anchor_balance, anchor_date, sort_order, wrapper, sync_provider)
     SELECT 'Trading 212 ISA', 'investment', 'Trading 212', '#13a5e0', 0, ?, (SELECT IFNULL(MAX(sort_order), 0) + 1 FROM accounts), 'isa', 'trading212'
     WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE institution = 'Trading 212')`,
  ).run(todayIso());
  db.prepare("INSERT INTO settings(key, value) VALUES ('isa_seeded', '1')").run();
}

export function seed(db: DB) {
  const seeded = db.prepare("SELECT value FROM settings WHERE key = 'seeded'").get();
  if (seeded) return;
  db.exec('BEGIN');
  try {
    const insCat = db.prepare(
      'INSERT INTO categories(name, kind, colour, icon, is_fixed, roll_forward, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    DEFAULT_EXPENSE_CATEGORIES.forEach((c, i) =>
      insCat.run(c.name, 'expense', c.colour, c.icon, c.fixed ? 1 : 0, 0, i),
    );
    DEFAULT_INCOME_CATEGORIES.forEach((c, i) =>
      insCat.run(c.name, 'income', c.colour, c.icon, 0, c.rollForward ? 1 : 0, i),
    );
    const insAcc = db.prepare(
      'INSERT INTO accounts(name, type, institution, colour, anchor_balance, anchor_date, sort_order) VALUES (?, ?, ?, ?, 0, ?, ?)',
    );
    const today = todayIso();
    DEFAULT_ACCOUNTS.forEach((a, i) => insAcc.run(a.name, a.type, a.institution, a.colour, today, i));

    const set = db.prepare('INSERT INTO settings(key, value) VALUES (?, ?)');
    set.run('seeded', '1');
    // Salary paid in the last N days of a month funds the following month.
    set.run('rollforward_days', '5');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
