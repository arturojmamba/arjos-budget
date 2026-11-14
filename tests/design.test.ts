import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// DESIGN.md › Layout: never a vertical scroll bar inside a card or page section. Lists fit and page instead.
// Only these may scroll vertically: the dialog overlay, the sidebar nav, and the list inside the Link a payment dialog.
const ALLOWED = ['.overlay', '.sidebar nav', '.link-list'];

test('nothing scrolls vertically inside a card (lists page instead)', () => {
  const css = readFileSync(new URL('../web/styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const offenders: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim();
    if (/overflow(-y)?\s*:\s*(auto|scroll)/.test(m[2]) && !ALLOWED.some((a) => selector.includes(a))) offenders.push(selector);
  }
  assert.deepEqual(offenders, [], `These scroll vertically; make the list fit and page instead (usePaged / useFitRows): ${offenders.join(', ')}`);
});

// DESIGN.md › Colors and web/series.ts: the Plan's series colours are tokens, never hex in a page.
const PLAN_PAGES = ['Bills', 'Payday', 'Overview', 'Reports', 'Budgets', 'Debts', 'Goals', 'Transactions'];

test('pages take plan and status colours from tokens, not hex', () => {
  const offenders: string[] = [];
  for (const page of PLAN_PAGES) {
    const src = readFileSync(new URL(`../web/pages/${page}.tsx`, import.meta.url), 'utf8');
    src.split('\n').forEach((line, i) => {
      if (/(colour|background|color)\s*[:=]\s*['"`]#[0-9a-f]{3,8}/i.test(line)) offenders.push(`${page}.tsx:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [], `Use SERIES (web/series.ts) or a CSS token instead of hex: ${offenders.join(', ')}`);
});
