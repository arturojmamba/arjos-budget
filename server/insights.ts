/**
 * Reports built around real questions:
 *  - spendingExplorer: where did it go? Drill category → subcategory/places → transactions.
 *  - cutBack: where could I spend less? Rising categories and places, small spends that add up, subscriptions.
 *  - habits: weekdays vs weekends, how big your spends are, the places you go most.
 *  - budgetRecord: how each budget has gone, month by month, and whether the limit is realistic.
 *  - cashFlow: in, out, saved, and how your money runs down from payday to payday.
 *  - compareDrivers: two periods, and which categories and places made the difference.
 *  - weekly: one Monday-to-Sunday week, against the week before and a typical week.
 *
 * Money is pence. Whole-month ranges use the month a transaction counts towards
 * (salary on the last working day funds the next month), as everywhere else.
 */
import { type DB } from './db.ts';
import { ValidationError } from './money.ts';
import { addDays, addMonths, daysBetween, daysInMonth, isIsoDate, monthOf, todayIso } from './dates.ts';
import { type Range, byCategory, compare, merchantKey, monthEnd, monthsIn, rangeWhere, totals, trends } from './reports.ts';
import { listRecurring, occurrences } from './recurring.ts';
import { budgetView, budgetCategoryIds, listBudgets } from './budgets.ts';

/** Categorical colours for things without their own colour (places, subcategories), in a fixed order. */
const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
const OTHER = '#94a3b8';

interface Row {
  id: number; date: string; period: string; description: string; merchant: string; amount: number;
  catId: number | null; catName: string | null; topId: number | null; topName: string; topColour: string; topIcon: string | null; fixed: number;
}

/** Every expense posting in a range, with its category and top-level category. Refunds come through as negative spending. */
function expenseRows(db: DB, r: Range): Row[] {
  const w = rangeWhere(r);
  return db.prepare(
    `SELECT t.id, t.date, t.period, t.description, IFNULL(NULLIF(t.merchant, ''), t.description) AS merchant, -p.amount AS amount,
            c.id AS catId, c.name AS catName, top.id AS topId, IFNULL(top.name, 'Uncategorised') AS topName,
            IFNULL(top.colour, '#94a3b8') AS topColour, top.icon AS topIcon, IFNULL(top.is_fixed, 0) AS fixed
     FROM postings p JOIN transactions t ON t.id = p.transaction_id
     LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN categories top ON top.id = IFNULL(c.parent_id, c.id)
     WHERE t.kind = 'expense' AND ${w.sql}`,
  ).all(...w.params) as unknown as Row[];
}

/** The same number of whole months immediately before a range (or the same number of days, for other ranges). */
export function previousRange(r: Range): Range {
  const whole = r.from.endsWith('-01') && r.to === monthEnd(monthOf(r.to));
  if (whole) {
    const n = monthsIn(r).length;
    const from = addMonths(monthOf(r.from), -n);
    return { from: `${from}-01`, to: monthEnd(addMonths(monthOf(r.from), -1)) };
  }
  const days = daysBetween(r.from, r.to) + 1;
  return { from: addDays(r.from, -days), to: addDays(r.from, -1) };
}

function checkRange(r: Range) {
  if (!isIsoDate(r.from) || !isIsoDate(r.to) || r.from > r.to) throw new ValidationError('Choose a valid date range');
}

const NOISE = new Set(['https', 'http', 'www', 'help', 'com', 'co', 'uk', 'gov', 'cp', 'ltd', 'limited', 'plc', 'london', 'gb', 'net', 'org', 'pm', 'lo', 'ub', 'amzn', 'sm', 'moa']);
/** A friendlier name for a place: drops web-address and company noise and repeated words. "Tfl Travel Charge Tfl Gov Cp" → "Tfl Travel Charge". */
export function placeLabel(key: string): string {
  const seen = new Set<string>();
  const words = key.split(/\s+/).filter((w) => {
    const l = w.toLowerCase();
    if (NOISE.has(l) || seen.has(l)) return false;
    seen.add(l);
    return true;
  });
  return words.length ? words.join(' ') : key;
}

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
const monthKey = (row: Row, whole: boolean) => (whole ? row.period : row.date.slice(0, 7));

// ---------------------------------------------------------------------------
// Spending explorer

export interface ExplorerQuery extends Range { categoryId?: number | null; merchant?: string | null; search?: string | null }

