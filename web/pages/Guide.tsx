import React from 'react';
import { Card } from '../components/ui.tsx';
import { Icon } from '../components/Icon.tsx';
import { navigate } from '../router.ts';

/** A link to another page of the app, used inside the guide. */
function Go({ to, children }: { to: string; children: React.ReactNode }) {
  return <button className="link-btn guide-go" onClick={() => navigate(to)}>{children}</button>;
}

const SETUP: { title: string; to: string; where: string; body: React.ReactNode }[] = [
  {
    title: 'Add your accounts', to: '/accounts', where: 'Accounts',
    body: <>Add every current account, savings account, credit card and loan. Give each its balance on a date you know: Coil works forward from that number, so later imports keep it right. Pots or spaces (a Starling space, say) can belong to their main account. Mark your Stocks & Shares ISA as an investment.</>,
  },
  {
    title: 'Import your transactions', to: '/import', where: 'Import',
    body: <>Download a CSV from your bank's website and drop it on Import, choosing the account it came from. Lloyds, Amex, Chase and Starling layouts are recognised on their own; for any other bank you match the columns once. Coil spots rows you've already imported, and matches transfers between your own accounts so they aren't counted as spending.</>,
  },
  {
    title: 'Check your categories', to: '/categories', where: 'Categories',
    body: <>Look through the spending and income categories and rename, add or remove what you like. Mark rent, bills and subscriptions as <strong>Fixed</strong>: they're kept apart from day-to-day spending in Reports and Budgets. Under <em>Auto-categorise rules</em>, teach Coil which shop goes where; it also learns from the categories you pick when you import.</>,
  },
  {
    title: 'Set up bills and income', to: '/bills', where: 'Bills and income',
    body: <>Add your salary, bills, subscriptions and regular savings with how often they happen. Coil suggests the ones it finds in your transactions, so you can usually just press Add. This is what powers "free to spend", the calendar and bill reminders.</>,
  },
  {
    title: 'Set budgets', to: '/budgets', where: 'Budgets',
    body: <>Give the things you spend on day to day a monthly limit: groceries, eating out, shopping. Coil can recommend limits from your pay and what you usually spend. You'll see what's left and get a warning as you get close.</>,
  },
  {
    title: 'Add your goals and debts', to: '/goals', where: 'Goals and Debts',
    body: <>Goals track saving towards something (an emergency fund, a holiday), linked to the account the money is in. Debts shows cards, Pay in 3 and loans, with a payoff plan and the month you'll be debt-free.</>,
  },
  {
    title: 'Connect Trading 212 (optional)', to: '/settings?tab=trading212', where: 'Settings → Trading 212',
    body: <>In Trading 212, create an API key with read permissions and paste the key and secret here. Coil only ever reads: it never places, changes or cancels orders. Your holdings, returns and ISA allowance then appear under Investing, synced every 6 hours.</>,
  },
  {
    title: 'Make it yours', to: '/settings', where: 'Settings',
    body: <>Pick a theme and colour, turn on a passcode, and choose which notifications you want (bills due, payday, your week, budgets). Amounts stay hidden in notifications unless you turn them on.</>,
  },
];

