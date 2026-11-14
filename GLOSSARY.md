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

**Free to spend**:
What's left of a month's income after what's committed and what's already been spent day to day.
_Avoid_: Left over, disposable income, buffer

**Buffer**:
What's left of your pay after the Payday plan gives every pound a job: committed money plus budgets.
_Avoid_: Free to spend (that's after actual spending, not budgets), spare
