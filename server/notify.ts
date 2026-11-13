/**
 * Notifications for the desktop app: what's worth telling you about right now.
 *
 * The desktop app asks `dueNotifications` every 15 minutes and when the computer wakes. Each
 * notification has a key, and a key is only ever sent once (the sent keys are kept in settings),
 * so restarts, sleep and catching up never repeat one. Amounts are left out unless you turn them on,
 * because notifications can show on the lock screen.
 */
import { type DB, getSetting, setSetting } from './db.ts';
import { addDays, daysBetween, monthOf, todayIso } from './dates.ts';
import { formatPence } from './money.ts';
import { occurrences } from './recurring.ts';
import { currentCycle, paydayStatus } from './payday.ts';
import { listBudgets } from './budgets.ts';
import { weekly, weekStart } from './insights.ts';
import { ValidationError } from './money.ts';

export interface NotifySettings {
  enabled: boolean;
  bills: boolean;
  /** Days before a bill is due: 1 (the day before) or 3. */
  billDays: 1 | 3;
  payday: boolean;
  weekly: boolean;
  budgets: boolean;
  imports: boolean;
  updates: boolean;
  /** Show amounts in notifications. Off by default: they can appear on the lock screen. */
  showAmounts: boolean;
  /** Quiet hours, as hours of the day (0-23). Nothing is sent from `quietFrom` until `quietTo`. */
  quietFrom: number;
  quietTo: number;
}

export const DEFAULT_NOTIFY: NotifySettings = {
  enabled: true, bills: true, billDays: 1, payday: true, weekly: true, budgets: true, imports: true, updates: true,
  showAmounts: false, quietFrom: 22, quietTo: 8,
};

export interface Notice {
  key: string;
  kind: 'bills' | 'payday' | 'weekly' | 'budgets' | 'imports' | 'updates' | 'test';
  title: string;
  body: string;
  /** The page to open when it's clicked. */
  route: string;
}

const SETTINGS_KEY = 'notifications';
const SENT_KEY = 'notifications_sent';
/** Accounts not imported into for this many days get a nudge (once a week at most). */
export const IMPORT_NUDGE_DAYS = 7;

export function notifySettings(db: DB): NotifySettings {
  try { return { ...DEFAULT_NOTIFY, ...JSON.parse(getSetting(db, SETTINGS_KEY, '{}')) }; } catch { return { ...DEFAULT_NOTIFY }; }
}

export function updateNotifySettings(db: DB, body: Partial<NotifySettings>): NotifySettings {
  const cur = notifySettings(db);
  const next: NotifySettings = { ...cur };
  for (const k of ['enabled', 'bills', 'payday', 'weekly', 'budgets', 'imports', 'updates', 'showAmounts'] as const) {
    if (body[k] !== undefined) {
      if (typeof body[k] !== 'boolean') throw new ValidationError(`${k} must be on or off`);
      next[k] = body[k] as boolean;
    }
  }
  if (body.billDays !== undefined) {
    if (body.billDays !== 1 && body.billDays !== 3) throw new ValidationError('Choose 1 or 3 days before');
    next.billDays = body.billDays;
  }
  for (const k of ['quietFrom', 'quietTo'] as const) {
    if (body[k] !== undefined) {
      const v = body[k];
      if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 23) throw new ValidationError('Choose an hour for quiet hours');
      next[k] = v as number;
    }
  }
  setSetting(db, SETTINGS_KEY, JSON.stringify(next));
  return next;
}

/** True during quiet hours. Equal from/to means no quiet hours. */
export function isQuiet(s: Pick<NotifySettings, 'quietFrom' | 'quietTo'>, hour: number): boolean {
  if (s.quietFrom === s.quietTo) return false;
  return s.quietFrom < s.quietTo ? hour >= s.quietFrom && hour < s.quietTo : hour >= s.quietFrom || hour < s.quietTo;
}

function sentKeys(db: DB): Record<string, string> {
  try { return JSON.parse(getSetting(db, SENT_KEY, '{}')); } catch { return {}; }
}

/** Record keys as sent; keys older than 120 days are forgotten (they can't come round again). */
export function markSent(db: DB, keys: string[], today = todayIso()) {
  const all = sentKeys(db);
  for (const k of keys) all[k] = today;
  const cutoff = addDays(today, -120);
  for (const [k, d] of Object.entries(all)) if (d < cutoff) delete all[k];
  setSetting(db, SENT_KEY, JSON.stringify(all));
}

const list = (names: string[]) => names.length <= 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Everything that should be sent now and hasn't been. Doesn't mark anything as sent, and doesn't
 * look at quiet hours: the caller does both.
 */
