/**
 * Can I afford it? A purchase simulator (see docs/specs/can-i-afford-it.md and GLOSSARY.md).
 *
 * Two layers:
 *   - loadContext(db) reads your real data once: balances, pay, bills, savings, goals, debts, cards
 *     and typical day-to-day spending. It never writes anything.
 *   - simulate(ctx, input) is pure: it builds each payment option, forecasts your available cash day by
 *     day with and without the purchase, and assesses it. Changing the inputs only re-runs this part.
 *
 * Rules (each one is shown to you as an assumption on the page):
 *   - Available cash is current accounts plus savings, less goal money and the emergency fund.
 *     Investments are left out. Any account can be added per simulation.
 *   - Bills and income use their real dates (last working day pay, bank holidays) and your share only.
 *   - Regular saving and investing, and goals' monthly amounts, leave your available cash: that money has a job.
 *   - Day-to-day spending is spread evenly through each month from your recent average (bills left out).
 *     The part you usually put on cards leaves your account on each card's due date, with what you owe
 *     today, so card spending and card repayments are never both counted.
 *   - Interest: an APR becomes a rate per payment as (1 + APR)^(1/payments a year) − 1.
 */
import type { DB } from './db.ts';
import { addDays, addMonths, daysBetween, daysInMonth, monthOf, todayIso } from './dates.ts';
import { occurrences, unlinkedBillSpending } from './recurring.ts';

/** A bill this many days late is treated as still to pay (as on Bills & income). */
const GRACE_DAYS = 5;
import { listAccounts } from './queries.ts';
import { listGoals } from './goals.ts';
import { plan } from './plan.ts';
import { isYourPay, yourPay } from './paycycle.ts';
import { instalmentAmounts, minimumDue } from './debts.ts';

// ---------------------------------------------------------------------------
// Types

export type Priority = 'essential' | 'important' | 'non_essential';
export type OptionKind = 'outright' | 'bnpl' | 'instalments' | 'finance' | 'card' | 'save';
export type Frequency = 'weekly' | 'fortnightly' | 'monthly';
export type CardPlan = 'full' | 'fixed' | 'minimum' | 'promo';
export type BnplPreset = 'pay_in_3' | 'pay_in_4' | 'pay_in_30';
export type Level = 'comfortable' | 'adjust' | 'stretching' | 'not_affordable';
export type Kind = 'outright' | 'zero_percent' | 'bnpl' | 'credit' | 'card' | 'save';

export interface Purchase {
  name: string;
  price: number;
  date: string;
  categoryId?: number | null;
  description?: string | null;
  priority?: Priority;
}

export interface OptionInput {
  id: string;
  kind: OptionKind;
  label?: string;
  /** BNPL presets fill in the number, frequency and first date; you can still change them. */
  preset?: BnplPreset;
  deposit?: number;
  payments?: number;
  frequency?: Frequency;
  firstPayment?: string;
  /** Basis points: 19.9% = 1990. */
  apr?: number;
  upfrontFee?: number;
  /** Added to every payment. */
  paymentFee?: number;
  /** PCP-style final payment, due one period after the last regular payment. */
  balloon?: number;
  /** Credit card options. */
  cardId?: number;
  cardPlan?: CardPlan;
  cardMonthly?: number;
  /** The rate on this purchase if it differs from the card's (e.g. a 0% purchase offer). */
  purchaseApr?: number | null;
  purchasePromoEnd?: string | null;
  /** Save first. */
  saveMonthly?: number;
  saveStart?: string;
}

export interface AccountOverride { include: boolean; amount?: number | null }
export interface Overrides {
  /** Your pay, each payday. */
  pay?: number | null;
  /** Day-to-day spending a month. */
  everyday?: number | null;
  /** Regular saving and investing (including goal amounts) a month. */
  saving?: number | null;
  /** Free to spend must stay at least this % of the month's income (basis points: 1000 = 10%) … */
  floorPercent?: number | null;
  /** … or at least this amount, if set. */
  floorAmount?: number | null;
  accounts?: Record<string, AccountOverride>;
}

export interface SimInput { purchase: Purchase; options: OptionInput[]; overrides?: Overrides }

export interface CashEvent {
  date: string;
  /** Positive = money in, negative = out. */
  amount: number;
  /** A bill charged to a card: it's paid off with the card, not on the day. */
  cardId?: number;
  /** 'card': paying off what you owe on a card today (spending already counted in an earlier month). */
  kind: 'income' | 'bill' | 'debt' | 'saving' | 'everyday' | 'purchase' | 'card';
  label: string;
  /** The month it counts towards (pay landing early counts towards next month). */
  period: string;
  isPay?: boolean;
}

export interface ContextAccount {
  id: number; name: string; type: string; colour: string; balance: number;
  /** Money with a job: the emergency fund and other goals in this account. */
  emergency: number; goals: number;
  /** Counted by default, and how much. */
  defaultIncluded: boolean; defaultAmount: number;
  /** Days since the last transaction or confirmed balance, when that's a while. */
  staleDays: number | null;
}

export interface CardInfo {
  accountId: number; name: string; owed: number;
  apr: number | null; promoApr: number | null; promoEnd: string | null;
  minType: 'fixed' | 'card'; minFixed: number; minPercent: number; minFloor: number;
  dueDay: number | null; statementDay: number | null; paysInFull: boolean; creditLimit: number | null;
  /** Your regular repayment to this card, if you have one set up: its dates and amounts. */
  repayments: { date: string; amount: number }[];
  hasDetails: boolean;
}

export interface Missing { what: string; fix: string }

export interface Context {
  today: string;
  end: string;
  accounts: ContextAccount[];
  /** Income, bills, loan repayments, saving and goal amounts from today to `end` (not cards, not day-to-day). */
  events: CashEvent[];
  everyday: { average: number; spentThisMonth: number; months: number;
    /** Share of day-to-day spending that goes on each card (by account id): paid off on its due dates instead of the day you spend. */
    cardShare: Record<string, number> };
  /** This month as the This month card counts it (income, bills, loan repayments, saving), so the figures match. */
  thisMonth: { income: number; bills: number; debts: number; saving: number };
  /** Your pay a month, and the regular saving and investing a month (used for overrides and the floor). */
  pay: { amount: number; name: string | null };
  savingPerMonth: number;
  cards: CardInfo[];
  goals: { id: number; name: string; monthlyTarget: number; isEmergency: boolean; account: string | null }[];
  missing: Missing[];
}

// ---------------------------------------------------------------------------
// Dates

const pad = (n: number) => String(n).padStart(2, '0');
export const monthEnd = (m: string) => `${m}-${pad(daysInMonth(m))}`;

/** The same day n months later, kept inside short months (31 Jan + 1 month = 28/29 Feb). */
export function addMonthsToDate(date: string, n: number, day = Number(date.slice(8, 10))): string {
  const m = addMonths(monthOf(date), n);
  return `${m}-${pad(Math.min(day, daysInMonth(m)))}`;
}

export function paymentDates(first: string, n: number, frequency: Frequency): string[] {
  return Array.from({ length: n }, (_, i) =>
    frequency === 'monthly' ? addMonthsToDate(first, i) : addDays(first, i * (frequency === 'weekly' ? 7 : 14)));
}

/** The next date on a day of the month, on or after `from`. */
export function nextOnDay(from: string, day: number): string {
  const here = `${monthOf(from)}-${pad(Math.min(day, daysInMonth(monthOf(from))))}`;
  return here >= from ? here : addMonthsToDate(here, 1, day);
}

/** The last date on a day of the month, strictly before `before`. */
export function prevOnDay(before: string, day: number): string {
  const here = `${monthOf(before)}-${pad(Math.min(day, daysInMonth(monthOf(before))))}`;
  return here < before ? here : addMonthsToDate(here, -1, day);
}

const PER_YEAR: Record<Frequency, number> = { weekly: 52, fortnightly: 26, monthly: 12 };

/** An APR (basis points) as a rate per payment: (1 + APR)^(1/n) − 1. */
export function periodicRate(aprBp: number, perYear: number): number {
  return aprBp > 0 ? Math.pow(1 + aprBp / 10000, 1 / perYear) - 1 : 0;
}

