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
