/**
 * England & Wales bank holidays and working-day helpers, used for "last working
 * day of the month" salary dates and for weekend-shifted direct debits.
 * One-off holidays (e.g. coronations) can be added to EXTRA.
 */
import { addDays, daysInMonth } from './dates.ts';

const EXTRA: string[] = [];

const cache = new Map<number, Set<string>>();

function iso(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function weekday(date: string): number {
  return new Date(date + 'T00:00:00Z').getUTCDay(); // 0 = Sunday
}

/** Gregorian Easter Sunday (Anonymous Gregorian algorithm). */
function easter(y: number): string {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(y, month, day);
}

function firstMonday(y: number, m: number): string {
  let d = iso(y, m, 1);
  while (weekday(d) !== 1) d = addDays(d, 1);
  return d;
}

function lastMonday(y: number, m: number): string {
  let d = iso(y, m, daysInMonth(iso(y, m, 1).slice(0, 7)));
  while (weekday(d) !== 1) d = addDays(d, -1);
  return d;
}

export function bankHolidays(year: number): Set<string> {
  if (cache.has(year)) return cache.get(year)!;
  const set = new Set<string>();
  // New Year's Day (substitute Monday if weekend)
  let ny = iso(year, 1, 1);
  while (weekday(ny) === 0 || weekday(ny) === 6) ny = addDays(ny, 1);
  set.add(ny);
  const e = easter(year);
  set.add(addDays(e, -2)); // Good Friday
  set.add(addDays(e, 1)); // Easter Monday
  set.add(firstMonday(year, 5)); // Early May
  set.add(lastMonday(year, 5)); // Spring
  set.add(lastMonday(year, 8)); // Summer
  // Christmas and Boxing Day with substitutes
  const xmas = iso(year, 12, 25);
  const boxing = iso(year, 12, 26);
  const wx = weekday(xmas);
  if (wx === 6) { set.add(iso(year, 12, 27)); set.add(iso(year, 12, 28)); }
  else if (wx === 0) { set.add(boxing); set.add(iso(year, 12, 27)); }
  else if (wx === 5) { set.add(xmas); set.add(iso(year, 12, 28)); }
  else { set.add(xmas); set.add(boxing); }
  for (const x of EXTRA) if (x.startsWith(String(year))) set.add(x);
  cache.set(year, set);
  return set;
}

export function isWorkingDay(date: string): boolean {
  const w = weekday(date);
  if (w === 0 || w === 6) return false;
  return !bankHolidays(Number(date.slice(0, 4))).has(date);
}

export function lastWorkingDay(month: string): string {
  let d = `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;
  while (!isWorkingDay(d)) d = addDays(d, -1);
  return d;
}

export function nextWorkingDay(date: string): string {
  let d = date;
  while (!isWorkingDay(d)) d = addDays(d, 1);
  return d;
}
