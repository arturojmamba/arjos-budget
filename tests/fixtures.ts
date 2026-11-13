/**
 * Test database with entirely fictional banks and accounts.
 * Real bank CSV formats (Lloyds, Amex…) are still exercised by the importer
 * tests, but every account, merchant, person and amount here is made up.
 */
import { openDb } from '../server/db.ts';
import { todayIso } from '../server/dates.ts';

export const TEST_ACCOUNTS = [
  { name: 'Northbank Current', type: 'current', institution: 'Northbank', colour: '#1d4ed8' },
  { name: 'Northbank Credit Card', type: 'credit_card', institution: 'Northbank', colour: '#3b82f6' },
  { name: 'Crest Card 1', type: 'credit_card', institution: 'Crest', colour: '#7c3aed' },
  { name: 'Crest Card 2', type: 'credit_card', institution: 'Crest', colour: '#a78bfa' },
  { name: 'Harbour Savings', type: 'savings', institution: 'Harbour', colour: '#0d9488' },
  { name: 'Lark', type: 'current', institution: 'Lark', colour: '#db2777' },
];

export function testDb() {
  const db = openDb(':memory:');
  db.exec("DELETE FROM accounts WHERE institution IS NULL OR institution != 'Trading 212'");
  const ins = db.prepare('INSERT INTO accounts(name, type, institution, colour, anchor_balance, anchor_date, sort_order) VALUES (?, ?, ?, ?, 0, ?, ?)');
  TEST_ACCOUNTS.forEach((a, i) => ins.run(a.name, a.type, a.institution, a.colour, todayIso(), i));
  return db;
}