// ---------------------------------------------------------------------------
// Payment options

export interface ScheduleRow {
  n: number; date: string; label: string;
  payment: number; interest: number; fees: number; principal: number; remaining: number;
}

export interface Built {
  id: string; kind: OptionKind; label: string; classification: Kind; classificationLabel: string;
  /** Cash leaving your available money for this purchase, dated. */
  flows: { date: string; amount: number; label: string }[];
  schedule: ScheduleRow[];
  upfront: number; regularPayment: number | null; frequency: Frequency | null; payments: number;
  totalInterest: number; totalFees: number; totalPayable: number;
  firstDate: string | null; lastDate: string | null;
  warnings: string[];
  /** Problems that make the option impossible as set up (e.g. over the credit limit). */
  blockers: string[];
  /** Card options: the card's balance with this purchase, and the credit left. */
  card?: { name: string; owedBefore: number; limit: number | null; available: number | null; rate: number; promoEnd: string | null };
  /** Save first: when you'd have it, and other monthly amounts. */
  save?: { monthly: number; months: number; reached: string; alternatives: { monthly: number; months: number; reached: string }[] };
}

const CLASS_LABEL: Record<Kind, string> = {
  outright: 'Paid in full',
  zero_percent: 'Interest-free (0%) finance',
  bnpl: 'Buy now, pay later',
  credit: 'Interest-bearing credit',
  card: 'Credit card',
  save: 'Save first, then buy',
};

const PRESETS: Record<BnplPreset, { label: string; payments: number; frequency: Frequency; firstOffsetDays: number }> = {
  pay_in_3: { label: 'Pay in 3 (Klarna-style)', payments: 3, frequency: 'monthly', firstOffsetDays: 0 },
  pay_in_4: { label: 'Pay in 4 (Clearpay-style)', payments: 4, frequency: 'fortnightly', firstOffsetDays: 0 },
  pay_in_30: { label: 'Pay in 30 days', payments: 1, frequency: 'monthly', firstOffsetDays: 30 },
};

/** Fixed payments on a loan or plan: equal payments that clear `financed` (less any balloon) at the APR. */
export function instalmentSchedule(o: {
  financed: number; payments: number; frequency: Frequency; first: string; apr: number; paymentFee?: number; balloon?: number;
}): ScheduleRow[] {
  const n = o.payments;
  const fee = o.paymentFee ?? 0;
  const balloon = Math.min(o.balloon ?? 0, o.financed);
  const dates = paymentDates(o.first, n, o.frequency);
  const i = periodicRate(o.apr, PER_YEAR[o.frequency]);
  const rows: ScheduleRow[] = [];
  if (i === 0) {
    // Interest-free: equal parts, the first absorbs odd pennies (as Klarna and PayPal do).
    const parts = instalmentAmounts(o.financed - balloon, n);
    let left = o.financed;
    parts.forEach((p, k) => {
      left -= p;
      rows.push({ n: k + 1, date: dates[k], label: `Payment ${k + 1}`, payment: p + fee, interest: 0, fees: fee, principal: p, remaining: left });
    });
  } else {
    // Annuity, with the balloon's present value taken off first.
    const pv = o.financed - balloon / Math.pow(1 + i, n);
    const pmt = Math.round((pv * i) / (1 - Math.pow(1 + i, -n)));
    let left = o.financed;
    for (let k = 0; k < n; k++) {
      const interest = Math.round(left * i);
      // The last regular payment clears exactly down to the balloon.
      const principal = k === n - 1 ? left - balloon : pmt - interest;
      left -= principal;
      rows.push({ n: k + 1, date: dates[k], label: `Payment ${k + 1}`, payment: principal + interest + fee, interest, fees: fee, principal, remaining: left });
    }
  }
  if (balloon > 0) {
    const date = o.frequency === 'monthly' ? addMonthsToDate(o.first, n) : addDays(dates[n - 1], o.frequency === 'weekly' ? 7 : 14);
    const interest = i === 0 ? 0 : Math.round(balloon * i);
    rows.push({ n: n + 1, date, label: 'Final (balloon) payment', payment: balloon + interest, interest, fees: 0, principal: balloon, remaining: 0 });
  }
  return rows;
}

// Credit cards ---------------------------------------------------------------

interface Bucket { owed: number; apr: number; promoApr: number | null; promoEnd: string | null }
const bucketRate = (b: Bucket, date: string) => (b.promoApr != null && b.promoEnd && date < b.promoEnd ? b.promoApr : b.apr);

/** The card's payment due dates over the horizon: its due day, or your repayment's dates, or monthly from today. */
export function cardDueDates(c: CardInfo, from: string, end: string): { dates: string[]; assumed: boolean } {
  if (c.dueDay) {
    const out: string[] = [];
    for (let d = nextOnDay(from, c.dueDay); d <= end; d = addMonthsToDate(d, 1, c.dueDay)) out.push(d);
    return { dates: out, assumed: false };
  }
  if (c.repayments.length) return { dates: c.repayments.map((r) => r.date).filter((d) => d >= from && d <= end), assumed: false };
  const out: string[] = [];
  for (let d = addMonthsToDate(from, 1); d <= end; d = addMonthsToDate(d, 1)) out.push(d);
  return { dates: out, assumed: true };
}

/** What you'd normally pay towards the card's balance on a due date (before any extra for a purchase). */
function basePayment(c: CardInfo, date: string, balance: number, interest: number): number {
  if (balance <= 0) return 0;
  const rep = c.repayments.find((r) => r.date === date);
  if (rep) return Math.min(balance, rep.amount);
  if (c.paysInFull) return balance;
  return minimumDue({ min_type: c.minType, min_fixed: c.minFixed, min_percent: c.minPercent, min_floor: c.minFloor, frequency: 'monthly' }, balance, interest);
}

/**
 * Month by month on a card: interest is added on each due date, then the payment goes to the
 * highest-rate balance first. `extra(k, withBalance, withoutBalance)` is the extra you pay for the purchase.
 */
export function runCard(c: CardInfo, dates: string[], purchase: { amount: number; date: string; apr: number; promoApr: number | null; promoEnd: string | null } | null,
  extra: (gap: number) => number) {
  const card = { owed: c.owed, apr: c.apr ?? 0, promoApr: c.promoApr, promoEnd: c.promoEnd };
  const without: Bucket[] = [{ ...card }];
  const withP: Bucket[] = [{ ...card }];
  const rows: { date: string; base: number; extra: number; interest: number; gap: number }[] = [];
  let added = !purchase;
  const total = (bs: Bucket[]) => bs.reduce((s, b) => s + b.owed, 0);
  // No interest while the card is cleared each month (the grace period): only on a balance carried over.
  const carried = new Map<Bucket[], boolean>([[without, carriesBalance(c)], [withP, carriesBalance(c)]]);
  const accrue = (bs: Bucket[], date: string) => {
    if (!carried.get(bs)) return 0;
    let n = 0;
    for (const b of bs) { const i = Math.round(b.owed * periodicRate(bucketRate(b, date), 12)); b.owed += i; n += i; }
    return n;
  };
  const pay = (bs: Bucket[], amount: number, date: string) => {
    let left = amount;
    for (const b of [...bs].sort((x, y) => bucketRate(y, date) - bucketRate(x, date))) {
      const p = Math.min(left, b.owed); b.owed -= p; left -= p;
    }
  };
  for (let k = 0; k < dates.length; k++) {
    const date = dates[k];
    if (!added && purchase!.date <= date) {
      withP.push({ owed: purchase!.amount, apr: purchase!.apr, promoApr: purchase!.promoApr, promoEnd: purchase!.promoEnd });
      added = true;
    }
    const iw = accrue(without, date);
    const ip = accrue(withP, date);
    const base0 = basePayment(c, date, total(without), iw);
    pay(without, base0, date);
    const base1 = Math.min(basePayment(c, date, total(withP), ip), Math.max(base0, 0));
    const gapBefore = Math.max(0, total(withP) - base1 - total(without));
    const e = added ? Math.max(0, Math.min(gapBefore, extra(gapBefore))) : 0;
    pay(withP, base1 + e, date);
    carried.set(without, total(without) > 0);
    carried.set(withP, total(withP) > 0);
    rows.push({ date, base: base0, extra: e, interest: ip - iw, gap: Math.max(0, total(withP) - total(without)) });
    if (added && total(withP) <= total(without) && purchase) break;
  }
  return { rows, cleared: added && total(withP) <= total(without), left: Math.max(0, total(withP) - total(without)) };
}

