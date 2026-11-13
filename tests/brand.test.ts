import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, setSetting } from '../server/db.ts';
import { getAppearance, getProfile } from '../server/personal.ts';

test('the Coil restyle: the old default coral and name move over, your own choices stay', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coil-'));
  const file = path.join(dir, 'finance.db');
  // A database as it was before (version 14) with the old defaults saved.
  const db = openDb(file);
  setSetting(db, 'appearance', JSON.stringify({ theme: 'dark', accent: '#ff5b45' }));
  setSetting(db, 'profile', JSON.stringify({ name: 'Alex', appName: 'Ledger' }));
  db.exec('PRAGMA user_version = 14');
  db.close();
  const again = openDb(file);
  assert.equal(getAppearance(again).accent, '#d9c08e');
  assert.equal(getAppearance(again).theme, 'dark');
  assert.equal(getProfile(again).appName, '');
  assert.equal(getProfile(again).name, 'Alex');
  again.close();

  // Chosen by you: kept.
  const raw = new DatabaseSync(file);
  raw.prepare("UPDATE settings SET value = ? WHERE key = 'appearance'").run(JSON.stringify({ accent: '#2563eb' }));
  raw.prepare("UPDATE settings SET value = ? WHERE key = 'profile'").run(JSON.stringify({ name: 'Alex', appName: 'My money' }));
  raw.exec('PRAGMA user_version = 14');
  raw.close();
  const third = openDb(file);
  assert.equal(getAppearance(third).accent, '#2563eb');
  assert.equal(getProfile(third).appName, 'My money');
  third.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a new database starts in champagne gold', () => {
  const db = openDb(':memory:');
  assert.equal(getAppearance(db).accent, '#d9c08e');
});
