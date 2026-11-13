# Ledger

A personal finance app that runs on your own computer. Your data stays in one file on your machine: no account, no cloud, no tracking.

Made for UK banking: pay on the last working day funds the next month, bank holidays are built in, and the ISA year runs April to April.

## What it does

- **Import bank statements** (Lloyds, Amex, Chase, Starling, or any CSV) and categorise them automatically
- **Track bills and income**, with price-rise alerts and shared bills
- **Plan payday:** cover bills, set budgets, move money to goals
- **Budgets, savings goals and debts**, with payoff plans
- **Investing** via Trading 212 (read-only): returns, fees and your ISA allowance
- **Reports:** where the money went, week by week or year by year
- **Notifications** for bills due, payday, your week and budgets, with amounts hidden unless you turn them on
- **Passcode lock**, with Touch ID on Mac

## Get the app

Download the latest version from the [Releases page](https://github.com/arturojmamba/arjos-budget/releases/latest):

| You have | Download |
|---|---|
| Mac with Apple chip (M1 or later) | `Ledger-…-mac-arm64.dmg` |
| Older Intel Mac | `Ledger-…-mac-x64.dmg` |
| Windows | `Ledger-Setup-….exe` |

**First open.** The app isn't paid-signed, so your computer warns you once:

- **Mac:** drag Ledger into Applications and open it. When macOS blocks it, go to System Settings → Privacy & Security and click **Open Anyway**.
- **Windows:** on "Windows protected your PC", click **More info → Run anyway**.

**Updates are automatic.** When a new version is out, a banner says **Restart to update**. Click it and you're done. Your data is backed up first and never touched.

## Your data

- Everything is saved on your computer, with a backup every day.
  - Mac: `~/Library/Application Support/Ledger/data`
  - Windows: `%APPDATA%\Ledger\data`
- Settings → Data opens that folder, and lets you download or restore a backup.
- Your Trading 212 key is encrypted with the system keychain and never saved in the data file.
- **Forgot your passcode?** Quit the app and delete `lock.json` in the data folder.

## Trading 212 (optional)

In Trading 212, go to Settings → API and create a key with **read-only** permissions. Paste it into Ledger under Settings → Trading 212.

Ledger only reads your account. It has no code that can place or cancel orders.

---

## For developers

### Run from source

Needs Node 22.13 or newer.

```bash
npm install
npm start          # http://localhost:4545
```

For Trading 212, copy `.env.example` to `.env` and add your key there. Your data goes in `data/`. Both are git-ignored.

### Useful commands

```bash
npm run dev        # rebuild and restart on change
npm test           # run the tests
npm run demo       # make a database of made-up data
npm run start:demo # open it on http://localhost:4546
npm run desktop    # run the desktop app from source
```

### Releasing a new version

1. Bump `version` in `package.json` and push.
2. On GitHub, go to **Actions → Desktop app → Run workflow**. Enter the version (for example `v1.3.0`) and, optionally, notes separated by `;`.

It runs the tests, builds the Mac and Windows apps, checks they start, and publishes the release. Then it checks that the previous version updates itself to the new one.

### How the money is counted

- Amounts are whole pence, never decimals.
- Every transaction balances to zero, so moving money between your own accounts is never counted as spending.
- Budgets and reports follow pay cycles, not calendar months.
- Investment growth is never counted as income.

### Where things are

| Folder | What's in it |
|---|---|
| `server/` | the database, money rules, importers, Trading 212 sync and API |
| `web/` | the React interface |
| `electron/` | the desktop app: window, menus, keychain and updates |
| `tests/` | tests, using made-up data only |
| `scripts/` | build, backup and demo data |

Press `?` in the app to see the keyboard shortcuts.
