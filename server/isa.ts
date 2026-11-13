/**
 * ISA allowance (7.4), from Trading 212's own record of deposits and withdrawals
 * when the ISA is synced, otherwise from the transfers on your bank statements.
 *
 * Trading 212's ISAs are flexible: money taken out can be put back in the same
 * tax year without using allowance. Deposits after a withdrawal replace it first.
 * Worked through in date order:
 *   withdrawal → adds to "can put back"
 *   deposit    → first uses up "can put back", the rest counts against the allowance
 *
 * Each Trading 212 deposit is also paired with the bank transfer that paid for it,
 * so money moved from savings (a savings account) shows as such and gaps stand out.
 */
import { type DB } from './db.ts';
import { addDays, daysBetween, monthOf, addMonths, todayIso } from './dates.ts';
import { taxYear, syncedAccounts, ISA_ALLOWANCE } from './investments.ts';

const SAVINGS_TYPES = new Set(['savings', 'pot', 'investment']);
const MATCH_DAYS = 5;

interface T212Event { date: string; type: string; amount: number; reference: string }
interface BankMove { transactionId: number; date: string; amount: number; account: string | null; accountType: string | null; description: string }

/** Work through the year's deposits and withdrawals in order (flexible ISA rules). */
export function flexibleUse(events: { date: string; amount: number }[]) {
  let replaceable = 0, used = 0, paidIn = 0, withdrawn = 0, replaced = 0;
  for (const e of [...events].sort((a, b) => a.date.localeCompare(b.date))) {
    if (e.amount < 0) { replaceable += -e.amount; withdrawn += -e.amount; continue; }
    paidIn += e.amount;
    const r = Math.min(replaceable, e.amount);
    replaceable -= r; replaced += r;
    used += e.amount - r;
  }
  return { paidIn, withdrawn, replaced, replaceable, used };
}

export function isaStatus(db: DB, today = todayIso()) {
  const ty = taxYear(today);
  const isaAccounts = db.prepare("SELECT id, name, sync_provider FROM accounts WHERE wrapper = 'isa' AND archived = 0 ORDER BY id").all() as { id: number; name: string; sync_provider: string | null }[];
  const synced = new Set(syncedAccounts(db));
  const hasT212 = (db.prepare("SELECT status FROM t212_sync WHERE endpoint = 'cash'").get() as { status: string } | undefined)?.status === 'ok';

  const accounts = isaAccounts.map((a) => {
    const fromT212 = hasT212 && synced.has(a.id) && a.sync_provider === 'trading212';
    const events: T212Event[] = fromT212
      ? (db.prepare(
        `SELECT substr(date_time, 1, 10) AS date, type, amount, reference FROM t212_cash
         WHERE account_id = ? AND type IN ('DEPOSIT','WITHDRAW','TRANSFER') AND substr(date_time, 1, 10) BETWEEN ? AND ? ORDER BY date_time`,
      ).all(a.id, ty.start, ty.end) as unknown as T212Event[])
      : [];
    const bank = db.prepare(
      `SELECT t.id AS transactionId, t.date, p.amount, t.description,
              (SELECT x.name FROM postings p2 JOIN accounts x ON x.id = p2.account_id WHERE p2.transaction_id = t.id AND p2.account_id != p.account_id LIMIT 1) AS account,
              (SELECT x.type FROM postings p2 JOIN accounts x ON x.id = p2.account_id WHERE p2.transaction_id = t.id AND p2.account_id != p.account_id LIMIT 1) AS accountType
       FROM postings p JOIN transactions t ON t.id = p.transaction_id
       WHERE p.account_id = ? AND t.kind = 'transfer' AND t.date BETWEEN ? AND ? ORDER BY t.date`,
    ).all(a.id, ty.start, ty.end) as unknown as BankMove[];

    const flex = flexibleUse(fromT212 ? events.map((e) => ({ date: e.date, amount: e.amount })) : bank.map((b) => ({ date: b.date, amount: b.amount })));
    return { id: a.id, name: a.name, source: fromT212 ? 'trading212' as const : 'bank' as const, ...flex, events, bank };
  });

  const used = accounts.reduce((n, a) => n + a.used, 0);
  const remaining = Math.max(0, ISA_ALLOWANCE - used);
  const daysLeft = Math.max(0, daysBetween(today, ty.end));
  // Paydays left this tax year: one per month from next month up to March (or April if before the 5th).
  const monthsLeft = Math.max(1, monthsUntil(today, ty.end));
  const main = accounts.find((a) => a.source === 'trading212') ?? accounts[0] ?? null;
  return {
    taxYear: ty.label, start: ty.start, end: ty.end, allowance: ISA_ALLOWANCE,
    used, remaining, over: Math.max(0, used - ISA_ALLOWANCE),
    paidIn: accounts.reduce((n, a) => n + a.paidIn, 0),
    withdrawn: accounts.reduce((n, a) => n + a.withdrawn, 0),
    replaced: accounts.reduce((n, a) => n + a.replaced, 0),
    replaceable: accounts.reduce((n, a) => n + a.replaceable, 0),
    daysLeft, monthsLeft, perMonthToFill: Math.ceil(remaining / monthsLeft),
    source: main?.source ?? 'bank',
    accounts: accounts.map((a) => ({ id: a.id, name: a.name, source: a.source, paidIn: a.paidIn, withdrawn: a.withdrawn, used: a.used, replaceable: a.replaceable })),
    matching: main && main.source === 'trading212' ? matchDeposits(main.events, main.bank) : null,
  };
}

