import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { isNewer, assetName, latestRelease, verifyDownload, macAppPath } from '../electron/update-core.ts';

test('versions: only a strictly newer release counts', () => {
  assert.equal(isNewer('1.2.1', '1.2.0'), true);
  assert.equal(isNewer('v1.10.0', '1.9.9'), true, 'numeric, not alphabetical');
  assert.equal(isNewer('1.2.0', '1.2.0'), false);
  assert.equal(isNewer('1.1.9', '1.2.0'), false);
  assert.equal(isNewer('nonsense', '1.0.0'), false);
});

test('the right installer for each computer', () => {
  assert.equal(assetName('1.2.1', 'darwin', 'arm64'), 'Ledger-1.2.1-mac-arm64.dmg');
  assert.equal(assetName('1.2.1', 'darwin', 'x64'), 'Ledger-1.2.1-mac-x64.dmg');
  assert.equal(assetName('1.2.1', 'win32', 'x64'), 'Ledger-Setup-1.2.1.exe');
  assert.equal(assetName('1.2.1', 'linux', 'x64'), null);
});

const release = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag, body: '- Passcode lock', published_at: '2026-11-13T19:00:00Z', html_url: `https://github.com/o/r/releases/tag/${tag}`, draft: false, prerelease: false,
  assets: [
    { name: `Ledger-${tag.slice(1)}-mac-arm64.dmg`, browser_download_url: 'https://example/arm.dmg', size: 10, digest: 'sha256:ABC' },
    { name: `Ledger-Setup-${tag.slice(1)}.exe`, browser_download_url: 'https://example/setup.exe', size: 20 },
  ],
  ...extra,
});
const fakeFetch = (status: number, body: unknown) => (async () => ({ ok: status === 200, status, json: async () => body })) as unknown as typeof fetch;

test('reads the latest GitHub release', async () => {
  const mac = await latestRelease('o/r', '1.2.0', 'darwin', 'arm64', fakeFetch(200, release('v1.2.1')));
  assert.equal(mac?.version, '1.2.1');
  assert.equal(mac?.asset.url, 'https://example/arm.dmg');
  assert.equal(mac?.asset.sha256, 'abc');
  assert.equal(mac?.notes, '- Passcode lock');
  const win = await latestRelease('o/r', '1.2.0', 'win32', 'x64', fakeFetch(200, release('v1.2.1')));
  assert.equal(win?.asset.sha256, null, 'no digest published: size check only');
  assert.equal(await latestRelease('o/r', '1.2.1', 'darwin', 'arm64', fakeFetch(200, release('v1.2.1'))), null, 'already up to date');
  assert.equal(await latestRelease('o/r', '1.2.0', 'darwin', 'x64', fakeFetch(200, release('v1.2.1'))), null, 'no file for this computer');
  assert.equal(await latestRelease('o/r', '1.2.0', 'darwin', 'arm64', fakeFetch(200, release('v1.3.0', { prerelease: true }))), null);
  assert.equal(await latestRelease('o/r', '1.2.0', 'darwin', 'arm64', fakeFetch(404, {})), null, 'no releases yet');
  await assert.rejects(latestRelease('o/r', '1.2.0', 'darwin', 'arm64', fakeFetch(403, {})), /GitHub answered 403/);
});

test('downloads are checked before installing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upd-'));
  const file = path.join(dir, 'x.dmg');
  fs.writeFileSync(file, 'new version');
  const sha = crypto.createHash('sha256').update('new version').digest('hex');
  await verifyDownload(file, { name: 'x.dmg', url: '', size: 11, sha256: sha });
  await assert.rejects(verifyDownload(file, { name: 'x.dmg', url: '', size: 12, sha256: null }), /incomplete/);
  await assert.rejects(verifyDownload(file, { name: 'x.dmg', url: '', size: 11, sha256: 'f'.repeat(64) }), /checksum/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a Mac app is only replaced where it can be', () => {
  const ok = () => true;
  assert.deepEqual(macAppPath('/Applications/Ledger.app/Contents/MacOS/Ledger', ok), { app: '/Applications/Ledger.app' });
  assert.match((macAppPath('/Volumes/Ledger 1.2.0/Ledger.app/Contents/MacOS/Ledger', ok) as any).reason, /disk image/);
  assert.match((macAppPath('/private/var/folders/x/AppTranslocation/ABC/d/Ledger.app/Contents/MacOS/Ledger', ok) as any).reason, /temporary location/);
  assert.match((macAppPath('/Applications/Ledger.app/Contents/MacOS/Ledger', () => false) as any).reason, /can't write/);
  assert.match((macAppPath('/usr/bin/node', ok) as any).reason, /installed app/);
});
