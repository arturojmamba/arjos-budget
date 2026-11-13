/**
 * All money is stored and calculated as integer pence. Never use floats for
 * arithmetic — only convert at the edges (parsing user/CSV input, display).
 */

export type Pence = number;

/**
 * Parse a money string like "£1,234.56", "-12.3", "(45.00)", "12.30 CR" into pence.
 * Uses string manipulation, not float multiplication, so there is no rounding drift.
 * Returns null when the input isn't a valid amount.
 */
export function parseMoney(input: string | number | null | undefined): Pence | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null;
    return parseMoney(input.toFixed(2));
  }
  let s = input.trim();
  if (s === '') return null;

  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  if (/\s*CR$/i.test(s)) {
    s = s.replace(/\s*CR$/i, '');
  } else if (/\s*DR$/i.test(s)) {
    negative = !negative;
    s = s.replace(/\s*DR$/i, '');
  }
  s = s.replace(/[£$€\s,]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  }
  // Trailing minus as used by some banks: "12.34-"
  if (s.endsWith('-')) {
    negative = !negative;
    s = s.slice(0, -1);
  }
  if (!/^\d+(\.\d+)?$/.test(s) && !/^\.\d+$/.test(s)) return null;

  const [wholeRaw, fracRaw = ''] = s.split('.');
  const whole = wholeRaw === '' ? 0 : parseInt(wholeRaw, 10);
  let frac = fracRaw.padEnd(3, '0');
  // Round half away from zero on the third decimal place.
  let pence = whole * 100 + parseInt(frac.slice(0, 2), 10);
  if (parseInt(frac[2], 10) >= 5) pence += 1;
  if (!Number.isSafeInteger(pence)) return null;
  return negative && pence !== 0 ? -pence : pence;
}

export function formatPence(p: Pence, opts: { sign?: boolean } = {}): string {
  const abs = Math.abs(p);
  const pounds = Math.floor(abs / 100).toLocaleString('en-GB');
  const pennies = String(abs % 100).padStart(2, '0');
  const sign = p < 0 ? '-' : opts.sign && p > 0 ? '+' : '';
  return `${sign}£${pounds}.${pennies}`;
}

export function assertPence(value: unknown, field = 'amount'): Pence {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new ValidationError(`${field} must be a whole number of pence`);
  }
  return value;
}

export class ValidationError extends Error {
  status = 400;
}