export function spendingExplorer(db: DB, q: ExplorerQuery) {
  checkRange(q);
  const whole = q.from.endsWith('-01') && q.to === monthEnd(monthOf(q.to));
  const months = monthsIn(q);
  const needle = q.search?.trim().toLowerCase() || '';
  const cat = q.categoryId ? db.prepare('SELECT id, name, colour, icon, parent_id FROM categories WHERE id = ?').get(q.categoryId) as { id: number; name: string; colour: string; icon: string | null; parent_id: number | null } | undefined : undefined;
  if (q.categoryId && !cat) throw new ValidationError('Category not found');

  const match = (r: Row) =>
    (!cat || (cat.parent_id == null ? r.topId === cat.id : r.catId === cat.id))
    && (!q.merchant || merchantKey(r.merchant) === q.merchant)
    && (!needle || r.description.toLowerCase().includes(needle) || r.merchant.toLowerCase().includes(needle));

  const rows = expenseRows(db, q).filter(match);
  const prev = previousRange(q);
  // Only compare with the period before if your data actually covers it.
  const firstDate = (db.prepare('SELECT MIN(date) AS d FROM transactions').get() as { d: string | null }).d;
  const covered = !!firstDate && firstDate <= addDays(prev.from, 7);
  const prevRows = covered ? expenseRows(db, prev).filter(match) : [];

  // What the bars are split by at this level.
  const hasSubs = cat && cat.parent_id == null && rows.some((r) => r.catId !== cat.id && r.catId != null);
  const level: 'category' | 'subcategory' | 'merchant' | 'transactions' =
    q.merchant ? 'transactions' : !cat ? 'category' : hasSubs ? 'subcategory' : 'merchant';
  type Key = { key: string; label: string; colour: string; icon: string | null; drill: { categoryId?: number; merchant?: string } | null };
  const keyOf = (r: Row): Key => {
    if (level === 'category') return { key: `c${r.topId ?? 0}`, label: r.topName, colour: r.topColour, icon: r.topIcon, drill: r.topId ? { categoryId: r.topId } : null };
    if (level === 'subcategory') return r.catId === cat!.id
      ? { key: `s${cat!.id}`, label: `${cat!.name} (general)`, colour: '', icon: null, drill: { categoryId: cat!.id, merchant: undefined } }
      : { key: `s${r.catId}`, label: r.catName ?? 'Other', colour: '', icon: null, drill: r.catId ? { categoryId: r.catId } : null };
    const m = merchantKey(r.merchant);
    return { key: `m${m}`, label: placeLabel(m), colour: '', icon: null, drill: { merchant: m } };
  };

  const groups = new Map<string, Key & { values: number[]; total: number; count: number; prev: number }>();
  for (const r of rows) {
    const k = keyOf(r);
    const g = groups.get(k.key) ?? { ...k, values: months.map(() => 0), total: 0, count: 0, prev: 0 };
    const i = months.indexOf(monthKey(r, whole));
    if (i >= 0) g.values[i] += r.amount;
    g.total += r.amount; g.count++;
    groups.set(k.key, g);
  }
  for (const r of prevRows) { const g = groups.get(keyOf(r).key); if (g) g.prev += r.amount; }

  let series = [...groups.values()].filter((g) => g.total !== 0).sort((a, b) => b.total - a.total);
  // Places and subcategories: 7 named, the rest as "Everything else".
  if (level !== 'category' && series.length > 8) {
    const rest = series.slice(7);
    series = [...series.slice(0, 7), {
      key: 'other', label: `${rest.length} more ${level === 'merchant' ? 'places' : ''}`.trim(), colour: OTHER, icon: null, drill: null,
      values: months.map((_, i) => sum(rest.map((g) => g.values[i]))), total: sum(rest.map((g) => g.total)), count: sum(rest.map((g) => g.count)), prev: sum(rest.map((g) => g.prev)),
    }];
  }
  let slot = 0;
  for (const s of series) if (!s.colour) s.colour = s.key === 'other' ? OTHER : SERIES[slot++ % SERIES.length];

  const total = sum(rows.map((r) => r.amount));
  const prevTotal = sum(prevRows.map((r) => r.amount));
  const monthTotals = months.map((_, i) => sum(series.map((s) => s.values[i])));

  // Places within the current filter.
  const places = new Map<string, { merchant: string; total: number; count: number; last: string; values: number[]; category: Map<string, number> }>();
  for (const r of rows) {
    const m = merchantKey(r.merchant);
    const p = places.get(m) ?? { merchant: m, total: 0, count: 0, last: '', values: months.map(() => 0), category: new Map() };
    p.total += r.amount; p.count++; if (r.date > p.last) p.last = r.date;
    const i = months.indexOf(monthKey(r, whole)); if (i >= 0) p.values[i] += r.amount;
    p.category.set(r.topName, (p.category.get(r.topName) ?? 0) + r.amount);
    places.set(m, p);
  }

  const crumbs: { label: string; categoryId?: number | null; merchant?: string | null }[] = [{ label: 'All spending', categoryId: null, merchant: null }];
  if (cat) {
    if (cat.parent_id != null) {
      const parent = db.prepare('SELECT id, name FROM categories WHERE id = ?').get(cat.parent_id) as { id: number; name: string };
      crumbs.push({ label: parent.name, categoryId: parent.id, merchant: null });
    }
    crumbs.push({ label: cat.name, categoryId: cat.id, merchant: null });
  }
  if (q.merchant) crumbs.push({ label: placeLabel(q.merchant), categoryId: cat?.id ?? null, merchant: q.merchant });

  return {
    range: { from: q.from, to: q.to }, previous: prev, months, level, crumbs,
    category: cat ? { id: cat.id, name: cat.name, colour: cat.colour, icon: cat.icon } : null,
    total, prevTotal: covered ? prevTotal : null, change: covered && prevTotal > 0 ? (total - prevTotal) / prevTotal : null, compared: covered,
    perMonth: months.length ? Math.round(total / months.length) : 0,
    count: rows.length,
    average: rows.length ? Math.round(total / rows.length) : 0,
    monthTotals,
    series: series.map((s) => ({
      key: s.key, label: s.label, colour: s.colour, icon: s.icon, drill: s.drill, values: s.values, total: s.total, count: s.count,
      share: total ? s.total / total : 0, prev: covered ? s.prev : null, change: covered && s.prev > 0 ? (s.total - s.prev) / s.prev : null,
    })),
    places: [...places.values()].sort((a, b) => b.total - a.total).slice(0, 15).map((p) => ({
      merchant: p.merchant, label: placeLabel(p.merchant), total: p.total, count: p.count, average: Math.round(p.total / p.count), last: p.last, values: p.values,
      category: [...p.category.entries()].sort((a, b) => b[1] - a[1])[0][0],
    })),
    transactions: rows.sort((a, b) => b.date.localeCompare(a.date) || b.amount - a.amount).slice(0, 60).map((r) => ({
      id: r.id, date: r.date, description: r.description, amount: r.amount, category: r.catName ?? r.topName, colour: r.topColour,
    })),
  };
}

