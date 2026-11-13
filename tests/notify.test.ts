import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './fixtures.ts';
import { createTransaction, simpleToPostings } from '../server/ledger.ts';
import { createRecurring } from '../server/recurring.ts';
import { createBudget } from '../server/budgets.ts';
import { completePayday } from '../server/payday.ts';
import { dueNotifications, runNotifications, isQuiet, updateNotifySettings, notifySettings, markSent, noticeKeys, DEFAULT_NOTIFY } from '../server/notify.ts';

function setup() {
  const db = testDb();
  db.exec("UPDATE accounts SET anchor_balance = 0, anchor_date = '2025-12-31'");
  const acc = (n: string) => (db.prepare('SELECT id FROM accounts WHERE name = ?').get(n) as { id: number }).id;
  const cat = (n: string, kind = 'expense') => (db.prepare('SELECT id FROM categories WHERE name = ? AND kind = ?').get(n, kind) as { id: number }).id;
  const northbank = acc('Northbank Current');
  createRecurring(db, { name: 'Salary', type: 'income', amount: 240000, frequency: 'monthly', startDate: '2026-01-30', schedule: 'last_working_day', accountId: northbank, categoryId: cat('Salary', 'income') });
  createRecurring(db, { name: 'Gym', type: 'bill', amount: 3000, frequency: 'monthly', startDate: '2026-01-06', accountId: northbank, categoryId: cat('Health & Fitness') });
  createRecurring(db, { name: 'StreamFlix', type: 'subscription', amount: 1099, frequency: 'monthly', startDate: '2026-01-07', accountId: northbank, categoryId: cat('Entertainment') });
  createBudget(db, { name: 'Eating Out', period: 'monthly', amount: 10000, categoryIds: [cat('Eating Out')] } as any, '2026-09-01');
  const spend = (date: string, amount: number, category = 'Eating Out') =>
    createTransaction(db, simpleToPostings({ kind: 'expense', date, description: 'CORNER CAFE', accountId: northbank, amount, categoryId: cat(category) }));
  return { db, northbank, spend };
}

const kinds = (ns: { kind: string }[]) => ns.map((n) => n.kind).sort();
const only = (db: any, k: keyof typeof DEFAULT_NOTIFY) => updateNotifySettings(db, { bills: false, payday: false, weekly: false, budgets: false, imports: false, [k]: true });

test('quiet hours wrap past midnight; equal hours mean none', () => {
  const s = { quietFrom: 22, quietTo: 8 };
  assert.equal(isQuiet(s, 23), true);
  assert.equal(isQuiet(s, 3), true);
  assert.equal(isQuiet(s, 8), false);
  assert.equal(isQuiet(s, 21), false);
  assert.equal(isQuiet({ quietFrom: 13, quietTo: 14 }, 13), true);
  assert.equal(isQuiet({ quietFrom: 9, quietTo: 9 }, 9), false);
});

test('settings: amounts hidden by default, and bad values refused', () => {
  const { db } = setup();
  assert.equal(notifySettings(db).showAmounts, false);
  assert.equal(notifySettings(db).billDays, 1);
  assert.throws(() => updateNotifySettings(db, { billDays: 2 as any }));
  assert.throws(() => updateNotifySettings(db, { quietFrom: 24 }));
  assert.throws(() => updateNotifySettings(db, { bills: 'yes' as any }));
  assert.equal(updateNotifySettings(db, { billDays: 3, quietTo: 7 }).quietTo, 7);
  assert.equal(notifySettings(db).billDays, 3);
});

test('bills: the day before, without amounts unless asked, combined, and only once', () => {
  const { db } = setup();
  only(db, 'bills');
  let n = dueNotifications(db, '2026-12-05');
  assert.equal(n.length, 1);
  assert.equal(n[0].title, 'Gym is due tomorrow');
  assert.equal(n[0].body, 'From Northbank Current.');
  assert.doesNotMatch(n[0].body, /£/);
  assert.equal(n[0].route, '/bills');

  updateNotifySettings(db, { showAmounts: true });
  assert.match(dueNotifications(db, '2026-12-05')[0].body, /£30\.00/);

  // Three days' notice: both bills in one notice.
  updateNotifySettings(db, { billDays: 3 });
  n = dueNotifications(db, '2026-12-04');
  assert.equal(n.length, 1);
  assert.equal(n[0].title, '2 bills due soon');
  assert.match(n[0].body, /Gym and StreamFlix, £40\.99 in total/);
  markSent(db, noticeKeys(n[0]), '2026-12-04');
  assert.equal(dueNotifications(db, '2026-12-05').length, 0, 'each bill is only mentioned once');
});

