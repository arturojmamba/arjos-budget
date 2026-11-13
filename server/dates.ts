/** Dates are stored as ISO "YYYY-MM-DD" strings (local calendar dates, no time zone). */

export function isIsoDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  const ta = Date.parse(a + 'T00:00:00Z');
  const tb = Date.parse(b + 'T00:00:00Z');
  return Math.round((tb - ta) / 86_400_000);
}

export function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

/** Parse common bank date formats into ISO. UK banks use day-first. */
export function parseBankDate(input: string, format: 'DMY' | 'YMD' | 'MDY' = 'DMY'): string | null {
  const s = input.trim();
  if (isIsoDate(s.slice(0, 10)) && /^\d{4}-/.test(s)) return s.slice(0, 10);
  const months: Record<string, number> = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  };
  // "05 Nov 2026" / "5-Nov-26"
  let m = s.match(/^(\d{1,2})[\s\-\/]([A-Za-z]{3})[A-Za-z]*[\s\-\/](\d{2,4})/);
  if (m) {
    const mon = months[m[2].toLowerCase()];
    if (!mon) return null;
    return build(+m[3], mon, +m[1]);
  }
  m = s.match(/^(\d{1,4})[\/\-.](\d{1,2})[\/\-.](\d{1,4})/);
  if (!m) return null;
  const [a, b, c] = [+m[1], +m[2], +m[3]];
  if (m[1].length === 4) return build(a, b, c);
  if (format === 'MDY') return build(c, a, b);
  return build(c, b, a);

  function build(y: number, mo: number, d: number): string | null {
    if (y < 100) y += 2000;
    const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    return isIsoDate(iso) ? iso : null;
  }
}