// ---------------------------------------------------------------------------
// Where can I cut back?

/** Last 3 full months against the 3 before them. */
export function cutBack(db: DB, today = todayIso()) {
  const cur = monthOf(today);
  const recent: Range = { from: `${addMonths(cur, -3)}-01`, to: monthEnd(addMonths(cur, -1)) };
  const before: Range = { from: `${addMonths(cur, -6)}-01`, to: monthEnd(addMonths(cur, -4)) };
  const rRows = expenseRows(db, recent);
  const bRows = expenseRows(db, before);
  const firstPeriod = (db.prepare('SELECT MIN(period) AS m FROM transactions').get() as { m: string | null }).m;
  const enoughHistory = !!firstPeriod && firstPeriod <= monthOf(before.from);

  const byKey = <K>(rows: Row[], key: (r: Row) => K) => {
    const m = new Map<K, { total: number; count: number; row: Row }>();
    for (const r of rows) { const k = key(r); const g = m.get(k) ?? { total: 0, count: 0, row: r }; g.total += r.amount; g.count++; m.set(k, g); }
    return m;
  };

  // Rising categories and places (monthly averages).
  const rc = byKey(rRows, (r) => r.topId), bc = byKey(bRows, (r) => r.topId);
  const risingCategories = enoughHistory ? [...rc].map(([id, g]) => {
    const now = Math.round(g.total / 3), was = Math.round((bc.get(id)?.total ?? 0) / 3);
    return { categoryId: id, name: g.row.topName, colour: g.row.topColour, icon: g.row.topIcon, fixed: !!g.row.fixed, now, was, extra: now - was, change: was > 0 ? (now - was) / was : null };
  }).filter((c) => c.extra >= 1500 && (c.change == null || c.change >= 0.2) && c.categoryId != null).sort((a, b) => b.extra - a.extra).slice(0, 6) : [];

  const rm = byKey(rRows, (r) => merchantKey(r.merchant)), bm = byKey(bRows, (r) => merchantKey(r.merchant));
  const risingPlaces = enoughHistory ? [...rm].map(([m, g]) => {
    const now = Math.round(g.total / 3), was = Math.round((bm.get(m)?.total ?? 0) / 3);
    return { merchant: m, label: placeLabel(m), category: g.row.topName, colour: g.row.topColour, visits: g.count, visitsBefore: bm.get(m)?.count ?? 0, now, was, extra: now - was, change: was > 0 ? (now - was) / was : null };
  }).filter((p) => p.extra >= 1000 && p.visits >= 2 && (p.change == null || p.change >= 0.25)).sort((a, b) => b.extra - a.extra).slice(0, 6) : [];

  // Small spends that add up: frequent, cheap, flexible.
  const last90: Range = { from: addDays(today, -89), to: today };
  const small = byKey(expenseRows(db, last90).filter((r) => !r.fixed && r.amount > 0), (r) => merchantKey(r.merchant));
  const smallSpends = [...small].map(([m, g]) => ({ merchant: m, label: placeLabel(m), category: g.row.topName, colour: g.row.topColour, visits: g.count, average: Math.round(g.total / g.count), total: g.total, perYear: Math.round((g.total * 365) / 90) }))
    .filter((s) => s.average <= 1200 && s.visits >= 6).sort((a, b) => b.total - a.total).slice(0, 8);

  // Subscriptions: what they cost a year, your share if shared, and whether one has gone quiet.
  const recurring = listRecurring(db);
  const subs = recurring.filter((r: any) => r.type === 'subscription' && r.active).map((r: any) => {
    const paid = (r.history ?? []).filter((h: any) => h.status === 'paid');
    const last = paid.length ? paid[0].paidDate ?? paid[0].dueDate : null;
    return {
      id: r.id, name: r.name, monthly: r.monthlyNet ?? r.monthly, yearly: Math.round((r.monthlyNet ?? r.monthly) * 12),
      amount: r.amount, yourShare: r.yourShare ?? r.amount, shared: (r.sharedBack ?? 0) > 0, frequency: r.frequency,
      account: r.accountName, since: r.startDate, lastPaid: last, priceChanges: (r.priceChanges ?? []).length,
    };
  }).sort((a: any, b: any) => b.yearly - a.yearly);

  // Charges in Subscriptions that aren't set up as a subscription, so they're easy to miss.
  const tracked = recurring.filter((r: any) => r.active).map((r: any) => (r.matchPattern || r.name).toLowerCase());
  const subRows = expenseRows(db, last90).filter((r) => r.topName === 'Subscriptions' && r.amount > 0);
  const untracked = [...byKey(subRows, (r) => merchantKey(r.merchant))]
    .filter(([m, g]) => !tracked.some((t) => m.toLowerCase().includes(t) || g.row.description.toLowerCase().includes(t)))
    .map(([m, g]) => ({ merchant: m, label: placeLabel(m), count: g.count, total: g.total, last: g.row.date })).sort((a, b) => b.total - a.total).slice(0, 6);

  return {
    recent, before, enoughHistory,
    risingCategories, risingPlaces, smallSpends,
    subscriptions: { list: subs, monthly: sum(subs.map((s: any) => s.monthly)), yearly: sum(subs.map((s: any) => s.yearly)), untracked },
    potential: sum(risingCategories.filter((c) => !c.fixed).map((c) => c.extra)),
  };
}