test('payday: on the day and the next two, until the routine is done', () => {
  const { db } = setup();
  only(db, 'payday');
  assert.equal(dueNotifications(db, '2026-11-27').length, 0);
  const n = dueNotifications(db, '2026-11-30');
  assert.equal(n.length, 1);
  assert.equal(n[0].title, "It's payday");
  assert.equal(n[0].route, '/payday');
  assert.equal(dueNotifications(db, '2026-12-02').length, 1, 'still sent if the computer was off on the day');
  assert.equal(dueNotifications(db, '2026-12-03').length, 0);
  completePayday(db, '2026-11-30', '2026-11-30');
  assert.equal(dueNotifications(db, '2026-11-30').length, 0);
});

test('weekly: last week from Monday, compared with a usual week, without amounts by default', () => {
  const { db, spend } = setup();
  only(db, 'weekly');
  for (let w = 1; w <= 8; w++) spend(`2026-${w <= 4 ? '10' : '11'}-${String(w <= 4 ? 5 + w * 5 : (w - 4) * 4).padStart(2, '0')}`, 5000);
  spend('2026-11-24', 2000);
  const n = dueNotifications(db, '2026-11-30');
  assert.equal(n.length, 1);
  assert.equal(n[0].title, 'Last week at a glance');
  assert.equal(n[0].route, '/reports?tab=week&week=2026-11-23');
  assert.match(n[0].body, /less than a usual week/);
  assert.match(n[0].body, /Most went on Eating Out/);
  assert.doesNotMatch(n[0].body, /£/);
  updateNotifySettings(db, { showAmounts: true });
  assert.match(dueNotifications(db, '2026-11-30')[0].body, /You spent £20\.00/);
  assert.equal(dueNotifications(db, '2026-10-05').length, 0, 'nothing for a week with no spending');
});

test('budgets: once at 80%, once when over', () => {
  const { db, spend } = setup();
  only(db, 'budgets');
  spend('2026-12-02', 5000);
  assert.equal(dueNotifications(db, '2026-12-05').length, 0);
  spend('2026-12-03', 3500);
  let n = dueNotifications(db, '2026-12-05');
  assert.equal(n.length, 1);
  assert.equal(n[0].title, 'Eating Out budget is 85% used');
  assert.doesNotMatch(n[0].body, /£/);
  markSent(db, noticeKeys(n[0]), '2026-12-05');
  assert.equal(dueNotifications(db, '2026-12-05').length, 0);
  spend('2026-12-04', 2000);
  n = dueNotifications(db, '2026-12-05');
  assert.equal(n.length, 1);
  assert.equal(n[0].title, 'Eating Out budget is over');
  assert.equal(n[0].body, "You've gone over it this month.");
});

test('import nudge: a week after the last import, at most once a week, not for long-unused accounts', () => {
  const { db, northbank } = setup();
  only(db, 'imports');
  db.prepare("INSERT INTO import_batches (account_id, filename, imported_at) VALUES (?, 'x.csv', '2026-11-20 10:00:00')").run(northbank);
  assert.equal(dueNotifications(db, '2026-11-25').length, 0);
  const n = dueNotifications(db, '2026-11-29');
  assert.equal(n.length, 1);
  assert.equal(n[0].body, "Northbank Current hasn't been imported for 9 days.");
  markSent(db, noticeKeys(n[0]), '2026-11-29');
  assert.equal(dueNotifications(db, '2026-11-29').length, 0);
  assert.equal(dueNotifications(db, '2026-12-01').length, 1, 'again the next week');
  assert.equal(dueNotifications(db, '2027-02-01').length, 0, 'not after two months');
});

test('a round: quiet hours wait, shown notices are marked, failed ones are retried, off means nothing', () => {
  const { db } = setup();
  only(db, 'payday');
  const shown: string[] = [];
  const show = (n: { title: string }) => { shown.push(n.title); return true; };
  assert.deepEqual(runNotifications(db, new Date(2026, 10, 30, 6, 0), show), []);
  assert.deepEqual(runNotifications(db, new Date(2026, 10, 30, 9, 0), () => false), []);
  assert.equal(runNotifications(db, new Date(2026, 10, 30, 9, 15), show).length, 1);
  assert.equal(runNotifications(db, new Date(2026, 10, 30, 9, 30), show).length, 0);
  assert.deepEqual(shown, ["It's payday"]);
  updateNotifySettings(db, { enabled: false, payday: true });
  assert.equal(dueNotifications(db, '2026-12-31').length, 0);
  assert.deepEqual(kinds(dueNotifications(db, '2026-12-31', { ...notifySettings(db), enabled: true })), ['payday']);
});
