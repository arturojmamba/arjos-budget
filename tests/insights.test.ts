import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './fixtures.ts';
import { createTransaction, simpleToPostings } from '../server/ledger.ts';
import { spendingExplorer, cutBack, habits, payday, compareDrivers, previousRange, placeLabel, weekly, weekStart } from '../server/insights.ts';

function setup() {
  const db = testDb();
  db.exec("UPDATE accounts SET anchor_balance = 0, anchor_date = '2025-12-31'");
  const acc = (db.prepare("SELECT id FROM accounts WHERE name = 'Lark'").get() as { id: number }).id;
  const cat = (n: string) => (db.prepare('SELECT id FROM categories WHERE name = ? AND kind = ?').get(n, 'expense') as { id: number }).id;
  const spend = (date: string, description: string, pounds: number, category: string) =>
    createTransaction(db, simpleToPostings({ kind: 'expense', date, description, accountId: acc, amount: Math.round(pounds * 100), categoryId: cat(category) }));
  return { db, acc, cat, spend };
}

test('explorer: categories, then places, then one place; previous period only when covered', () => {
  const { db, cat, spend } = setup();
  for (const m of ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06']) {
    spend(`${m}-03`, 'CAFE LUMEN 123', 5, 'Eating Out');
    spend(`${m}-10`, 'GRILLHOUSE LONDON', 20, 'Eating Out');
    spend(`${m}-12`, 'BASKETCO STORES 3297', 30, 'Groceries');
  }
  const top: any = spendingExplorer(db, { from: '2026-04-01', to: '2026-06-30' });
  assert.equal(top.level, 'category');
  assert.equal(top.total, 3 * 5500);
  assert.equal(top.series[0].label, 'Groceries');
  assert.deepEqual(top.series[0].values, [3000, 3000, 3000]);
  assert.equal(top.compared, true);
  assert.equal(top.change, 0);
  const eat: any = spendingExplorer(db, { from: '2026-04-01', to: '2026-06-30', categoryId: cat('Eating Out') });
  assert.equal(eat.level, 'merchant');
  assert.deepEqual(eat.series.map((s: any) => s.label).sort(), ['Cafe Lumen', 'Grillhouse']);
  const cafe = eat.series.find((s: any) => s.label === 'Cafe Lumen');
  const one: any = spendingExplorer(db, { from: '2026-04-01', to: '2026-06-30', categoryId: cat('Eating Out'), merchant: cafe.drill.merchant });
  assert.equal(one.level, 'transactions');
  assert.equal(one.count, 3);
  assert.deepEqual(one.crumbs.map((c: any) => c.label), ['All spending', 'Eating Out', 'Cafe Lumen']);
  // Data starts in January, so a Jan–Mar view has nothing before it to compare with.
  const early: any = spendingExplorer(db, { from: '2026-01-01', to: '2026-03-31' });
  assert.equal(early.compared, false);
  assert.equal(early.change, null);
  const search: any = spendingExplorer(db, { from: '2026-01-01', to: '2026-06-30', search: 'grill' });
  assert.equal(search.total, 6 * 2000);
});

test('previous range and place labels', () => {
  assert.deepEqual(previousRange({ from: '2026-04-01', to: '2026-06-30' }), { from: '2026-01-01', to: '2026-03-31' });
  assert.deepEqual(previousRange({ from: '2026-04-06', to: '2026-04-12' }), { from: '2026-03-30', to: '2026-04-05' });
  assert.equal(placeLabel('Metro Travel Charge Metro Gov Cp'), 'Metro Travel Charge');
});

test('cut back: rising categories and small spends that add up', () => {
  const { db, spend } = setup();
  const months = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'];
  months.forEach((m, i) => {
    spend(`${m}-05`, 'SPICE ROOM', i < 3 ? 30 : 90, 'Eating Out');
    spend(`${m}-06`, 'BASKETCO STORES', 100, 'Groceries');
  });
  for (let d = 1; d <= 20; d++) spend(`2026-11-${String(d).padStart(2, '0')}`, 'BREWHOUSE', 3.5, 'Eating Out');
  const c: any = cutBack(db, '2026-11-25');
  assert.equal(c.enoughHistory, true);
  assert.equal(c.risingCategories.length, 1);
  assert.equal(c.risingCategories[0].name, 'Eating Out');
  assert.equal(c.risingCategories[0].extra, 6000);
  assert.equal(c.potential, 6000);
  assert.equal(c.risingPlaces[0].label, 'Spice Room');
  assert.equal(c.smallSpends[0].label, 'Brewhouse');
  assert.equal(c.smallSpends[0].visits, 20);
});