/** A card that's paid in full each month (or owes nothing) isn't charged interest on new spending. */
const carriesBalance = (c: CardInfo) => !c.paysInFull && c.owed > 0;

/**
 * Cash leaving your account for a card: what you owe today, then each statement's spending, paid on the
 * card's due dates as you normally pay it (in full, your regular repayment, or the minimum).
 * `charges` is what goes on the card after today (day-to-day spending and bills charged to it).
 */
export function cardBaseline(c: CardInfo, today: string, end: string, charges: Map<string, number> = new Map()): { date: string; amount: number }[] {
  const { dates } = cardDueDates(c, today, end);
  const out: { date: string; amount: number }[] = [];
  const b: Bucket = { owed: c.owed, apr: c.apr ?? 0, promoApr: c.promoApr, promoEnd: c.promoEnd };
  const chargedBy = (d: string) => { let n = 0; for (const [k, v] of charges) if (k > today && k <= d) n += v; return n; };
  let carried = carriesBalance(c);
  let paid = 0;
  let interest = 0;
  for (const date of dates) {
    // The statement this payment is for closed on the statement day before it (or about 25 days before).
    const close = c.statementDay ? prevOnDay(date, c.statementDay) : addDays(date, -25);
    const statement = c.owed + interest + (close > today ? chargedBy(close) : 0) - paid;
    if (statement <= 0) continue;
    const i = carried ? Math.round(statement * periodicRate(bucketRate(b, date), 12)) : 0;
    interest += i;
    const p = Math.min(statement + i, basePayment(c, date, statement + i, i));
    paid += p;
    carried = !c.paysInFull && statement + i - p > 0;
    if (p > 0) out.push({ date, amount: p });
  }
  return out;
}

// Building each option ---------------------------------------------------------

export function buildOption(ctx: Pick<Context, 'today' | 'end' | 'cards'>, p: Purchase, o: OptionInput, firstPayday?: string | null): Built {
  const warnings: string[] = [];
  const blockers: string[] = [];
  const base = { id: o.id, kind: o.kind, warnings, blockers };
  const price = p.price;

  if (o.kind === 'outright') {
    return {
      ...base, label: o.label || 'Pay outright', classification: 'outright', classificationLabel: CLASS_LABEL.outright,
      flows: [{ date: p.date, amount: price, label: p.name }],
      schedule: [{ n: 1, date: p.date, label: 'Paid in full', payment: price, interest: 0, fees: 0, principal: price, remaining: 0 }],
      upfront: price, regularPayment: null, frequency: null, payments: 1, totalInterest: 0, totalFees: 0, totalPayable: price,
      firstDate: p.date, lastDate: p.date,
    };
  }

  if (o.kind === 'bnpl' || o.kind === 'instalments' || o.kind === 'finance') {
    const preset = o.kind === 'bnpl' ? PRESETS[o.preset ?? 'pay_in_3'] : null;
    const payments = Math.max(1, Math.min(120, Math.round(o.payments ?? preset?.payments ?? 12)));
    const frequency = o.frequency ?? preset?.frequency ?? 'monthly';
    const deposit = Math.max(0, Math.min(price, o.deposit ?? 0));
    const apr = Math.max(0, o.apr ?? 0);
    const fee = Math.max(0, o.upfrontFee ?? 0);
    const paymentFee = Math.max(0, o.paymentFee ?? 0);
    const balloon = o.kind === 'finance' ? Math.max(0, Math.min(price - deposit, o.balloon ?? 0)) : 0;
    const first = o.firstPayment ?? (preset ? addDays(p.date, preset.firstOffsetDays) : addMonthsToDate(p.date, 1));
    if (first < p.date) blockers.push('The first payment is before the purchase date');
    const rows = instalmentSchedule({ financed: price - deposit, payments, frequency, first, apr, paymentFee, balloon });
    const pre: ScheduleRow[] = [];
    if (deposit > 0) pre.push({ n: 0, date: p.date, label: 'Deposit', payment: deposit, interest: 0, fees: 0, principal: deposit, remaining: price - deposit });
    if (fee > 0) pre.push({ n: 0, date: p.date, label: 'Arrangement fee', payment: fee, interest: 0, fees: fee, principal: 0, remaining: price - deposit });
    const schedule = [...pre, ...rows];
    const totalInterest = rows.reduce((s, r) => s + r.interest, 0);
    const totalFees = fee + rows.reduce((s, r) => s + r.fees, 0);
    const classification: Kind = apr > 0 ? 'credit' : o.kind === 'bnpl' ? 'bnpl' : 'zero_percent';
    if (classification === 'bnpl') {
      warnings.push('Buy now, pay later is not regulated like a loan: missed payments can mean late fees and can affect your credit file.');
      if (payments * (frequency === 'monthly' ? 1 : frequency === 'fortnightly' ? 0.5 : 0.25) > 12) warnings.push('Most buy now, pay later plans are under 12 months; longer ones are usually credit agreements with interest.');
    }
    if (classification === 'zero_percent') warnings.push('Interest-free finance is regulated credit: it is a credit agreement and is checked against your credit file.');
    if (classification === 'credit') warnings.push(`This is interest-bearing credit at ${(apr / 100).toFixed(1)}% APR.`);
    if (balloon > 0) warnings.push(`A final payment of £${(balloon / 100).toFixed(2)} is due at the end; you need to have it ready (or hand the item back, with PCP).`);
    const regular = rows.filter((r) => r.label.startsWith('Payment'));
    const typical = regular.length ? regular[regular.length > 1 ? 1 : 0].payment : null;
    const label = o.label || (preset ? preset.label : `${payments} ${frequency === 'monthly' ? 'months' : frequency === 'weekly' ? 'weekly payments' : 'fortnightly payments'}${apr ? ` at ${(apr / 100).toFixed(1)}%` : ''}`);
    return {
      ...base, label, classification, classificationLabel: CLASS_LABEL[classification],
      flows: schedule.map((r) => ({ date: r.date, amount: r.payment, label: r.label })),
      schedule, upfront: deposit + fee + rows.filter((r) => r.date === p.date).reduce((s, r) => s + r.payment, 0),
      regularPayment: typical, frequency, payments,
      totalInterest, totalFees, totalPayable: price + totalInterest + totalFees,
      firstDate: schedule[0]?.date ?? null, lastDate: schedule[schedule.length - 1]?.date ?? null,
    };
  }

  if (o.kind === 'card') {
    const c = ctx.cards.find((x) => x.accountId === o.cardId);
    const empty = {
      ...base, label: o.label || 'Credit card', classification: 'card' as Kind, classificationLabel: CLASS_LABEL.card,
      flows: [], schedule: [], upfront: 0, regularPayment: null, frequency: 'monthly' as Frequency, payments: 0,
      totalInterest: 0, totalFees: 0, totalPayable: price, firstDate: null, lastDate: null,
    };
    if (!c) { blockers.push('Choose a credit card'); return empty; }
    const plan = o.cardPlan ?? 'full';
    const pApr = o.purchaseApr ?? c.apr ?? 0;
    const promoActive = c.promoApr != null && c.promoEnd && c.promoEnd > p.date;
    const promoEnd = o.purchasePromoEnd !== undefined ? o.purchasePromoEnd : promoActive ? c.promoEnd : null;
    const promoApr = promoEnd ? (o.purchasePromoEnd !== undefined ? 0 : c.promoApr) : null;
    if (!c.hasDetails) warnings.push(`${c.name} has no card details saved (APR, due day, minimum payment), so these figures are rough. Add them on the Debts page.`);
    else if (c.apr == null) warnings.push(`${c.name} has no APR saved, so interest is worked out at 0%. Add it on the Debts page.`);
    const available = c.creditLimit != null ? c.creditLimit - c.owed : null;
    if (available != null && price > available) blockers.push(`£${(price / 100).toFixed(2)} is more than the £${(Math.max(0, available) / 100).toFixed(2)} of credit left on ${c.name}.`);
    else if (available != null && price > available * 0.9) warnings.push(`This uses most of the credit left on ${c.name}, which can lower your credit score while it's outstanding.`);
    const end = addMonthsToDate(p.date, 360);
    const { dates, assumed } = cardDueDates(c, p.date, end);
    if (assumed) warnings.push(`${c.name} has no payment due day saved, so payments are assumed monthly from today.`);
    // The first payment that can include the purchase: the due date after the statement it lands on.
    let firstDue = dates[0];
    if (c.statementDay) {
      const closes = nextOnDay(p.date, c.statementDay);
      firstDue = dates.find((d) => d > closes) ?? dates[0];
    } else if (firstDue && daysBetween(p.date, firstDue) < 14) firstDue = dates[1] ?? firstDue;
    const due = dates.filter((d) => d >= (firstDue ?? p.date));
    const purchase = { amount: price, date: p.date, apr: pApr, promoApr, promoEnd };
    let monthly = Math.max(0, o.cardMonthly ?? 0);
    if (plan === 'promo') {
      if (!promoEnd) { blockers.push('No interest-free offer to clear it within. Choose another way to repay, or add the offer.'); }
      else {
        const before = due.filter((d) => d < promoEnd).length;
        if (before === 0) blockers.push('The interest-free offer ends before the first payment.');
        else monthly = Math.ceil(price / before);
      }
    }
    if (plan === 'fixed' && monthly <= 0) blockers.push('Enter how much you will pay towards it each month');
    if (c.owed > 0 && !c.paysInFull && plan === 'full') warnings.push('You carry a balance on this card, so interest is usually charged on new purchases even if you pay this one off.');
    const sim = runCard(c, due, purchase, (gap) => (plan === 'full' ? gap : plan === 'minimum' ? 0 : monthly));
    if ((plan === 'fixed' || plan === 'promo') && monthly > 0 && !sim.cleared) warnings.push(`£${(monthly / 100).toFixed(2)} a month doesn't clear it: the interest is more than you'd pay off.`);
    // Minimum only: the extra is what the higher minimum costs you each month.
    let rows = sim.rows;
    if (plan === 'minimum') {
      const minSim = runMinimum(c, due, purchase);
      rows = minSim.rows;
      if (!minSim.cleared) warnings.push('At the minimum payment this takes more than 30 years to clear.');
    }
    const paid = rows.filter((r) => r.extra > 0);
    const totalPaid = paid.reduce((s, r) => s + r.extra, 0);
    const interest = Math.max(0, totalPaid - price);
    if (plan === 'minimum' && paid.length) warnings.push(`Paying the minimum takes ${paid.length} payments and costs £${(interest / 100).toFixed(2)} in interest.`);
    if (promoEnd && paid.length && paid[paid.length - 1].date >= promoEnd) warnings.push(`The 0% offer ends on ${dayName(promoEnd)}, before this is paid off: interest is charged after that.`);
    let left = price;
    const schedule = paid.map((r, k) => {
      const share = Math.min(r.extra, left + r.interest);
      left = Math.max(0, left + Math.max(0, r.interest) - r.extra);
      return { n: k + 1, date: r.date, label: `Card payment ${k + 1}`, payment: r.extra, interest: Math.max(0, r.interest), fees: 0, principal: Math.max(0, share - Math.max(0, r.interest)), remaining: k === paid.length - 1 ? 0 : left };
    });
    return {
      ...empty,
      label: o.label || `${c.name}: ${plan === 'full' ? 'pay it off at the next statement' : plan === 'fixed' ? `£${(monthly / 100).toFixed(0)} a month` : plan === 'promo' ? 'clear it before the 0% offer ends' : 'minimum payments'}`,
      flows: paid.map((r) => ({ date: r.date, amount: r.extra, label: `Extra to ${c.name}` })),
      schedule, regularPayment: paid.length > 1 ? paid[1].extra : paid[0]?.extra ?? null, payments: paid.length,
      totalInterest: interest, totalPayable: totalPaid || price,
      firstDate: paid[0]?.date ?? null, lastDate: paid[paid.length - 1]?.date ?? null,
      card: { name: c.name, owedBefore: c.owed, limit: c.creditLimit, available: available != null ? available - price : null, rate: promoApr ?? pApr, promoEnd },
    };
  }

  // Save first.
  const monthly = Math.max(0, o.saveMonthly ?? 0);
  const start = o.saveStart ?? firstPayday ?? addMonthsToDate(ctx.today, 1, 1);
  const label = o.label || 'Save first, then buy';
  const months = monthly > 0 ? Math.ceil(price / monthly) : 0;
  if (monthly <= 0) blockers.push('Enter how much you could save each month');
  const dates = months ? paymentDates(start, months, 'monthly') : [];
  let saved = 0;
  const schedule = dates.map((d, k) => {
    const amount = Math.min(monthly, price - saved);
    saved += amount;
    return { n: k + 1, date: d, label: `Save ${k + 1}`, payment: amount, interest: 0, fees: 0, principal: amount, remaining: price - saved };
  });
  const reached = dates[dates.length - 1] ?? start;
  const alt = [3, 6, 12, 18, 24].map((n) => {
    const m = Math.ceil(price / n / 500) * 500;
    const k = Math.ceil(price / m);
    return { monthly: m, months: k, reached: paymentDates(start, k, 'monthly')[k - 1] };
  }).filter((a, i, all) => all.findIndex((b) => b.monthly === a.monthly) === i);
  return {
    ...base, label, classification: 'save', classificationLabel: CLASS_LABEL.save,
    flows: schedule.map((r) => ({ date: r.date, amount: r.payment, label: `Save towards ${p.name}` })),
    schedule, upfront: 0, regularPayment: monthly, frequency: 'monthly', payments: months,
    totalInterest: 0, totalFees: 0, totalPayable: price, firstDate: dates[0] ?? null, lastDate: reached,
    save: { monthly, months, reached, alternatives: alt },
  };
}