export function dueNotifications(db: DB, today = todayIso(), s = notifySettings(db)): Notice[] {
  if (!s.enabled) return [];
  const sent = sentKeys(db);
  const out: Notice[] = [];
  const money = (p: number) => formatPence(Math.abs(p));
  const add = (n: Notice) => { if (!sent[n.key]) out.push(n); };

  // Bills, subscriptions and debt payments coming up (not income or savings moves).
  if (s.bills) {
    const soon = occurrences(db, addDays(today, 1), addDays(today, s.billDays))
      .filter((o) => (o.type === 'bill' || o.type === 'subscription' || o.isDebt) && o.status !== 'paid' && o.status !== 'skipped')
      .filter((o) => !sent[`bill:${o.recurringId}:${o.dueDate}`]);
    if (soon.length) {
      const when = (d: string) => daysBetween(today, d) === 1 ? 'tomorrow' : `in ${daysBetween(today, d)} days`;
      const total = soon.reduce((t, o) => t + o.expected, 0);
      const first = soon[0];
      const title = soon.length === 1 ? `${first.name} is due ${when(first.dueDate)}` : `${plural(soon.length, 'bill')} due soon`;
      const body = soon.length === 1
        ? (s.showAmounts ? `${money(first.expected)} from ${first.accountName}.` : `From ${first.accountName}.`)
        : `${list(soon.map((o) => o.name))}${s.showAmounts ? `, ${money(total)} in total` : ''}.`;
      // One notice covering several bills; each bill's own key is marked so it's never sent twice.
      out.push({ key: soon.map((o) => `bill:${o.recurringId}:${o.dueDate}`).join('|'), kind: 'bills', title, body, route: '/bills' });
    }
  }

  // Payday: on the day (or when the computer is next on, within two days), until the routine is done.
  if (s.payday) {
    const cycle = currentCycle(db, today);
    const st = paydayStatus(db, today);
    if (daysBetween(cycle, today) <= 2 && !st.completedAt) {
      add({ key: `payday:${cycle}`, kind: 'payday', title: "It's payday", body: `${plural(st.stepsTotal, 'step')} to sort out the month ahead.`, route: '/payday' });
    }
  }

  // Last week's summary, from Monday morning.
  if (s.weekly) {
    const last = addDays(weekStart(today), -7);
    if (!sent[`weekly:${last}`]) {
      const w = weekly(db, last, today);
      if (w.count > 0) {
        const top = w.categories.find((c) => !c.fixed && c.total > 0);
        let body: string;
        if (s.showAmounts) {
          const usual = w.typical?.spent;
          const vs = usual ? (w.spent <= usual ? `, ${money(usual - w.spent)} less than usual` : `, ${money(w.spent - usual)} more than usual`) : '';
          body = `You spent ${money(w.spent)}${vs}.${top ? ` Most went on ${top.name} (${money(top.total)}).` : ''}`;
        } else {
          const usual = w.typical?.spent;
          const vs = usual ? (w.spent <= usual ? 'less than' : 'more than') : null;
          body = `${vs ? `You spent ${vs} a usual week.` : 'Your week in one place.'}${top ? ` Most went on ${top.name}.` : ''}`;
        }
        add({ key: `weekly:${last}`, kind: 'weekly', title: 'Last week at a glance', body, route: `/reports?tab=week&week=${last}` });
      }
    }
  }

  // Spending budgets: once when nearly used (80%), once when over, per budget per period.
  if (s.budgets) {
    for (const b of listBudgets(db, monthOf(today), today).budgets) {
      if (b.kind !== 'spending' || b.archived || b.available <= 0) continue;
      const where = b.period === 'weekly' ? 'this week' : b.period === 'annual' ? 'this year' : 'this month';
      if (b.spent > b.available) {
        add({ key: `budget:${b.id}:${b.current.key}:over`, kind: 'budgets', title: `${b.name} budget is over`,
          body: s.showAmounts ? `${money(b.spent - b.available)} over for ${where}.` : `You've gone over it ${where}.`, route: '/budgets' });
      } else if (b.spent >= b.available * 0.8 && !sent[`budget:${b.id}:${b.current.key}:over`]) {
        const days = b.pace?.daysLeft;
        add({ key: `budget:${b.id}:${b.current.key}:80`, kind: 'budgets', title: `${b.name} budget is ${Math.floor((b.spent / b.available) * 100)}% used`,
          body: s.showAmounts ? `${money(b.available - b.spent)} left${days ? `, with ${plural(days, 'day')} to go` : ''}.` : days ? `${plural(days, 'day')} to go ${where}.` : 'Nearly all of it is spent.', route: '/budgets' });
      }
    }
  }

  // Accounts you import statements into that haven't had one for a week. At most once a week.
  if (s.imports) {
    const key = `imports:${weekStart(today)}`;
    if (!sent[key]) {
      const rows = db.prepare(
        `SELECT a.name, MAX(date(b.imported_at)) AS last FROM accounts a JOIN import_batches b ON b.account_id = a.id
         WHERE a.archived = 0 AND a.sync_provider IS NULL GROUP BY a.id HAVING last <= ? ORDER BY last`,
      ).all(addDays(today, -IMPORT_NUDGE_DAYS)) as { name: string; last: string }[];
      // Accounts left alone for months are probably not ones you import into any more.
      const stale = rows.filter((r) => daysBetween(r.last, today) <= 60);
      if (stale.length) {
        const days = daysBetween(stale[0].last, today);
        add({ key, kind: 'imports', title: 'Time to import',
          body: stale.length === 1 ? `${stale[0].name} hasn't been imported for ${days} days.` : `${list(stale.map((r) => r.name))} haven't been imported for a week or more.`,
          route: '/import' });
      }
    }
  }

  return out;
}

/** The keys a notice covers (a combined bills notice covers one key per bill). */
export const noticeKeys = (n: Notice) => n.key.split('|');

export function updateNotice(version: string): Notice {
  return { key: `update:${version}`, kind: 'updates', title: `Coil ${version} is ready`, body: 'Restart to update. Your data stays as it is.', route: '/settings?tab=about' };
}

export function wasSent(db: DB, key: string): boolean {
  return !!sentKeys(db)[key];
}

const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * One round: outside quiet hours, show whatever is due and mark it sent. Returns what was shown.
 * `show` returns false if it couldn't show it, so it's tried again next time.
 */
export function runNotifications(db: DB, now: Date, show: (n: Notice) => boolean): Notice[] {
  const s = notifySettings(db);
  if (!s.enabled || isQuiet(s, now.getHours())) return [];
  const today = isoDay(now);
  const shown: Notice[] = [];
  for (const n of dueNotifications(db, today, s)) {
    if (show(n)) { markSent(db, noticeKeys(n), today); shown.push(n); }
  }
  return shown;
}