// ---------------------------------------------------------------------------
// Habits

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const SIZES = [
  { label: 'Under £5', max: 500 }, { label: '£5–£20', max: 2000 }, { label: '£20–£50', max: 5000 },
  { label: '£50–£100', max: 10000 }, { label: '£100–£250', max: 25000 }, { label: '£250 and over', max: Infinity },
];

/** Leave out single spends this big from day-of-week patterns: one car purchase would swamp a year of Wednesdays. */
export const ONE_OFF = 25000;

/** Day-to-day (flexible) spending only: rent, bills and subscriptions would drown the pattern. */
export function habits(db: DB, r: Range, today = todayIso()) {
  checkRange(r);
  const end = r.to < today ? r.to : today;
  const all = expenseRows(db, { from: r.from, to: end }).filter((x) => !x.fixed && x.amount > 0 && x.date >= r.from && x.date <= end);
  const rows = all.filter((x) => x.amount < ONE_OFF);
  const oneOffs = all.filter((x) => x.amount >= ONE_OFF);
  const days = Math.max(1, daysBetween(r.from, end) + 1);
  const dow = (d: string) => (new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7;
  const dayCount = WEEKDAYS.map(() => 0);
  for (let i = 0; i < days; i++) dayCount[dow(addDays(r.from, i))]++;
  const weekday = WEEKDAYS.map((name, i) => {
    const xs = rows.filter((x) => dow(x.date) === i);
    const total = sum(xs.map((x) => x.amount));
    return { day: name, short: name.slice(0, 3), total, count: xs.length, perDay: dayCount[i] ? Math.round(total / dayCount[i]) : 0, days: dayCount[i] };
  });
  const wkTotal = sum(weekday.slice(0, 5).map((d) => d.total)), weTotal = sum(weekday.slice(5).map((d) => d.total));
  const wkDays = sum(dayCount.slice(0, 5)), weDays = sum(dayCount.slice(5));

  const sizes = SIZES.map((s, i) => {
    const min = i === 0 ? 0 : SIZES[i - 1].max;
    const xs = all.filter((x) => x.amount > min && x.amount <= s.max);
    return { label: s.label, count: xs.length, total: sum(xs.map((x) => x.amount)) };
  });

  const places = new Map<string, { merchant: string; category: string; colour: string; count: number; total: number; days: Set<string> }>();
  for (const x of rows) {
    const m = merchantKey(x.merchant);
    const p = places.get(m) ?? { merchant: m, category: x.topName, colour: x.topColour, count: 0, total: 0, days: new Set<string>() };
    p.count++; p.total += x.amount; p.days.add(x.date); places.set(m, p);
  }
  const weeks = days / 7;
  const spendDays = new Set(rows.map((x) => x.date)).size;
  return {
    range: { from: r.from, to: end }, days,
    total: sum(rows.map((x) => x.amount)), count: rows.length,
    weekday,
    weekdayVsWeekend: { weekday: wkDays ? Math.round(wkTotal / wkDays) : 0, weekend: weDays ? Math.round(weTotal / weDays) : 0 },
    busiest: [...weekday].sort((a, b) => b.perDay - a.perDay)[0]?.day ?? null,
    sizes,
    frequent: [...places.values()].sort((a, b) => b.count - a.count || b.total - a.total).slice(0, 10).map((p) => ({
      merchant: p.merchant, label: placeLabel(p.merchant), category: p.category, colour: p.colour, visits: p.count, perWeek: weeks >= 1 ? p.count / weeks : p.count, average: Math.round(p.total / p.count), total: p.total,
    })),
    noSpendDays: days - spendDays,
    typicalSpend: median(rows.map((x) => x.amount)),
    oneOffs: { count: oneOffs.length, total: sum(oneOffs.map((x) => x.amount)), threshold: ONE_OFF },
  };
}

function median(xs: number[]) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

// ---------------------------------------------------------------------------
// Budget track record

export function budgetRecord(db: DB, today = todayIso()) {
  const rows = db.prepare("SELECT * FROM budgets WHERE archived = 0 AND IFNULL(kind, 'spending') = 'spending' ORDER BY sort_order, id").all() as any[];
  return rows.map((b) => {
    const v = budgetView(db, b, today, today);
    const full = v.history.filter((h) => h.key !== v.current.key);
    const withSpend = full.filter((h) => h.spent > 0 || h.limit > 0);
    const over = withSpend.filter((h) => h.spent > h.limit);
    const typical = median(withSpend.map((h) => h.spent));
    const roundUp = (n: number) => Math.ceil(n / 1000) * 1000;
    let verdict: 'realistic' | 'too-tight' | 'roomy' | 'new' = 'realistic';
    let suggestion: number | null = null;
    if (withSpend.length < 2) verdict = 'new';
    else if (over.length / withSpend.length >= 0.5 && typical > v.limit) { verdict = 'too-tight'; suggestion = roundUp(typical); }
    else if (withSpend.every((h) => h.spent < h.limit * 0.6) && v.limit > 2000) { verdict = 'roomy'; suggestion = roundUp(Math.max(...withSpend.map((h) => h.spent)) * 1.1); }
    return {
      id: v.id, name: v.name, colour: v.colour, icon: v.icon, period: v.period, limit: v.limit, startDate: b.start_date,
      current: { label: v.current.label, spent: v.spent, available: v.available, pct: v.pct, onTrack: v.pace?.onTrack ?? null },
      history: v.history.map((h) => ({ ...h, before: h.key < periodKeyOf(b.start_date, v.period), current: h.key === v.current.key })),
      under: withSpend.length - over.length, over: over.length, months: withSpend.length,
      typical, averageOver: over.length ? Math.round(sum(over.map((h) => h.spent - h.limit)) / over.length) : 0,
      verdict, suggestion,
    };
  });
}

function periodKeyOf(date: string, period: string) {
  return period === 'monthly' ? monthOf(date) : period === 'annual' ? date.slice(0, 4) : date;
}

// ---------------------------------------------------------------------------
// Cash flow and payday to payday

export function cashFlow(db: DB, months = 12, today = todayIso()) {
  const t = trends(db, months, today);
  const cur = monthOf(today);
  const months0 = t.flow.filter((f) => f.month !== cur && (f.income > 0 || f.spending > 0));
  const typicalIncome = months0.length ? sum(months0.map((f) => f.income)) / months0.length : 0;
  // A month with hardly any income (pay landed the month before, a gap between jobs) makes the rate
  // meaningless, thousands of percent, and flattens the chart. Leave it out instead.
  const flow = t.flow.map((f) => ({ ...f, savingsRate: f.income > 0 && f.income >= typicalIncome * 0.25 ? f.saved / f.income : null, current: f.month === cur }));
  const full = flow.filter((f) => !f.current && (f.income > 0 || f.spending > 0));
  const avg = (k: 'income' | 'spending' | 'saved' | 'fixed' | 'flexible') => (full.length ? Math.round(sum(full.map((f) => f[k])) / full.length) : 0);
  return {
    flow,
    averages: { income: avg('income'), spending: avg('spending'), saved: avg('saved'), fixed: avg('fixed'), flexible: avg('flexible') },
    savingsRate: avg('income') > 0 ? avg('saved') / avg('income') : null,
    payday: payday(db, today),
  };
}

/**
 * How spending builds up through each pay month. Day 0 is payday (money that
 * lands before the 1st and counts towards the month shows as day 0).
 */
export function payday(db: DB, today = todayIso(), lookback = 6) {
  const cur = monthOf(today);
  const periods = Array.from({ length: lookback }, (_, i) => addMonths(cur, i - lookback)).concat(cur);
  const rows = db.prepare(
    `SELECT t.period AS period, t.date AS date, -p.amount AS amount, IFNULL(top.is_fixed, 0) AS fixed
     FROM postings p JOIN transactions t ON t.id = p.transaction_id
     LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN categories top ON top.id = IFNULL(c.parent_id, c.id)
     WHERE t.kind = 'expense' AND t.period BETWEEN ? AND ?`,
  ).all(periods[0], cur) as { period: string; date: string; amount: number; fixed: number }[];
  const firstPeriod = (db.prepare('SELECT MIN(period) AS m FROM transactions').get() as { m: string | null }).m ?? cur;

  const curve = (period: string, flexibleOnly: boolean) => {
    const n = daysInMonth(period);
    const daily = Array.from({ length: n + 1 }, () => 0);
    for (const r of rows) {
      if (r.period !== period || (flexibleOnly && (r.fixed || r.amount >= ONE_OFF))) continue;
      const d = Math.max(0, Math.min(n, r.date < `${period}-01` ? 0 : Number(r.date.slice(8, 10))));
      daily[d] += r.amount;
    }
    let run = 0;
    return daily.map((x) => (run += x));
  };
  const past = periods.slice(0, -1).filter((p) => p >= firstPeriod && rows.some((r) => r.period === p));
  const avgCurve = (flex: boolean) => {
    const curves = past.map((p) => curve(p, flex));
    if (!curves.length) return [];
    return Array.from({ length: 32 }, (_, d) => Math.round(sum(curves.map((c) => c[Math.min(d, c.length - 1)])) / curves.length));
  };
  const todayDay = Number(today.slice(8, 10));
  const income = past.length ? Math.round(sum(past.map((p) => totals(db, { from: `${p}-01`, to: monthEnd(p) }).income)) / past.length) : 0;
  const thisIncome = totals(db, { from: `${cur}-01`, to: monthEnd(cur) }).income;
  const build = (flex: boolean) => {
    const usual = avgCurve(flex);
    const now = curve(cur, flex).slice(0, todayDay + 1);
    const usualToday = usual[Math.min(todayDay, usual.length - 1)] ?? 0;
    const usualEnd = usual[daysInMonth(cur)] ?? usual[usual.length - 1] ?? 0;
    const spentToday = now[now.length - 1] ?? 0;
    // On today's pace: what you've spent plus what you usually spend in the rest of the month.
    const projected = spentToday + Math.max(0, usualEnd - usualToday);
    const share = (d: number) => (usualEnd > 0 ? (usual[d] ?? 0) / usualEnd : null);
    return { usual, now, usualToday, usualEnd, spentToday, projected, firstWeekShare: share(7), midMonthShare: share(15) };
  };
  return {
    month: cur, today: todayDay, days: daysInMonth(cur), months: past,
    income: { usual: income, thisMonth: thisIncome },
    all: build(false),
    flexible: build(true),
  };
}

// ---------------------------------------------------------------------------
// Compare, with what drove the difference

export function compareDrivers(db: DB, a: Range, b: Range) {
  checkRange(a); checkRange(b);
  const base = compare(db, a, b);
  const group = (rows: Row[]) => {
    const m = new Map<string, { total: number; count: number; category: string; colour: string }>();
    for (const r of rows) { const k = merchantKey(r.merchant); const g = m.get(k) ?? { total: 0, count: 0, category: r.topName, colour: r.topColour }; g.total += r.amount; g.count++; m.set(k, g); }
    return m;
  };
  const ma = group(expenseRows(db, a)), mb = group(expenseRows(db, b));
  const keys = new Set([...ma.keys(), ...mb.keys()]);
  const places = [...keys].map((k) => {
    const x = ma.get(k), y = mb.get(k);
    return { merchant: k, label: placeLabel(k), category: (x ?? y)!.category, colour: (x ?? y)!.colour, a: x?.total ?? 0, b: y?.total ?? 0, aCount: x?.count ?? 0, bCount: y?.count ?? 0, diff: (x?.total ?? 0) - (y?.total ?? 0) };
  }).filter((p) => p.diff !== 0).sort((p, q) => Math.abs(q.diff) - Math.abs(p.diff)).slice(0, 12);
  const daysA = daysBetween(a.from, a.to) + 1, daysB = daysBetween(b.from, b.to) + 1;
  return { ...base, places, days: { a: daysA, b: daysB }, perDay: { a: Math.round(base.a.spending / daysA), b: Math.round(base.b.spending / daysB) } };
}

// ---------------------------------------------------------------------------
// Weekly summary: Monday to Sunday

/** The Monday of the week a date falls in. */
export function weekStart(date: string): string {
  const dow = new Date(`${date}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(date, -((dow + 6) % 7));
}

const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * One week, Monday to Sunday. Compared with the week before (for the current week: the same days of it,
 * so a Wednesday isn't measured against a whole week) and with a typical week (the average of the
 * 8 full weeks before). "Day-to-day" leaves out fixed categories such as rent and bills, which land
 * in whichever week they're due and would swamp the comparison.
 */
export function weekly(db: DB, week?: string | null, today = todayIso()) {
  if (week != null && !isIsoDate(week)) throw new ValidationError('Choose a valid week');
  const thisWeek = weekStart(today);
  const from = week ? weekStart(week) : thisWeek;
  if (from > thisWeek) throw new ValidationError("That week hasn't started yet");
  const to = addDays(from, 6);
  const current = from === thisWeek;
  const upTo = current ? today : to; // the last day with data
  const elapsed = daysBetween(from, upTo) + 1;

  const rows = expenseRows(db, { from, to: upTo });
  const prevFrom = addDays(from, -7);
  const prevAll = expenseRows(db, { from: prevFrom, to: addDays(from, -1) });
  const prevSame = prevAll.filter((r) => r.date <= addDays(prevFrom, elapsed - 1));
  const spent = (rs: Row[]) => sum(rs.map((r) => r.amount));
  const dayToDay = (rs: Row[]) => sum(rs.filter((r) => !r.fixed).map((r) => r.amount));

  // A typical week: the 8 full weeks before this one.
  const histFrom = addDays(from, -56);
  const hist = expenseRows(db, { from: histFrom, to: addDays(from, -1) });
  const firstTx = (db.prepare("SELECT MIN(date) AS d FROM transactions WHERE kind = 'expense'").get() as { d: string | null }).d;
  const weeksOfHistory = firstTx ? Math.max(0, Math.min(8, Math.floor(daysBetween(firstTx > histFrom ? weekStart(addDays(firstTx, 6)) : histFrom, from) / 7))) : 0;
  const typical = weeksOfHistory > 0
    ? { spent: Math.round(spent(hist.filter((r) => r.date >= addDays(from, -7 * weeksOfHistory))) / weeksOfHistory),
        dayToDay: Math.round(dayToDay(hist.filter((r) => r.date >= addDays(from, -7 * weeksOfHistory))) / weeksOfHistory), weeks: weeksOfHistory }
    : null;

  const t = totals(db, { from, to: upTo });

  // Days, stacked by category (top 6 + the rest), as on the spending explorer.
  const catTotals = new Map<string, { id: number | null; name: string; colour: string; icon: string | null; fixed: boolean; total: number; count: number }>();
  for (const r of rows) {
    const k = String(r.topId);
    const c = catTotals.get(k) ?? { id: r.topId, name: r.topName, colour: r.topColour, icon: r.topIcon, fixed: !!r.fixed, total: 0, count: 0 };
    c.total += r.amount; c.count++; catTotals.set(k, c);
  }
  const prevCat = new Map<string, number>();
  for (const r of current ? prevSame : prevAll) prevCat.set(String(r.topId), (prevCat.get(String(r.topId)) ?? 0) + r.amount);
  const ranked = [...catTotals.entries()].sort((a, b) => b[1].total - a[1].total);
  const shown = ranked.slice(0, 6).map(([k]) => k);
  const dates = Array.from({ length: 7 }, (_, i) => addDays(from, i));
  const series = [
    ...ranked.slice(0, 6).map(([k, c]) => ({ key: k, label: c.name, colour: c.colour, values: dates.map((d) => sum(rows.filter((r) => r.date === d && String(r.topId) === k).map((r) => r.amount))) })),
    ...(ranked.length > 6 ? [{ key: 'other', label: 'Everything else', colour: OTHER, values: dates.map((d) => sum(rows.filter((r) => r.date === d && !shown.includes(String(r.topId))).map((r) => r.amount))) }] : []),
  ];
  const days = dates.map((d, i) => {
    const rs = rows.filter((r) => r.date === d);
    return { date: d, label: DAY_SHORT[i], spent: spent(rs), count: rs.length, future: d > upTo, today: d === today };
  });

  const categories = [...new Set([...catTotals.keys(), ...prevCat.keys()])].map((k) => {
    const c = catTotals.get(k);
    const prev = prevCat.get(k) ?? 0;
    const any = c ?? (() => { const r = (current ? prevSame : prevAll).find((x) => String(x.topId) === k)!; return { id: r.topId, name: r.topName, colour: r.topColour, icon: r.topIcon, fixed: !!r.fixed, total: 0, count: 0 }; })();
    return { categoryId: any.id, name: any.name, colour: any.colour, icon: any.icon, fixed: any.fixed, total: c?.total ?? 0, count: c?.count ?? 0, previous: prev, change: (c?.total ?? 0) - prev };
  }).filter((c) => c.total !== 0 || c.previous !== 0).sort((a, b) => b.total - a.total || b.previous - a.previous);

  const placeMap = new Map<string, { total: number; count: number; colour: string; category: string }>();
  for (const r of rows) { const k = merchantKey(r.merchant); const p = placeMap.get(k) ?? { total: 0, count: 0, colour: r.topColour, category: r.topName }; p.total += r.amount; p.count++; placeMap.set(k, p); }
  const places = [...placeMap.entries()].map(([k, p]) => ({ merchant: k, label: placeLabel(k), ...p })).filter((p) => p.total > 0).sort((a, b) => b.total - a.total).slice(0, 8);

  const biggest = rows.filter((r) => r.amount > 0).sort((a, b) => b.amount - a.amount).slice(0, 5)
    .map((r) => ({ id: r.id, date: r.date, description: r.description, merchant: merchantKey(r.merchant), label: placeLabel(merchantKey(r.merchant)), category: r.catName ?? r.topName, colour: r.topColour, amount: r.amount }));

  // Bills due this week, and what's coming next week.
  const bill = (o: ReturnType<typeof occurrences>[number]) => ({ recurringId: o.recurringId, name: o.name, type: o.type, date: o.dueDate, amount: o.paidAmount ?? o.expected, status: o.status });
  const bills = occurrences(db, from, to).filter((o) => o.type !== 'income').map(bill);
  const nextWeek = current ? occurrences(db, addDays(to, 1), addDays(to, 7)).filter((o) => o.type !== 'income').map(bill) : [];

  // Budgets: what went on each this week, and where it stands for its period.
  // Budgets as they stood for this week: live for the current week; otherwise at the end of the month
  // the week mostly falls in (a week's Thursday decides its month, as with ISO weeks).
  const thursday = addDays(from, 3);
  const ref = current ? today : monthOf(to) === monthOf(thursday) ? to : monthEnd(monthOf(thursday));
  const budgets = listBudgets(db, monthOf(ref), ref).budgets.filter((b) => b.kind === 'spending' && !b.archived).map((b) => {
    const ids = new Set(budgetCategoryIds(db, b.id));
    const week = sum(rows.filter((r) => (r.catId != null && ids.has(r.catId)) || (r.topId != null && ids.has(r.topId))).map((r) => r.amount));
    return { id: b.id, name: b.name, icon: b.icon, colour: b.colour, period: b.period, periodLabel: b.current.label, thisWeek: week, spent: b.spent, available: b.available, remaining: b.remaining, status: b.status };
  }).filter((b) => b.thisWeek !== 0 || b.status !== 'ok');

  return {
    from, to, upTo, current, elapsed, isLastWeek: from === addDays(thisWeek, -7), isFirstWeek: !!firstTx && to < firstTx,
    previousWeek: prevFrom, nextWeek: current ? null : addDays(from, 7),
    spent: spent(rows), dayToDay: dayToDay(rows), fixed: spent(rows) - dayToDay(rows),
    income: t.income, saved: t.saved, count: rows.length,
    last: { spent: spent(current ? prevSame : prevAll), dayToDay: dayToDay(current ? prevSame : prevAll), sameDays: current, fullWeek: spent(prevAll) },
    typical,
    days, series, categories, places, biggest, bills, upcoming: nextWeek, budgets,
  };
}

export { byCategory };
