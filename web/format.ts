/** Display helpers. Amounts are integer pence everywhere. */

/** When balances are hidden, every formatted amount is masked (inputs are unaffected). */
let hidden = false;
export function setAmountsHidden(v: boolean) { hidden = v; }
export function amountsHidden() { return hidden; }
/** Whole pounds only (£1,234) when pence are switched off in Settings → Appearance. */
let pence = true;
export function setShowPence(v: boolean) { pence = v; }
/** A label that would reveal good/bad (e.g. "Over budget") is replaced by a neutral one while amounts are hidden. */
export function privateLabel(good: boolean, ifGood: string, ifBad: string, neutral: string): string {
  return hidden ? neutral : good ? ifGood : ifBad;
}

export function money(p: number, opts: { sign?: boolean; abs?: boolean; compact?: boolean } = {}): string {
  if (hidden) return '£••••';
  const v = opts.abs ? Math.abs(p) : p;
  const neg = v < 0;
  const abs = Math.abs(v);
  let body: string;
  if (opts.compact && abs >= 100_000_00) body = `£${(abs / 100_000_00).toFixed(1)}m`;
  else if (opts.compact && abs >= 10_000_00) body = `£${Math.round(abs / 100_000)}k`;
  else if (opts.compact) body = `£${Math.round(abs / 100).toLocaleString('en-GB')}`;
  else if (!pence) body = `£${Math.round(abs / 100).toLocaleString('en-GB')}`;
  else body = `£${Math.floor(abs / 100).toLocaleString('en-GB')}.${String(abs % 100).padStart(2, '0')}`;
  if (neg) return `−${body}`;
  if (opts.sign && v > 0) return `+${body}`;
  return body;
}

/** Parse what the user typed in an amount box into pence (string maths, no floats). */
export function parseAmount(input: string): number | null {
  const s = input.replace(/[£,\s]/g, '');
  if (!/^\d*(\.\d{0,2})?$/.test(s) || s === '' || s === '.') return null;
  const [w, f = ''] = s.split('.');
  return (w ? parseInt(w, 10) : 0) * 100 + parseInt(f.padEnd(2, '0') || '0', 10);
}

export function penceToInput(p: number): string {
  const a = Math.abs(p);
  return `${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function monthLabel(m: string, short = false): string {
  const [y, mo] = m.split('-').map(Number);
  const name = MONTHS[mo - 1];
  return short ? `${name.slice(0, 3)}` : `${name} ${y}`;
}

export function dayLabel(iso: string, today: string): string {
  if (iso === today) return 'Today';
  const d = new Date(iso + 'T00:00:00');
  const t = new Date(today + 'T00:00:00');
  const diff = Math.round((t.getTime() - d.getTime()) / 86400000);
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', ...(d.getFullYear() !== t.getFullYear() ? { year: 'numeric' } : {}) });
}

export function shortDate(iso: string): string {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function pct(n: number | null, digits = 0): string {
  return n === null || !Number.isFinite(n) ? '—' : `${(n * 100).toFixed(digits)}%`;
}

export const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  current: 'Current account', savings: 'Savings', cash: 'Cash', pot: 'Savings pot', investment: 'Investments', other_asset: 'Other asset',
  credit_card: 'Credit card', loan: 'Loan', other_liability: 'Other debt',
};

export function initials(name: string): string {
  return name.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w[0] ?? '')).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
}

export const FREQUENCY_LABELS: Record<string, string> = {
  weekly: 'Weekly', fortnightly: 'Every 2 weeks', four_weekly: 'Every 4 weeks', monthly: 'Monthly', quarterly: 'Quarterly', annually: 'Yearly',
};

export const RECURRING_TYPE_LABELS: Record<string, string> = {
  bill: 'Bill', subscription: 'Subscription', saving: 'Saving', income: 'Income',
};

/** "in 3 days", "today", "2 days ago" */
export function relativeDay(iso: string, today: string): string {
  const d = Math.round((new Date(iso + 'T00:00:00').getTime() - new Date(today + 'T00:00:00').getTime()) / 86400000);
  if (d === 0) return 'Today';
  if (d === 1) return 'Tomorrow';
  if (d === -1) return 'Yesterday';
  return d > 0 ? `In ${d} days` : `${-d} days ago`;
}

export function dayMonth(iso: string): { day: string; month: string } {
  const d = new Date(iso + 'T00:00:00');
  return { day: String(d.getDate()), month: d.toLocaleDateString('en-GB', { month: 'short' }) };
}

export function timeAgo(sqlUtc: string): string {
  const t = new Date(sqlUtc.replace(' ', 'T') + 'Z').getTime();
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** Spending categories with names like these are usually money moving between your own accounts or paying off debt. */
export function looksLikeTransfer(name: string): boolean {
  return /\b(debt|repay|repayment|transfer|savings?|pot|isa|credit card|card payment|loan payment)\b/i.test(name);
}