/** Minimum payments on the card with and without the purchase: the extra is the difference. */
function runMinimum(c: CardInfo, dates: string[], purchase: { amount: number; date: string; apr: number; promoApr: number | null; promoEnd: string | null }) {
  const mk = (owed: number, apr: number, promoApr: number | null, promoEnd: string | null): Bucket => ({ owed, apr, promoApr, promoEnd });
  const without = [mk(c.owed, c.apr ?? 0, c.promoApr, c.promoEnd)];
  const withP = [mk(c.owed, c.apr ?? 0, c.promoApr, c.promoEnd), mk(purchase.amount, purchase.apr, purchase.promoApr, purchase.promoEnd)];
  const total = (bs: Bucket[]) => bs.reduce((s, b) => s + b.owed, 0);
  const carried = new Map<Bucket[], boolean>([[without, carriesBalance(c)], [withP, carriesBalance(c)]]);
  const step = (bs: Bucket[], date: string) => {
    let i = 0;
    if (carried.get(bs)) for (const b of bs) { const x = Math.round(b.owed * periodicRate(bucketRate(b, date), 12)); b.owed += x; i += x; }
    const bal = total(bs);
    const rep = c.repayments.find((r) => r.date === date)?.amount ?? 0;
    const min = minimumDue({ min_type: c.minType, min_fixed: c.minFixed, min_percent: c.minPercent, min_floor: c.minFloor, frequency: 'monthly' }, bal, i);
    const payment = Math.min(bal, Math.max(rep, min));
    let left = payment;
    for (const b of [...bs].sort((x, y) => bucketRate(y, date) - bucketRate(x, date))) { const q = Math.min(left, b.owed); b.owed -= q; left -= q; }
    carried.set(bs, total(bs) > 0);
    return { payment, interest: i };
  };
  const rows: { date: string; base: number; extra: number; interest: number; gap: number }[] = [];
  for (const date of dates.slice(0, 360)) {
    const a = step(without, date);
    const b = step(withP, date);
    rows.push({ date, base: a.payment, extra: Math.max(0, b.payment - a.payment), interest: b.interest - a.interest, gap: total(withP) - total(without) });
    if (total(withP) - total(without) <= 0) return { rows, cleared: true };
  }
  return { rows, cleared: false };
}

