/**
 * Passcode lock. When a passcode is set, the API answers nothing but the lock screen's own calls
 * until you unlock, and every start of the app begins locked (sessions live only in memory).
 *
 * The passcode is never stored: only a salted scrypt hash, in lock.json next to the database.
 * It's kept out of the database on purpose, so backups and restores never carry an old passcode.
 * Forgot it? Delete lock.json (with the app closed). This is a privacy lock, not encryption:
 * anyone who can browse your files can already open the database file itself.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ValidationError } from './money.ts';

interface LockFile { v: 1; salt: string; hash: string; length: number; updatedAt: string }

const N = 16384; // scrypt cost
const hashOf = (code: string, salt: Buffer) => crypto.scryptSync(code, salt, 32, { N, r: 8, p: 1 });

export function checkPasscodeFormat(code: unknown): string {
  if (typeof code !== 'string' || !/^\d{4,12}$/.test(code)) throw new ValidationError('Use 4 to 12 digits');
  return code;
}

export class Lock {
  private sessions = new Set<string>();
  private failures = 0;
  private blockedUntil = 0;

  constructor(readonly file: string, private now: () => number = Date.now) {}

  private read(): LockFile | null {
    try {
      const f = JSON.parse(fs.readFileSync(this.file, 'utf8')) as LockFile;
      return f && f.v === 1 && f.salt && f.hash ? f : null;
    } catch { return null; }
  }

  get enabled() { return this.read() !== null; }
  /** How many digits the passcode has, so the lock screen can submit as soon as it's complete. */
  get length() { return this.read()?.length ?? null; }

  isUnlocked(token: string | undefined) {
    return !this.enabled || (!!token && this.sessions.has(token));
  }

  /** Seconds to wait before another try, after repeated wrong passcodes. */
  waitSeconds() { return Math.max(0, Math.ceil((this.blockedUntil - this.now()) / 1000)); }

  private matches(code: string) {
    const f = this.read();
    if (!f) return true;
    const expected = Buffer.from(f.hash, 'base64');
    const got = hashOf(code, Buffer.from(f.salt, 'base64'));
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  }

  /** Check a passcode (with a growing pause after 5 wrong tries) and start a session. */
  unlock(code: unknown): string {
    const wait = this.waitSeconds();
    if (wait > 0) throw new ValidationError(`Too many tries. Wait ${wait} seconds.`);
    if (typeof code !== 'string' || !this.matches(code)) {
      this.failures++;
      if (this.failures >= 5) this.blockedUntil = this.now() + Math.min(300, 30 * 2 ** (this.failures - 5)) * 1000;
      throw new ValidationError(this.failures >= 5 ? `Wrong passcode. Wait ${this.waitSeconds()} seconds before trying again.` : 'Wrong passcode');
    }
    this.failures = 0; this.blockedUntil = 0;
    return this.startSession();
  }

  /** A session without a passcode (after Touch ID, or right after setting the passcode). */
  startSession(): string {
    const token = crypto.randomBytes(32).toString('base64url');
    this.sessions.add(token);
    return token;
  }

  end(token: string | undefined) { if (token) this.sessions.delete(token); }

  /** Set or change the passcode. Changing or removing it needs the current one. */
  set(code: unknown, current?: unknown) {
    const next = checkPasscodeFormat(code);
    if (this.enabled && (typeof current !== 'string' || !this.matches(current))) throw new ValidationError('Your current passcode is wrong');
    const salt = crypto.randomBytes(16);
    const f: LockFile = { v: 1, salt: salt.toString('base64'), hash: hashOf(next, salt).toString('base64'), length: next.length, updatedAt: new Date().toISOString() };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(f), { mode: 0o600 });
    this.sessions.clear();
    return this.startSession();
  }

  remove(current: unknown) {
    if (!this.enabled) return;
    if (typeof current !== 'string' || !this.matches(current)) throw new ValidationError('Your current passcode is wrong');
    fs.rmSync(this.file, { force: true });
    this.sessions.clear();
  }
}

export const LOCK_COOKIE = 'ledger_session';
export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}
export const sessionCookie = (token: string) => `${LOCK_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict`;
export const clearCookie = () => `${LOCK_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
