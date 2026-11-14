import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { DB } from './db.ts';
import { getSetting, setSetting, backup } from './db.ts';
import { ValidationError } from './money.ts';
import { Lock, LOCK_COOKIE, IDLE_CHOICES, readCookie, sessionCookie, clearCookie } from './lock.ts';
import { createTransaction, updateTransaction, deleteTransaction, simpleToPostings, mergeIntoTransfer, ACCOUNT_TYPES } from './ledger.ts';
import { listAccounts, listCategories, listTransactions, getTransaction, monthSummary, monthSpending, monthsWithData } from './queries.ts';
import {
  createAccount, updateAccount, deleteAccount, createCategory, updateCategory, deleteCategory, reorderCategories, bulkCategorise,
  createRule, updateRule, testRules, deleteRule, listRules,
} from './admin.ts';
import { healthChecks } from './health.ts';
import { getAppearance, getProfile, saveAppearance, saveProfile, saveAvatar } from './personal.ts';
import { suggestRules, createRules } from './rulesuggest.ts';
import { loadRules, suggest } from './importers/categorise.ts';
import { smartCategory } from './importers/smart.ts';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from './db.ts';
import { trends, merchants, explore, compare, netWorthHistory, yearReview, reportYears } from './reports.ts';
import { listGoals, createGoal, updateGoal, deleteGoal, archiveGoal, reorderGoals, moveMoney, goalMoves } from './goals.ts';
import { previewImport, commitImport, undoImport, listImports, listSkipped, restoreSkipped, dismissSkipped } from './importers/import.ts';
import { PRESETS } from './importers/presets.ts';
import { monthOf, todayIso, addDays, daysInMonth } from './dates.ts';
import {
  createRecurring, updateRecurring, deleteRecurring, listRecurring, occurrences, monthPlan, setPayment, suggestRecurring, autoMatch, FREQUENCIES,
} from './recurring.ts';
import { listBudgets, createBudget, updateBudget, deleteBudget, reorderBudgets, suggestBudgets, budgetCategoryIds, budgetAccount, budgetGuide, updateGuide } from './budgets.ts';
import { listDebts, debtPlan, saveDebtPlan, saveDebt, createDebt, deleteDebtDetails, linkCandidates, linkToDebt, reviewRepayments, debtTimeline, archiveDebt, addRepaymentToBills, DEBT_TYPES } from './debts.ts';
import { setValuation, deleteValuation, investmentHistory, trading212Config, syncedAccounts } from './investments.ts';
import { resetTrading212, startSync, syncStatus, syncTrading212Full } from './t212.ts';
import { saveShares } from './shares.ts';
import { portfolio, holdingDetail } from './investing.ts';
import { isaStatus, isaAllowanceSummary } from './isa.ts';
import { performance } from './performance.ts';
import { payday, paydayStatus, setCheck, setPaydayBudgets, completePayday, reopenPayday, paydayLogs, addPaydayItem, deletePaydayItem } from './payday.ts';
import { notifySettings, updateNotifySettings } from './notify.ts';
import { spendingExplorer, cutBack, habits, budgetRecord, cashFlow, compareDrivers, weekly } from './insights.ts';

type Handler = (ctx: { db: DB; params: Record<string, string>; query: URLSearchParams; body: any; session?: string; setCookie: (c: string) => void }) => unknown;

interface Route { method: string; pattern: RegExp; keys: string[]; handler: Handler }

const routes: Route[] = [];
function route(method: string, pathPattern: string, handler: Handler) {
  const keys: string[] = [];
  const pattern = new RegExp(
    '^' + pathPattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$',
  );
  routes.push({ method, pattern, keys, handler });
}

const int = (v: string | null | undefined) => (v == null || v === '' ? undefined : Number.parseInt(v, 10));
const id = (params: Record<string, string>) => {
  const n = Number.parseInt(params.id, 10);
  if (!Number.isSafeInteger(n)) throw new ValidationError('Invalid id');
  return n;
};

