import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDb } from './fixtures.ts';
import { createTransaction, simpleToPostings } from '../server/ledger.ts';
import { updateAccount } from '../server/admin.ts';
import { listGoals, createGoal, updateGoal, moveMoney, deleteGoal, archiveGoal } from '../server/goals.ts';

function setup() {
  const db = testDb();
  db.exec("UPDATE accounts SET anchor_balance = 0, anchor_date = '2025-12-31'");
  const acc = (n: string) => (db.prepare('SELECT id FROM accounts WHERE name = ?').get(n) as { id: number }).id;
  const move = (date: string, amount: number, from: number, to: number) =>
    createTransaction(db, simpleToPostings({ kind: 'transfer', date, description: 'Move', accountId: from, toAccountId: to, amount }));
  const goal = (name: string, today = '2026-06-20') => listGoals(db, today).goals.find((g) => g.name === name)!;
  return { db, acc, move, goal };
}

test('one goal follows the whole account; money added each month is transfers in', () => {
  const { db, acc, move, goal } = setup();
  const northbank = acc('Northbank Current'), harbour = acc('Harbour Savings');
  createGoal(db, { name: 'Emergency fund', accountId: harbour, target: 300000, isEmergency: true, monthlyTarget: 50000 });
  move('2026-04-02', 50000, northbank, harbour);
  move('2026-05-02', 50000, northbank, harbour);
  move('2026-06-02', 30000, northbank, harbour);
  move('2026-06-10', 5000, harbour, northbank);
  const g = goal('Emergency fund');
  assert.equal(g.mode, 'rest');
  assert.equal(g.saved, 125000);
  assert.equal(g.thisMonth, 25000);
  assert.equal(g.remaining, 175000);
  assert.deepEqual(g.history.slice(-3).map((h) => [h.month, h.saved, h.added]), [['2026-04', 50000, 50000], ['2026-05', 100000, 50000], ['2026-06', 125000, 25000]]);
  assert.equal(g.eta, '2026-12', '£1,750 left at the Mar–May average of about £333 a month');
  assert.equal(g.status, 'on_track');
});

test('splitting an account: money set aside for goals, the rest goes to the main one', () => {
  const { db, acc, move, goal } = setup();
  const northbank = acc('Northbank Current'), harbour = acc('Harbour Savings');
  move('2026-05-01', 400000, northbank, harbour);
  const ef = createGoal(db, { name: 'Emergency fund', accountId: harbour });
  const house = createGoal(db, { name: 'House deposit', accountId: harbour, target: 2000000, deadline: '2028-05-31', startWith: 50000 }, '2026-06-01');
  assert.equal(goal('House deposit').mode, 'share');
  assert.equal(goal('House deposit').saved, 50000);
  assert.equal(goal('Emergency fund').saved, 350000);
  moveMoney(db, house, { amount: 25000, date: '2026-06-15' });
  assert.equal(goal('House deposit').saved, 75000);
  assert.equal(goal('House deposit').thisMonth, 25000, 'the starting amount was already saved, so only the later £250 counts as added');
  assert.equal(goal('Emergency fund').saved, 325000);
  assert.equal(goal('Emergency fund').thisMonth, -25000, 'setting money aside moves it from the rest');
  assert.equal(goal('House deposit').neededPerMonth, Math.ceil((2000000 - 75000) / 24));
  assert.equal(goal('House deposit').status, 'behind');
  assert.throws(() => moveMoney(db, house, { amount: 400000 }), /isn't set aside yet/);
  assert.throws(() => moveMoney(db, ef, { amount: 100 }), /follows the rest/);
  assert.throws(() => createGoal(db, { name: 'Another rest', accountId: harbour, mode: 'rest' }), /already uses what is left/);
  // Two share goals can pass money between them.
  const car = createGoal(db, { name: 'Car', accountId: harbour, mode: 'share' });
  moveMoney(db, car, { amount: 10000, fromGoalId: house, date: '2026-06-16' });
  assert.equal(goal('Car').saved, 10000);
  assert.equal(goal('House deposit').saved, 65000);
  const list = listGoals(db, '2026-06-20');
  assert.deepEqual(list.accounts.find((a) => a.id === harbour), { id: harbour, name: 'Harbour Savings', type: 'savings', colour: list.accounts[0].colour, balance: 400000, setAside: 75000, unassigned: 0, overAssigned: 0, hasRest: true });
  // Deleting a goal puts its money back with the rest.
  deleteGoal(db, house);
  assert.equal(goal('Emergency fund').saved, 390000);
});

test('without a main goal, unassigned money is shown; overspending a split account is flagged', () => {
  const { db, acc, move } = setup();
  const northbank = acc('Northbank Current'), harbour = acc('Harbour Savings');
  move('2026-05-01', 100000, northbank, harbour);
  createGoal(db, { name: 'Holiday', accountId: harbour, mode: 'share', startWith: 60000 }, '2026-05-02');
  let a = listGoals(db, '2026-06-20').accounts[0];
  assert.equal(a.unassigned, 40000);
  move('2026-06-03', 70000, harbour, northbank);
  a = listGoals(db, '2026-06-20').accounts[0];
  assert.equal(a.overAssigned, 30000);
});

test('investments: the goal tracks market value, split into paid in and growth', () => {
  const { db, acc, move, goal } = setup();
  const t212 = acc('Trading 212 ISA');
  move('2026-05-01', 100000, acc('Northbank Current'), t212);
  db.prepare("INSERT INTO valuations (account_id, date, value) VALUES (?, '2026-06-19', 112000)").run(t212);
  createGoal(db, { name: 'ISA £20k', accountId: t212, target: 2000000 });
  const g = goal('ISA £20k');
  assert.equal(g.saved, 112000);
  assert.equal(g.contributed, 100000);
  assert.equal(g.growth, 12000);
  assert.equal(g.thisMonth, 0, 'growth is not money added');
});

test('switching a main goal to set-aside keeps its money; archived goals are hidden', () => {
  const { db, acc, move, goal } = setup();
  const harbour = acc('Harbour Savings');
  move('2026-05-01', 80000, acc('Northbank Current'), harbour);
  const id = createGoal(db, { name: 'Wedding', accountId: harbour });
  updateGoal(db, id, { name: 'Wedding', accountId: harbour, mode: 'share' });
  assert.equal(goal('Wedding', '2099-01-01').mode, 'share');
  assert.equal(goal('Wedding', '2099-01-01').saved, 80000);
  archiveGoal(db, id, true);
  assert.equal(listGoals(db, '2026-06-20').goals.length, 0);
  updateAccount(db, harbour, { balance: 1000 });
});
