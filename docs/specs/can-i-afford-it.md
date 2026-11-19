# Can I afford it?

Agreed on 19 Nov 2026, built in 1.18.0. Terms are in GLOSSARY.md (Can I afford it?).

## Where it lives
- A **Can I afford it?** page in the sidebar (Plan), a button on Overview, and G then F.
- "Free to spend" throughout, never "disposable income".

## The purchase
Name, price, category (existing; a link to add one), purchase date, optional notes, priority (Essential, Important, Non-essential).

## Ways to pay (compared side by side, up to 8)
1. **Pay outright.**
2. **Buy now, pay later**, with editable presets: Pay in 3 (monthly, first payment on the day), Pay in 4 (every 2 weeks, first on the day), Pay in 30 days.
3. **Instalments**: 3, 4, 6, 12, 18, 24, 36, 48 or any number of payments.
4. **Credit card** (an existing card only): added to the card's balance; available credit checked against the limit; APR and any 0% offer; repay in full at the next statement, a fixed amount a month, minimum only, or clear it before the 0% offer ends. Payments clear the highest-rate balance first. No interest while a card is cleared each month (the grace period).
5. **Finance agreement**: interest-bearing, with an optional final (balloon) payment one period after the last.
6. **Save first**: monthly amount, months to save, the date you'd have it, other amounts to compare, the most you could save and stay healthy.

Every financed option: deposit, number of payments, APR, an arrangement fee and a fee per payment, first payment date, weekly / fortnightly / monthly. Each is labelled Interest-free (0%) finance, Buy now, pay later, or Interest-bearing credit (a BNPL plan with an APR is credit). Warnings: BNPL isn't regulated like a loan; a 0% offer ending before it's paid off; a balloon you must have ready; using most of a card's credit.

Interest: an APR becomes a rate per payment as (1 + APR)^(1/payments a year) − 1. Equal (annuity) payments; interest-free plans split equally with the odd pennies on the first payment, as Klarna and PayPal do.

## Forecast (server/afford.ts)
- Day by day from today's balances to the end of the longest option (at least 3 months, at most 5 years), with and without the purchase. Every option uses the same horizon so they compare fairly.
- Pay, bills and subscriptions (your share), loan and BNPL repayments, regular saving and investing, and goals' monthly amounts (the day after the pay that funds the month), all on their real dates.
- Day-to-day spending spread evenly from the average of the last three full months, with bills that weren't linked yet left out. The share usually spent on cards leaves your account on each card's due date with what you owe today, so card spending and card repayments are never both counted.
- Monthly rows use the calendar month (income and saving by the month they're for), and this month matches the This month card (ADR 0001).

## Available money
- By default: current accounts, plus savings less goal money and the emergency fund. Investments are left out.
- Per simulation, any account can be counted, with any amount. Counting protected money is shown in the result.

## Healthy, and the four results
Healthy, every month: bills and debt payments paid on time, regular investing and goal amounts unchanged, normal spending covered, Free to spend at least 10% of income (or your own % or £), and the balance never below £0.
- **Comfortably affordable**: passes everything.
- **Affordable with adjustments**: Free to spend dips below the minimum in one or two months; Coil names the changes (spend £X less, pause a goal) with amounts.
- **Financially stretching**: only works with goal money, the emergency fund or investments, or Free to spend stays below the minimum for three months or more.
- **Not currently affordable**: the balance goes below £0 (a payment would be missed), or the way to pay can't work (over the credit limit, say).

Every result lists its reasons and checks, the assumptions behind it, and anything missing (no pay set up, an old balance, a card with no details). Missing figures are named, never guessed.

## Overrides
Pay, day-to-day spending, regular saving and investing, the Free to spend minimum (% or £), and which accounts count and how much. Only for that simulation, and marked "Changed".

## Charts
Available money day by day (with and without); Free to spend each month before and after, with the minimum; where each month's money goes; the payment schedule with what's left after each payment; what each way costs (price, interest, fees); the effect on your goals.

## Saved simulations (purchase_plans)
Save, edit, compare (each planned one is worked out again against today's figures), drop, plan again and delete. A simulation is only inputs and never changes your money.

## Confirming ("I've bought it" / "Save for this")
The purchase counts once, as spending on the day you buy it.
- **Outright**: a one-off expected payment in Bills and income, matched when the import brings the real transaction in.
- **BNPL, instalments, finance**: a debt (a Pay in 3 debt for Pay in 3/4) starting at £0, the financed part recorded once as spending against it, repayments in Bills and income ending after the last one, a one-off deposit and arrangement fee, and a one-off balloon. Interest and fees are split out of each repayment as it's paid (ADR 0002).
- **Credit card**: a one-off expected payment on the card; extra repayments until it's paid off, unless the card is paid in full each month anyway. Card interest arrives with the statement import.
- **Save first**: a goal with the target, monthly amount and date, linked to the simulation.
The simulation is kept, marked bought, and can't be changed. Deleting it never removes what it created.

## Data
One table, `purchase_plans` (v17), and an optional `credit_limit` on card debt details.
