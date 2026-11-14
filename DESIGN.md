---
name: Coil
colors:
  midnight-navy: "#0f1a2e"
  champagne-gold: "#d9c08e"
  pale-champagne: "#f1e5c6"
  ivory-ground: "#f5f1e8"
  ivory-surface: "#fffdf8"
  ivory-surface-2: "#faf6ee"
  border: "#e9e2d4"
  border-strong: "#d8cebb"
  text-secondary: "#4b5568"
  text-tertiary: "#626876"
  good: "#0f9d58"
  good-text: "#0b7743"
  warn: "#b7791f"
  warn-text: "#8d5d18"
  bad: "#d93025"
  bad-text: "#c52c22"
  info: "#2f6fde"
  info-text: "#2a64c8"
  spend-series: "#5b6b8c"
  dark-ground: "#0b1322"
  dark-surface: "#111c30"
  dark-surface-2: "#16233b"
  dark-text: "#f2ecdf"
typography:
  brand:
    fontFamily: "ui-serif, 'New York', 'Iowan Old Style', Georgia, serif"
    fontWeight: 650
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', 'Segoe UI', Roboto, sans-serif"
    fontSize: 24px
    fontWeight: 700
    letterSpacing: -0.02em
  figure:
    fontSize: 26px
    fontWeight: 700
    letterSpacing: -0.03em
    fontFeature: tnum
  body:
    fontSize: 14px
    fontWeight: 400
  label:
    fontSize: 12.5px
    fontWeight: 500
rounded:
  sm: 10px
  md: 16px
  pill: 999px
components:
  button-primary:
    backgroundColor: "{colors.champagne-gold}"
    textColor: "{colors.midnight-navy}"
    rounded: "{rounded.pill}"
    height: 38px
  card:
    backgroundColor: "{colors.ivory-surface}"
    rounded: "{rounded.md}"
---

# Design System: Coil

## Overview

Coil is a personal finance app used at a desk once or twice a week: import statements, check the month, run payday. It is an **Operate** surface: familiar controls, scannable numbers, and the brand carried in precise details rather than decoration. The identity is midnight navy and champagne gold, a quiet private-bank feel. Light mode is warm ivory with navy text; dark mode is deep navy with warm off-white text. The serif is for the Coil name only.

## Colors

