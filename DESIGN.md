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
- **Red** (bad / bad-text): over a limit, money owed, a real problem.
- **Amber** (warn / warn-text): getting close to a limit (85% or more).
- **Blue** (info / info-text, `--saved`): money saved or moved to savings and investments.
- **A category's own colour**: only to identify that category (dots, share bars, chart series).
- **Neutral** (text colours, `--spend` slate): everything that isn't a judgement, such as a mid-month net, a change in net worth, spending as a series.

**Status text uses the -text variants.** The fills (good, warn, bad, info) are for bars, dots and charts; text in those meanings uses `--good-text` and friends, which pass 4.5:1 in light mode. In dark mode both are the same.

**Never colour alone.** A status colour comes with words ("over", "left", "Paid") or a sign, so it reads without colour.

## Typography

System sans for everything in the app; tabular numbers for every amount. The serif appears only in the Coil wordmark (sidebar, lock screen, settings credit).

### Hierarchy
- **Headline** (700, 24px, -0.02em): page titles.
- **Figure** (700, 26px, -0.03em, tabular): headline amounts in stat tiles.
- **Title** (600, 15px): card titles.
- **Body** (400, 14px): rows, descriptions.
- **Label** (500, 12.5px): captions under figures, table headers, hints.

## Layout

Sidebar navigation (grouped: Everyday, Plan, Wealth, Set up), content in a grid of cards with an 18px gap.

### Named Rules

**The Line-Up Rule.** Cards side by side end level. No card grows the row without limit: a list that can get long pages (`usePaged`) or fills its card and pages (`.fit-row` + `useFitRows`). Never leave a short card next to a tall one with empty page below it.

## Elevation & Depth

Flat, tonal layering: cards are a surface tone with a 1px border and a barely-there shadow. Modals use the larger shadow. No other depth.

## Shapes

Cards 16px radius; inputs and insets 10px; buttons, badges and segmented controls are pills.

## Components

- **Buttons:** pill, 38px. Primary is gold with navy text; hover darkens the accent; secondary is surface with a strong border.
- **Focus:** a 2px ring in `--accent-text`, offset 2px, on every focusable element.
- **Progress bars:** against a limit they turn green, amber at 85%, red when over; a share uses its category colour; savings use blue.
- **Badges:** soft background of the status colour with its -text colour.

## Do's and Don'ts

- Do show a number once per screen.
- Do use the -text colour for any coloured text.
- Don't use green for "big" or red for "small": colour is a verdict, not a size.
- Don't introduce a new hex in a component; add a token here and in `styles.css`.
