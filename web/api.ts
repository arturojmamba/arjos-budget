export interface Account {
  id: number; name: string; type: string; institution: string | null; parentId: number | null; currency: string;
  anchorBalance: number; anchorDate: string; colour: string; archived: boolean; sortOrder: number;
  isLiability: boolean; balance: number; transactionCount: number; lastActivity: string | null;
  wrapper: string | null; syncProvider: string | null; lastSyncedAt: string | null; syncError: string | null;
  contributed: number | null; valuationDate: string | null; growth: number | null;
}
export interface Category {
  id: number; name: string; kind: 'expense' | 'income'; parentId: number | null; colour: string; icon: string | null;
  isFixed: boolean; rollForward: boolean; archived: boolean; sortOrder: number; transactionCount: number;
}
export interface Posting {
  id: number; accountId: number; accountName: string; accountColour: string; accountIsLiability: boolean; accountType: string; amount: number;
  categoryId: number | null; categoryName: string | null; categoryColour: string | null; bankDescription: string | null;
}
export interface Transaction {
  id: number; date: string; period: string; description: string; merchant: string; kind: 'expense' | 'income' | 'transfer';
  notes: string | null; importBatchId: number | null; postings: Posting[];
}
export interface CategoryTotal { categoryId: number | null; name: string; colour: string; isFixed: boolean; amount: number }
export interface Summary {
  month: string; income: number; spending: number; net: number; savingsRate: number | null; fixed: number; variable: number;
  byCategory: CategoryTotal[]; incomeByCategory: CategoryTotal[]; assets: number; liabilities: number; savings: number; cash: number;
  investments: number; netWorth: number; netWorthChange: number; accounts: Account[]; history: { month: string; income: number; spending: number; saved: number }[]; saved: number;
  daily: { date: string; amount: number }[]; uncategorised: number; recent: Transaction[];
  topSpends: { id: number; date: string; description: string; amount: number; categoryId: number | null }[];
  pace: { day: number; daysInMonth: number; isCurrent: boolean; spentToDate: number; lastMonthToDate: number; lastMonthTotal: number };
}
export interface MonthSpending { month: string; spending: number; byCategory: CategoryTotal[]; daily: { date: string; amount: number }[] }
export interface Meta {
  accountTypes: string[]; presets: { id: string; label: string; note?: string }[]; months: string[];
  frequencies: Frequency[]; trading212: { configured: boolean };
  currentMonth: string; today: string; settings: { rollforwardDays: number };
  appearance: Appearance; profile: Profile;
  lockEnabled: boolean;
  lockIdleMinutes: number | null;
  /** Set when running as the desktop app. */
  desktop: { version: string; platform: string; dataDir: string } | null;
}
export interface Appearance {
  theme: 'system' | 'light' | 'dark'; accent: string; density: 'comfortable' | 'compact'; textSize: 'small' | 'normal' | 'large';
  showPence: boolean; startPage: string; startHidden: boolean; reduceMotion: boolean; weekStart: 'monday';
}
export interface Profile { name: string; avatar: string | null }
/** The app's name. Fixed: it isn't a setting. */
export const APP_NAME = 'Coil';
export interface Rule {
  id: number; pattern: string; matchType: string; accountId: number | null; accountName: string | null; categoryId: number | null;
  categoryName: string | null; categoryColour: string | null; transferAccountId: number | null; transferAccountName: string | null;
  renameTo: string | null; priority: number; hits: number; matches: number; lastMatch: string | null; createdAt: string | null;
}

export class ApiError extends Error {}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  // The app was locked (another tab, or Lock now): show the lock screen.
  if (res.status === 401 && data.locked) window.dispatchEvent(new Event('ledger-locked'));
  if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body: unknown) => request<T>('POST', url, body),
  put: <T>(url: string, body: unknown) => request<T>('PUT', url, body),
  del: <T>(url: string) => request<T>('DELETE', url),
};

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    p.set(k, v === true ? '1' : String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

export type RecurringType = 'bill' | 'subscription' | 'income' | 'saving';
export type Frequency = 'weekly' | 'fortnightly' | 'four_weekly' | 'monthly' | 'quarterly' | 'annually';
export type OccurrenceStatus = 'paid' | 'skipped' | 'upcoming' | 'due' | 'overdue';

export interface Recurring {
  id: number; name: string; type: RecurringType; amount: number; variable: boolean; frequency: Frequency; startDate: string;
  schedule: 'fixed' | 'last_working_day'; endDate: string | null; accountId: number; accountName: string;
  transferAccountId: number | null; transferAccountName: string | null; categoryId: number | null; categoryName: string | null;
  categoryColour: string | null; categoryIcon: string | null; matchPattern: string | null; notes: string | null; active: boolean;
  monthly: number; next: { dueDate: string; status: OccurrenceStatus; expected: number } | null;
  history: { dueDate: string; status: 'paid' | 'skipped'; amount: number | null; paidDate: string | null; transactionId: number | null; description: string | null }[];
  priceChanges: { date: string; from: number; to: number }[]; lastChange: { date: string; from: number; to: number } | null;
  oneOff: boolean; extras: { date: string; expected: number; amount: number; extra: number }[]; extrasThisYear: number;
  shares: RecurringShare[]; sharedBack: number; yourShare: number; monthlyNet: number; shareCycles: ShareCycle[];
}
export interface RecurringShare { id?: number; name: string; matchPattern: string | null; amount: number; accountId: number | null }
export interface ShareCycle { dueDate: string; paidCount: number; received: number; people: { shareId: number; name: string; expected: number; paid: number; paidDate: string | null }[] }
export interface Occurrence {
  recurringId: number; name: string; type: RecurringType; dueDate: string; period: string; expected: number; status: OccurrenceStatus;
  paidAmount: number | null; paidDate: string | null; transactionId: number | null; accountName: string;
  categoryColour: string | null; categoryIcon: string | null; isDebt: boolean;
}
export interface Plan {
  month: string; incomeExpected: number; incomeReceived: number; incomeExtra: number; billsTotal: number; billsPaid: number; billsRemaining: number;
  savingsTotal: number; savingsDone: number; debtTotal: number; debtDone: number; committed: number; committedShare: number | null; otherSpending: number; freeToSpend: number;
  monthly: { bills: number; subscriptions: number; savings: number; debts: number; income: number };
}
export interface Suggestion {
  name: string; matchPattern: string; type: RecurringType; amount: number; variable: boolean; frequency: Frequency; startDate: string;
  accountId: number; accountIsCard: boolean; categoryId: number | null; categoryName: string | null; count: number; lastDate: string;
}
export interface IsaAllowance {
  taxYear: string; start: string; end: string; allowance: number; used: number; remaining: number;
  accounts: { id: number; name: string; paidIn: number; withdrawn: number }[];
  source?: 'trading212' | 'bank'; replaceable?: number;
}
export interface ValuationPoint { date: string; value: number; contributed: number; source: string; details: Record<string, number | null> | null }

export interface T212Endpoint { key: string; label: string; permission: string; status: 'never' | 'ok' | 'denied' | 'error' | 'unavailable'; message: string | null; lastOkAt: string | null; lastTryAt: string | null; items: number }
export interface T212Status {
  accountNumber: string | null;
  configured: boolean; environment: 'live' | 'demo'; accountId: number | null; running: boolean; step: string | null; lastRunError: string | null;
  endpoints: T212Endpoint[];
  cash: { amount: number; asOf: string; since: string | null; days: number; nudge: boolean } | null;
}
