/**
 * Keeps the desktop app up to date from the public GitHub releases.
 *
 *  - Checks when the app opens and once a day (switch off in Settings → About & updates).
 *  - Downloads the new installer in the background, checks it against the SHA-256 GitHub publishes,
 *    then says "Restart to update". It never restarts by itself.
 *  - Before installing it takes a backup. On a Mac a small script swaps the app once it has quit
 *    and opens the new one; on Windows the installer runs silently and reopens the app.
 *  - If it can't update in place (e.g. running from the disk image), it explains why and offers
 *    the download instead.
 */
import { app, shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { type Available, latestRelease, macAppPath, macInstallScript, verifyDownload } from './update-core.ts';

export type UpdateState =
  | { status: 'idle' | 'checking' | 'none' }
  | { status: 'downloading'; available: Omit<Available, 'asset'>; received: number; total: number }
  | { status: 'ready'; available: Omit<Available, 'asset'> }
  | { status: 'manual'; available: Omit<Available, 'asset'>; reason: string }
  | { status: 'error'; message: string; available?: Omit<Available, 'asset'> };

export interface UpdateInfo { version: string; auto: boolean; checkedAt: string | null; state: UpdateState }

const DAY = 24 * 60 * 60 * 1000;
const strip = (a: Available) => ({ version: a.version, tag: a.tag, notes: a.notes, publishedAt: a.publishedAt, page: a.page });

export class Updater {
  private state: UpdateState = { status: 'idle' };
  private found: Available | null = null;
  private file: string | null = null;
  private checkedAt: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private settingsFile: string;
  private dir: string;

  constructor(private repo: string, private beforeInstall: () => void, private log: (m: string) => void = () => {}) {
    this.settingsFile = path.join(app.getPath('userData'), 'updates.json');
    this.dir = path.join(app.getPath('userData'), 'updates');
  }

  get supported() { return app.isPackaged && (process.platform === 'darwin' || process.platform === 'win32'); }
  get auto(): boolean {
    try { return JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')).auto !== false; } catch { return true; }
  }
  setAuto(on: boolean) {
    fs.writeFileSync(this.settingsFile, JSON.stringify({ auto: !!on }));
    this.schedule();
  }

  info(): UpdateInfo { return { version: app.getVersion(), auto: this.auto, checkedAt: this.checkedAt, state: this.state }; }

  /** Check on start (after a short pause) and then once a day, if automatic checks are on. */
  schedule() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!this.supported || !this.auto) return;
    setTimeout(() => void this.check(), 20_000).unref();
    this.timer = setInterval(() => void this.check(), DAY);
    this.timer.unref();
  }

  async check(): Promise<UpdateInfo> {
    if (!this.supported) { this.state = { status: 'error', message: 'Updates work in the installed app only.' }; return this.info(); }
    if (this.state.status === 'checking' || this.state.status === 'downloading') return this.info();
    if (this.state.status === 'ready') return this.info();
    this.state = { status: 'checking' };
    try {
      const found = await latestRelease(this.repo, app.getVersion(), process.platform, process.arch, fetch, process.env.LEDGER_GITHUB_TOKEN || undefined);
      this.checkedAt = new Date().toISOString();
      if (!found) { this.state = { status: 'none' }; return this.info(); }
      this.found = found;
      await this.download(found);
    } catch (e: any) {
      this.log(`Update check failed: ${e?.message ?? e}`);
      this.state = { status: 'error', message: friendly(e), available: this.found ? strip(this.found) : undefined };
    }
    return this.info();
  }

  private async download(a: Available) {
    fs.mkdirSync(this.dir, { recursive: true });
    for (const f of fs.readdirSync(this.dir)) if (f !== a.asset.name) fs.rmSync(path.join(this.dir, f), { force: true, recursive: true });
    const file = path.join(this.dir, a.asset.name);
    // Already downloaded and intact (e.g. after a restart)?
    if (fs.existsSync(file)) {
      try { await verifyDownload(file, a.asset); this.file = file; this.state = { status: 'ready', available: strip(a) }; return; } catch { fs.rmSync(file, { force: true }); }
    }
    this.state = { status: 'downloading', available: strip(a), received: 0, total: a.asset.size };
    const res = await fetch(a.asset.url, { headers: { 'User-Agent': 'Ledger-desktop-updater' } });
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
    const part = `${file}.part`;
    let received = 0;
    const counter = new Transform({
      transform: (chunk, _enc, cb) => {
        received += chunk.length;
        if (this.state.status === 'downloading') this.state = { ...this.state, received };
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body as any), counter, fs.createWriteStream(part));
    fs.renameSync(part, file);
    await verifyDownload(file, a.asset);
    this.file = file;
    this.state = { status: 'ready', available: strip(a) };
    this.log(`Update ${a.version} downloaded and verified`);
  }

  /** Back up, then hand over to the installer and quit. Returns a reason instead if it can't. */
  install(opts: { relaunch?: boolean } = {}): { ok: true } | { ok: false; reason: string } {
    if (this.state.status !== 'ready' || !this.file || !this.found) return { ok: false, reason: 'No update is ready yet.' };
    const relaunch = opts.relaunch !== false;
    if (process.platform === 'darwin') {
      const where = macAppPath(process.execPath, (dir) => { try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; } });
      if ('reason' in where) {
        this.state = { status: 'manual', available: strip(this.found), reason: where.reason };
        return { ok: false, reason: where.reason };
      }
      this.beforeInstall();
      const script = path.join(os.tmpdir(), `ledger-update-${Date.now()}.sh`);
      fs.writeFileSync(script, macInstallScript(), { mode: 0o755 });
      const logFile = path.join(app.getPath('userData'), 'update.log');
      spawn('/bin/bash', [script, String(process.pid), this.file, where.app, logFile, relaunch ? '' : 'norelaunch'], { detached: true, stdio: 'ignore' }).unref();
      return { ok: true };
    }
    if (process.platform === 'win32') {
      this.beforeInstall();
      // Silent install over the current one; --force-run opens the app again afterwards.
      spawn(this.file, relaunch ? ['/S', '--updated', '--force-run'] : ['/S', '--updated'], { detached: true, stdio: 'ignore' }).unref();
      return { ok: true };
    }
    return { ok: false, reason: 'Updates are for Mac and Windows.' };
  }

  /** Open the downloaded installer (or the release page) to update by hand. */
  openManual() {
    if (this.file && fs.existsSync(this.file)) void shell.openPath(this.file);
    else if (this.found) void shell.openExternal(this.found.page);
  }
}

function friendly(e: any): string {
  const m = String(e?.message ?? e);
  if (/fetch failed|ENOTFOUND|ECONN|network/i.test(m)) return "Couldn't reach GitHub. Check your internet connection.";
  return m;
}
