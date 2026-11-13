/**
 * Starts the app: opens the database (swapping in a staged restore first), keeps daily backups,
 * matches bills, syncs Trading 212 every 6 hours, and serves the API and UI on localhost.
 * Used by `npm start` (server/index.ts) and by the desktop app (electron/main.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { openDb, backup, type DB } from './db.ts';
import { createApp, type DesktopHost } from './app.ts';
import { syncedAccounts, trading212Config } from './investments.ts';
import { syncTrading212Full } from './t212.ts';
import { autoMatch } from './recurring.ts';

export interface StartOptions {
  dbFile: string;
  backupDir: string;
  /** Built UI (dist/). Omit to serve the API only. */
  staticDir?: string;
  port: number;
  /** If the port is taken, take any free one instead of failing (the desktop app). */
  anyPortIfTaken?: boolean;
  host?: string;
  desktop?: DesktopHost;
  log?: (msg: string) => void;
  /** Skip the start-up sync and the timers (tests). */
  quiet?: boolean;
}

export interface Running { server: Server; db: DB; port: number; url: string; close(): Promise<void> }

/** A backup chosen in Settings → Restore is swapped in before the database is opened. */
function applyStagedRestore(dbFile: string, backupDir: string, log: (m: string) => void) {
  const staged = `${dbFile}.restore`;
  if (!fs.existsSync(staged)) return;
  fs.mkdirSync(backupDir, { recursive: true });
  if (fs.existsSync(dbFile)) {
    const keep = path.join(backupDir, `before-restore-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.db`);
    // VACUUM INTO includes anything still in the write-ahead log, unlike a plain file copy.
    const old = new DatabaseSync(dbFile);
    old.exec(`VACUUM INTO '${keep.replace(/'/g, "''")}'`);
    old.close();
    log(`Restoring a backup. Your previous data is saved at ${keep}`);
  }
  for (const ext of ['-wal', '-shm']) fs.rmSync(dbFile + ext, { force: true });
  fs.renameSync(staged, dbFile);
}

export async function startServer(o: StartOptions): Promise<Running> {
  const log = o.log ?? ((m: string) => console.log(`  ${m}`));
  const host = o.host ?? '127.0.0.1'; // local only: never exposed to your network by default
  applyStagedRestore(o.dbFile, o.backupDir, log);
  const db = openDb(o.dbFile);
  const timers: NodeJS.Timeout[] = [];

  // Daily automatic backup (keeps the last 30).
  const dailyBackup = () => {
    fs.mkdirSync(o.backupDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const existing = fs.readdirSync(o.backupDir).filter((f) => f.endsWith('.db') && !f.startsWith('before-')).sort();
    if (!existing.some((f) => f.includes(today))) {
      backup(db, o.backupDir);
      for (const old of existing.slice(0, Math.max(0, existing.length + 1 - 30))) fs.rmSync(path.join(o.backupDir, old));
    }
  };

  // Sync Trading 212 now and every 6 hours. T212_SYNC=off pauses automatic syncing (e.g. for the demo).
  const syncAll = async () => {
    const config = trading212Config();
    if (!config || process.env.T212_SYNC === 'off') return;
    for (const accountId of syncedAccounts(db).slice(0, 1)) { // one API key is one Trading 212 account
      try {
        const r = await syncTrading212Full(db, accountId, config);
        const failed = r.steps.filter((s) => s.status !== 'ok').map((s) => s.key);
        log(`Trading 212 synced${r.value !== null ? `: £${(r.value / 100).toFixed(2)}` : ''} (${r.calls} requests${failed.length ? `; not read: ${failed.join(', ')}` : ''})`);
      } catch (e: any) {
        log(`Trading 212 sync failed: ${e.message}`);
      }
    }
  };

  if (!o.quiet) {
    try { dailyBackup(); } catch (e: any) { log(`Backup failed: ${e.message}`); }
    timers.push(setInterval(() => { try { dailyBackup(); } catch { /* next time */ } }, 6 * 60 * 60 * 1000));
    try { autoMatch(db); } catch (e: any) { log(`Bill matching failed: ${e.message}`); }
    timers.push(setTimeout(syncAll, 1500));
    timers.push(setInterval(syncAll, 6 * 60 * 60 * 1000));
    for (const t of timers) t.unref();
  }

  const staticDir = o.staticDir && fs.existsSync(o.staticDir) ? o.staticDir : undefined;
  const server = createApp(db, { staticDir, backupDir: o.backupDir, dbFile: o.dbFile, desktop: o.desktop });
  const listen = (port: number) => new Promise<number>((resolve, reject) => {
    const onError = (e: NodeJS.ErrnoException) => { server.off('listening', onOk); reject(e); };
    const onOk = () => { server.off('error', onError); resolve((server.address() as { port: number }).port); };
    server.once('error', onError);
    server.once('listening', onOk);
    server.listen(port, host);
  });
  let port: number;
  try {
    port = await listen(o.port);
  } catch (e: any) {
    if (e.code !== 'EADDRINUSE' || !o.anyPortIfTaken) { db.close(); throw e; }
    port = await listen(0);
  }
  return {
    server, db, port, url: `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`,
    close: () => new Promise<void>((resolve) => {
      for (const t of timers) clearTimeout(t);
      server.closeAllConnections?.();
      server.close(() => { try { db.close(); } catch { /* already closed */ } resolve(); });
    }),
  };
}
