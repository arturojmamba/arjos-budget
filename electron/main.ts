/**
 * The desktop app: runs the same server as `npm start` inside Electron and shows it in a window.
 *
 *  - Data lives in the system's app-data folder (macOS: ~/Library/Application Support/Ledger/data,
 *    Windows: %APPDATA%\Ledger\data), not next to the app.
 *  - On first run you can start fresh or bring in an existing database (e.g. from `npm start`).
 *  - The Trading 212 key is encrypted with the system keychain (Electron safeStorage) and kept in a
 *    file in the app-data folder; it never goes into the database.
 *  - Updates itself from the GitHub releases (electron/update.ts).
 *  - Sends notifications (server/notify.ts decides what; this file shows them) every 15 minutes and
 *    when the computer wakes, and can open at login without a window (--hidden).
 *  - LEDGER_SMOKE=1 starts the server, checks the API answers, and quits (used by the build);
 *    LEDGER_SMOKE_FILE=path also writes the result there (a packaged Windows app has no console).
 *
 * Bundled to dist-electron/main.mjs by scripts/build-desktop.mjs.
 */
import { app, BrowserWindow, Menu, Notification, Tray, dialog, safeStorage, shell, nativeTheme, powerMonitor, systemPreferences } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer, type Running } from '../server/start.ts';
import { backup } from '../server/db.ts';
import { Updater } from './update.ts';
import { runNotifications, notifySettings, updateNotice, wasSent, markSent, type Notice } from '../server/notify.ts';
import type { DesktopHost } from '../server/app.ts';

const PRODUCT = 'Ledger';
const SMOKE = process.env.LEDGER_SMOKE === '1';
/** CI: check for an update, install it without reopening, write the result, quit. */
const UPDATE_TEST = process.env.LEDGER_UPDATE_TEST === '1';

/** The GitHub repo releases come from, from package.json's "repository". */
function releaseRepo(): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8'));
    const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
    const m = /github\.com[/:]([^/]+\/[^/.]+)/.exec(url ?? '');
    return m ? m[1] : null;
  } catch { return null; }
}
app.setName(PRODUCT);
// Windows ties notifications to the app's ID (the installer's shortcut carries the same one).
if (process.platform === 'win32') app.setAppUserModelId('app.ledger.desktop');
const MAC = process.platform === 'darwin';
/** Opened at login: start in the background, without a window. */
function openedHidden(): boolean {
  if (process.argv.includes('--hidden')) return true;
  try { const l = app.getLoginItemSettings(); return MAC && (l.wasOpenedAtLogin || l.wasOpenedAsHidden); } catch { return false; }
}

const userData = app.getPath('userData');
const dataDir = path.join(userData, 'data');
const dbFile = path.join(dataDir, 'finance.db');
const backupDir = path.join(dataDir, 'backups');
const keyFile = path.join(userData, 't212-key.bin');
const windowFile = path.join(userData, 'window.json');

let running: Running | null = null;
let win: BrowserWindow | null = null;
let quitting = false;
let tray: Tray | null = null;
let startHidden = false;

// ---------------------------------------------------------------------------
// Trading 212 key, encrypted by the OS keychain

function loadKey() {
  try {
    if (!fs.existsSync(keyFile) || !safeStorage.isEncryptionAvailable()) return;
    const { key, secret } = JSON.parse(safeStorage.decryptString(fs.readFileSync(keyFile)));
    if (key && secret) { process.env.T212_API_KEY = key; process.env.T212_API_SECRET = secret; }
  } catch { /* unreadable: treat as not set */ }
}
function saveKey(key: string, secret: string) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('The system keychain is not available, so the key cannot be stored safely.');
  fs.writeFileSync(keyFile, safeStorage.encryptString(JSON.stringify({ key, secret })), { mode: 0o600 });
  process.env.T212_API_KEY = key; process.env.T212_API_SECRET = secret;
}
function clearKey() {
  fs.rmSync(keyFile, { force: true });
  delete process.env.T212_API_KEY; delete process.env.T212_API_SECRET;
}

// ---------------------------------------------------------------------------
// First run: start fresh or bring in an existing database

