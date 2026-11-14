/** Every released version, newest first. Add the new version at the top before each release (a test checks it). */
export interface Release { version: string; date: string; changes: string[] }

export const RELEASES: Release[] = [
  {
    "version": "1.9.0",
    "date": "2026-11-14",
    "changes": [
      "Settings → What's new lists every version, what changed and when",
      "A guide to every page and how to set Coil up, step by step (Settings → Guide)",
      "Overview: the Income, Spent and Net worth notes wrap instead of being cut off",
      "Money and debt: a long list of cards and loans shows a page at a time, so the card stays the same size",
      "Reports: the Day-to-day tile says what it leaves out"
    ]
  },
  {
    "version": "1.8.1",
    "date": "2026-11-14",
    "changes": [
      "Pace rings no longer fill in solid when you're spending ahead of time",
      "Goal icons sit in the middle of their rings again",
      "This month shows as many biggest spends as fit, and Money and debt stacks short groups beside a long one"
    ]
  },
  {
    "version": "1.8.0",
    "date": "2026-11-14",
    "changes": [
      "Navy sidebar and a navy band at the top of Overview",
      "Categories now use clean line icons instead of emoji",
      "New pace rings show time to payday against spending money used, on Overview and Payday"
    ]
  },
  {
    "version": "1.7.0",
    "date": "2026-11-14",
    "changes": [
      "Bills and income lists subscriptions, bills and salary from your transactions that aren't tracked yet: add them in one click, edit first, or mark them as not regular",
      "This week explains what's in the fixed-costs total, and shows when a bill was paid at a different amount",
      "The Add button follows the page you're on: Add bill, New budget, New goal and so on",
      "Easier to use by touch and keyboard: bigger tap areas, labels for screen readers, and Reduce motion is respected"
    ]
  },
  {
    "version": "1.6.0",
    "date": "2026-11-14",
    "changes": [
      "Overview opens with one answer: what's free to spend, whether you're on track, and how much a day you have until payday",
      "Transactions shows its totals once, with a tidier toolbar",
      "Payday shows its steps once, with progress above them",
      "Shop and bank names show in normal case instead of capitals",
      "The savings-rate chart no longer spikes in months with almost no income"
    ]
  },
  {
    "version": "1.5.0",
    "date": "2026-11-14",
    "changes": [
      "Easier to read in light mode: grey captions and green, amber, red and blue amounts are darker",
      "Colour now means one thing everywhere: green is money in or on track, red is over a limit or owed, amber is getting close, blue is saved",
      "Category bars use each category's own colour, and normal mid-month figures are no longer red",
      "A clear focus ring when you use the keyboard",
      "Gold buttons no longer flash coral when you hover"
    ]
  },
  {
    "version": "1.4.3",
    "date": "2026-11-14",
    "changes": [
      "Reports: the breakdown fills its space down to the bottom of Top places, with arrows only when there's more",
      "Bills and income: no more scroll bar in the rest of the month. It shows as many as fit beside the calendar, with arrows for the rest"
    ]
  },
  {
    "version": "1.4.2",
    "date": "2026-11-14",
    "changes": [
      "Bills and income: a tidier layout. The rest of the month sits next to the calendar and scrolls inside, and This month runs across the page",
      "Cards side by side now line up on every page, with no gaps",
      "Import: recent imports are hidden until you click Show recent imports, 8 at a time"
    ]
  },
  {
    "version": "1.4.1",
    "date": "2026-11-14",
    "changes": [
      "Budgets: the Needs, Wants and Savings bars show again",
      "Reports: the breakdown shows 10 categories at a time, with arrows for the rest",
      "Settings: the app is always called Coil, and Settings says who made it",
      "Windows: if Windows blocks an update, Coil stays open and explains what to do"
    ]
  },
  {
    "version": "1.4.0",
    "date": "2026-11-13",
    "changes": [
      "Ledger is now Coil: a new icon, a mamba coiled round a £",
      "Navy and champagne gold, for light and dark mode",
      "Your data, passcode and settings carry over. A colour or name you chose yourself is kept",
      "On a Mac the app is renamed to Coil in Applications the first time it opens",
      "You may need to add your Trading 212 key again (Settings → Trading 212)"
    ]
  },
  {
    "version": "1.3.0",
    "date": "2026-11-13",
    "changes": [
      "Notifications for bills due, payday, your week, budgets and imports (Settings → Notifications)",
      "Amounts are hidden in notifications unless you turn them on",
      "Quiet hours, 10pm to 8am by default",
      "Open at login, in the background",
      "Windows: closing the window keeps Ledger running by the clock while notifications are on"
    ]
  },
  {
    "version": "1.2.1",
    "date": "2026-11-13",
    "changes": [
      "Check for Updates… in the app menu (Ledger menu on a Mac, Help on Windows)",
      "Settings… opens with ⌘, on a Mac"
    ]
  },
  {
    "version": "1.2.0",
    "date": "2026-11-13",
    "changes": [
      "Ledger now updates itself: when a new version is out you get a Restart to update banner (Settings → About & updates to check by hand or turn automatic checks off)",
      "The passcode lock can lock the app after no use: 15 minutes by default, up to 1 hour 30, or never"
    ]
  },
  {
    "version": "1.1.0",
    "date": "2026-11-13",
    "changes": [
      "Desktop app builds for Mac (Apple Silicon and Intel) and Windows"
    ]
  },
  {
    "version": "1.0.0",
    "date": "2026-11-13",
    "changes": [
      "The first desktop app for Mac and Windows"
    ]
  }
];