// ---------------------------------------------------------------------------
// Reading your data

export function loadContext(db: DB, today = todayIso(), months = 60): Context {
  const end = monthEnd(addMonths(monthOf(today), months));
  const missing: Missing[] = [];
  const accounts = listAccounts(db);
  const goalData = listGoals(db, today) as any;
  const goals = ((goalData.goals ?? []) as any[]).filter((g) => !g.archived && !g.completedAt);

  // Money with a job in each account: a goal that takes the rest of the account takes all of it.
  const jobs = new Map<number, { emergency: number; goals: number }>();
  for (const a of accounts) {
    const here = goals.filter((g) => g.account?.id === a.id);
    if (!here.length) continue;
    const rest = here.find((g) => g.mode === 'rest');
    let emergency = 0, other = 0;
    if (rest) (rest.isEmergency ? (emergency = Math.max(0, a.balance - here.filter((g) => g !== rest && g.mode === 'share').reduce((s, g) => s + g.saved, 0))) : (other = Math.max(0, a.balance - here.filter((g) => g !== rest && g.mode === 'share').reduce((s, g) => s + g.saved, 0))));
    for (const g of here.filter((x) => x.mode === 'share')) (g.isEmergency ? (emergency += Math.max(0, g.saved)) : (other += Math.max(0, g.saved)));
    // Never protect more than is in the account.
    const scale = emergency + other > Math.max(0, a.balance) && emergency + other > 0 ? Math.max(0, a.balance) / (emergency + other) : 1;
    jobs.set(a.id, { emergency: Math.round(emergency * scale), goals: Math.round(other * scale) });
  }
  const ctxAccounts: ContextAccount[] = accounts
    .filter((a) => !a.isLiability)
    .map((a) => {
      const j = jobs.get(a.id) ?? { emergency: 0, goals: 0 };
      const everyday = ['current', 'cash'].includes(a.type);
      const saving = ['savings', 'pot'].includes(a.type);
      const free = Math.max(0, a.balance - j.emergency - j.goals);
      const last = [a.lastActivity, a.anchorDate].filter(Boolean).sort().pop() ?? null;
      const age = last ? daysBetween(last, today) : null;
      return {
        id: a.id, name: a.name, type: a.type, colour: a.colour, balance: a.balance, emergency: j.emergency, goals: j.goals,
        defaultIncluded: everyday || saving, defaultAmount: everyday ? a.balance - j.emergency - j.goals : saving ? free : 0,
        staleDays: a.syncProvider ? null : age != null && age > 35 ? age : null,
      };
    });
  for (const a of ctxAccounts.filter((x) => x.defaultIncluded && x.staleDays != null && x.balance !== 0)) {
    missing.push({ what: `${a.name}'s balance was last updated ${a.staleDays} days ago`, fix: 'Import a recent statement, or set its balance on Accounts.' });
  }

  // Dated events: everything still to come from today, in your share.
  const occ = occurrences(db, addDays(today, -GRACE_DAYS), end);
  const rec = new Map((db.prepare(
    `SELECT r.id, r.type, r.account_id, r.transfer_account_id, ta.type AS transfer_type, a.type AS account_type,
            IFNULL((SELECT SUM(s.amount) FROM recurring_shares s WHERE s.recurring_id = r.id), 0) AS shared
     FROM recurring r JOIN accounts a ON a.id = r.account_id LEFT JOIN accounts ta ON ta.id = r.transfer_account_id`,
  ).all() as { id: number; type: string; account_id: number; transfer_account_id: number | null; transfer_type: string | null; account_type: string; shared: number }[]).map((r) => [r.id, r]));
  const pay = yourPay(db);
  const events: CashEvent[] = [];
  const cardIds = new Set(accounts.filter((a) => a.type === 'credit_card').map((a) => a.id));
  const cardRepayments = new Map<number, { date: string; amount: number }[]>();
  for (const o of occ) {
    if (o.status === 'paid' || o.status === 'skipped') continue;
    // Already past: income is assumed to have arrived (it's in the balance); a bill a few days late is still to pay.
    if (o.dueDate < today && (o.type === 'income' || daysBetween(o.dueDate, today) > GRACE_DAYS)) continue;
    const r = rec.get(o.recurringId);
    if (!r) continue;
    const date = o.dueDate < today ? today : o.dueDate;
    const amount = Math.max(0, o.expected - (o.type === 'income' ? 0 : r.shared));
    if (o.type === 'income') {
      if (r.account_type === 'investment' || ['credit_card', 'loan', 'other_liability'].includes(r.account_type)) continue;
      events.push({ date, amount, kind: 'income', label: o.name, period: o.period, isPay: isYourPay(db, { recurringId: o.recurringId }, pay) });
    } else if (o.type === 'bill' || o.type === 'subscription') {
      events.push({ date, amount: -amount, kind: 'bill', label: o.name, period: monthOf(o.dueDate), ...(r.account_type === 'credit_card' ? { cardId: r.account_id } : {}) });
    } else if (o.isDebt) {
      // Card repayments are worked out from the card itself (what you owe and what goes on it): see cardBaseline.
      if (r.transfer_account_id != null && cardIds.has(r.transfer_account_id)) {
        cardRepayments.set(r.transfer_account_id, [...(cardRepayments.get(r.transfer_account_id) ?? []), { date, amount }]);
        continue;
      }
      events.push({ date, amount: -amount, kind: 'debt', label: o.name, period: monthOf(o.dueDate) });
    } else {
      events.push({ date, amount: -amount, kind: 'saving', label: o.name, period: monthOf(o.dueDate) });
    }
  }
  if (!events.some((e) => e.kind === 'income')) missing.push({ what: 'No regular pay is set up', fix: 'Add your pay in Bills & income so the forecast knows when money comes in.' });

  // Goals' monthly amounts into accounts no regular saving already covers, the day after payday.
  const savingAccounts = new Set([...rec.values()].filter((r) => r.type === 'saving').map((r) => r.transfer_account_id));
  const goalTargets = goals.filter((g) => g.monthlyTarget && g.account && !savingAccounts.has(g.account.id));
  // The pay that funds each month (pay landing on the 28th funds the next month).
  const paydays = events.filter((e) => e.isPay);
  for (let m = monthOf(today); m <= monthOf(end); m = addMonths(m, 1)) {
    const pd = paydays.find((e) => e.period === m)?.date;
    let date = pd ? addDays(pd, 1) : `${m}-01`;
    if (date < today) date = today;
    for (const g of goalTargets) {
      const amount = m === monthOf(today) ? Math.max(0, g.monthlyTarget - Math.max(0, g.thisMonth)) : g.monthlyTarget;
      if (amount) events.push({ date, amount: -amount, kind: 'saving', label: `${g.name} (goal)`, period: m });
    }
  }
  events.sort((a, b) => a.date.localeCompare(b.date));

  // Day-to-day spending: the average of the last three full months with spending in them.
  const recent = [1, 2, 3, 4, 5, 6].map((n) => addMonths(monthOf(today), -n));
  const seen: number[] = [];
  const onCards = new Map<number, number>();
  for (const m of recent) {
    if (seen.length === 3) break;
    // Leave out bills that weren't linked yet (set up later), so they aren't counted twice.
    const e = plan(db, m, today).spending.everyday - unlinkedBillSpending(db, m);
    if (e <= 0) continue;
    seen.push(e);
    for (const r of db.prepare(
      `SELECT p.account_id AS id, -SUM(p.amount) AS n FROM postings p JOIN transactions t ON t.id = p.transaction_id JOIN accounts a ON a.id = p.account_id
       WHERE t.kind = 'expense' AND t.period = ? AND a.type = 'credit_card'
         AND NOT EXISTS (SELECT 1 FROM recurring_payments rp WHERE rp.transaction_id = t.id) GROUP BY p.account_id`,
    ).all(m) as { id: number; n: number }[]) onCards.set(r.id, (onCards.get(r.id) ?? 0) + Math.max(0, r.n));
  }
  const everydayTotal = seen.reduce((s2, x) => s2 + x, 0);
  const cardShare: Record<string, number> = {};
  let shareSum = 0;
  for (const [id, n] of onCards) { const f = everydayTotal > 0 ? Math.min(1, n / everydayTotal) : 0; cardShare[String(id)] = f; shareSum += f; }
  if (shareSum > 1) for (const k of Object.keys(cardShare)) cardShare[k] /= shareSum;
  const average = seen.length ? Math.round(seen.reduce((s, x) => s + x, 0) / seen.length) : 0;
  if (!seen.length) missing.push({ what: 'No day-to-day spending history yet', fix: 'Import a few months of statements, or enter your typical monthly spending below.' });
  else if (seen.length < 3) missing.push({ what: `Day-to-day spending is based on only ${seen.length} month${seen.length === 1 ? '' : 's'}`, fix: 'Import more history for a steadier average, or enter your own figure below.' });
  const now = plan(db, monthOf(today), today);
  const spentThisMonth = now.spending.everyday;
  const cardSet = new Set(accounts.filter((a) => a.type === 'credit_card').map((a) => a.id));
  const thisMonth = {
    income: now.income.planned, bills: now.bills.planned, saving: Math.max(now.savings.planned, now.savings.saved),
    debts: now.debts.items.filter((i) => i.accountId == null || !cardSet.has(i.accountId)).reduce((s2, i) => s2 + i.amount, 0),
  };

  // Cards.
  const details = new Map((db.prepare('SELECT * FROM debts').all() as any[]).map((d) => [d.account_id, d]));
  const cards: CardInfo[] = accounts.filter((a) => a.type === 'credit_card').map((a) => {
    const d = details.get(a.id);
    const owed = Math.max(0, -a.balance);
    if (!d && owed > 0) missing.push({ what: `${a.name} has no card details (APR, payments)`, fix: 'Add them on the Debts page so card options and repayments are accurate.' });
    else if (d && !d.due_day && owed > 0) missing.push({ what: `${a.name} has no payment due day`, fix: 'Add it on the Debts page.' });
    return {
      accountId: a.id, name: a.name, owed: Math.max(0, -a.balance),
      apr: d ? d.apr : null, promoApr: d?.promo_apr ?? null, promoEnd: d?.promo_end ?? null,
      minType: d?.min_type ?? 'card', minFixed: d?.min_fixed ?? 0, minPercent: d?.min_percent ?? 100, minFloor: d?.min_floor ?? 2500,
      dueDay: d?.due_day ?? null, statementDay: d?.statement_day ?? null, paysInFull: !!d?.pays_in_full,
      creditLimit: d?.credit_limit ?? null, repayments: cardRepayments.get(a.id) ?? [], hasDetails: !!d,
    };
  });

  const payAmount = pay ? (occ.find((o) => o.recurringId === pay.id && o.dueDate >= today)?.expected ?? pay.amount) : 0;
  const nextMonth = addMonths(monthOf(today), 1);
  const savingPerMonth = -events.filter((e) => e.kind === 'saving' && e.period === nextMonth).reduce((s, e) => s + e.amount, 0);
  return {
    today, end, accounts: ctxAccounts, events,
    everyday: { average, spentThisMonth, months: seen.length, cardShare }, thisMonth,
    pay: { amount: payAmount, name: pay?.name ?? null },
    savingPerMonth, cards,
    goals: goals.filter((g) => g.monthlyTarget).map((g) => ({ id: g.id, name: g.name, monthlyTarget: g.monthlyTarget, isEmergency: g.isEmergency, account: g.account?.name ?? null })),
    missing,
  };
}

