/**
 * Builds a demo database full of made-up data, for screenshots and trying the app out.
 *
 *   npm run demo                      # writes data/demo.db
 *   FINANCE_DB=data/demo.db npm start # browse it
 *
 * Everything here is fictional: the person, employer, banks, shops, people and funds.
 * The Trading 212 part is loaded through the real sync code, fed by a fake Trading 212.
 */
import fs from 'node:fs';
import path from 'node:path';
import { openDb, setSetting, type DB } from '../server/db.ts';
import { createTransaction, simpleToPostings } from '../server/ledger.ts';
import { createAccount, createCategory, createRule } from '../server/admin.ts';
import { createRecurring, autoMatch } from '../server/recurring.ts';
import { createBudget } from '../server/budgets.ts';
import { createGoal, moveMoney } from '../server/goals.ts';
import { createDebt, upsertDebt } from '../server/debts.ts';
import { saveShares } from '../server/shares.ts';
import { saveProfile } from '../server/personal.ts';
import { setValuation } from '../server/investments.ts';
import { syncTrading212Full, type T212Fetch } from '../server/t212.ts';
import { addDays, todayIso } from '../server/dates.ts';

const file = path.resolve(process.argv[2] ?? 'data/demo.db');
for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
const db: DB = openDb(file);
const TODAY = todayIso();
const START = '2025-12-31'; // balances are known at the end of this day; transactions start the day after

// ---------------------------------------------------------------------------------------------
// Repeatable randomness, dates