function monthsUntil(today: string, end: string) {
  let n = 0;
  for (let m = addMonths(monthOf(today), 1); `${m}-01` <= end; m = addMonths(m, 1)) n++;
  return n;
}

/**
 * Pair each Trading 212 deposit/withdrawal with the bank transfer for it: same amount,
 * within a few days, closest first.
 */
export function matchDeposits(events: T212Event[], bank: BankMove[]) {
  const free = bank.map((b) => ({ ...b, used: false }));
  const matched: { date: string; bankDate: string; amount: number; type: string; from: string | null; fromSavings: boolean; lagDays: number }[] = [];
  const t212Only: { date: string; amount: number; type: string; note: string }[] = [];
  for (const e of [...events].sort((a, b) => a.date.localeCompare(b.date))) {
    const cands = free.filter((b) => !b.used && b.amount === e.amount && Math.abs(daysBetween(b.date, e.date)) <= MATCH_DAYS)
      .sort((x, y) => Math.abs(daysBetween(x.date, e.date)) - Math.abs(daysBetween(y.date, e.date)));
    const hit = cands[0];
    if (hit) {
      hit.used = true;
      matched.push({ date: e.date, bankDate: hit.date, amount: e.amount, type: e.type, from: hit.account, fromSavings: !!hit.accountType && SAVINGS_TYPES.has(hit.accountType) && e.amount > 0, lagDays: daysBetween(hit.date, e.date) });
    } else {
      t212Only.push({
        date: e.date, amount: e.amount, type: e.type,
        note: e.type === 'TRANSFER' ? 'A transfer within Trading 212 or from another provider' : e.amount < 0 ? 'Not on an imported bank statement yet' : 'Not on an imported bank statement: a card deposit, or a statement not imported yet',
      });
    }
  }
  const bankOnly = free.filter((b) => !b.used).map((b) => ({ date: b.date, amount: b.amount, from: b.account, description: b.description, note: daysBetween(b.date, todayIso()) <= MATCH_DAYS ? 'Probably still on its way' : 'No matching Trading 212 record' }));
  const fromSavings = matched.filter((m) => m.fromSavings).reduce((n, m) => n + m.amount, 0);
  const deposits = matched.filter((m) => m.amount > 0).reduce((n, m) => n + m.amount, 0);
  return {
    matched: matched.reverse(), t212Only, bankOnly,
    fromSavings, fromPay: deposits - fromSavings,
    bySource: Object.entries(matched.filter((m) => m.amount > 0).reduce<Record<string, number>>((acc, m) => { const k = m.from ?? 'Unknown'; acc[k] = (acc[k] ?? 0) + m.amount; return acc; }, {}))
      .map(([account, amount]) => ({ account, amount, savings: matched.some((m) => m.from === account && m.fromSavings) })).sort((a, b) => b.amount - a.amount),
  };
}

/** Same numbers in the shape older screens use (Accounts card, year in review). */
export function isaAllowanceSummary(db: DB, today = todayIso()) {
  const s = isaStatus(db, today);
  return { taxYear: s.taxYear, start: s.start, end: s.end, allowance: s.allowance, used: s.used, remaining: s.remaining, source: s.source, replaceable: s.replaceable, accounts: s.accounts };
}

export { addDays };