// ---------------------------------------------------------------------------
// Forecasting

export interface MonthRow {
  month: string;
  start: number; income: number; bills: number; debts: number; saving: number; everyday: number; purchase: number; end: number;
  /** Paying off what you owe on cards today: cash out, but not in Free to spend (that spending was counted when it happened). */
  cards: number;
  freeToSpend: number; floor: number;
}

export interface Forecast {
  start: number;
  days: { date: string; balance: number }[];
  months: MonthRow[];
  lowest: { balance: number; date: string };
  /** What's going out on the day the balance is lowest. */
  lowestOn: string[];
}

export interface Pool {
  start: number;
  /** Accounts counted, with how much of each. */
  accounts: { id: number; name: string; amount: number; changed: boolean; protectedUsed: number }[];
  /** Of the start, how much is goal money or the emergency fund you've chosen to count. */
  protectedIncluded: { emergency: number; goals: number; investments: number };
}

export function pool(ctx: Context, ov: Overrides = {}): Pool {
  const out: Pool['accounts'] = [];
  const prot = { emergency: 0, goals: 0, investments: 0 };
  for (const a of ctx.accounts) {
    const o = ov.accounts?.[String(a.id)];
    const include = o ? o.include : a.defaultIncluded;
    if (!include) continue;
    const amount = o?.amount != null ? o.amount : o ? (a.defaultIncluded ? a.defaultAmount : Math.max(0, a.balance)) : a.defaultAmount;
    const free = a.type === 'investment' ? 0 : Math.max(0, a.balance - a.emergency - a.goals);
    let used = Math.max(0, amount - free);
    if (a.type === 'investment') prot.investments += Math.max(0, amount);
    else {
      const fromGoals = Math.min(used, a.goals); prot.goals += fromGoals; used -= fromGoals;
      prot.emergency += Math.min(used, a.emergency);
    }
    out.push({ id: a.id, name: a.name, amount, changed: !!o && (o.include !== a.defaultIncluded || o.amount != null), protectedUsed: Math.max(0, amount - free) });
  }
  return { start: out.reduce((s, a) => s + a.amount, 0), accounts: out, protectedIncluded: prot };
}

/** Floor for Free to spend in a month. */
const floorFor = (income: number, ov: Overrides) => (ov.floorAmount != null ? ov.floorAmount : Math.round((income * (ov.floorPercent ?? 1000)) / 10000));