### Primary
- **Champagne Gold** (#d9c08e): primary buttons (with navy text), the selected nav item's tint, the logo tile in light mode. The accent is a user setting; text on it and text in it are computed for contrast (`--accent-ink`, `--accent-text`).
- **Midnight Navy** (#0f1a2e): all body text in light mode, the logo tile and ground in dark mode.

### Neutral
- **Ivory ground / surface / surface-2** (#f5f1e8 / #fffdf8 / #faf6ee): page, cards, insets.
- **Secondary text** (#4b5568) and **tertiary text** (#626876): captions and labels. Tertiary is the lightest grey allowed for text: 4.5:1 on every light surface.

### Named Rules

**The Colour Means Something Rule.** Colour is never decoration on a number or bar:
- **Green** (good / good-text): money coming in, on track, target reached.
- **Red** (bad / bad-text): over a limit, debt you're carrying, a real problem.
- **Amber** (warn / warn-text): getting close to a limit (85% or more).
- **Blue** (info / info-text, `--saved`): money saved or moved to savings and investments.
- **A category's own colour**: only to identify that category (dots, share bars, chart series).
- **Neutral** (text colours, `--spend` slate): everything that isn't a judgement, such as a mid-month net, a change in net worth, spending as a series.

**Status text uses the -text variants.** The fills (good, warn, bad, info) are for bars, dots and charts; text in those meanings uses `--good-text` and friends, which pass 4.5:1 in light mode. In dark mode both are the same.

- **Red is for debt you're carrying.** A credit card paid in full each month is spending, not debt: its balance history is neutral (`--spend`), never red.
  Why: clearing a card every month is a good habit, and showing it red reads as a warning.
  <!-- 2026-11-14: chose "Neutral when paid in full" for credit-card history bars -->

**Never colour alone.** A status colour comes with words ("over", "left", "Paid") or a sign, so it reads without colour.

## Typography

System sans for everything in the app; tabular numbers for every amount. The serif appears only in the Coil wordmark (sidebar, lock screen, settings credit).

### Hierarchy
- **Headline** (700, 24px, -0.02em): page titles.
- **Figure** (700, 26px, -0.03em, tabular): headline amounts in stat tiles.
- **Title** (600, 15px): card titles.
- **Body** (400, 14px): rows, descriptions.
- **Label** (500, 12.5px): captions under figures, table headers, hints.

### Named Rules

- **Text that tells you something is never cut off with "…".** It wraps: up to two lines in stat tiles (`.stat-sub`), and a headline sentence (the Free to spend sentence in `.stat-hero`) wraps in full. "…" is only for names in dense lists (transactions, accounts, categories), and the full name must be in a `title` so it shows on hover.
  Why: a cut-off note hides exactly the detail you were looking for.
  <!-- 2026-11-14: "in the overview page where it says income, loan repayment - you cant fully see the text, please fix" -->

## Layout

Sidebar navigation (grouped: Everyday, Plan, Wealth, Set up), content in a grid of cards with an 18px gap.

### Named Rules

- **The Line-Up Rule. Cards side by side always end level, and so do columns inside a card.** When one card, column or group is longer than its neighbours, it pages (`usePaged`) at a size that matches them; beside a fixed-height card it fills the card and then pages (`.fit-row` + `useFitRows`). An odd card at the end of a grid spans the full row (`:last-child:nth-child(odd) { grid-column: 1 / -1 }`). Never leave empty space under a shorter card or column, however much data the user adds. The one exception: a short reference card beside a long list the user works through (the Transactions summary, Income categories) stays in view as you scroll (`position: sticky`) instead of paging. A row of stat tiles shares its width between however many tiles it has.
  Why: "uniform with everything else". Gaps make the page look broken and grow as the data grows.
  <!-- 2026-11-14: "theres a huge gap between that and the thing below it… I want it to be uniform with everything else… please keep note of this when designing new pages". Repeated the same day for Reports' breakdown, Overview's This month, and Money and debt ("will the card continue to grow… wont there be more empty space") -->
- **Never a vertical scroll bar inside a card or page section.** A list shows as many rows as fit, then pages with arrows. Horizontal scrolling is fine for wide tables and tab rows on narrow screens. Enforced by `tests/design.test.ts`.
  Why: a scroll bar inside a card hides rows and fights the page's own scrolling.
  <!-- 2026-11-14: "the scroll wheel introduced in bills and income under the rest of month year section, can this be redesigned?" -->

## Elevation & Depth

Flat, tonal layering: cards are a surface tone with a 1px border and a barely-there shadow. Modals use the larger shadow. No other depth.

## Shapes

Cards 16px radius; inputs and insets 10px; buttons, badges and segmented controls are pills.

## Components

- **Buttons:** pill, 38px. Primary is gold with navy text; hover darkens the accent; secondary is surface with a strong border.
- **Focus:** a 2px ring in `--accent-text`, offset 2px, on every focusable element.
- **Progress bars:** against a limit they turn green, amber at 85%, red when over; a share uses its category colour; savings use blue.
- **Badges:** soft background of the status colour with its -text colour.
- **One control per job per page.** The top-bar Add is the page's Add (`usePageAdd`), labelled for that page ("Add bill", "New category"); there is no second Add for the same thing inside the page, and no second month picker. An Add for a different kind of thing (e.g. "Add pay in 3" on Debts) sits in its own section's heading.
  Why: two controls for one job makes you wonder whether they do different things.
  <!-- 2026-11-14: chose to fix "two month pickers on Overview" and "Add buttons duplicated on Accounts, Goals and Debts" -->

## Do's and Don'ts

- Do show a number once per screen.
- Do use the -text colour for any coloured text.
- Don't use green for "big" or red for "small": colour is a verdict, not a size.
- Don't introduce a new hex in a component; add a token here and in `styles.css`.

## Brand surfaces (1.8)

- **Navy sidebar** in both themes (`#0f1a2e` light, `#08101d` dark). It carries the `.on-navy` class, which borrows the dark-mode tokens so anything inside reads correctly. The brand mark stays on its gold tile there.
- **Navy band on Overview**: behind the greeting and the headline tiles, sized by `useNavyBand` to end 26px below them. Tiles inside use `#17243d`.
- **Category icons** are line icons. Stored emoji map to icons through `iconFor` (Icon.tsx); unmapped emoji still show as emoji. Use `CatGlyph` for inline icons, `Bubble` for tinted circles.
- **Anything that coils or fills a circle goes clockwise from the top**: the snake in the mark (tail at the top right, head leading clockwise), the pace rings, goal and progress rings.
  Why: so the snake "goes better with the ring".
  <!-- 2026-11-14: "can we redraw the app logo so the snake goes clockwise rather than counter clockwise, it goes better with the ring in the overview page" -->
- **The £ in the Coil mark is a bold sans (Inter Bold), never a serif.** The serif is only for the word "Coil".
  Why: the serif £ looked off inside the coil; a bold sans holds its shape at small sizes.
  <!-- 2026-11-13: "the £ sign looks weird" → "bold sans is the best" -->
- **Pace rings** are Coil's signature: outer gold ring = time through the pay cycle, inner ring = share of spending money used, with the snake's head at its tip. Inner is green while behind time, amber when 10+ points ahead, red when over. Shown in the Overview hero tile and at the top of Payday. Don't use them for anything else.

## Motion (1.10)

Coil is used every day, so most things don't move. Motion has to have a purpose: feedback, showing where something came from, or bridging a change that would otherwise jump.

- Easing: `--ease-out` (cubic-bezier(0.23, 1, 0.32, 1)) for anything entering or changing; `--ease-in-out` for things travelling across the screen. Never `ease-in`, never `transition: all`.
- Durations: presses 120ms, value changes 250ms, dialogs 200ms, accordions 220ms. Nothing in the app over 300ms except the pace-ring draw-in (650ms, once per launch).
- Never animate: page switches, month and pager arrows, charts, numbers, list rows, or anything opened from a keyboard shortcut (`kbd-open` makes those dialogs instant).
- Hover effects are colour only and sit behind `@media (hover: hover) and (pointer: fine)`.
- Reduce motion turns everything off (system setting and Settings → Appearance).

## Privacy

- **Anything Coil shows outside its own window hides amounts unless the user turns them on**: notifications, the tray or menu bar, and anything added later (widgets, badges). Show what happened ("A bill is due tomorrow"), not how much.
  Why: notifications can be seen by people near the screen or on a locked screen.
  <!-- 2026-11-13: "hide amounts by default yes" (notifications) -->

## Interaction

- **Coil finds, the user confirms.** Wherever Coil can work something out from transactions (bills, subscriptions, salary, debts, goals, categories), it suggests it with one-click Add, Edit first, and a way to dismiss for good, rather than asking the user to type it in. A manual form is the fallback, not the start.
  Why: "Instead of me manually adding them, they should show up."
  <!-- 2026-11-14: "let expenses categorised as subscriptions or bills, basically anything recurring, including salary . have an option to add it in the bills and income page. Instead of me manually adding them, they should show up". Confirmed to apply everywhere. -->
