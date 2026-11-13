import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openDb, backup } from './db.ts';
import { createApp } from './app.ts';
import { syncedAccounts, trading212Config } from './investments.ts';
import { syncTrading212Full } from './t212.ts';
import { autoMatch } from './recurring.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Secrets (Trading 212 API key) live in .env next to package.json — never in the database or the UI.
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const dbFile = process.env.FINANCE_DB ?? path.join(root, 'data', 'finance.db');
const backupDir = process.env.FINANCE_BACKUPS ?? path.join(root, 'data', 'backups');
const port = Number(process.env.PORT ?? 4545);
const host = process.env.HOST ?? '127.0.0.1'; // local only — never exposed to your network by default

// A backup chosen in Settings → Restore is swapped in here, before the database is opened.
const staged = `${dbFile}.restore`;
if (fs.existsSync(staged)) {
  fs.mkdirSync(backupDir, { recursive: true });
  if (fs.existsSync(dbFile)) {
    const keep = path.join(backupDir, `before-restore-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.db`);
    // VACUUM INTO includes anything still in the write-ahead log, unlike a plain file copy.
    const old = new DatabaseSync(dbFile);
    old.exec(`VACUUM INTO '${keep.replace(/'/g, "''")}'`);
    old.close();
    console.log(`  Restoring a backup. Your previous data is saved at ${keep}`);
  }
  for (const ext of ['-wal', '-shm']) fs.rmSync(dbFile + ext, { force: true });
  fs.renameSync(staged, dbFile);
}

const db = openDb(dbFile);

// Daily automatic backup (keeps the last 30).
function dailyBackup() {
  fs.mkdirSync(backupDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const existing = fs.readdirSync(backupDir).filter((f) => f.endsWith('.db')).sort();
  if (!existing.some((f) => f.includes(today))) {
    backup(db, backupDir);
    for (const old of existing.slice(0, Math.max(0, existing.length + 1 - 30))) fs.rmSync(path.join(backupDir, old));
  }
}
try { dailyBackup(); } catch (e) { console.warn('Backup failed:', e); }
setInterval(() => { try { dailyBackup(); } catch {} }, 6 * 60 * 60 * 1000).unref();

// Match bills to transactions on start, then sync Trading 212 now and every 6 hours.
try { autoMatch(db); } catch (e) { console.warn('Bill matching failed:', e); }
async function syncAll() {
  const config = trading212Config();
  if (!config || process.env.T212_SYNC === 'off') return; // T212_SYNC=off pauses automatic syncing (e.g. for the demo)
  // One API key is one Trading 212 account.
  for (const accountId of syncedAccounts(db).slice(0, 1)) {
    try {
      const r = await syncTrading212Full(db, accountId, config);
      const failed = r.steps.filter((s) => s.status !== 'ok').map((s) => s.key);
      console.log(`  Trading 212 synced${r.value !== null ? `: £${(r.value / 100).toFixed(2)}` : ''} (${r.calls} requests${failed.length ? `; not read: ${failed.join(', ')}` : ''})`);
    } catch (e: any) {
      console.warn(`  Trading 212 sync failed: ${e.message}`);
    }
  }
}
setTimeout(syncAll, 1500);
setInterval(syncAll, 6 * 60 * 60 * 1000).unref();

const staticDir = path.join(root, 'dist');
const app = createApp(db, { staticDir: fs.existsSync(staticDir) ? staticDir : undefined, backupDir, dbFile });
app.listen(port, host, () => {
  console.log(`\n  Finance app running at http://localhost:${port}\n  Database: ${dbFile}`);
  console.log(`  Trading 212: ${trading212Config() ? 'API key found' : 'not configured (see .env.example)'}\n`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { db.close(); process.exit(0); });
}