const PAGES: { name: string; to: string; icon: string; what: string; tips: string[] }[] = [
  { name: 'Overview', to: '/', icon: 'dashboard', what: 'Your month at a glance: what\'s free to spend, where the money went, every account, goals, budgets and what\'s coming up.',
    tips: ['Free to spend is your pay, minus bills, savings, debt repayments and what you\'ve spent so far.',
      'The pace rings: the outer ring is how far you are to payday, the inner ring is how much of your spending money has gone. Inner behind outer means you\'re fine; amber means you\'re spending faster than time is passing.',
      'Use the arrows by the month to look back at earlier months.'] },
  { name: 'Reports', to: '/reports', icon: 'chart-pie', what: 'Look back and spot patterns.',
    tips: ['This week: your week so far against a typical week, split into fixed costs (bills) and day-to-day spending.',
      'Spending: where it went, where you could cut back, your habits, and how often you keep to each budget.',
      'Cash flow, Compare and Net worth: money in against money out, one period against another, and what you own minus what you owe over time.',
      'Year in review sums up a whole year.'] },
  { name: 'Transactions', to: '/transactions', icon: 'list', what: 'Every transaction, searchable and filterable.',
    tips: ['Press / to search and N to add one by hand.', 'Click a transaction to change its category, split it across categories, or turn it into a transfer.',
      'Tick several to change them all at once.'] },
  { name: 'Bills and income', to: '/bills', icon: 'calendar', what: 'Everything that repeats: salary, bills, subscriptions and regular savings, with a calendar of the month.',
    tips: ['Not tracked yet lists regular payments found in your transactions. Add, Edit first, or Not regular to hide one for good.',
      'Variable bills (energy, say) use a typical amount until the real one arrives.'] },
  { name: 'Import', to: '/import', icon: 'upload', what: 'Bring in bank statements as CSV files.',
    tips: ['Import every week or two so Overview and reminders stay accurate.', 'Rows needing a look (possible duplicates, unmatched transfers, no category) are flagged before you save.',
      'Show recent imports lists what you brought in, and lets you undo an import.'] },
  { name: 'Payday', to: '/payday', icon: 'cash', what: 'A short routine for the day you\'re paid.',
    tips: ['Check your pay, close last month, give every pound a job, move the money, set this month\'s budgets, then finish.',
      'Add your own steps for anything else you do each payday.', 'Finished paydays are saved so you can look back.'] },
  { name: 'Budgets', to: '/budgets', icon: 'wallet', what: 'Monthly (or weekly, or yearly) limits for day-to-day spending, and the 50/30/20 split of needs, wants and savings.',
    tips: ['Amber means you\'re past 85% of a budget, red means you\'re over.', 'Spending that no budget covers is shown so nothing slips through.'] },
  { name: 'Goals', to: '/goals', icon: 'gift', what: 'Saving towards something, with progress and milestones.',
    tips: ['Link a goal to the account the money sits in and it updates itself.', 'Give a goal a target and a date to see how much a month you need, or how soon you\'ll get there at your current pace.'] },
  { name: 'Can I afford it?', to: '/afford', icon: 'scale', what: 'Try a purchase before you buy it: pay outright, pay later, spread it, put it on a card, or save first, against your real figures.',
    tips: ['Enter the price and Coil works out each way to pay, day by day, with your pay, bills, debts, saving and normal spending on their real dates.',
      'Each way gets a result (comfortably affordable, with adjustments, stretching, or not affordable) and the reasons, plus what would make it work.',
      "Your emergency fund, goal money and investments aren't counted as spare. You can count them for one simulation under What this is based on, and change any other figure there too.",
      "Nothing changes until you press I've bought it (or Save for this). Then the debt, repayments or goal are added for you, and the simulation is kept."] },
  { name: 'Accounts', to: '/accounts', icon: 'wallet', what: 'Every account, its balance and its history.',
    tips: ['If a balance looks wrong, open the account and set the balance on a date from your bank statement.'] },
  { name: 'Investing', to: '/investing', icon: 'trending-up', what: 'Your Trading 212 ISA: holdings, value over time, returns and ISA allowance.',
    tips: ['Needs the Trading 212 key in Settings.', 'Deposits are matched to the bank transfers that paid them in.'] },
  { name: 'Debts', to: '/debts', icon: 'percentage', what: 'Credit cards, Pay in 3 and loans in one place.',
    tips: ['The payoff plan shows which to clear first and when you\'ll be debt-free.', 'Cards you clear in full each month aren\'t counted as debt you\'re paying off.'] },
  { name: 'Categories', to: '/categories', icon: 'tag', what: 'The categories and subcategories your money is sorted into, and the rules that sort it.',
    tips: ['Drag to reorder: the order is used in every picker.', 'Mark income that sometimes arrives a few days early as "counts next month if paid late".'] },
  { name: 'Settings', to: '/settings', icon: 'settings', what: 'Profile, appearance, privacy, passcode, notifications, budgeting months, Trading 212, data and updates.',
    tips: ['Data has health checks, a Back up now button and restore. A backup is taken automatically every day and the last 30 are kept.', 'Turn on Keep a copy off this computer to put each backup in iCloud Drive (or a folder of your choice) as well.', 'Press H anywhere to hide or show amounts.'] },
];

const FAQ: { q: string; a: React.ReactNode }[] = [
  { q: 'What does "day-to-day spending" mean?', a: <>Everything you spend except fixed costs: the categories marked Fixed, such as rent, bills and subscriptions. It's the part you can change week to week, so Reports and Budgets look at it on its own. Change what counts as fixed under <Go to="/categories">Categories</Go>.</> },
  { q: 'Why does my salary count towards next month?', a: <>You're paid on the last working day, so pay that lands in the last few days of a month funds the next one: October's payday pays for November. You can change this under <Go to="/settings?tab=budgeting">Settings → Budgeting</Go>.</> },
  { q: 'A balance is wrong. What do I do?', a: <>Usually a statement is missing. Import it, or open the account under <Go to="/accounts">Accounts</Go> and set the balance on a date from your bank statement.</> },
  { q: 'How often should I import?', a: <>Every week or two is plenty. Before payday is a good habit, so the Payday steps see the whole month.</> },
  { q: 'Where is my data?', a: <>In one file on this computer, never online. See <Go to="/settings?tab=data">Settings → Data</Go> for where it is, backups and export. If you turn it on there, a copy of each backup also goes to iCloud Drive or a folder you choose.</> },
  { q: 'How do updates work?', a: <>Coil checks for new versions and shows Restart to update when one is ready. <Go to="/settings?tab=whatsnew">What's new</Go> lists every change.</> },
];

export function Guide() {
  return (
    <div className="guide">
      <Card title="Set up Coil, step by step">
        <ol className="guide-steps">
          {SETUP.map((s, i) => (
            <li key={s.title}>
              <span className="guide-num">{i + 1}</span>
              <div>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
                <Go to={s.to}>Open {s.where} <Icon name="chevron-right" size={14} /></Go>
              </div>
            </li>
          ))}
        </ol>
      </Card>

      <Card title="Every page">
        <div className="guide-pages">
          {PAGES.map((p) => (
            <details key={p.name} className="guide-page">
              <summary><Icon name={p.icon} size={17} /><strong>{p.name}</strong><span className="muted">{p.what}</span><Icon name="chevron-down" size={16} className="guide-chev" /></summary>
              <ul>{p.tips.map((t) => <li key={t}>{t}</li>)}</ul>
              <Go to={p.to}>Open {p.name} <Icon name="chevron-right" size={14} /></Go>
            </details>
          ))}
        </div>
      </Card>

      <Card title="Common questions">
        <dl className="guide-faq">
          {FAQ.map((f) => <React.Fragment key={f.q}><dt>{f.q}</dt><dd>{f.a}</dd></React.Fragment>)}
        </dl>
      </Card>
    </div>
  );
}
