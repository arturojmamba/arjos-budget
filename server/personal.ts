/** Profile and appearance preferences, kept in the settings table so they follow the database. */
import { type DB, getSetting, setSetting } from './db.ts';
import { ValidationError } from './money.ts';

export interface Appearance {
  theme: 'system' | 'light' | 'dark';
  accent: string;
  density: 'comfortable' | 'compact';
  textSize: 'small' | 'normal' | 'large';
  showPence: boolean;
  startPage: string;
  startHidden: boolean;
  reduceMotion: boolean;
  weekStart: 'monday';
}
export interface Profile { name: string; appName: string; avatar: string | null }

export const DEFAULT_APPEARANCE: Appearance = {
  theme: 'system', accent: '#d9c08e', density: 'comfortable', textSize: 'normal', showPence: true,
  startPage: '/', startHidden: false, reduceMotion: false, weekStart: 'monday',
};
const PAGES = ['/', '/transactions', '/budgets', '/goals', '/bills', '/debts', '/reports', '/accounts'];

function readJson<T>(db: DB, key: string, fallback: T): T {
  try { return { ...fallback, ...JSON.parse(getSetting(db, key, '{}')) }; } catch { return fallback; }
}

export function getAppearance(db: DB): Appearance { return readJson(db, 'appearance', DEFAULT_APPEARANCE); }

export function getProfile(db: DB): Profile {
  const p = readJson(db, 'profile', { name: '', appName: '' });
  return { name: p.name ?? '', appName: p.appName ?? '', avatar: getSetting(db, 'avatar', '') || null };
}

export function saveAppearance(db: DB, input: Partial<Appearance>) {
  const a = { ...getAppearance(db), ...input };
  if (!['system', 'light', 'dark'].includes(a.theme)) throw new ValidationError('Unknown theme');
  if (!/^#[0-9a-fA-F]{6}$/.test(a.accent)) throw new ValidationError('Accent must be a colour like #d9c08e');
  if (!['comfortable', 'compact'].includes(a.density)) throw new ValidationError('Unknown density');
  if (!['small', 'normal', 'large'].includes(a.textSize)) throw new ValidationError('Unknown text size');
  if (!PAGES.includes(a.startPage)) throw new ValidationError('Unknown start page');
  for (const k of ['showPence', 'startHidden', 'reduceMotion'] as const) a[k] = !!a[k];
  setSetting(db, 'appearance', JSON.stringify(a));
  return a;
}

export function saveProfile(db: DB, input: { name?: string; appName?: string }) {
  const cur = getProfile(db);
  const name = String(input.name ?? cur.name).trim().slice(0, 40);
  const appName = String(input.appName ?? cur.appName).trim().slice(0, 30);
  setSetting(db, 'profile', JSON.stringify({ name, appName }));
  return getProfile(db);
}

/** A small square picture (the browser resizes it before sending). */
export function saveAvatar(db: DB, dataUrl: string | null) {
  if (dataUrl === null || dataUrl === '') { setSetting(db, 'avatar', ''); return; }
  if (typeof dataUrl !== 'string' || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) throw new ValidationError('Choose a PNG, JPEG or WebP picture');
  if (dataUrl.length > 400_000) throw new ValidationError('That picture is too large');
  setSetting(db, 'avatar', dataUrl);
}