// ---------- Desktop app ----------
/** What the desktop app (Electron) lets the UI do. Absent when running with `npm start`. */
export interface DesktopHost {
  version: string;
  platform: string;
  dataDir: string;
  /** Store the Trading 212 key in the system keychain (never the database) and use it from now on. */
  saveT212Key(key: string, secret: string): void;
  clearT212Key(): void;
  openDataFolder(): void;
  relaunch(): void;
  /** Updates from the GitHub releases (installed app only). */
  updates?: {
    info(): unknown;
    check(): Promise<unknown>;
    install(): Promise<{ ok: true } | { ok: false; reason: string }>;
    setAuto(on: boolean): void;
    openManual(): void;
  };
  /** Touch ID on Macs that have it: unlock without typing the passcode. */
  touchId?: { available(): boolean; prompt(reason: string): Promise<boolean> };
  /** System notifications and opening at login. */
  notifications?: {
    supported(): boolean;
    /** Show a test notification now (ignores quiet hours). */
    test(): boolean;
    /** Check now, e.g. after the settings change. */
    run(): void;
    /** null when it can't be set (running from source rather than installed). */
    openAtLogin(): boolean | null;
    setOpenAtLogin(on: boolean): void;
  };
}
let desktop: DesktopHost | null = null;
// ---------- Passcode lock ----------
let lock: Lock | null = null;
/** The only calls that answer while the app is locked. */
const OPEN_WHILE_LOCKED = new Set(['GET /api/lock/status', 'POST /api/lock/unlock', 'POST /api/lock/touchid']);
route('GET', '/api/lock/status', ({ db, session }) => {
  const p = getProfile(db);
  return {
    enabled: !!lock?.enabled, locked: !!lock && !lock.isUnlocked(session), length: lock?.length ?? null, wait: lock?.waitSeconds() ?? 0,
    idleMinutes: lock?.enabled ? lock.idleMinutes : null, idleChoices: IDLE_CHOICES,
    name: p.name, avatar: p.avatar, accent: getAppearance(db).accent, theme: getAppearance(db).theme,
    touchId: !!lock?.enabled && !!desktop?.touchId?.available(), desktop: !!desktop,
  };
});
route('POST', '/api/lock/unlock', ({ body, setCookie }) => {
  if (!lock?.enabled) return { ok: true };
  setCookie(sessionCookie(lock.unlock(body?.passcode)));
  return { ok: true };
});
route('POST', '/api/lock/touchid', async ({ db, setCookie }) => {
  if (!lock?.enabled) return { ok: true };
  if (!desktop?.touchId?.available()) throw new ValidationError('Touch ID is not available');
  const name = 'Coil';
  if (!(await desktop.touchId.prompt(`unlock ${name}`))) throw new ValidationError('Touch ID was cancelled');
  setCookie(sessionCookie(lock.startSession()));
  return { ok: true };
});
// Pings from the app while you use it (typing, clicking, scrolling), pushing the automatic lock back.
route('POST', '/api/lock/activity', ({ session }) => { lock?.touch(session); return { ok: true }; });
route('PUT', '/api/lock/idle', ({ body }) => {
  if (!lock) throw new ValidationError('The passcode lock is not available here');
  lock.setIdleMinutes(Number(body?.minutes));
  return { idleMinutes: lock.idleMinutes };
});
route('POST', '/api/lock/lock', ({ session, setCookie }) => { lock?.end(session); setCookie(clearCookie()); return { ok: true }; });
route('POST', '/api/lock/passcode', ({ body, setCookie }) => {
  if (!lock) throw new ValidationError('The passcode lock is not available here');
  setCookie(sessionCookie(lock.set(body?.passcode, body?.current)));
  return { ok: true };
});
route('POST', '/api/lock/remove', ({ body, setCookie }) => {
  if (!lock) return { ok: true };
  lock.remove(body?.current);
  setCookie(clearCookie());
  return { ok: true };
});

const needDesktop = () => { if (!desktop) throw new ValidationError('Only available in the desktop app'); return desktop; };

// ---------- Meta ----------
route('GET', '/api/meta', ({ db }) => ({
  desktop: desktop ? { version: desktop.version, platform: desktop.platform, dataDir: desktop.dataDir } : null,
  lockEnabled: !!lock?.enabled,
  lockIdleMinutes: lock?.enabled ? lock.idleMinutes : null,
  accountTypes: ACCOUNT_TYPES,
  presets: PRESETS.map((p) => ({ id: p.id, label: p.label, note: p.note })),
  months: monthsWithData(db),
  frequencies: FREQUENCIES,
  trading212: { configured: trading212Config() !== null },
  currentMonth: monthOf(todayIso()),
  today: todayIso(),
  settings: { rollforwardDays: Number(getSetting(db, 'rollforward_days', '5')) },
  appearance: getAppearance(db),
  profile: getProfile(db),
}));
route('PUT', '/api/appearance', ({ db, body }) => saveAppearance(db, body ?? {}));
route('PUT', '/api/profile', ({ db, body }) => saveProfile(db, body ?? {}));
route('PUT', '/api/profile/avatar', ({ db, body }) => { saveAvatar(db, body?.dataUrl ?? null); return { ok: true }; });

