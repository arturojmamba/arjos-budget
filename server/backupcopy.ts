/**
 * Off-computer backups: after each automatic (or "Back up now") backup, a copy also goes to a
 * folder you choose — usually iCloud Drive, which then uploads it. Coil only writes into that
 * folder; your cloud app does the uploading. The last 30 copies are kept there, like at home.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DB } from './db.ts';
import { backup, getSetting, setSetting } from './db.ts';
import { ValidationError } from './money.ts';

const FOLDER_KEY = 'backup_copy_folder';
const LAST_KEY = 'backup_copy_last';
export const KEEP = 30;
export const ICLOUD_SUBFOLDER = 'Coil Backups';

export interface CopyStatus { at: string; ok: boolean; file?: string; error?: string }

/** Where iCloud Drive lives on this computer, or null if it isn't set up here. */
export function iCloudDrive(platform = process.platform, home = os.homedir()): string | null {
  const candidates = platform === 'darwin' ? [path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs')]
    : platform === 'win32' ? [path.join(home, 'iCloudDrive')]
    : [];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

export function copyFolder(db: DB): string | null {
  return getSetting(db, FOLDER_KEY, '') || null;
}

export function lastCopy(db: DB): CopyStatus | null {
  try { return JSON.parse(getSetting(db, LAST_KEY, 'null')); } catch { return null; }
}

/** Keep the newest `keep` dated backups in a folder (never the before-… safety copies). */
export function prune(dir: string, keep = KEEP) {
  const files = fs.readdirSync(dir).filter((f) => /^finance-.*\.db$/.test(f)).sort();
  for (const old of files.slice(0, Math.max(0, files.length - keep))) fs.rmSync(path.join(dir, old));
}

/** Copy one backup file into the chosen folder, if there is one. Never throws: the status records failures. */
export function copyBackup(db: DB, file: string): CopyStatus | null {
  const folder = copyFolder(db);
  if (!folder) return null;
  let status: CopyStatus;
  try {
    if (!fs.existsSync(path.dirname(folder))) throw new Error(`${path.dirname(folder)} isn't there any more`);
    fs.mkdirSync(folder, { recursive: true });
    const dest = path.join(folder, path.basename(file));
    // Write under a temporary name first, so a half-written file never looks like a backup.
    fs.copyFileSync(file, `${dest}.part`);
    fs.renameSync(`${dest}.part`, dest);
    prune(folder);
    status = { at: new Date().toISOString(), ok: true, file: dest };
  } catch (e: any) {
    status = { at: new Date().toISOString(), ok: false, error: e?.message ?? String(e) };
  }
  setSetting(db, LAST_KEY, JSON.stringify(status));
  return status;
}

/** Take a backup at home, then copy it to the chosen folder. */
export function backupAndCopy(db: DB, backupDir: string): { file: string; copy: CopyStatus | null } {
  const file = backup(db, backupDir);
  return { file, copy: copyBackup(db, file) };
}

/** Choose (or clear, with null) the folder. A new folder gets a copy straight away, so you know it works. */
export function setCopyFolder(db: DB, backupDir: string, folder: string | null): CopyStatus | null {
  if (folder === null || folder.trim() === '') {
    setSetting(db, FOLDER_KEY, '');
    setSetting(db, LAST_KEY, 'null');
    return null;
  }
  const f = path.resolve(folder.trim());
  if (!path.isAbsolute(folder.trim())) throw new ValidationError('Choose a full folder path');
  if (!fs.existsSync(path.dirname(f))) throw new ValidationError(`${path.dirname(f)} doesn't exist`);
  if (path.resolve(backupDir) === f) throw new ValidationError('That is already where backups are kept');
  setSetting(db, FOLDER_KEY, f);
  const status = backupAndCopy(db, backupDir).copy!;
  if (!status.ok) {
    setSetting(db, FOLDER_KEY, '');
    setSetting(db, LAST_KEY, 'null');
    throw new ValidationError(`Couldn't save a copy there: ${status.error}`);
  }
  return status;
}
