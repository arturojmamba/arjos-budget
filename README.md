# arjos-budget

A local-first personal finance app. It runs on your own computer, keeps everything in one SQLite file and talks to nothing except (optionally) Trading 212 for read-only investment data. There's no account to sign up for, no cloud and no tracking.

Built for UK banking: pay arrives on the last working day of the month and funds the month after, England & Wales bank holidays are built in, and the ISA tax year runs 6 April to 5 April.

## Features

**Everyday**
- **Transactions:** a double-entry ledger underneath, so transfers between your own accounts are never counted as spending or income. Search, filters, notes and CSV export.
- **Import:** CSV import with presets for Lloyds, Amex, Chase and Starling (others can be mapped by hand), plus duplicate detection, transfer matching and auto-categorise rules. Rules are suggested from your history and can be tested before saving. With no rule or history yet, a built-in list of about 600 UK merchants and tell-tale words suggests a category (McDonald's → Eating Out, TfL → Transport, Zara → Clothing or Shopping), using your own category names where they exist. It runs offline.
- **Bills and income:** bills, subscriptions, regular savings and expected income. Payments are matched automatically, with price-rise alerts and shared bills (people who pay you back for their part).

**Planning**
- **Payday:** a six-step routine for when pay lands: check the pay, cover the bills, set budgets, move money to goals and debts, keep a buffer, and add your own steps. Moves tick themselves off on the next import.
- **Budgets:** weekly, monthly or yearly, across one or more categories, as fixed amounts or a percentage of take-home pay. Includes pace, rollover, warnings, suggestions from your spending and a 50/30/20 view.
- **Goals:** savings goals in any account or pot, an emergency-fund view (months of essentials covered) and monthly targets.

**Wealth**
- **Accounts:** current accounts, credit cards, savings, pots and investments, plus the ISA allowance at a glance.
- **Investing:** Trading 212 sync covering holdings, pies, orders, dividends and value history, organised in three tabs:
  - **Performance:** a money-weighted return, where the return came from (holdings, sales, dividends, currency), fees, and results by pie and by holding, sold ones included.
  - **ISA allowance:** flexible-ISA rules (withdrawals can go back in without using allowance), the amount per month needed to fill it, and each deposit matched to the bank transfer that paid for it, with money moved from savings labelled as such.
- **Debts:** APR, promotional rates, card-style or fixed minimums, payoff dates and interest, with snowball vs avalanche.
- **Reports:** interactive charts with hover, drill-down and toggles, covering spending trends, where the money went, income vs outgoings, and a year in review.

**Housekeeping**
- **Data health:** stale imports, uncategorised transactions, likely duplicates and overdue bills.
- **Backups:** daily backups, a backup before every upgrade, plus downloadable backups and restore.
- **Settings:** personalisation, a hide-amounts switch, light and dark themes, and keyboard shortcuts.

## Desktop app (Mac and Windows)

The same app as a normal desktop app: no Node, npm or Terminal needed.

**Download:** Mac (`Ledger-…-mac-arm64.dmg` for Apple Silicon, `…-x64.dmg` for Intel) or Windows (`Ledger-Setup-….exe`), from the repository's Releases page or as a file shared with you.

**First open.** The app isn't signed with a paid Apple or Microsoft certificate, so the system warns you once:
- **Mac:** open the .dmg and drag Ledger to Applications. Open it once; when macOS says it can't check it, go to System Settings → Privacy & Security, scroll down, and click **Open Anyway**. If it says the app is "damaged", run `xattr -dr com.apple.quarantine /Applications/Ledger.app` in Terminal once.
- **Windows:** if SmartScreen says "Windows protected your PC", click **More info → Run anyway**.

**Your data** lives in the system's app-data folder (Mac: `~/Library/Application Support/Ledger/data`, Windows: `%APPDATA%\Ledger\data`), with daily backups in its `backups` folder. On first launch you can start fresh or bring in an existing database (for example `data/finance.db` from running it with `npm start`). Settings → Data → *Show in Finder/Explorer* opens the folder.

**Trading 212:** add the API key in Settings → Trading 212. It's encrypted with the system keychain and kept in the app-data folder, never in the database or backups.

On a Mac, closing the window keeps the app running (so syncing carries on); quit with ⌘Q.

**Building it yourself:**
```bash
npm install
npm run desktop        # run it from source in a window
npm run desktop:mac    # → release/Ledger-<version>-mac-<arch>.dmg (needs a Mac)
npm run desktop:win    # → release/Ledger-Setup-<version>.exe (needs Windows)
```
GitHub builds both automatically: run **Actions → Desktop app → Run workflow**, or push a version tag (`git tag v1.0.1 && git push --tags`) to attach the installers to a release. Each build checks the packaged app starts before it's published.

## Run it from source

Requires Node 22.13 or newer (Node 24 recommended).

```bash
npm install
npm start            # builds the UI and serves it on http://localhost:4545
```

The server listens on `127.0.0.1` only, so nothing else on your network can reach it. Change the port with `PORT=5000 npm start`.

For development:

```bash
npm run dev          # rebuilds the UI and restarts the server on change
npm test             # financial-rule, importer and sync tests
npm run typecheck
npm run backup       # one-off backup
```

## Demo data

To try the app or take screenshots without your own data, build a demo database full of made-up data: a fictional person, employer, banks, shops and funds, with a year of transactions, bills, budgets, goals, a loan and a Trading 212 ISA.

```bash
npm run demo         # writes data/demo.db (your own data/finance.db is not touched)
npm run start:demo   # serves it on http://localhost:4546, with Trading 212 shown as connected but not syncing
```

Set `T212_SYNC=off` to pause automatic Trading 212 syncing in general.

## Trading 212 (optional)

Copy `.env.example` to `.env` and add an API key from Trading 212 (Settings → API):

```bash
cp .env.example .env
```

Give the key **read-only permissions** (account data, portfolio, history). The app only ever sends `GET` requests and contains no code that places, edits or cancels orders. It syncs on start, every 6 hours, and when you press *Sync now*. If a sync fails, the last known data is kept.

`.env` is git-ignored. Keys are never stored in the database or shown in the UI.

## Your data

| What | Where |
|---|---|
| Database | `data/finance.db` (override with `FINANCE_DB`) |
| Backups | `data/backups/`, daily (last 30 kept) and before every upgrade or restore (override with `FINANCE_BACKUPS`) |
| Secrets | `.env` |

`data/`, `.env` and all `*.db` files are git-ignored, so none of your financial data or keys can end up in the repository.

## How the money is counted

- Amounts are stored as whole pence; no floating-point money.
- Every transaction is a set of postings that sum to zero. A transfer is one posting out and one in, so it never shows as spending.
- **Saved** counts transfers from an everyday account into savings, pots or investments. Moving money between two savings accounts isn't counted twice.
- **Periods:** pay on the last working day funds the next month, so budgets and reports follow pay cycles rather than calendar months.
- **Investment growth** is the difference between an account's value and what was paid in. It's never counted as income.

## Project layout

```
server/
  index.ts         `npm start`: .env loading, then start.ts
  start.ts         startup shared with the desktop app: restore, backups, scheduled sync, server
  db.ts            schema + migrations (node:sqlite, no native dependencies)
  ledger.ts        transaction rules and validation
  queries.ts       balances, lists, monthly summary
  importers/       CSV parser, bank presets, matching, categorisation
  recurring.ts     bills, subscriptions, savings, income, monthly plan
  shares.ts        shared bills and pay-backs
  payday.ts        payday routine
  budgets.ts       budgets, rollover, pace, suggestions
  goals.ts         savings goals
  debts.ts         debts and payoff simulation
  investments.ts   valuations, tax year helpers
  t212.ts          Trading 212 sync (read-only)
  investing.ts     holdings, pies, activity
  performance.ts   returns (XIRR, Modified Dietz), breakdown, costs
  isa.ts           flexible ISA allowance and bank matching
  insights.ts      report data
  reports.ts       year in review
  health.ts        data health checks
  app.ts           JSON API
web/               React UI, bundled with esbuild
electron/          desktop app (window, menus, data folder, keychain), bundled to dist-electron/
tests/             node:test suites
scripts/           build and backup
```

## Keyboard shortcuts

Press `?` anywhere. `N` new transaction · `H` hide amounts · `/` search · `G` then a letter to jump between pages (`O` overview, `T` transactions, `P` payday, `B` budgets, `G` goals, `I` bills, `D` debts, `R` reports, `V` investing, `A` accounts, `C` categories, `M` import, `S` settings).