route('PUT', '/api/settings', ({ db, body }) => {
  if (body.rollforwardDays !== undefined) {
    const n = Number(body.rollforwardDays);
    if (!Number.isInteger(n) || n < 0 || n > 10) throw new ValidationError('Days must be between 0 and 10');
    setSetting(db, 'rollforward_days', String(n));
  }
  return { ok: true };
});

// ---------- Summary ----------
route('GET', '/api/spending', ({ db, query }) => {
  const month = query.get('month') || monthOf(todayIso());
  if (!/^\d{4}-\d{2}$/.test(month)) throw new ValidationError('Invalid month');
  return monthSpending(db, month);
});

route('GET', '/api/summary', ({ db, query }) => {
  const month = query.get('month') || monthOf(todayIso());
  if (!/^\d{4}-\d{2}$/.test(month)) throw new ValidationError('Invalid month');
  return monthSummary(db, month);
});

// ---------- Accounts ----------
route('GET', '/api/accounts', ({ db, query }) => listAccounts(db, { includeArchived: query.get('archived') === '1' }));
route('POST', '/api/accounts', ({ db, body }) => ({ id: createAccount(db, body) }));
route('PUT', '/api/accounts/:id', ({ db, params, body }) => { updateAccount(db, id(params), body); return { ok: true }; });
route('DELETE', '/api/accounts/:id', ({ db, params }) => { deleteAccount(db, id(params)); return { ok: true }; });

// ---------- Categories ----------
route('GET', '/api/categories', ({ db }) => listCategories(db));
route('POST', '/api/categories', ({ db, body }) => ({ id: createCategory(db, body) }));
route('PUT', '/api/categories/order', ({ db, body }) => { reorderCategories(db, body.ids); return { ok: true }; });
route('PUT', '/api/categories/:id', ({ db, params, body }) => { updateCategory(db, id(params), body); return { ok: true }; });
route('DELETE', '/api/categories/:id', ({ db, params, query }) => {
  deleteCategory(db, id(params), int(query.get('reassignTo')) ?? null);
  return { ok: true };
});

// ---------- Transactions ----------
route('GET', '/api/transactions', ({ db, query }) =>
  listTransactions(db, {
    month: query.get('month') && query.get('month') !== 'all' ? query.get('month')! : undefined,
    from: query.get('from') || undefined,
    to: query.get('to') || undefined,
    accountId: int(query.get('accountId')) ?? (query.get('budgetId') ? budgetAccount(db, Number(query.get('budgetId'))) ?? undefined : undefined),
    categoryId: int(query.get('categoryId')),
    categoryIds: query.get('budgetId') && !budgetAccount(db, Number(query.get('budgetId'))) ? budgetCategoryIds(db, Number(query.get('budgetId'))) : undefined,
    kind: query.get('kind') || undefined,
    search: query.get('search') || undefined,
    merchant: query.get('merchant') || undefined,
    uncategorised: query.get('uncategorised') === '1',
    limit: query.get('limit') === 'all' ? 100000 : int(query.get('limit')),
    offset: int(query.get('offset')),
  }),
);
route('GET', '/api/transactions/:id', ({ db, params }) => {
  const t = getTransaction(db, id(params));
  if (!t) throw new ValidationError('Transaction not found');
  return t;
});
route('POST', '/api/transactions', ({ db, body }) => {
  const input = body.postings ? body : simpleToPostings(body);
  const txnId = createTransaction(db, input);
  autoMatch(db);
  return { id: txnId };
});
route('PUT', '/api/transactions/:id', ({ db, params, body }) => {
  const input = body.postings ? body : simpleToPostings(body);
  updateTransaction(db, id(params), input);
  autoMatch(db);
  return { ok: true };
});
route('DELETE', '/api/transactions/:id', ({ db, params }) => { deleteTransaction(db, id(params)); return { ok: true }; });
route('POST', '/api/transactions/bulk-categorise', ({ db, body }) => {
  if (!Array.isArray(body.ids)) throw new ValidationError('ids required');
  bulkCategorise(db, body.ids.map(Number), body.categoryId ?? null);
  return { ok: true };
});
route('POST', '/api/transactions/bulk-delete', ({ db, body }) => {
  if (!Array.isArray(body.ids)) throw new ValidationError('ids required');
  for (const t of body.ids) deleteTransaction(db, Number(t));
  return { ok: true };
});
route('POST', '/api/transactions/merge-transfer', ({ db, body }) => ({ id: mergeIntoTransfer(db, Number(body.outId), Number(body.inId)) }));

