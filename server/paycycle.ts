/**
 * Pay cycle: your pay, its paydays, the month each payday funds, and how far through
 * the cycle today is (see GLOSSARY.md: Your pay, Payday, Pay cycle, Funded month).
 *
 * Every screen and rule that needs a payday asks here; nothing else works one out.
 *   - Your pay: the biggest active monthly income in Bills and income.
 *   - Payday: the last working day (bank holidays included) or a fixed day of the month.
 *   - Funded month: pay in the last few days of a month (Settings → Budgeting, 5 by default)
 *     funds the next month; otherwise it funds the month it lands in.
 *   - No pay set up: the cycle is the calendar month.
 */
import { type DB, getSetting } from './db.ts';
import { addMonths, daysBetween, daysInMonth, monthOf, todayIso } from './dates.ts';
import { lastWorkingDay } from './calendar.ts';

export interface YourPay { id: number; name: string; amount: number; schedule: string; start_date: string; account_id: number; category_id: number | null }

/** Your pay: the biggest active monthly income item, if you've set one up. */
export function yourPay(db: DB): YourPay | null {
  return (db.prepare(
    "SELECT id, name, amount, schedule, start_date, account_id, category_id FROM recurring WHERE type = 'income' AND active = 1 AND frequency = 'monthly' ORDER BY amount DESC, id LIMIT 1",
  ).get() as YourPay | undefined) ?? null;
}

/** The payday in a month (YYYY-MM). */
export function paydayIn(month: string, pay: YourPay | null): string {
  if (!pay || pay.schedule === 'last_working_day') return lastWorkingDay(month);
  const day = Math.min(Number(pay.start_date.slice(8, 10)), daysInMonth(month));
  return `${month}-${String(day).padStart(2, '0')}`;
}

/** The latest payday on or before a date. */
export function paydayOnOrBefore(db: DB, date = todayIso(), pay = yourPay(db)): string {
  const here = paydayIn(monthOf(date), pay);
  return here <= date ? here : paydayIn(addMonths(monthOf(date), -1), pay);
}

/** True when income landing on this date counts towards the next month (the last few days of a month). */
export function landsLate(db: DB, date: string): boolean {
  const days = parseInt(getSetting(db, 'rollforward_days', '5'), 10);
  if (!days) return false;
  return Number(date.slice(8, 10)) > daysInMonth(monthOf(date)) - days;
}

/** The month a payday (or any pay landing on this date) funds. */
export function fundedMonth(db: DB, date: string): string {
  return landsLate(db, date) ? addMonths(monthOf(date), 1) : monthOf(date);
}

/** Is this income your pay? (Your pay always follows the late-in-the-month rule, whatever its category says.) */
export function isYourPay(db: DB, by: { recurringId?: number | null; categoryId?: number | null }, pay = yourPay(db)): boolean {
  if (!pay) return false;
  if (by.recurringId != null) return by.recurringId === pay.id;
  return by.categoryId != null && by.categoryId === pay.category_id;
}

export interface PayCycle {
  /** False when no pay is set up: the cycle is then the calendar month. */
  hasPay: boolean;
  /** The payday that started this cycle (or the 1st of the month). */
  start: string;
  /** The next payday (or the last day of the month). */
  end: string;
  /** The payday before `start`, for stepping back. */
  previous: string;
  fundedMonth: string;
  daysIn: number;
  daysLeft: number;
  /** How far through the cycle today is, 0–1 (counting today as half done). */
  progress: number;
}

/** The pay cycle containing a date. */
export function payCycle(db: DB, today = todayIso()): PayCycle {
  const pay = yourPay(db);
  if (!pay) {
    const month = monthOf(today);
    const start = `${month}-01`;
    const end = `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;
    return shape(false, start, end, `${addMonths(month, -1)}-01`, month, today);
  }
  const start = paydayOnOrBefore(db, today, pay);
  const end = paydayIn(addMonths(monthOf(start), 1), pay);
  const previous = paydayIn(addMonths(monthOf(start), -1), pay);
  return shape(true, start, end, previous, fundedMonth(db, start), today);
}

/** The cycle that starts on the payday in a given date's month (the Payday page; without pay set up, the last working day stands in). */
export function cycleFrom(db: DB, payday: string, today = todayIso()): PayCycle {
  const pay = yourPay(db);
  const start = paydayIn(monthOf(payday), pay);
  const end = paydayIn(addMonths(monthOf(start), 1), pay);
  const previous = paydayIn(addMonths(monthOf(start), -1), pay);
  return shape(true, start, end, previous, fundedMonth(db, start), today);
}

function shape(hasPay: boolean, start: string, end: string, previous: string, funded: string, today: string): PayCycle {
  const span = Math.max(1, daysBetween(start, end) + (hasPay ? 0 : 1));
  const daysIn = Math.max(0, daysBetween(start, today));
  const progress = Math.min(1, Math.max(0, (daysIn + 0.5) / span));
  const daysLeft = Math.max(1, daysBetween(today, end) + (hasPay ? 0 : 1));
  return { hasPay, start, end, previous, fundedMonth: funded, daysIn, daysLeft, progress };
}