async function firstRun(): Promise<boolean> {
  if (fs.existsSync(dbFile) || SMOKE || UPDATE_TEST) return true;
  fs.mkdirSync(dataDir, { recursive: true });
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Start fresh', 'Use my existing data…', 'Quit'],
    defaultId: 0, cancelId: 2,
    title: `Welcome to ${PRODUCT}`,
    message: `Welcome to ${PRODUCT}`,
    detail: 'Everything stays on this computer. If you already use the app in a browser (npm start), you can bring that data in: choose finance.db from its data folder, or a backup file.',
  });
  if (response === 2) return false;
  if (response === 1) {
    const pick = await dialog.showOpenDialog({ title: 'Choose your database or a backup', properties: ['openFile'], filters: [{ name: 'Database', extensions: ['db', 'sqlite', 'sqlite3'] }] });
    if (pick.canceled || !pick.filePaths[0]) return firstRun();
    try {
      // VACUUM INTO gives a consistent copy, including anything still in the write-ahead log.
      const src = new DatabaseSync(pick.filePaths[0], { readOnly: true });
      const ok = src.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('accounts','transactions','postings','categories')").get() as { n: number };
      if (ok.n !== 4) { src.close(); throw new Error("That file isn't a database from this app."); }
      src.exec(`VACUUM INTO '${dbFile.replace(/'/g, "''")}'`);
      src.close();
    } catch (e: any) {
      await dialog.showMessageBox({ type: 'error', message: "Couldn't use that file", detail: e.message });
      return firstRun();
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Window

function windowState(): { width: number; height: number; x?: number; y?: number; maximized?: boolean } {
  try { return JSON.parse(fs.readFileSync(windowFile, 'utf8')); } catch { return { width: 1360, height: 880 }; }
}

function createWindow(url: string) {
  const s = windowState();
  win = new BrowserWindow({
    width: s.width, height: s.height, x: s.x, y: s.y, minWidth: 380, minHeight: 560,
    title: PRODUCT, show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#14171c' : '#f3f4f6',
    titleBarStyle: process.platform === 'darwin' ? 'default' : undefined,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  if (s.maximized) win.maximize();
  win.once('ready-to-show', () => { if (!startHidden) win?.show(); startHidden = false; });
  // Links to other sites open in the normal browser; the app itself stays in the window.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (!target.startsWith(url)) void shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, target) => { if (!target.startsWith(url)) { e.preventDefault(); void shell.openExternal(target); } });
  const remember = () => {
    if (!win || win.isDestroyed()) return;
    const b = win.getNormalBounds();
    fs.writeFileSync(windowFile, JSON.stringify({ ...b, maximized: win.isMaximized() }));
  };
  win.on('close', (e) => {
    remember();
    // macOS: closing the window keeps the app running (sync and notifications carry on); quit with ⌘Q.
    // Windows: the same while notifications are on, with an icon by the clock to reopen or quit.
    if (quitting) return;
    if (MAC) { e.preventDefault(); win?.hide(); return; }
    if (running && notifySettings(running.db).enabled) { e.preventDefault(); win?.hide(); void showTray(); }
  });
  win.on('closed', () => { win = null; });
  void win.loadURL(url);
}

function openRoute(route: string) {
  if (!running) return;
  if (!win) createWindow(running.url);
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
  void win.webContents.executeJavaScript(`location.hash = ${JSON.stringify('#' + route)}`);
}

/** Windows: an icon by the clock while the window is closed, to reopen or quit. */
async function showTray() {
  if (MAC || tray) return;
  try {
    tray = new Tray(await app.getFileIcon(process.execPath, { size: 'small' }));
    tray.setToolTip(`${PRODUCT} is running, so notifications can arrive`);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: `Open ${PRODUCT}`, click: () => openRoute('/') },
      { type: 'separator' },
      { label: `Quit ${PRODUCT}`, click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on('click', () => openRoute('/'));
  } catch { /* no tray: the window just stays hidden; opening Ledger again shows it */ }
}

// ---------------------------------------------------------------------------
// Notifications

const live = new Set<Notification>(); // keep a reference so click handlers survive garbage collection
function showNotice(n: Notice): boolean {
  if (!Notification.isSupported()) return false;
  try {
    const note = new Notification({ title: n.title, body: n.body });
    live.add(note);
    note.on('click', () => { live.delete(note); openRoute(n.route); });
    note.on('close', () => live.delete(note));
    note.show();
    setTimeout(() => live.delete(note), 24 * 3600e3);
    return true;
  } catch { return false; }
}

function startNotifications(updater: Updater | null) {
  let timer: NodeJS.Timeout | null = null;
  const run = () => {
    if (!running) return;
    try {
      runNotifications(running.db, new Date(), showNotice);
      // A downloaded update: say so once, unless you're using the app (the banner shows it there).
      const s = notifySettings(running.db);
      const st = updater?.info().state;
      if (s.enabled && s.updates && st?.status === 'ready' && !win?.isFocused()) {
        const n = updateNotice(st.available.version);
        if (!wasSent(running.db, n.key) && showNotice(n)) markSent(running.db, [n.key]);
      }
    } catch (e) { console.error('Notifications:', e); }
  };
  const soon = (ms: number) => { if (timer) clearTimeout(timer); timer = setTimeout(run, ms); };
  soon(30_000);
  setInterval(run, 15 * 60_000);
  // After sleep, catch up a minute after waking (the network and clock settle first).
  powerMonitor.on('resume', () => soon(60_000));
  powerMonitor.on('unlock-screen', () => soon(5_000));
  return { run: () => soon(1_000) };
}

function buildMenu() {
  const mac = process.platform === 'darwin';
  const go = (route: string) => () => { if (!win) return; win.show(); void win.webContents.executeJavaScript(`location.hash = ${JSON.stringify('#' + route)}`); };
  const checkUpdates = { label: 'Check for Updates…', click: go('/settings?tab=about') };
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(mac ? [{ label: PRODUCT, submenu: [
      { role: 'about' as const }, checkUpdates, { type: 'separator' as const },
      { label: 'Settings…', accelerator: 'Cmd+,', click: go('/settings') }, { type: 'separator' as const },
      { role: 'services' as const }, { type: 'separator' as const },
      { role: 'hide' as const }, { role: 'hideOthers' as const }, { role: 'unhide' as const }, { type: 'separator' as const },
      { role: 'quit' as const },
    ] }] : []),
    { label: 'File', submenu: [
      { label: 'Import a statement…', accelerator: 'CmdOrCtrl+I', click: go('/import') },
      { label: 'Show data folder', click: () => void shell.openPath(dataDir) },
      { label: 'Lock', accelerator: 'CmdOrCtrl+L', click: () => { if (!win) return; win.show(); void win.webContents.executeJavaScript("window.dispatchEvent(new Event('ledger-lock-now'))"); } },
      { type: 'separator' },
      mac ? { role: 'close' } : { role: 'quit' },
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [
      { label: 'Overview', accelerator: 'CmdOrCtrl+1', click: go('/') },
      { label: 'Transactions', accelerator: 'CmdOrCtrl+2', click: go('/transactions') },
      { label: 'Budgets', accelerator: 'CmdOrCtrl+3', click: go('/budgets') },
      { label: 'Reports', accelerator: 'CmdOrCtrl+4', click: go('/reports') },
      { label: 'Investing', accelerator: 'CmdOrCtrl+5', click: go('/investing') },
      { type: 'separator' },
      { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' },
    ] },
    { role: 'windowMenu' },
    ...(mac ? [] : [{ label: 'Help', submenu: [checkUpdates] }]),
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------------------------------------------------------------------------
// Start

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });

  app.whenReady().then(async () => {
    if (!(await firstRun())) { app.quit(); return; }
    loadKey();
    const repo = releaseRepo();
    const updater = repo ? new Updater(repo, () => { if (running) backup(running.db, backupDir); }, (m) => console.log(m)) : null;
    let notifier: { run(): void } | null = null;
    const host: DesktopHost = {
      version: app.getVersion(),
      platform: process.platform,
      dataDir,
      saveT212Key: saveKey,
      clearT212Key: clearKey,
      openDataFolder: () => void shell.openPath(dataDir),
      relaunch: () => { quitting = true; app.relaunch(); app.exit(0); },
      updates: updater ? {
        info: () => updater.info(),
        check: () => updater.check(),
        setAuto: (on) => updater.setAuto(on),
        openManual: () => updater.openManual(),
        install: () => {
          const r = updater.install();
          if (r.ok) setTimeout(() => { quitting = true; app.quit(); }, 300);
          return r;
        },
      } : undefined,
      touchId: process.platform === 'darwin' ? {
        available: () => { try { return systemPreferences.canPromptTouchID(); } catch { return false; } },
        prompt: async (reason: string) => {
          try { win?.show(); await systemPreferences.promptTouchID(reason); return true; } catch { return false; }
        },
      } : undefined,
      notifications: {
        supported: () => Notification.isSupported(),
        test: () => showNotice({ key: 'test', kind: 'test', title: `Notifications are on`, body: `This is how ${PRODUCT} will let you know about bills, payday and your week.`, route: '/settings?tab=notifications' }),
        run: () => notifier?.run(),
        openAtLogin: () => { if (!app.isPackaged) return null; try { return app.getLoginItemSettings().openAtLogin; } catch { return null; } },
        setOpenAtLogin: (on: boolean) => {
          if (!app.isPackaged) throw new Error('Opening at login works in the installed app.');
          app.setLoginItemSettings({ openAtLogin: on, openAsHidden: true, args: ['--hidden'] });
        },
      },
    };
    try {
      running = await startServer({
        dbFile, backupDir,
        staticDir: path.join(app.getAppPath(), 'dist'),
        port: SMOKE ? 0 : 45454, anyPortIfTaken: true,
        desktop: host, quiet: SMOKE,
      });
    } catch (e: any) {
      dialog.showErrorBox(`${PRODUCT} couldn't start`, e?.message ?? String(e));
      app.exit(1);
      return;
    }

    if (UPDATE_TEST && updater) {
      const out = (line: string) => { console.log(line); if (process.env.LEDGER_SMOKE_FILE) fs.writeFileSync(process.env.LEDGER_SMOKE_FILE, line); };
      const info = await updater.check();
      if (info.state.status !== 'ready') { out(`UPDATE TEST FAILED ${JSON.stringify(info.state)}`); app.exit(1); return; }
      const r = updater.install({ relaunch: false });
      out(r.ok ? `UPDATE TEST OK ${app.getVersion()} -> ${info.state.available.version}` : `UPDATE TEST FAILED ${r.reason}`);
      await running.close();
      app.exit(r.ok ? 0 : 1);
      return;
    }

    if (SMOKE) {
      // Build check: the server answers, the UI is bundled, and node:sqlite works inside Electron.
      try {
        const meta = await (await fetch(`${running.url}/api/meta`)).json();
        const page = await (await fetch(`${running.url}/`)).text();
        if (!meta.desktop || !page.includes('<div id="root">')) throw new Error('unexpected response');
        const line = `SMOKE OK ${meta.desktop.version} ${process.platform}`;
        console.log(line);
        if (process.env.LEDGER_SMOKE_FILE) fs.writeFileSync(process.env.LEDGER_SMOKE_FILE, line);
        await running.close();
        app.exit(0);
      } catch (e: any) {
        console.error(`SMOKE FAILED ${e?.message ?? e}`);
        if (process.env.LEDGER_SMOKE_FILE) fs.writeFileSync(process.env.LEDGER_SMOKE_FILE, `SMOKE FAILED ${e?.message ?? e}`);
        app.exit(1);
      }
      return;
    }

    buildMenu();
    startHidden = openedHidden();
    createWindow(running.url);
    if (startHidden && !MAC) void showTray();
    updater?.schedule();
    notifier = startNotifications(updater);
    app.on('activate', () => { if (win) win.show(); else if (running) createWindow(running.url); });
  });

  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('will-quit', () => { void running?.close(); });
}