export function forecast(ctx: Context, start: number, end: string, extra: { date: string; amount: number; label: string }[], ov: Overrides = {}): Forecast {
  const today = ctx.today;
  // Overrides scale the matching events.
  const payScale = ov.pay != null && ctx.pay.amount > 0 ? ov.pay / ctx.pay.amount : 1;
  const saveScale = ov.saving != null && ctx.savingPerMonth > 0 ? ov.saving / ctx.savingPerMonth : 1;
  const everyday = ov.everyday != null ? ov.everyday : ctx.everyday.average;
  const ev: CashEvent[] = ctx.events.filter((e) => e.date <= end).map((e) => ({
    ...e, amount: Math.round(e.amount * (e.isPay ? payScale : e.kind === 'saving' ? saveScale : 1)),
  }));
  for (const f of extra) if (f.date <= end) ev.push({ date: f.date < today ? today : f.date, amount: -f.amount, kind: 'purchase', label: f.label, period: monthOf(f.date < today ? today : f.date) });

  // Day-to-day spending, spread evenly: this month only what's left of the usual amount.
  const thisMonth = monthOf(today);
  const daily = new Map<string, number>();
  for (let m = thisMonth; m <= monthOf(end); m = addMonths(m, 1)) {
    const first = m === thisMonth ? today : `${m}-01`;
    const days = daysBetween(first, monthEnd(m)) + 1;
    const total = m === thisMonth ? Math.max(0, everyday - ctx.everyday.spentThisMonth) : everyday;
    if (!total) continue;
    const per = Math.floor(total / days);
    let odd = total - per * days;
    for (let k = 0; k < days; k++) {
      const d = addDays(first, k);
      if (d > end) break;
      daily.set(d, per + (odd-- > 0 ? 1 : 0));
    }
  }

  // Cards: spending and bills charged to a card leave your account on the card's due dates, not the day you spend.
  const shares = ctx.everyday.cardShare ?? {};
  const cashShare = Math.max(0, 1 - Object.values(shares).reduce((s, x) => s + x, 0));
  const cardEvents: CashEvent[] = [];
  for (const c of ctx.cards) {
    const f = shares[String(c.accountId)] ?? 0;
    const charges = new Map<string, number>();
    if (f > 0) for (const [d, v] of daily) charges.set(d, Math.round(v * f));
    for (const e of ev) if (e.cardId === c.accountId) charges.set(e.date, (charges.get(e.date) ?? 0) - e.amount);
    for (const x of cardBaseline(c, today, end, charges)) cardEvents.push({ date: x.date, amount: -x.amount, kind: 'card', label: `${c.name} payment`, period: monthOf(x.date) });
  }
  const cash = (e: CashEvent) => e.cardId == null;
  const byDate = new Map<string, CashEvent[]>();
  for (const e of [...ev.filter(cash), ...cardEvents]) byDate.set(e.date, [...(byDate.get(e.date) ?? []), e]);
  const days: Forecast['days'] = [];
  let bal = start;
  let lowest = { balance: start, date: today };
  let lowestOn: string[] = [];
  for (let d = today; d <= end; d = addDays(d, 1)) {
    const todays = byDate.get(d) ?? [];
    bal += todays.reduce((s, e) => s + e.amount, 0) - Math.round((daily.get(d) ?? 0) * cashShare);
    days.push({ date: d, balance: bal });
    if (bal < lowest.balance) { lowest = { balance: bal, date: d }; lowestOn = todays.filter((e) => e.amount < 0).map((e) => e.label); }
  }

  // Calendar months (income by the month it counts towards, as on This month).
  const months: MonthRow[] = [];
  let running = start;
  for (let m = thisMonth; m <= monthOf(end); m = addMonths(m, 1)) {
    // Income and saving count towards the month they're for (pay on the 28th funds next month, and so does saving from it).
    const inM = ev.filter((e) => (e.kind === 'income' || e.kind === 'saving' ? e.period === m : monthOf(e.date) === m));
    const sumKind = (k: CashEvent['kind']) => -(k === 'card' ? cardEvents.filter((e) => monthOf(e.date) === m) : inM.filter((e) => e.kind === k)).reduce((s, e) => s + e.amount, 0);
    // This month: the same figures as the This month card (what's happened plus what's still to come).
    const cur = m === thisMonth ? ctx.thisMonth : null;
    const income = cur ? Math.round(cur.income * (ov.pay != null && ctx.pay.amount > 0 ? payScale : 1)) : inM.filter((e) => e.kind === 'income').reduce((s, e) => s + e.amount, 0);
    const spend = [...daily.entries()].filter(([d]) => monthOf(d) === m).reduce((s, [, v]) => s + v, 0) + (m === thisMonth ? ctx.everyday.spentThisMonth : 0);
    const row: MonthRow = {
      month: m, start: running, income, bills: cur ? cur.bills : sumKind('bill'), debts: cur ? cur.debts : sumKind('debt'),
      saving: cur ? Math.round(cur.saving * saveScale) : sumKind('saving'), everyday: spend,
      purchase: sumKind('purchase'), cards: sumKind('card'), end: 0, freeToSpend: 0, floor: 0,
    };
    // The month's cash movement (by actual date) for the ending balance.
    const lastDay = days.filter((x) => monthOf(x.date) === m).pop();
    row.end = lastDay ? lastDay.balance : running;
    row.freeToSpend = row.income - row.bills - row.debts - row.saving - row.everyday - row.purchase;
    row.floor = floorFor(row.income, ov);
    running = row.end;
    months.push(row);
  }
  return { start, days, months, lowest, lowestOn };
}

// ---------------------------------------------------------------------------
// Assessment

export interface Assessment {
  level: Level;
  title: string;
  reasons: string[];
  adjustments: string[];
  checks: { key: string; label: string; ok: boolean; detail: string }[];
}

const LEVEL_TITLE: Record<Level, string> = {
  comfortable: 'Comfortably affordable',
  adjust: 'Affordable with adjustments',
  stretching: 'Financially stretching',
  not_affordable: 'Not currently affordable',
};

const gbp = (p: number) => `£${(Math.abs(p) / 100).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
/** 29 Nov 2026 */
export const dayName = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const monthName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });

export function assess(ctx: Context, b: Built, withP: Forecast, defaultPool: Forecast | null, p: Pool, ov: Overrides): Assessment {
  const reasons: string[] = [];
  const adjustments: string[] = [];
  const months = withP.months.filter((m) => m.purchase > 0 || m.month <= monthOf(b.lastDate ?? ctx.today) || m.month <= addMonths(monthOf(ctx.today), 3));
  const below = months.filter((m) => m.freeToSpend < m.floor);
  const negativeMonths = months.filter((m) => m.freeToSpend < 0);
  const goesNegative = withP.lowest.balance < 0;
  const usesProtected = p.protectedIncluded.emergency + p.protectedIncluded.goals + p.protectedIncluded.investments > 0;
  const neededProtected = usesProtected && defaultPool != null && defaultPool.lowest.balance < 0 && !goesNegative;

  const checks: Assessment['checks'] = [
    { key: 'balance', label: 'Your balance never goes below £0', ok: !goesNegative,
      detail: goesNegative ? `It would go to -${gbp(withP.lowest.balance)} on ${dayName(withP.lowest.date)}${withP.lowestOn.length ? ` (${withP.lowestOn.slice(0, 3).join(', ')} due)` : ''}.` : `Lowest is ${gbp(withP.lowest.balance)} on ${dayName(withP.lowest.date)}.` },
    { key: 'bills', label: 'Bills and debt payments are paid on time', ok: !goesNegative,
      detail: goesNegative ? 'At least one payment would be due when there isn\'t enough money.' : 'Every bill and debt payment is covered on its date.' },
    { key: 'emergency', label: 'Your emergency fund stays protected', ok: p.protectedIncluded.emergency === 0 || !neededProtected,
      detail: p.protectedIncluded.emergency ? `You've counted ${gbp(p.protectedIncluded.emergency)} of it as available.` : 'Not counted as available.' },
    { key: 'goals', label: 'Your goals and investing carry on', ok: p.protectedIncluded.goals + p.protectedIncluded.investments === 0 || !neededProtected,
      detail: p.protectedIncluded.goals + p.protectedIncluded.investments ? `You've counted ${gbp(p.protectedIncluded.goals + p.protectedIncluded.investments)} of goal money or investments.` : 'Regular saving, investing and goal amounts go out as usual.' },
    { key: 'free', label: `Free to spend stays at least ${ov.floorAmount != null ? gbp(ov.floorAmount) : `${((ov.floorPercent ?? 1000) / 100).toFixed(0)}% of income`} each month`, ok: below.length === 0,
      detail: below.length ? `Below it in ${below.map((m) => monthName(m.month)).join(', ')}.` : 'Above it every month.' },
  ];

  if (b.blockers.length) {
    return { level: 'not_affordable', title: LEVEL_TITLE.not_affordable, reasons: [...b.blockers], adjustments: [], checks };
  }

  let level: Level = 'comfortable';
  if (goesNegative) {
    level = 'not_affordable';
    reasons.push(`Your available money would run out: -${gbp(withP.lowest.balance)} on ${dayName(withP.lowest.date)}, so a payment would be missed.`);
    const monthsTo = Math.max(1, daysBetween(ctx.today, withP.lowest.date) / 30.4);
    const short = -withP.lowest.balance;
    adjustments.push(`You'd need ${gbp(short)} more by ${dayName(withP.lowest.date)}: about ${gbp(Math.ceil(short / monthsTo))} a month less day-to-day spending until then${monthsTo < 1.5 ? ', which is a lot at short notice' : ''}.`);
    if (b.kind === 'outright') adjustments.push('Or compare spreading the cost, or saving first.');
    else if (b.kind !== 'save') adjustments.push('Or try a longer plan, a later purchase date, or saving first.');
  } else if (neededProtected) {
    level = 'stretching';
    const parts = [p.protectedIncluded.emergency && `${gbp(p.protectedIncluded.emergency)} of your emergency fund`, p.protectedIncluded.goals && `${gbp(p.protectedIncluded.goals)} of goal money`, p.protectedIncluded.investments && `${gbp(p.protectedIncluded.investments)} of investments`].filter(Boolean);
    reasons.push(`It only works by using ${parts.join(' and ')}. Without that, your balance would go to -${gbp(defaultPool!.lowest.balance)} on ${dayName(defaultPool!.lowest.date)}.`);
  } else if (below.length >= 3 || negativeMonths.length >= 3) {
    level = 'stretching';
    reasons.push(`Free to spend drops below your minimum in ${below.length} months (${below.slice(0, 4).map((m) => monthName(m.month)).join(', ')}${below.length > 4 ? '…' : ''}).`);
  } else if (below.length > 0) {
    level = 'adjust';
    reasons.push(`Free to spend dips below your minimum in ${below.map((m) => monthName(m.month)).join(' and ')}.`);
  }

  // What would fix the short months, in plain amounts.
  if (below.length && level !== 'not_affordable') {
    const worst = below.reduce((a, m) => (m.floor - m.freeToSpend > a.floor - a.freeToSpend ? m : a), below[0]);
    const gap = worst.floor - worst.freeToSpend;
    adjustments.push(`Spend ${gbp(gap)} less day to day in ${below.length === 1 ? monthName(worst.month) : 'those months'} (from about ${gbp(worst.everyday)}).`);
    const goalAmounts = ctx.goals.filter((g) => !g.isEmergency).sort((a, c) => c.monthlyTarget - a.monthlyTarget);
    let covered = 0; const pause: string[] = [];
    for (const g of goalAmounts) { if (covered >= gap) break; pause.push(`${g.name} (${gbp(g.monthlyTarget)})`); covered += g.monthlyTarget; }
    if (pause.length && covered >= gap) adjustments.push(`Or pause ${pause.join(' and ')} for ${below.length === 1 ? 'that month' : `${below.length} months`}.`);
    if (b.kind === 'outright' || b.kind === 'save') adjustments.push('Or spread the cost: compare the other options.');
    else if (b.payments > 0) adjustments.push('Or choose a longer plan with smaller payments.');
  }

  if (level === 'comfortable') {
    const minFree = Math.min(...months.map((m) => m.freeToSpend - m.floor));
    reasons.push(`All your bills, debts, saving and investing are covered, and Free to spend stays at least ${gbp(Math.max(0, minFree))} above your minimum every month.`);
    reasons.push(`Your balance stays at ${gbp(withP.lowest.balance)} or more.`);
  }
  if (b.totalInterest > 0) reasons.push(`It costs ${gbp(b.totalInterest)} in interest${b.totalFees ? ` and ${gbp(b.totalFees)} in fees` : ''}.`);
  else if (b.totalFees > 0) reasons.push(`It costs ${gbp(b.totalFees)} in fees.`);
  return { level, title: LEVEL_TITLE[level], reasons, adjustments, checks };
}