test('habits leave out one-offs; payday curve builds from day 0', () => {
  const { db, spend } = setup();
  spend('2026-06-01', 'CAR DEALER', 8000, 'Shopping'); // a Monday
  spend('2026-06-06', 'PUB', 40, 'Eating Out'); // Saturday
  spend('2026-06-08', 'CAFE LUMEN', 6, 'Eating Out'); // Monday
  const h: any = habits(db, { from: '2026-06-01', to: '2026-06-14' }, '2026-06-30');
  assert.equal(h.oneOffs.count, 1);
  assert.equal(h.weekday.find((d: any) => d.short === 'Mon').total, 600);
  assert.equal(h.weekday.find((d: any) => d.short === 'Sat').total, 4000);
  for (const m of ['2026-04', '2026-05']) { spend(`${m}-02`, 'BASKETCO', 50, 'Groceries'); spend(`${m}-20`, 'BASKETCO', 50, 'Groceries'); }
  spend('2026-07-02', 'BASKETCO', 70, 'Groceries');
  const p: any = payday(db, '2026-07-05');
  assert.equal(p.flexible.now[2], 7000);
  assert.equal(p.flexible.usual[2] > 0, true);
  assert.equal(p.flexible.spentToday, 7000);
});

test('compare shows the places behind the difference', () => {
  const { db, spend } = setup();
  spend('2026-09-10', 'GRILLHOUSE', 20, 'Eating Out');
  spend('2026-10-10', 'GRILLHOUSE', 20, 'Eating Out');
  spend('2026-10-11', 'SPICE ROOM', 60, 'Eating Out');
  const r: any = compareDrivers(db, { from: '2026-10-01', to: '2026-10-31' }, { from: '2026-09-01', to: '2026-09-30' });
  assert.equal(r.a.spending - r.b.spending, 6000);
  assert.equal(r.places[0].label, 'Spice Room');
  assert.equal(r.places[0].diff, 6000);
  assert.equal(r.categories[0].diff, 6000);
});

test('weekly: Monday to Sunday, the same days last week, and a typical week', () => {
  const { db, spend } = setup();
  assert.equal(weekStart('2026-11-13'), '2026-11-09', 'Friday → Monday');
  assert.equal(weekStart('2026-11-15'), '2026-11-09', 'Sunday belongs to the week before it');
  assert.equal(weekStart('2026-11-09'), '2026-11-09');
  // 8 weeks of history: £10 coffee every Monday, £60 groceries every Saturday
  for (let w = 0; w < 9; w++) {
    const mon = new Date(Date.UTC(2026, 8, 14 + 7 * w)).toISOString().slice(0, 10);
    const sat = new Date(Date.UTC(2026, 8, 19 + 7 * w)).toISOString().slice(0, 10);
    spend(mon, 'CAFE LUMEN', 10, 'Eating Out');
    if (sat < '2026-11-13') spend(sat, 'BASKETCO STORES', 60, 'Groceries');
  }
  spend('2026-11-10', 'OAKLET LETTINGS', 900, 'Rent / Housing');
  spend('2026-11-12', 'GRILLHOUSE', 25, 'Eating Out');

  const w = weekly(db, null, '2026-11-13'); // a Friday
  assert.equal(w.from, '2026-11-09');
  assert.equal(w.to, '2026-11-15');
  assert.equal(w.current, true);
  assert.equal(w.elapsed, 5);
  assert.equal(w.spent, 93500);
  assert.equal(w.fixed, 90000, 'rent is a fixed cost');
  assert.equal(w.dayToDay, 3500);
  assert.equal(w.last.spent, 1000, 'last week up to Friday: only Monday coffee, not Saturday groceries');
  assert.equal(w.last.fullWeek, 7000);
  assert.deepEqual(w.typical, { spent: 7000, dayToDay: 7000, weeks: 8 });
  assert.deepEqual(w.days.map((d) => d.label), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  assert.deepEqual(w.days.map((d) => d.future), [false, false, false, false, false, true, true]);
  assert.equal(w.nextWeek, null);

  const past = weekly(db, '2026-11-04', '2026-11-13'); // any day picks its week
  assert.equal(past.from, '2026-11-02');
  assert.equal(past.isLastWeek, true);
  assert.equal(past.nextWeek, '2026-11-09');
  assert.equal(past.spent, 7000);
  assert.equal(past.last.sameDays, false);
  assert.throws(() => weekly(db, '2026-11-16', '2026-11-13'), /hasn't started/);
});
