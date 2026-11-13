/**
 * Data health checks: things that quietly make the numbers wrong if left alone.
 * Each check returns a plain-English problem and where to fix it.
 */
import { type DB } from './db.ts';
import { addDays, todayIso } from './dates.ts';
import { occurrences } from './recurring.ts';
import { uncountedRepayments } from './debts.ts';
import { uninvestedCash } from './t212.ts';
import { syncedAccounts } from './investments.ts';
import { formatPence } from './money.ts';

export interface HealthIssue {
  id: string;
  level: 'warn' | 'info';
  title: string;
  detail: string;
  link: string;
  linkLabel: string;
}

export function healthChecks(db: DB, today = todayIso()): HealthIssue[] {
  const out: HealthIssue[] = [];

  // Accounts you import into that haven't had anything new for a while.
  const stale = db.prepare(
    `SELECT a.id, a.name, MAX(t.date) AS last FROM accounts a
     JOIN postings p ON p.account_id = a.id JOIN transactions t ON t.id = p.transaction_id
     WHERE a.archived = 0 AND a.sync_provider IS NULL AND EXISTS (SELECT 1 FROM import_batches b WHERE b.account_id = a.id)
     GROUP BY a.id HAVING last < ?`,
  ).all(addDays(today, -30)) as { id: number; name: string; last: string }[];
  for (const s of stale) {
    const days = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${s.last}T12:00:00Z`)) / 86400000);
    out.push({ id: `stale-${s.id}`, level: 'info', title: `${s.name} hasn't been updated in ${days} days`, detail: `Latest transaction is from ${s.last}. Import a new statement so balances and budgets stay right.`, link: '/import', linkLabel: 'Import' });
  }

  const uncat = (db.prepare(
    `SELECT COUNT(DISTINCT t.id) AS n FROM transactions t JOIN postings p ON p.transaction_id = t.id
     WHERE t.kind != 'transfer' AND p.category_id IS NULL AND t.date >= ?`,
  ).get(addDays(today, -90)) as { n: number }).n;
  if (uncat > 0) out.push({ id: 'uncategorised', level: 'warn', title: `${uncat} transaction${uncat === 1 ? '' : 's'} without a category`, detail: 'From the last 90 days. They show as "Uncategorised" in reports and budgets.', link: '/transactions?uncategorised=1&month=all', linkLabel: 'Categorise' });

  const dupAccounts = db.prepare(
    `SELECT lower(name) AS k, GROUP_CONCAT(name, ', ') AS names, COUNT(*) AS n FROM accounts WHERE archived = 0 GROUP BY lower(name) HAVING n > 1`,
  ).all() as { k: string; names: string; n: number }[];
  for (const d of dupAccounts) out.push({ id: `dup-acct-${d.k}`, level: 'warn', title: `${d.n} accounts called “${d.names.split(', ')[0]}”`, detail: 'If one is a mistake, delete or archive it so it isn’t counted twice.', link: '/accounts', linkLabel: 'Accounts' });

  // The same amount on the same account within a day, where one was typed in and one imported (or both typed in).
  const dupTx = (db.prepare(
    `SELECT COUNT(*) AS n FROM postings p1 JOIN transactions t1 ON t1.id = p1.transaction_id
     JOIN postings p2 ON p2.account_id = p1.account_id AND p2.amount = p1.amount AND p2.id > p1.id
     JOIN transactions t2 ON t2.id = p2.transaction_id
     WHERE t1.id != t2.id AND ABS(julianday(t1.date) - julianday(t2.date)) <= 1 AND t1.date >= ?
       AND (p1.import_hash IS NULL OR p2.import_hash IS NULL)
       AND (lower(t1.merchant) = lower(t2.merchant) OR lower(t1.description) = lower(t2.description))`,
  ).get(addDays(today, -120)) as { n: number }).n;
  if (dupTx > 0) out.push({ id: 'dup-tx', level: 'warn', title: `${dupTx} possible duplicate transaction${dupTx === 1 ? '' : 's'}`, detail: 'Same account, amount and name within a day, where at least one was added by hand. Check and delete the extra one.', link: '/transactions?month=all', linkLabel: 'Transactions' });

  const overdue = occurrences(db, addDays(today, -45), today).filter((o) => o.status === 'overdue');
  if (overdue.length) out.push({ id: 'overdue', level: 'warn', title: `${overdue.length} bill${overdue.length === 1 ? '' : 's'} marked overdue`, detail: `${overdue.slice(0, 3).map((o) => o.name).join(', ')}${overdue.length > 3 ? '…' : ''}. If they were paid under a different name, mark them paid so they stop counting as still to pay.`, link: '/bills', linkLabel: 'Bills' });

  const noDetails = db.prepare(
    `SELECT a.name FROM accounts a WHERE a.archived = 0 AND a.type IN ('credit_card','loan','other_liability')
     AND NOT EXISTS (SELECT 1 FROM debts d WHERE d.account_id = a.id)`,
  ).all() as { name: string }[];
  if (noDetails.length) out.push({ id: 'debt-details', level: 'info', title: `${noDetails.length} card${noDetails.length === 1 ? '' : 's'} or loan${noDetails.length === 1 ? '' : 's'} without details`, detail: `${noDetails.map((d) => d.name).join(', ')}. Add the APR and payments to see payoff dates and interest.`, link: '/debts', linkLabel: 'Debts' });

  const debts = db.prepare("SELECT id, name FROM accounts WHERE archived = 0 AND type IN ('loan','other_liability')").all() as { id: number; name: string }[];
  const unc = debts.filter((d) => uncountedRepayments(db, d.id).length > 0);
  if (unc.length) out.push({ id: 'uncounted', level: 'info', title: `Repayments to check on ${unc.map((u) => u.name).join(', ')}`, detail: 'They’re dated on or before the day you set the amount owed. Decide whether they should come off.', link: '/debts', linkLabel: 'Debts' });

  // Cash sitting in Trading 212 for a week or more isn't working for you.
  const t212 = syncedAccounts(db)[0];
  const idle = t212 ? uninvestedCash(db, t212, today) : null;
  if (idle?.nudge) out.push({ id: 'idle-cash', level: 'info', title: `${formatPence(idle.amount)} uninvested in Trading 212`, detail: `It's been sitting as cash for ${idle.days} days. Invest it or move it, if it isn't meant to be there.`, link: '/accounts', linkLabel: 'Accounts' });

  return out;
}
