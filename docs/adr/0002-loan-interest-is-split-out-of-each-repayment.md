# Interest on a confirmed purchase is split out of each repayment as it's paid

Status: accepted (1.18.0)

When a purchase made with buy now pay later, instalments or a finance agreement is confirmed in Can I afford it?, the debt starts with only the amount financed. Unlike a credit card, a lender's interest never appears on a bank statement on its own: you only see the repayment. So when each repayment is paid (matched to its transaction, or marked paid), Coil records that payment's interest and fees from the agreement's schedule as spending on the debt (category Interest & Fees), the same way card interest arrives with a card statement. The debt then goes down by exactly the part that repays it, it reaches £0 with the last payment, and interest counts as spending once, in the month you actually pay it. This lives in `recordPlanInterest` (server/recurring.ts) and is keyed by repayment and due date, so matching again never adds it twice.

## Considered options

- **All the interest as spending on the day you buy.** Simpler, and shows the full cost up front, but that month looks far more expensive than it was, and the debt would start above what you borrowed. Rejected because each month's figures should match the transactions behind them.
- **Spread across the payments (chosen).**

## Consequences

- Only debts created by confirming a purchase are split this way; their schedule is stored on the purchase (`purchase_plans.schedule`).
- If you pay off early or the lender changes the schedule, the stored schedule no longer matches: change the debt's balance on Accounts.