route('GET', '/api/export/transactions.csv', ({ db, query }) => {
  const { items } = listTransactions(db, {
    month: query.get('month') && query.get('month') !== 'all' ? query.get('month')! : undefined,
    accountId: int(query.get('accountId')),
    categoryId: int(query.get('categoryId')),
    search: query.get('search') || undefined,
    limit: 1000000,
  } as any);
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [['Date', 'Counts towards', 'Description', 'Type', 'Account', 'Category', 'Amount', 'Notes'].join(',')];
  for (const t of items) {
    for (const p of t.postings) {
      lines.push([t.date, t.period, t.description, t.kind, p.accountName, p.categoryName ?? '', (p.amount / 100).toFixed(2), t.notes ?? ''].map(esc).join(','));
    }
  }
  return { __raw: lines.join('\n') + '\n', type: 'text/csv; charset=utf-8', filename: 'transactions.csv' };
});

// ---------- Rules ----------
route('GET', '/api/rules', ({ db }) => listRules(db));
route('GET', '/api/rules/suggestions', ({ db }) => suggestRules(db));
/** A category for a description you're typing: your rules, then last time, then the built-in merchant list. */
route('GET', '/api/categorise/suggest', ({ db, query }) => {
  const description = (query.get('description') ?? '').trim();
  const amount = Number(query.get('amount')) || -1;
  const accountId = int(query.get('accountId'));
  if (description.length < 2) return { categoryId: null, source: 'none' };
  if (accountId) {
    const s = suggest(db, loadRules(db), accountId, description, amount);
    if (s.categoryId && s.kind !== 'transfer') return { categoryId: s.categoryId, kind: s.kind, source: s.source };
  }
  const smart = smartCategory(db, description, amount);
  return smart ? { categoryId: smart.categoryId, kind: smart.kind, source: 'smart', matched: smart.matched } : { categoryId: null, source: 'none' };
});
route('POST', '/api/rules/bulk', ({ db, body }) => createRules(db, body?.items, body?.fillIn !== false));
route('POST', '/api/rules', ({ db, body }) => ({ id: createRule(db, body) }));
route('PUT', '/api/rules/:id', ({ db, params, body }) => { updateRule(db, id(params), body); return { ok: true }; });
route('POST', '/api/rules/test', ({ db, body }) => testRules(db, body?.description, body?.accountId ?? null));
route('DELETE', '/api/rules/:id', ({ db, params }) => { deleteRule(db, id(params)); return { ok: true }; });

// ---------- Import ----------
route('POST', '/api/import/preview', ({ db, body }) => previewImport(db, body));
route('POST', '/api/import/commit', ({ db, body }) => {
  const result = commitImport(db, body);
  autoMatch(db);
  return result;
});