// ---------------------------------------------------------------------------
// Everything together

export interface OptionResult extends Built {
  assessment: Assessment;
  forecast: Forecast;
  minFreeToSpend: number;
}

export interface SimResult {
  purchase: Purchase;
  pool: Pool;
  floor: { percent: number | null; amount: number | null };
  baseline: Forecast;
  options: OptionResult[];
  best: { id: string; why: string } | null;
  assumptions: { label: string; value: string; changed: boolean }[];
  missing: Missing[];
  /** Save first: the most you could put aside a month and still stay healthy. */
  maxMonthlySaving: number;
}

const LEVEL_RANK: Record<Level, number> = { comfortable: 0, adjust: 1, stretching: 2, not_affordable: 3 };

export function simulate(ctx: Context, input: SimInput): SimResult {
  const ov = input.overrides ?? {};
  const p = input.purchase;
  const pl = pool(ctx, ov);
  const defaultPl = pool(ctx, { ...ov, accounts: undefined });
  const firstPayday = ctx.events.find((e) => e.isPay && e.date >= ctx.today)?.date ?? null;
  const built = input.options.map((o) => buildOption(ctx, p, o, firstPayday ? addDays(firstPayday, 1) : null));
  // One horizon for everyone, so the options compare fairly: the longest plan, at least 3 months.
  const lastDates = built.map((b) => b.lastDate).filter((d): d is string => !!d);
  const latest = [addMonthsToDate(ctx.today, 3), p.date, ...lastDates].sort().pop()!;
  const end = [monthEnd(monthOf(latest)), ctx.end].sort()[0];

  const baseline = forecast(ctx, pl.start, end, [], ov);
  const options: OptionResult[] = built.map((b) => {
    const f = forecast(ctx, pl.start, end, b.flows, ov);
    const fDefault = pl.start !== defaultPl.start ? forecast(ctx, defaultPl.start, end, b.flows, ov) : null;
    const assessment = assess(ctx, b, f, fDefault, pl, ov);
    const relevant = f.months.filter((m) => m.month <= monthOf(b.lastDate ?? ctx.today) || m.month <= addMonths(monthOf(ctx.today), 3));
    return { ...b, assessment, forecast: f, minFreeToSpend: Math.min(...relevant.map((m) => m.freeToSpend)) };
  });

  // Best balance: the best result, then the lowest total cost, then the most room left each month.
  let best: SimResult['best'] = null;
  const ranked = options.filter((o) => o.assessment.level !== 'not_affordable')
    .sort((a, b) => LEVEL_RANK[a.assessment.level] - LEVEL_RANK[b.assessment.level] || a.totalPayable - b.totalPayable || b.minFreeToSpend - a.minFreeToSpend);
  if (ranked.length && options.length > 1) {
    const o = ranked[0];
    const cheaper = options.filter((x) => x.totalPayable < o.totalPayable && x.id !== o.id);
    const why = [
      `${o.assessment.title.toLowerCase()}`,
      o.totalInterest + o.totalFees === 0 ? 'costs nothing extra' : `costs ${gbp(o.totalInterest + o.totalFees)} extra`,
      o.minFreeToSpend > 0 ? `leaves at least ${gbp(o.minFreeToSpend)} Free to spend each month` : `Free to spend goes down to ${o.minFreeToSpend < 0 ? '-' : ''}${gbp(o.minFreeToSpend)} in the tightest month`,
    ];
    best = { id: o.id, why: `${o.label}: ${why.join(', ')}.${cheaper.length ? ` ${cheaper.map((c) => c.label).join(', ')} would be cheaper but ${cheaper.length === 1 ? 'is' : 'are'} harder to afford.` : ''}` };
  }

  // The most you could save a month: the smallest gap between Free to spend and the minimum over the next year.
  const next12 = baseline.months.slice(1, 13);
  const maxMonthlySaving = next12.length ? Math.max(0, Math.min(...next12.map((m) => m.freeToSpend - m.floor))) : 0;

  const assumptions: SimResult['assumptions'] = [
    { label: 'Available money today', value: `${gbp(pl.start)} from ${pl.accounts.map((a) => a.name).join(', ') || 'no accounts'}`, changed: pl.accounts.some((a) => a.changed) },
    { label: 'Your pay', value: ctx.pay.amount || ov.pay ? `${gbp(ov.pay ?? ctx.pay.amount)} each payday${ctx.pay.name ? ` (${ctx.pay.name})` : ''}` : 'Not set up', changed: ov.pay != null },
    { label: 'Day-to-day spending', value: `${gbp(ov.everyday ?? ctx.everyday.average)} a month${ov.everyday == null ? `, your average over the last ${ctx.everyday.months || 0} months` : ''}`, changed: ov.everyday != null },
    { label: 'Regular saving and investing', value: `${gbp(ov.saving ?? ctx.savingPerMonth)} a month, including goals' monthly amounts`, changed: ov.saving != null },
    { label: 'Free to spend minimum', value: ov.floorAmount != null ? `${gbp(ov.floorAmount)} a month` : `${((ov.floorPercent ?? 1000) / 100).toFixed(0)}% of each month's income`, changed: ov.floorAmount != null || ov.floorPercent != null },
    { label: 'Bills and subscriptions', value: 'Your share, on their due dates', changed: false },
    { label: 'Credit cards', value: `${Math.round(Object.values(ctx.everyday.cardShare).reduce((s, x) => s + x, 0) * 100)}% of day-to-day spending goes on cards, and leaves your account when you pay each card off on its due date (what you owe today included)`, changed: false },
    { label: 'Interest', value: 'APR turned into a rate per payment: (1 + APR) ^ (1 / payments a year) − 1', changed: false },
  ];
  return { purchase: p, pool: pl, floor: { percent: ov.floorAmount != null ? null : ov.floorPercent ?? 1000, amount: ov.floorAmount ?? null }, baseline, options, best, assumptions, missing: ctx.missing, maxMonthlySaving };
}
