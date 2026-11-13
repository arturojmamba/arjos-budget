import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server/start.ts';

test('startServer serves the API, falls back to a free port, and only offers desktop actions to the desktop app', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  const a = await startServer({ dbFile: path.join(dir, 'a.db'), backupDir: path.join(dir, 'backups'), port: 0, quiet: true });
  const meta = await (await fetch(`${a.url}/api/meta`)).json();
  assert.equal(meta.desktop, null);
  const r = await fetch(`${a.url}/api/t212/key`, { method: 'POST', body: JSON.stringify({ key: 'k', secret: 's' }), headers: { 'Content-Type': 'application/json' } });
  assert.equal(r.status, 400);

  // Second app wants the same port: takes another one instead of failing.
  const saved: string[] = [];
  const b = await startServer({
    dbFile: path.join(dir, 'b.db'), backupDir: path.join(dir, 'backups-b'), port: a.port, anyPortIfTaken: true, quiet: true,
    desktop: { version: '1.0.0', platform: 'darwin', dataDir: dir, saveT212Key: (k, s) => saved.push(`${k}:${s}`), clearT212Key: () => {}, openDataFolder: () => {}, relaunch: () => {} },
  });
  assert.notEqual(b.port, a.port);
  const meta2 = await (await fetch(`${b.url}/api/meta`)).json();
  assert.deepEqual(meta2.desktop, { version: '1.0.0', platform: 'darwin', dataDir: dir });
  const bad = await fetch(`${b.url}/api/t212/key`, { method: 'POST', body: JSON.stringify({ key: 'has space', secret: 'x' }) });
  assert.equal(bad.status, 400);
  const ok = await fetch(`${b.url}/api/t212/key`, { method: 'POST', body: JSON.stringify({ key: 'KEY1', secret: 'SECRET1' }) });
  assert.equal(ok.status, 200);
  assert.deepEqual(saved, ['KEY1:SECRET1']);
  await a.close(); await b.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
