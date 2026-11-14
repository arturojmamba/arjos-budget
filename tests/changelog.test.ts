import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RELEASES } from '../web/changelog.ts';

test('the changelog starts with the version being released', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(RELEASES[0].version, pkg.version);
});

test('every release has a date and at least one change, newest first', () => {
  for (const r of RELEASES) {
    assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(r.changes.length > 0, r.version);
  }
  const n = (v: string) => v.split('.').map(Number).reduce((t, x) => t * 1000 + x, 0);
  for (let i = 1; i < RELEASES.length; i++) assert.ok(n(RELEASES[i - 1].version) > n(RELEASES[i].version));
});
