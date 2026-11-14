import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../server/db.ts';
import { backupAndCopy, copyBackup, copyFolder, iCloudDrive, lastCopy, prune, setCopyFolder } from '../server/backupcopy.ts';
import { startServer } from '../server/start.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'coil-copy-'));

test('no folder chosen: backups stay at home and nothing is copied', () => {
  const dir = tmp();
  const db = openDb(':memory:');
  const r = backupAndCopy(db, path.join(dir, 'backups'));
  assert.ok(fs.existsSync(r.file));
  assert.equal(r.copy, null);
  assert.equal(copyFolder(db), null);
});

test('choosing a folder copies a backup straight away, and later backups follow', () => {
  const dir = tmp();
  const db = openDb(':memory:');
  const cloud = path.join(dir, 'cloud', 'Coil Backups');
  fs.mkdirSync(path.dirname(cloud));
  const first = setCopyFolder(db, path.join(dir, 'backups'), cloud)!;
  assert.equal(first.ok, true);
  assert.equal(copyFolder(db), cloud);
  assert.equal(fs.readdirSync(cloud).filter((f) => f.endsWith('.db')).length, 1);
  assert.deepEqual(fs.readdirSync(cloud).filter((f) => f.endsWith('.part')), []);
  const again = backupAndCopy(db, path.join(dir, 'backups'));
  assert.equal(again.copy?.ok, true);
  assert.equal(path.basename(again.copy!.file!), path.basename(again.file));
  assert.equal(lastCopy(db)?.ok, true);
});

test('a folder whose parent is missing is refused and nothing is saved', () => {
  const dir = tmp();
  const db = openDb(':memory:');
  assert.throws(() => setCopyFolder(db, path.join(dir, 'backups'), path.join(dir, 'nope', 'deeper')), /doesn't exist/);
  assert.throws(() => setCopyFolder(db, path.join(dir, 'backups'), 'relative/folder'), /full folder path|doesn't exist/);
  assert.equal(copyFolder(db), null);
});

test('a folder that disappears later records a failed copy without losing the backup at home', () => {
  const dir = tmp();
  const db = openDb(':memory:');
  const parent = path.join(dir, 'drive');
  fs.mkdirSync(parent);
  setCopyFolder(db, path.join(dir, 'backups'), path.join(parent, 'Coil Backups'));
  fs.rmSync(parent, { recursive: true });
  const r = backupAndCopy(db, path.join(dir, 'backups'));
  assert.ok(fs.existsSync(r.file));
  assert.equal(r.copy?.ok, false);
  assert.match(lastCopy(db)!.error!, /isn't there/);
});

test('clearing the folder stops copying', () => {
  const dir = tmp();
  const db = openDb(':memory:');
  setCopyFolder(db, path.join(dir, 'backups'), path.join(dir, 'copies'));
  setCopyFolder(db, path.join(dir, 'backups'), null);
  assert.equal(copyFolder(db), null);
  assert.equal(lastCopy(db), null);
  assert.equal(copyBackup(db, backupAndCopy(db, path.join(dir, 'backups')).file), null);
});

test('prune keeps the newest 30 dated backups and leaves everything else alone', () => {
  const dir = tmp();
  for (let i = 1; i <= 33; i++) fs.writeFileSync(path.join(dir, `finance-2026-01-${String(i).padStart(2, '0')}T00-00-00.db`), '');
  fs.writeFileSync(path.join(dir, 'before-update-x.db'), '');
  fs.writeFileSync(path.join(dir, 'notes.txt'), '');
  prune(dir);
  const left = fs.readdirSync(dir).sort();
  assert.equal(left.filter((f) => f.startsWith('finance-')).length, 30);
  assert.ok(!left.includes('finance-2026-01-01T00-00-00.db'));
  assert.ok(left.includes('finance-2026-01-33T00-00-00.db'));
  assert.ok(left.includes('before-update-x.db') && left.includes('notes.txt'));
});

test('iCloud Drive is found where macOS and Windows put it', () => {
  const home = tmp();
  assert.equal(iCloudDrive('darwin', home), null);
  const mac = path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
  fs.mkdirSync(mac, { recursive: true });
  assert.equal(iCloudDrive('darwin', home), mac);
  assert.equal(iCloudDrive('win32', home), null);
  fs.mkdirSync(path.join(home, 'iCloudDrive'));
  assert.equal(iCloudDrive('win32', home), path.join(home, 'iCloudDrive'));
  assert.equal(iCloudDrive('linux', home), null);
});

test('the API sets the folder, and the picker only works in the desktop app', async () => {
  const dir = tmp();
  const a = await startServer({ dbFile: path.join(dir, 'a.db'), backupDir: path.join(dir, 'backups'), port: 0, quiet: true });
  const put = (body: unknown) => fetch(`${a.url}/api/backup/copy`, { method: 'PUT', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  assert.equal((await (await fetch(`${a.url}/api/backup/copy`)).json()).folder, null);
  const ok = await (await put({ folder: path.join(dir, 'copies') })).json();
  assert.equal(ok.folder, path.join(dir, 'copies'));
  assert.equal(ok.last.ok, true);
  assert.equal(ok.canPick, false);
  const made = await (await fetch(`${a.url}/api/backup`, { method: 'POST', body: '{}' })).json();
  assert.equal(made.copy.ok, true);
  assert.equal((await fetch(`${a.url}/api/backup/copy/pick`, { method: 'POST', body: '{}' })).status, 400);
  assert.equal((await put({ folder: 5 })).status, 400);
  await a.close();

  const picked = path.join(dir, 'picked');
  const b = await startServer({
    dbFile: path.join(dir, 'b.db'), backupDir: path.join(dir, 'backups-b'), port: 0, quiet: true,
    desktop: { version: '1.0.0', platform: 'darwin', dataDir: dir, saveT212Key: () => {}, clearT212Key: () => {}, openDataFolder: () => {}, relaunch: () => {}, pickFolder: async () => picked },
  });
  const r = await (await fetch(`${b.url}/api/backup/copy/pick`, { method: 'POST', body: '{}' })).json();
  assert.equal(r.folder, picked);
  assert.equal(r.canPick, true);
  assert.ok(fs.readdirSync(picked).some((f) => f.endsWith('.db')));
  await b.close();
});
