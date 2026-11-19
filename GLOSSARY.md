# Coil

A personal finance app for one person: their accounts, bills, budgets, goals, debts and investments, planned around a monthly payday.

## Investments

**Money put in**:
What the person has put into an investment account themselves: deposits and transfers in, less withdrawals. Interest, dividends and fees are never part of it.
_Avoid_: Paid in (reserved for ISA allowance use within a tax year), contributed, deposited, invested

**Contributions**:
The record of money moving into and out of an investment account by the person's own hand, from which Money put in is worked out. Trading 212's cash history is the source whenever the account is linked to Trading 212 and has any; otherwise the matched bank transfers are.
_Avoid_: Deposits, flows, cash history

**Paid in**:
Money put into an ISA within one tax year, as counted against the ISA allowance.
_Avoid_: Money put in (that is all-time, not per tax year), subscriptions

**Earlier-year transfer**:
An ISA transferred in from another provider that holds money paid in during earlier tax years. It is Money put in, but not Paid in for this tax year.
_Avoid_: ISA transfer (too broad), carried-in subscriptions

## Pay

**Your pay**:
The person's biggest active monthly income in Bills and income. Paydays, the pay cycle and the funded month all follow it.
_Avoid_: Salary (fine in conversation, but not every pay is a salary), income (too broad: bonuses and interest are income too)

**Payday**:
The date your pay lands: the last working day of the month (bank holidays included) or a fixed day of the month.
_Avoid_: Cycle (in the code this used to mean the payday date), pay date

**Pay cycle**:
The stretch from one payday to the next. The pace rings measure time through it.
_Avoid_: Cycle on its own, pay period

**Funded month**:
The month a payday pays for. Pay that lands in the last few days of a month (Settings → Budgeting, 5 by default) funds the next month; otherwise it funds the month it lands in.
_Avoid_: Period (in the code this is the funded month), budget month

## Plan

**Plan**:
What a funded month's money is committed to: bills and subscriptions, savings and debt repayments, with what's done and what's left of each. Every screen reads the same Plan for the same month.
_Avoid_: Budget (budgets are limits on everyday spending), schedule

**Committed**:
Bills and subscriptions plus savings plus debt repayments in a Plan, counting only your share of shared bills.
_Avoid_: Fixed costs (that's a category marking), outgoings

**Saved**:
New money moved into a savings or investment account from an everyday account (current account, cash or card), less any moved back out to one. Moving between two savings or investment accounts is not saving.
_Avoid_: Moved (any transfer), deposited

**Free to spend**:
What's left of a month's income after what's committed and what's already been spent day to day.
_Avoid_: Left over, disposable income, buffer

**Buffer**:
What's left of your pay after the Payday plan gives every pound a job: committed money plus budgets.
_Avoid_: Free to spend (that's after actual spending, not budgets), spare

## Can I afford it?

**Simulation**:
A purchase you're trying out, with the ways you might pay for it. Only inputs: saving, changing or deleting one never changes your money.
_Avoid_: Scenario, plan (Plan is the This month card)

**Available money**:
What a simulation can spend: current accounts, plus savings less goal money and the emergency fund. Investments are left out. You can count more for one simulation.
_Avoid_: Balance, disposable income, spare cash

**Way to pay**:
One option in a simulation: pay outright, buy now pay later, instalments, a finance agreement, a credit card, or save first.
_Avoid_: Payment method, plan

**Interest-free (0%) finance**:
Regulated credit with no interest (a credit agreement). Different from **Buy now, pay later** (short, unregulated, interest-free split payments such as Pay in 3) and **Interest-bearing credit** (an APR above 0%).

**Result**:
A simulation's verdict on a way to pay: Comfortably affordable, Affordable with adjustments, Financially stretching, or Not currently affordable.
_Avoid_: Score, rating

**Free to spend minimum**:
How much Free to spend a month must keep for a purchase to count as comfortable: 10% of that month's income unless you change it.
_Avoid_: Buffer (that's the Payday plan's leftover)
