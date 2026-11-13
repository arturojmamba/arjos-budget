import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Lock } from '../server/lock.ts';
import { startServer } from '../server/start.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lock-'));

test('passcode: stored only as a hash, checked, throttled after 5 wrong tries', () => {
  let now = 1_000_000;
  const dir = tmp();
  const lock = new Lock(path.join(dir, 'lock.json'), () => now);
  assert.equal(lock.enabled, false);
  assert.equal(lock.isUnlocked(undefined), true, 'no passcode: nothing locked');
  assert.throws(() => lock.set('12a4'), /4 to 12 digits/);
  assert.throws(() => lock.set('123'), /4 to 12 digits/);
  lock.set('482915');
  const raw = fs.readFileSync(path.join(dir, 'lock.json'), 'utf8');
  assert.ok(!raw.includes('482915'), 'the passcode itself is never written');
  assert.equal(lock.length, 6);
  assert.equal(lock.isUnlocked(undefined), false);

  for (let i = 0; i < 4; i++) assert.throws(() => lock.unlock('000000'), (e: any) => e.message === 'Wrong passcode');
  assert.throws(() => lock.unlock('000000'), /Wait 30 seconds/);
  assert.throws(() => lock.unlock('482915'), /Too many tries/, 'even the right one waits');
  now += 31_000;
  const token = lock.unlock('482915');
  assert.equal(lock.isUnlocked(token), true);
  assert.equal(lock.isUnlocked('someone-else'), false);

  assert.throws(() => lock.set('1111', '000000'), /current passcode is wrong/);
  const t2 = lock.set('1111', '482915');
  assert.equal(lock.isUnlocked(token), false, 'changing the passcode ends other sessions');
  assert.equal(lock.isUnlocked(t2), true);
  assert.throws(() => lock.remove('482915'), /current passcode is wrong/);
  lock.remove('1111');
  assert.equal(lock.enabled, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('locked app: only the lock screen answers until unlocked; a restart locks again', async () => {
  const dir = tmp();
  const opts = { dbFile: path.join(dir, 'finance.db'), backupDir: path.join(dir, 'backups'), port: 0, quiet: true };
  let app = await startServer(opts);
  const call = (p: string, init: RequestInit & { cookie?: string } = {}) =>
    fetch(`${app.url}${p}`, { ...init, headers: { 'Content-Type': 'application/json', ...(init.cookie ? { Cookie: init.cookie } : {}) } });
  const cookieOf = (r: Response) => (r.headers.get('set-cookie') ?? '').split(';')[0];

  assert.equal((await call('/api/meta')).status, 200, 'no passcode yet');
  await call('/api/profile', { method: 'PUT', body: JSON.stringify({ name: 'Alex' }) });
  const set = await call('/api/lock/passcode', { method: 'POST', body: JSON.stringify({ passcode: '2468' }) });
  assert.equal(set.status, 200);
  const mine = cookieOf(set);
  assert.match(mine, /^ledger_session=/);
  assert.match(set.headers.get('set-cookie')!, /HttpOnly/);
  assert.equal((await call('/api/meta', { cookie: mine })).status, 200, 'setting it keeps you in');
  assert.equal((await call('/api/meta')).status, 401, 'anyone else is locked out');
  assert.equal((await call('/api/transactions')).status, 401);
  assert.ok(fs.existsSync(path.join(dir, 'lock.json')), 'stored next to the database, not in it');

  const status = await (await call('/api/lock/status')).json();
  assert.equal(status.locked, true);
  assert.equal(status.length, 4);

  await app.close();
  app = await startServer(opts);
  assert.equal((await call('/api/meta', { cookie: mine })).status, 401, 'every launch starts locked');
  assert.equal((await call('/api/lock/unlock', { method: 'POST', body: JSON.stringify({ passcode: '1357' }) })).status, 400);
  const ok = await call('/api/lock/unlock', { method: 'POST', body: JSON.stringify({ passcode: '2468' }) });
  const c = cookieOf(ok);
  assert.equal((await call('/api/meta', { cookie: c })).status, 200);
  await call('/api/lock/lock', { method: 'POST', cookie: c });
  assert.equal((await call('/api/meta', { cookie: c })).status, 401, 'lock now');
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
