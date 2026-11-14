/**
 * The Plan's series: one name and colour each, used by every chart, legend and bubble
 * (see GLOSSARY.md: Plan). Colours are design tokens from styles.css, never hex here.
 */
export type SeriesKey = 'bills' | 'subscriptions' | 'savings' | 'debts' | 'spending' | 'income';

export const SERIES: Record<SeriesKey, { label: string; colour: string }> = {
  bills: { label: 'Bills', colour: 'var(--bills)' },
  subscriptions: { label: 'Subscriptions', colour: 'var(--subscriptions)' },
  savings: { label: 'Savings', colour: 'var(--saved)' },
  debts: { label: 'Debt repayments', colour: 'var(--bad)' },
  spending: { label: 'Everyday spending', colour: 'var(--spend)' },
  income: { label: 'Income', colour: 'var(--income)' },
};