let seed = 20261113;
const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const between = (lo: number, hi: number) => Math.round(lo + rnd() * (hi - lo));
const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
const chance = (p: number) => rnd() < p;
const days = (from: string, to: string) => { const out: string[] = []; for (let d = from; d <= to; d = addDays(d, 1)) out.push(d); return out; };
const dow = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay();
const lastWorkingDay = (ym: string) => { let d = addDays(`${ym}-01`, 40).slice(0, 7) + '-01'; d = addDays(d, -1); while (dow(d) === 0 || dow(d) === 6) d = addDays(d, -1); return d; };
const months = (from: string, to: string) => { const out: string[] = []; let m = from; while (m <= to) { out.push(m); const [y, mo] = m.split('-').map(Number); m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`; } return out; };
const on = (ym: string, day: number) => `${ym}-${String(day).padStart(2, '0')}`;

// ---------------------------------------------------------------------------------------------
// Person, accounts, categories

saveProfile(db, { name: 'Alex', appName: 'Ledger' });
db.exec("DELETE FROM accounts WHERE institution IS NULL OR institution != 'Trading 212'");
const acct = (name: string, type: string, institution: string, colour: string, balance: number, extra: Record<string, unknown> = {}) =>
  createAccount(db, { name, type, institution, colour, balance, balanceDate: START, ...extra } as any);
const current = acct('Everyday Current', 'current', 'Northbank', '#2563eb', 145000);
const card = acct('Rewards Credit Card', 'credit_card', 'Crest', '#7c3aed', -28040);
const savings = acct('Easy Access Saver', 'savings', 'Harbour', '#0d9488', 320000);
const isa = (db.prepare("SELECT id FROM accounts WHERE institution = 'Trading 212'").get() as { id: number }).id;
db.prepare("UPDATE accounts SET name = 'Trading 212 ISA', sync_provider = 'trading212', wrapper = 'isa', anchor_date = ?, anchor_balance = 0, sort_order = 10 WHERE id = ?").run(START, isa);

const cat = (name: string) => {
  const r = db.prepare('SELECT id FROM categories WHERE name = ?').get(name) as { id: number } | undefined;
  if (!r) throw new Error(`No category ${name}`);
  return r.id;
};
const sub = (parent: string, name: string) => createCategory(db, { name, kind: 'expense', parentId: cat(parent) } as any);
const coffee = sub('Eating Out', 'Coffee');
const takeaway = sub('Eating Out', 'Takeaway');
const clothes = sub('Shopping', 'Clothes');
const energy = sub('Bills & Utilities', 'Energy');
const phone = sub('Bills & Utilities', 'Phone & Internet');
const carCat = createCategory(db, { name: 'Car', kind: 'expense', colour: '#64748b', icon: '🚗' } as any);

// ---------------------------------------------------------------------------------------------
// Transactions

const spend = (date: string, description: string, pence: number, categoryId: number, accountId = card, notes: string | null = null) =>
  createTransaction(db, simpleToPostings({ kind: 'expense', date, description, accountId, amount: pence, categoryId, notes }));
const earn = (date: string, description: string, pence: number, categoryId: number, accountId = current) =>
  createTransaction(db, simpleToPostings({ kind: 'income', date, description, accountId, amount: pence, categoryId }));
const move = (date: string, description: string, pence: number, from: number, to: number) =>
  createTransaction(db, simpleToPostings({ kind: 'transfer', date, description, accountId: from, toAccountId: to, amount: pence }));

const span = days(addDays(START, 1), TODAY);
const monthList = months('2026-01', TODAY.slice(0, 7));

// Pay, bills, regular moves
for (const ym of monthList) {
  const payday = lastWorkingDay(ym);
  if (payday <= TODAY) earn(payday, 'NORTHWIND LTD SALARY', ym === '2026-03' ? 340000 + 60000 : 340000, cat('Salary'));
  const bill = (day: number, d: string, p: number, c: number, a = current) => { const date = on(ym, day); if (date <= TODAY) spend(date, d, p, c, a); };
  bill(1, 'OAKLET LETTINGS RENT', 95000, cat('Rent / Housing'));
  if (ym <= '2027-01') bill(2, 'MIDTOWN COUNCIL TAX', 12800, cat('Bills & Utilities'));
  bill(3, 'FITHUB MEMBERSHIP', 3500, cat('Health & Fitness'));
  bill(9, 'STREAMIX.COM', 1099, cat('Subscriptions'), card);
  bill(11, 'TUNEBOX FAMILY', 1799, cat('Subscriptions'), card);
  bill(12, 'BRIGHTWATT ENERGY', ym >= '2026-10' ? 8600 : 7400, energy);
  bill(14, 'CLOUDNEST STORAGE', 249, cat('Subscriptions'), card);
  bill(18, 'FIBRELINE BROADBAND', 3000, phone);
  bill(20, 'CLEARSTREAM WATER', 3600, cat('Bills & Utilities'));
  bill(22, 'SKYWAVE MOBILE', 1800, phone);
  bill(24, 'SURECOVER CAR INSURANCE', 4250, carCat);
  if (on(ym, 1) <= TODAY) move(on(ym, 1), 'TO EASY ACCESS SAVER', 30000, current, savings);
  if (on(ym, 2) <= TODAY) move(on(ym, 2), 'TRADING 212 ISA', 25000, current, isa);
  // Shared music plan: two people pay back their part
  for (const [who, day] of [['SAM RIVERS', 12], ['JO MARLOW', 15]] as const) {
    const d = on(ym, day);
    if (d <= TODAY) createTransaction(db, simpleToPostings({ kind: 'expense', refund: true, date: d, description: `${who} MUSIC`, accountId: current, amount: 600, categoryId: cat('Subscriptions') }));
  }
  // Savings interest
  const intDate = on(ym, 28);
  if (intDate <= TODAY) earn(intDate, 'HARBOUR GROSS INTEREST', between(1350, 1650), cat('Interest'), savings);
}
move('2026-07-08', 'TRADING 212 ISA TOP UP', 50000, savings, isa); // a lump sum from savings

// Day-to-day spending
const commute = (d: string) => dow(d) >= 1 && dow(d) <= 5 && !(d >= '2026-08-10' && d <= '2026-08-16');
for (const d of span) {
  const weekend = dow(d) === 0 || dow(d) === 6;
  if (commute(d)) spend(d, 'CITY TRANSIT TRAVEL CHARGE', pick([560, 560, 560, 280, 840]), cat('Transport'));
  if (commute(d) && chance(0.55)) spend(d, pick(['CAFE LUMEN', 'CAFE LUMEN', 'BREWHOUSE COFFEE', 'DAILY GRIND']), between(310, 460), coffee);
  if (commute(d) && chance(0.3)) spend(d, pick(['GREENLEAF SALADS', 'CORNER DELI', 'NOODLE BAR']), between(650, 1150), cat('Eating Out'));
  if (dow(d) === 6 || (dow(d) === 3 && chance(0.6))) spend(d, pick(['BASKETCO STORES', 'BASKETCO STORES', 'MARKETFIELD', 'FRESHWAY LOCAL']), between(2400, 7800), cat('Groceries'), chance(0.3) ? current : card);
  if (weekend && chance(0.35)) spend(d, pick(['GRILLHOUSE', 'SPICE ROOM', 'THE OLD BELL', 'PIZZERIA ROMA', 'SAKURA SUSHI']), between(1800, 5200), cat('Eating Out'));
  if (dow(d) === 5 && chance(0.5)) spend(d, pick(['QUICKBITE DELIVERY', 'QUICKBITE DELIVERY', 'WOK EXPRESS']), between(1600, 3200), takeaway);
  if (chance(0.04)) spend(d, pick(['THREADLY', 'NORTHSTYLE', 'THREADLY']), between(2500, 8900), clothes);
  if (chance(0.05)) spend(d, pick(['SHOPZONE MARKETPLACE', 'SHOPZONE MARKETPLACE', 'HOMEWARE HUB', 'PAGEBOOKS']), between(899, 4599), cat('Shopping'));
  if (weekend && chance(0.12)) spend(d, pick(['PICTUREHOUSE CINEMA', 'LANES BOWLING', 'TICKETHUB']), between(1200, 4800), cat('Entertainment'));
  if (chance(0.05)) spend(d, pick(['RIDENOW TRIP', 'RIDENOW TRIP']), between(900, 2400), cat('Transport'));
  if (chance(0.025)) spend(d, 'WELLCARE PHARMACY', between(450, 1800), cat('Health & Fitness'));
  if (chance(0.02)) spend(d, 'SHARPCUT BARBERS', 2200, cat('Personal Care'));
  if (chance(0.03)) spend(d, 'GOFUEL SERVICE STATION', between(4500, 6500), carCat);
}
// A holiday, a few one-offs and a refund
spend('2026-06-02', 'SKYJET AIRWAYS', 28640, cat('Travel'));
spend('2026-07-20', 'HARBOURVIEW HOTEL', 42000, cat('Travel'));
for (const d of days('2026-08-10', '2026-08-15')) spend(d, pick(['TAVERNA AZUL', 'GELATERIA SOLE', 'MERCADO CENTRAL']), between(1500, 4800), cat('Travel'));
spend('2026-09-14', 'PAGEBOOKS', 2599, cat('Education'), card, 'Course textbook');
spend('2026-10-04', 'BLOOMBOX FLOWERS', 3500, cat('Shopping'), card, 'Birthday flowers');
spend('2026-10-21', 'SOUNDLAB HEADPHONES', 17999, cat('Shopping'));
createTransaction(db, simpleToPostings({ kind: 'expense', refund: true, date: '2026-10-29', description: 'THREADLY REFUND', accountId: card, amount: 4599, categoryId: clothes }));

// Paying the credit card in full each month (on the 5th) from the current account
for (const ym of monthList) {
  const date = on(ym, 5);
  if (date > TODAY) continue;
  const owed = -(db.prepare(`SELECT a.anchor_balance + IFNULL(SUM(CASE WHEN t.date > a.anchor_date AND t.date < ? THEN p.amount END), 0) AS b
    FROM accounts a LEFT JOIN postings p ON p.account_id = a.id LEFT JOIN transactions t ON t.id = p.transaction_id WHERE a.id = ?`).get(date, card) as { b: number }).b;
  if (owed > 0) move(date, 'CREST CARD PAYMENT', owed, current, card);
}

// ---------------------------------------------------------------------------------------------
// Bills, subscriptions and income plan

const rec = (name: string, type: string, amount: number, startDay: string, accountId: number, categoryId: number | null, matchPattern: string, extra: Record<string, unknown> = {}) =>
  createRecurring(db, { name, type, amount, frequency: 'monthly', startDate: startDay, accountId, categoryId, matchPattern, ...extra } as any);
rec('Salary', 'income', 340000, '2026-01-30', current, cat('Salary'), 'northwind ltd salary', { schedule: 'last_working_day' });
rec('Rent', 'bill', 95000, '2026-01-01', current, cat('Rent / Housing'), 'oaklet lettings');
rec('Council tax', 'bill', 12800, '2026-01-02', current, cat('Bills & Utilities'), 'midtown council', { endDate: '2027-01-02' });
rec('Energy', 'bill', 8600, '2026-01-12', current, energy, 'brightwatt', { variable: true });
rec('Water', 'bill', 3600, '2026-01-20', current, cat('Bills & Utilities'), 'clearstream');
rec('Broadband', 'bill', 3000, '2026-01-18', current, phone, 'fibreline');
rec('Mobile', 'bill', 1800, '2026-01-22', current, phone, 'skywave');
rec('Car insurance', 'bill', 4250, '2026-01-24', current, carCat, 'surecover');
rec('Gym', 'subscription', 3500, '2026-01-03', current, cat('Health & Fitness'), 'fithub');
rec('Streamix', 'subscription', 1099, '2026-01-09', card, cat('Subscriptions'), 'streamix');
const music = rec('Tunebox Family', 'subscription', 1799, '2026-01-11', card, cat('Subscriptions'), 'tunebox');
rec('Cloud storage', 'subscription', 249, '2026-01-14', card, cat('Subscriptions'), 'cloudnest');
rec('Savings', 'saving', 30000, '2026-01-01', current, null, 'to easy access saver', { transferAccountId: savings });
rec('ISA', 'saving', 25000, '2026-01-02', current, null, 'trading 212 isa', { transferAccountId: isa });
saveShares(db, music, [{ name: 'Sam Rivers', amount: 600, accountId: current }, { name: 'Jo Marlow', amount: 600, accountId: current }], { applyToPast: true });
autoMatch(db);

// Rules (a few, as if built up over time)
createRule(db, { pattern: 'cafe lumen', categoryId: coffee } as any);
createRule(db, { pattern: 'city transit', categoryId: cat('Transport') } as any);
createRule(db, { pattern: 'basketco', categoryId: cat('Groceries') } as any);
createRule(db, { pattern: 'quickbite', categoryId: takeaway } as any);

// ---------------------------------------------------------------------------------------------
// Budgets, goals, debts

createBudget(db, { name: 'Groceries', period: 'monthly', amount: 32000, categoryIds: [cat('Groceries')], icon: '🛒', colour: '#16a34a' }, '2026-01-01');
createBudget(db, { name: 'Eating out', period: 'monthly', amount: 26000, categoryIds: [cat('Eating Out')], icon: '🍽️', colour: '#f97316', rollover: true }, '2026-01-01');
createBudget(db, { name: 'Getting around', period: 'monthly', amount: 15000, categoryIds: [cat('Transport')], icon: '🚌', colour: '#0ea5e9' }, '2026-01-01');
createBudget(db, { name: 'Shopping', period: 'monthly', amount: 15000, categoryIds: [cat('Shopping')], icon: '🛍️', colour: '#ec4899' }, '2026-01-01');
createBudget(db, { name: 'Fun', period: 'monthly', amount: 8000, categoryIds: [cat('Entertainment')], icon: '🎬', colour: '#8b5cf6' }, '2026-01-01');
createBudget(db, { name: 'Holidays', period: 'annual', amount: 150000, categoryIds: [cat('Travel')], icon: '✈️', colour: '#06b6d4' }, '2026-01-01');

createGoal(db, { name: 'Emergency fund', icon: '🛟', accountId: savings, target: 600000, isEmergency: true, monthlyTarget: 20000 });
const trip = createGoal(db, { name: 'Japan 2027', icon: '🗾', accountId: savings, target: 250000, deadline: '2027-09-30', monthlyTarget: 15000 });
const laptop = createGoal(db, { name: 'New laptop', icon: '💻', accountId: savings, target: 140000, deadline: '2027-02-28' });
for (const ym of monthList) {
  if (on(ym, 1) > TODAY) continue;
  moveMoney(db, trip, { amount: 15000, date: on(ym, 1) });
  moveMoney(db, laptop, { amount: 12000, date: on(ym, 1) });
}

createDebt(db, {
  name: 'Car loan', debtType: 'car_finance', owed: 612000, originalBalance: 900000, apr: 690, minType: 'fixed', minFixed: 28500,
  dueDay: 15, paymentAccountId: current, addRepayment: true, colour: '#475569',
} as any);
upsertDebt(db, card, { debtType: 'credit_card', originalBalance: 0, apr: 2490, minType: 'card', minPercent: 100, minFloor: 2500, dueDay: 5, paysInFull: true, paymentAccountId: current } as any);
const loan = (db.prepare("SELECT id FROM accounts WHERE name = 'Car loan'").get() as { id: number }).id;
for (const ym of monthList) { const d = on(ym, 15); if (d <= TODAY && d > START) move(d, 'DRIVEWELL FINANCE', 28500, current, loan); }
// The loan's balance today should read about £6,120: set its starting point so repayments since bring it there.
const repaid = 28500 * monthList.filter((m) => on(m, 15) <= TODAY).length;
db.prepare('UPDATE accounts SET anchor_balance = ?, anchor_date = ? WHERE id = ?').run(-(612000 + repaid), START, loan);

// ---------------------------------------------------------------------------------------------
// Trading 212, through the real sync code against a fake Trading 212

const funds = [
  { t: 'GLBLl_EQ', name: 'Global All-Cap Index (Acc)', isin: 'XX0000000101', price: [8.12, 9.92], pie: 1 },
  { t: 'TECHl_EQ', name: 'World Technology Leaders ETF', isin: 'XX0000000102', price: [41.2, 53.6], pie: 2 },
  { t: 'UKDVl_EQ', name: 'UK Dividend Income ETF', isin: 'XX0000000103', price: [5.31, 5.88], pie: 1 },
  { t: 'EMKTl_EQ', name: 'Emerging Markets Equity ETF', isin: 'XX0000000104', price: [30.4, 34.3], pie: 1 },
  { t: 'ROBOl_EQ', name: 'Robotics & Automation ETF', isin: 'XX0000000105', price: [12.6, 15.7], pie: 2 },
  { t: 'GRENl_EQ', name: 'Clean Energy Transition ETF', isin: 'XX0000000106', price: [7.9, 6.85], pie: 0 },
];
const fills: any[] = []; let orderId = 1000; const qty: Record<string, number> = {}; const cost: Record<string, number> = {};
const deposits: any[] = [];
const isaMonths = months('2025-05', TODAY.slice(0, 7));
isaMonths.forEach((ym, i) => {
  const d = on(ym, 2);
  if (d > TODAY) return;
  if (d < '2026-01-01') deposits.push({ type: 'DEPOSIT', amount: 250, currency: 'GBP', dateTime: `${d}T07:30:00Z`, reference: `DEP-${ym}` });
  const amount = ym === '2026-07' ? 750 : 250;
  const split = [['GLBLl_EQ', 0.45], ['TECHl_EQ', 0.2], ['UKDVl_EQ', 0.1], ['EMKTl_EQ', 0.1], ['ROBOl_EQ', 0.15]] as const;
  for (const [t, share] of split) {
    const f = funds.find((x) => x.t === t)!;
    const price = +(f.price[0] + (f.price[1] - f.price[0]) * (i / (isaMonths.length - 1)) * (0.9 + rnd() * 0.2)).toFixed(2);
    const value = +(amount * share).toFixed(2);
    const q = +(value / price).toFixed(4);
    qty[t] = (qty[t] ?? 0) + q; cost[t] = (cost[t] ?? 0) + value;
    fills.push({ order: { id: ++orderId, side: 'BUY', ticker: t, instrument: { ticker: t, name: f.name, isin: f.isin, currency: 'GBP' }, status: 'FILLED', type: 'VALUE', createdAt: `${d}T09:00:00Z`, currency: 'GBP' },
      fill: { id: orderId * 10, filledAt: `${d}T09:00:05Z`, price, quantity: q, walletImpact: { currency: 'GBP', netValue: -value, fxRate: 1, realisedProfitLoss: 0, taxes: [] } } });
  }
});
// Earlier clean-energy position, bought then sold at a loss
fills.push({ order: { id: 900, side: 'BUY', ticker: 'GRENl_EQ', instrument: { ticker: 'GRENl_EQ', name: funds[5].name, isin: funds[5].isin, currency: 'GBP' }, status: 'FILLED', type: 'MARKET', createdAt: '2025-06-10T09:00:00Z', currency: 'GBP' },
  fill: { id: 9001, filledAt: '2025-06-10T09:00:05Z', price: 7.9, quantity: 25, walletImpact: { currency: 'GBP', netValue: -197.5, fxRate: 1, realisedProfitLoss: 0, taxes: [] } } });
fills.push({ order: { id: 901, side: 'SELL', ticker: 'GRENl_EQ', instrument: { ticker: 'GRENl_EQ', name: funds[5].name, isin: funds[5].isin, currency: 'GBP' }, status: 'FILLED', type: 'MARKET', createdAt: '2026-03-18T09:00:00Z', currency: 'GBP' },
  fill: { id: 9011, filledAt: '2026-03-18T09:00:05Z', price: 6.85, quantity: 25, walletImpact: { currency: 'GBP', netValue: 171.25, fxRate: 1, realisedProfitLoss: -26.25, taxes: [] } } });
deposits.push({ type: 'DEPOSIT', amount: 200, currency: 'GBP', dateTime: '2025-06-09T07:30:00Z', reference: 'DEP-GREN' });
// The sale proceeds and dividends go back into the global fund
{ const f = funds[0]; const q = +(190 / 9.1).toFixed(4); qty[f.t] += q; cost[f.t] += 190;
  fills.push({ order: { id: 902, side: 'BUY', ticker: f.t, instrument: { ticker: f.t, name: f.name, isin: f.isin, currency: 'GBP' }, status: 'FILLED', type: 'VALUE', createdAt: '2026-09-21T09:00:00Z', currency: 'GBP' },
    fill: { id: 9021, filledAt: '2026-09-21T09:00:05Z', price: 9.1, quantity: q, walletImpact: { currency: 'GBP', netValue: -190, fxRate: 1, realisedProfitLoss: 0, taxes: [] } } }); }
// Deposits from the bank transfers above (so ISA allowance and bank matching line up)
for (const r of db.prepare("SELECT t.date, p.amount FROM postings p JOIN transactions t ON t.id = p.transaction_id WHERE p.account_id = ? AND p.amount > 0").all(isa) as { date: string; amount: number }[]) {
  deposits.push({ type: 'DEPOSIT', amount: r.amount / 100, currency: 'GBP', dateTime: `${r.date}T08:10:00Z`, reference: `DEP-${r.date}` });
}
deposits.push({ type: 'INTEREST_ON_FREE_CASH', amount: 0.84, currency: 'GBP', dateTime: '2026-10-31T00:00:00Z', reference: 'INT-2610' });
const divs = ['2025-12-20', '2026-03-20', '2026-06-19', '2026-09-18'].map((d, i) => ({ amount: +(3.1 + i * 0.85).toFixed(2), currency: 'GBP', paidOn: `${d}T00:00:00Z`, reference: `DIV-${i}`, ticker: 'UKDVl_EQ', quantity: 40 + i * 12, grossAmountPerShare: 0.08, type: 'ORDINARY', instrument: { name: funds[2].name } }));

const positions = funds.filter((f) => qty[f.t]).map((f) => {
  const q = +qty[f.t].toFixed(4); const now = f.price[1];
  return { instrument: { ticker: f.t, name: f.name, isin: f.isin, currency: 'GBP' }, quantity: q, quantityInPies: q, averagePricePaid: +(cost[f.t] / q).toFixed(4), currentPrice: now, createdAt: '2025-05-02T09:00:00Z',
    walletImpact: { currency: 'GBP', currentValue: +(q * now).toFixed(2), totalCost: +cost[f.t].toFixed(2), unrealizedProfitLoss: +(q * now - cost[f.t]).toFixed(2), fxImpact: null } };
});
const invested = positions.reduce((s, p) => s + p.walletImpact.currentValue, 0);
const totalCost = positions.reduce((s, p) => s + p.walletImpact.totalCost, 0);
const cashIn = deposits.reduce((s, x) => s + x.amount, 0) + divs.reduce((s, x) => s + x.amount, 0);
const cashOut = fills.reduce((s, f) => s - f.fill.walletImpact.netValue, 0);
const freeCash = +(cashIn - cashOut).toFixed(2);
const summary = { id: 40000001, currency: 'GBP', cash: { availableToTrade: freeCash, inPies: 0, reservedForOrders: 0 }, investments: { currentValue: +invested.toFixed(2), totalCost: +totalCost.toFixed(2), unrealizedProfitLoss: +(invested - totalCost).toFixed(2) }, totalValue: +(invested + freeCash).toFixed(2) };
const pieOf = (n: number) => positions.filter((p) => funds.find((f) => f.t === p.instrument.ticker)!.pie === n);
const pieTotals = (n: number) => { const ps = pieOf(n); const v = ps.reduce((s, p) => s + p.walletImpact.currentValue, 0); const c = ps.reduce((s, p) => s + p.walletImpact.totalCost, 0); return { v, c }; };
const pieDetail = (n: number, name: string, goal: number) => ({ settings: { name, goal }, instruments: pieOf(n).map((p) => ({ ticker: p.instrument.ticker, ownedQuantity: p.quantity, expectedShare: +(p.walletImpact.currentValue / pieTotals(n).v).toFixed(3), currentShare: +(p.walletImpact.currentValue / pieTotals(n).v).toFixed(3), result: { priceAvgInvestedValue: p.walletImpact.totalCost, priceAvgValue: p.walletImpact.currentValue, priceAvgResult: p.walletImpact.unrealizedProfitLoss } })) });
const pieSummary = (n: number) => { const { v, c } = pieTotals(n); return { id: n, cash: 0, dividendDetails: { gained: n === 1 ? 14.15 : 0 }, result: { priceAvgInvestedValue: +c.toFixed(2), priceAvgValue: +v.toFixed(2), priceAvgResult: +(v - c).toFixed(2) }, status: 'AHEAD' }; };
const routes: Record<string, unknown> = {
  '/equity/account/summary': summary,
  '/equity/positions': positions,
  '/equity/orders': [],
  '/equity/history/orders?limit=50': { items: fills.sort((a, b) => b.fill.filledAt.localeCompare(a.fill.filledAt)), nextPagePath: null },
  '/equity/history/dividends?limit=50': { items: divs, nextPagePath: null },
  '/equity/history/transactions?limit=50': { items: deposits.sort((a, b) => b.dateTime.localeCompare(a.dateTime)), nextPagePath: null },
  '/equity/metadata/instruments': funds.map((f) => ({ ticker: f.t, type: 'ETF', isin: f.isin, currencyCode: 'GBP', name: f.name, shortName: f.t.slice(0, 4) })),
  '/equity/pies': [pieSummary(1), pieSummary(2)],
  '/equity/pies/1': pieDetail(1, 'Core', 10000),
  '/equity/pies/2': pieDetail(2, 'Growth themes', 4000),
};
const fakeFetch: T212Fetch = async (url) => {
  const p = url.replace(/^https:\/\/[^/]+\/api\/v0/, '');
  return p in routes ? { ok: true, status: 200, json: async () => structuredClone(routes[p]) } : { ok: false, status: 404, json: async () => ({}) };
};
await syncTrading212Full(db, isa, { key: 'demo', secret: 'demo', baseUrl: 'https://demo.trading212.com/api/v0' }, { fetch: fakeFetch, sleep: async () => {} });
// A value history for the chart: month ends, deposits so far times a gently rising return
const netIn = (d: string) => deposits.filter((x) => x.type === 'DEPOSIT' && x.dateTime.slice(0, 10) <= d).reduce((s, x) => s + x.amount, 0);
const finalRatio = summary.totalValue / netIn(TODAY);
const ends = isaMonths.slice(0, -1).map((ym) => addDays(addDays(`${ym}-01`, 40).slice(0, 7) + '-01', -1));
ends.forEach((d, i) => {
  const ratio = 1 + (finalRatio - 1) * ((i + 1) / (ends.length + 1)) + Math.sin(i * 1.7) * 0.012;
  setValuation(db, isa, d, Math.round(netIn(d) * ratio * 100), 'trading212');
});
// Look like imported statements (so the "added by hand" duplicate check stays quiet)
db.exec("UPDATE postings SET import_hash = 'demo-' || id WHERE import_hash IS NULL");
setSetting(db, 'demo', '1');

db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
console.log(`Demo database written to ${file}`);
