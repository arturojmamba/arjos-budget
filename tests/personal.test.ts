import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.ts';
import { getAppearance, saveAppearance, saveProfile, getProfile, saveAvatar } from '../server/personal.ts';

test('appearance and profile settings are validated and kept', () => {
  const db = openDb(':memory:');
  assert.equal(getAppearance(db).theme, 'system');
  saveAppearance(db, { theme: 'dark', accent: '#6366f1', showPence: false });
  assert.deepEqual([getAppearance(db).theme, getAppearance(db).accent, getAppearance(db).showPence, getAppearance(db).density], ['dark', '#6366f1', false, 'comfortable']);
  assert.throws(() => saveAppearance(db, { accent: 'red' }), /colour/);
  assert.throws(() => saveAppearance(db, { startPage: '/nope' }), /start page/);
  saveProfile(db, { name: '  Alex  ', appName: 'Ledger' });
  assert.deepEqual(getProfile(db), { name: 'Alex', appName: 'Ledger', avatar: null });
  saveAvatar(db, 'data:image/jpeg;base64,AAAA');
  assert.equal(getProfile(db).avatar, 'data:image/jpeg;base64,AAAA');
  assert.throws(() => saveAvatar(db, 'data:text/html;base64,AAAA'), /PNG, JPEG or WebP/);
  saveAvatar(db, null);
  assert.equal(getProfile(db).avatar, null);
});