// ---------- Bills, subscriptions, savings and income ----------
route('GET', '/api/recurring', ({ db }) => { autoMatch(db); return listRecurring(db); });
route('POST', '/api/recurring', ({ db, body }) => ({ id: createRecurring(db, body) }));
route('PUT', '/api/recurring/:id', ({ db, params, body }) => { updateRecurring(db, id(params), body); return { ok: true }; });
route('DELETE', '/api/recurring/:id', ({ db, params }) => { deleteRecurring(db, id(params)); return { ok: true }; });
route('POST', '/api/recurring/:id/payment', ({ db, params, body }) => { setPayment(db, id(params), body); return { ok: true }; });
route('PUT', '/api/recurring/:id/shares', ({ db, params, body }) => saveShares(db, id(params), body?.shares ?? [], { applyToPast: body?.applyToPast === true }));
route('GET', '/api/recurring/suggestions', ({ db }) => suggestRecurring(db));
route('GET', '/api/upcoming', ({ db, query }) => {
  const today = todayIso();
  const month = query.get('month');
  if (month) {
    // Everything due in a calendar month (paid or not), plus anything still overdue from before it.
    if (!/^\d{4}-\d{2}$/.test(month)) throw new ValidationError('Invalid month');
    const start = `${month}-01`;
    const end = `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;
    return occurrences(db, addDays(start, -31), end).filter((o) => o.dueDate >= start || o.status === 'overdue' || o.status === 'due');
  }
  const days = Math.min(Number(query.get('days') ?? 45), 400);
  // Include recent unpaid items so overdue ones stay visible.
  return occurrences(db, addDays(today, -31), addDays(today, days))
    .filter((o) => o.dueDate >= today || o.status === 'overdue' || o.status === 'due');
});
route('GET', '/api/plan', ({ db, query }) => {
  const month = query.get('month') || monthOf(todayIso());
  if (!/^\d{4}-\d{2}$/.test(month)) throw new ValidationError('Invalid month');
  return monthPlan(db, month);
});

// ---------- Budgets ----------
route('GET', '/api/budgets', ({ db, query }) => {
  const month = query.get('month') || monthOf(todayIso());
  if (!/^\d{4}-\d{2}$/.test(month)) throw new ValidationError('Invalid month');
  return listBudgets(db, month);
});
route('GET', '/api/budgets/suggestions', ({ db }) => suggestBudgets(db));
route('GET', '/api/budgets/guide', ({ db, query }) => budgetGuide(db, query.get('month') || monthOf(todayIso())));
route('PUT', '/api/budgets/guide', ({ db, body }) => { updateGuide(db, body); return { ok: true }; });
route('POST', '/api/budgets', ({ db, body }) => ({ id: createBudget(db, body) }));
route('POST', '/api/budgets/order', ({ db, body }) => { reorderBudgets(db, (body.ids ?? []).map(Number)); return { ok: true }; });
route('PUT', '/api/budgets/:id', ({ db, params, body }) => { updateBudget(db, id(params), body); return { ok: true }; });
route('DELETE', '/api/budgets/:id', ({ db, params }) => { deleteBudget(db, id(params)); return { ok: true }; });

// ---------- Debts ----------
route('GET', '/api/debts', ({ db }) => ({ ...listDebts(db), types: DEBT_TYPES }));
route('GET', '/api/debts/plan', ({ db, query }) => debtPlan(db, query.get('monthly') ? Number(query.get('monthly')) : null));
route('PUT', '/api/debts/plan', ({ db, body }) => { saveDebtPlan(db, body); return { ok: true }; });
route('POST', '/api/debts', ({ db, body }) => ({ id: createDebt(db, body) }));
route('GET', '/api/debts/:id/candidates', ({ db, params, query }) => linkCandidates(db, id(params), query.get('search') ?? ''));
route('POST', '/api/debts/:id/link', ({ db, params, body }) => { linkToDebt(db, id(params), body?.transactionIds, { takeOff: body?.takeOff }); return { ok: true }; });
route('GET', '/api/debts/timeline', ({ db }) => debtTimeline(db));
route('POST', '/api/debts/:id/archive', ({ db, params }) => { archiveDebt(db, id(params)); return { ok: true }; });
route('POST', '/api/debts/:id/review', ({ db, params, body }) => { reviewRepayments(db, id(params), body?.postingIds, !!body?.apply); return { ok: true }; });
route('PUT', '/api/debts/:id', ({ db, params, body }) => { saveDebt(db, id(params), body); return { ok: true }; });
route('DELETE', '/api/debts/:id', ({ db, params }) => { deleteDebtDetails(db, id(params)); return { ok: true }; });
route('POST', '/api/debts/:id/repayment', ({ db, params }) => ({ id: addRepaymentToBills(db, id(params)) }));

// ---------- Investments ----------
route('GET', '/api/accounts/:id/valuations', ({ db, params }) => investmentHistory(db, id(params)));
route('POST', '/api/accounts/:id/valuations', ({ db, params, body }) => {
  setValuation(db, id(params), body.date ?? todayIso(), body.value);
  return { ok: true };
});
route('DELETE', '/api/accounts/:id/valuations/:date', ({ db, params }) => { deleteValuation(db, id(params), params.date); return { ok: true }; });
route('POST', '/api/accounts/:id/sync', async ({ db, params }) => {
  const r = await syncTrading212Full(db, id(params), trading212Config());
  const failed = r.steps.filter((s) => s.status !== 'ok');
  return { ok: true, value: r.value, failed: failed.map((f) => f.key) };
});
// Read-only Trading 212 copy: status, and "Sync now" (runs in the background; poll status).
route('GET', '/api/payday', ({ db, query }) => payday(db, query.get('cycle')));
route('GET', '/api/payday/status', ({ db }) => paydayStatus(db));
route('GET', '/api/payday/logs', ({ db }) => paydayLogs(db));
route('POST', '/api/payday/check', ({ db, body }) => { setCheck(db, body?.cycle, body?.key, body?.done !== false); return { ok: true }; });
route('POST', '/api/payday/budgets', ({ db, body }) => { setPaydayBudgets(db, body?.cycle, body?.limits); return { ok: true }; });
route('POST', '/api/payday/complete', ({ db, body }) => completePayday(db, body?.cycle));
route('POST', '/api/payday/reopen', ({ db, body }) => { reopenPayday(db, body?.cycle); return { ok: true }; });
route('POST', '/api/payday/items', ({ db, body }) => ({ id: addPaydayItem(db, body?.text) }));
route('DELETE', '/api/payday/items/:id', ({ db, params }) => { deletePaydayItem(db, id(params)); return { ok: true }; });
route('GET', '/api/investing', ({ db }) => portfolio(db));
route('GET', '/api/investing/holding/:ticker', ({ db, params }) => holdingDetail(db, params.ticker));
route('POST', '/api/t212/key', ({ db, body }) => {
  const host = needDesktop();
  const key = typeof body?.key === 'string' ? body.key.trim() : '';
  const secret = typeof body?.secret === 'string' ? body.secret.trim() : '';
  if (!key || !secret) throw new ValidationError('Enter both the API key and the secret');
  if (key.length > 400 || secret.length > 400 || /\s/.test(key + secret)) throw new ValidationError("That doesn't look like a Trading 212 key");
  host.saveT212Key(key, secret);
  const config = trading212Config();
  let started = false;
  if (config && syncedAccounts(db).length) { try { startSync(db, config); started = true; } catch { /* already running */ } }
  return { configured: config !== null, started };
});
route('DELETE', '/api/t212/key', () => { needDesktop().clearT212Key(); return { configured: trading212Config() !== null }; });
route('POST', '/api/desktop/open-data', () => { needDesktop().openDataFolder(); return { ok: true }; });
route('GET', '/api/desktop/update', () => {
  const u = desktop?.updates;
  return u ? { supported: true, ...(u.info() as object) } : { supported: false, version: desktop?.version ?? null };
});
route('POST', '/api/desktop/update/check', async () => {
  const u = desktop?.updates;
  if (!u) throw new ValidationError('Updates work in the desktop app');
  return { supported: true, ...((await u.check()) as object) };
});
route('POST', '/api/desktop/update/install', async () => {
  const u = desktop?.updates;
  if (!u) throw new ValidationError('Updates work in the desktop app');
  const r = await u.install();
  if (!r.ok) throw new ValidationError(r.reason);
  return { ok: true };
});
route('POST', '/api/desktop/update/open', () => { desktop?.updates?.openManual(); return { ok: true }; });
route('PUT', '/api/desktop/update/auto', ({ body }) => {
  const u = desktop?.updates;
  if (!u) throw new ValidationError('Updates work in the desktop app');
  u.setAuto(body?.on !== false);
  return { supported: true, ...(u.info() as object) };
});
// ---------- Notifications (desktop app) ----------
const notifyState = (db: Parameters<typeof notifySettings>[0]) => {
  const n = desktop?.notifications;
  return { supported: !!n?.supported(), platform: desktop?.platform ?? null, openAtLogin: n ? n.openAtLogin() : null, settings: notifySettings(db) };
};
route('GET', '/api/notifications', ({ db }) => notifyState(db));
route('PUT', '/api/notifications', ({ db, body }) => {
  const { openAtLogin, ...rest } = (body ?? {}) as Record<string, unknown>;
  updateNotifySettings(db, rest);
  if (typeof openAtLogin === 'boolean') {
    if (!desktop?.notifications) throw new ValidationError('Opening at login works in the desktop app');
    try { desktop.notifications.setOpenAtLogin(openAtLogin); } catch (e: any) { throw new ValidationError(e?.message ?? "Couldn't change that"); }
  }
  desktop?.notifications?.run();
  return notifyState(db);
});
route('POST', '/api/notifications/test', () => {
  const n = desktop?.notifications;
  if (!n?.supported()) throw new ValidationError('Notifications work in the desktop app');
  if (!n.test()) throw new ValidationError("The notification couldn't be shown. Check that Coil is allowed to send notifications in your system settings.");
  return { ok: true };
});
route('POST', '/api/desktop/relaunch', () => { const host = needDesktop(); setTimeout(() => host.relaunch(), 150); return { ok: true }; });
route('GET', '/api/t212/status', ({ db }) => syncStatus(db, trading212Config()));
route('POST', '/api/t212/sync', ({ db, body }) => { startSync(db, trading212Config(), {}, { force: body?.force === true }); return { ok: true }; });
route('GET', '/api/isa', ({ db }) => isaAllowanceSummary(db));
route('GET', '/api/isa/details', ({ db }) => isaStatus(db));
route('GET', '/api/investing/performance', ({ db }) => performance(db));
route('GET', '/api/imports', ({ db }) => listImports(db));
const rng = (q: URLSearchParams, a = 'from', b = 'to') => ({ from: q.get(a) ?? '', to: q.get(b) ?? '' });
route('GET', '/api/reports/trends', ({ db, query }) => trends(db, Number(query.get('months') ?? 12)));
route('GET', '/api/reports/merchants', ({ db, query }) => merchants(db, rng(query)));
route('GET', '/api/reports/explore', ({ db, query }) => explore(db, { ...rng(query), categoryId: int(query.get('categoryId')) ?? null, search: query.get('search') ?? '', kind: query.get('kind') === 'income' ? 'income' : 'expense' }));
route('GET', '/api/reports/spending', ({ db, query }) => spendingExplorer(db, { ...rng(query), categoryId: int(query.get('categoryId')) ?? null, merchant: query.get('merchant') || null, search: query.get('search') || null }));
route('GET', '/api/reports/cutback', ({ db }) => cutBack(db));
route('GET', '/api/reports/habits', ({ db, query }) => habits(db, rng(query)));
route('GET', '/api/reports/budgets', ({ db }) => budgetRecord(db));
route('GET', '/api/reports/cashflow', ({ db, query }) => cashFlow(db, Number(query.get('months') ?? 12)));
route('GET', '/api/reports/week', ({ db, query }) => weekly(db, query.get('week')));
route('GET', '/api/reports/compare2', ({ db, query }) => compareDrivers(db, rng(query, 'aFrom', 'aTo'), rng(query, 'bFrom', 'bTo')));
route('GET', '/api/reports/compare', ({ db, query }) => compare(db, rng(query, 'aFrom', 'aTo'), rng(query, 'bFrom', 'bTo')));
route('GET', '/api/reports/networth', ({ db, query }) => netWorthHistory(db, Number(query.get('months') ?? 24)));
route('GET', '/api/reports/year', ({ db, query }) => yearReview(db, query.get('kind') === 'tax' ? 'tax' : 'calendar', Number(query.get('year'))));
route('GET', '/api/reports/years', ({ db }) => reportYears(db));
route('GET', '/api/goals', ({ db, query }) => listGoals(db, undefined, { includeArchived: query.get('archived') === '1' }));
route('POST', '/api/goals', ({ db, body }) => ({ id: createGoal(db, body) }));
route('PUT', '/api/goals/order', ({ db, body }) => { reorderGoals(db, body?.ids); return { ok: true }; });
route('PUT', '/api/goals/:id', ({ db, params, body }) => {
  if (body && Object.keys(body).length === 1 && 'archived' in body) archiveGoal(db, id(params), !!body.archived);
  else updateGoal(db, id(params), body);
  return { ok: true };
});
route('DELETE', '/api/goals/:id', ({ db, params }) => { deleteGoal(db, id(params)); return { ok: true }; });
route('GET', '/api/goals/:id/moves', ({ db, params }) => goalMoves(db, id(params)));
route('POST', '/api/goals/:id/move', ({ db, params, body }) => { moveMoney(db, id(params), body ?? {}); return { ok: true }; });
route('GET', '/api/skipped', ({ db }) => listSkipped(db));
route('POST', '/api/skipped/:id/restore', ({ db, params, body }) => ({ id: restoreSkipped(db, id(params), body ?? {}) }));
route('DELETE', '/api/skipped/:id', ({ db, params }) => { dismissSkipped(db, id(params)); return { ok: true }; });
route('DELETE', '/api/imports/:id', ({ db, params }) => { undoImport(db, id(params)); return { ok: true }; });

// ---------- Backup ----------
export function createApp(db: DB, opts: { staticDir?: string; backupDir: string; dbFile?: string; desktop?: DesktopHost; lockFile?: string }) {
  desktop = opts.desktop ?? null;
  // The passcode (if any) lives next to the database, not in it.
  const lockFile = opts.lockFile ?? (opts.dbFile && opts.dbFile !== ':memory:' ? path.join(path.dirname(opts.dbFile), 'lock.json') : null);
  lock = lockFile ? new Lock(lockFile) : null;
  route('POST', '/api/backup', () => ({ file: backup(db, opts.backupDir) }));
  // Clear everything synced from Trading 212 (after a backup) and download it again with the current key.
  route('POST', '/api/t212/reset', () => {
    const accountId = syncedAccounts(db)[0];
    if (!accountId) throw new ValidationError('No account is set to sync with Trading 212.');
    const file = backup(db, opts.backupDir);
    const removed = resetTrading212(db, accountId);
    let started = false;
    const config = trading212Config();
    if (config) { try { startSync(db, config); started = true; } catch { /* already running: the next sync picks it up */ } }
    return { backup: path.basename(file), removed, started };
  });
  route('GET', '/api/health', ({ db }) => healthChecks(db));
  // Download a copy of everything (a consistent snapshot, safe while the app is running).
  route('GET', '/api/backup/download', () => {
    const file = backup(db, opts.backupDir);
    const stamp = new Date().toISOString().slice(0, 10);
    return { __raw: fs.readFileSync(file), type: 'application/vnd.sqlite3', filename: `finance-backup-${stamp}.db` };
  });
  // Restore: check the file, stage it next to the database, and swap it in on the next start.
  route('POST', '/api/backup/restore', ({ body }) => {
    if (!opts.dbFile) throw new ValidationError('Restore is not available here');
    if (typeof body?.data !== 'string') throw new ValidationError('Choose a backup file');
    const buf = Buffer.from(body.data, 'base64');
    if (buf.subarray(0, 16).toString('latin1') !== 'SQLite format 3\u0000') throw new ValidationError("That isn't a backup from this app");
    const staged = `${opts.dbFile}.restore`;
    fs.writeFileSync(staged, buf);
    try {
      const check = new DatabaseSync(staged, { readOnly: true });
      const v = (check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
      const ok = check.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('accounts','transactions','postings','categories')").get() as { n: number };
      const counts = { transactions: (check.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n, accounts: (check.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n };
      check.close();
      if (ok.n !== 4) throw new ValidationError("That file doesn't look like a backup from this app");
      if (v > MIGRATIONS.length) throw new ValidationError('That backup is from a newer version of the app');
      return { ok: true, ...counts };
    } catch (e) {
      fs.rmSync(staged, { force: true });
      if (e instanceof ValidationError) throw e;
      throw new ValidationError("That file couldn't be read as a backup");
    }
  });
  route('DELETE', '/api/backup/restore', () => { if (opts.dbFile) fs.rmSync(`${opts.dbFile}.restore`, { force: true }); return { ok: true }; });
  route('GET', '/api/backup/restore', () => ({ pending: !!opts.dbFile && fs.existsSync(`${opts.dbFile}.restore`) }));

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        const session = readCookie(req.headers.cookie, LOCK_COOKIE);
        if (lock && !OPEN_WHILE_LOCKED.has(`${req.method} ${url.pathname}`) && !lock.isUnlocked(session)) return send(res, 401, { error: 'Locked', locked: true });
        const r = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
        if (!r) return send(res, 404, { error: 'Not found' });
        const match = url.pathname.match(r.pattern)!;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(match[i + 1])]));
        const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readJson(req);
        const cookies: string[] = [];
        const result: any = await r.handler({ db, params, query: url.searchParams, body, session, setCookie: (c) => cookies.push(c) });
        if (cookies.length) res.setHeader('Set-Cookie', cookies);
        if (result && typeof result === 'object' && '__raw' in result) {
          res.writeHead(200, { 'Content-Type': result.type, 'Content-Disposition': `attachment; filename="${result.filename}"` });
          return res.end(result.__raw);
        }
        return send(res, 200, result ?? { ok: true });
      }
      if (opts.staticDir) return serveStatic(opts.staticDir, url.pathname, res);
      send(res, 404, { error: 'Not found' });
    } catch (err: any) {
      if (err instanceof ValidationError) return send(res, 400, { error: err.message });
      if (err instanceof SyntaxError) return send(res, 400, { error: 'Invalid JSON' });
      console.error(err);
      send(res, 500, { error: 'Something went wrong. Check the server log.' });
    }
  });
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 25 * 1024 * 1024) throw new ValidationError('Request too large');
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.map': 'application/json',
  '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
};

function serveStatic(dir: string, pathname: string, res: http.ServerResponse) {
  const safe = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = path.join(dir, safe);
  if (!file.startsWith(path.resolve(dir)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(dir, 'index.html'); // SPA fallback
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}
