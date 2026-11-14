# The This month card uses the calendar month, not the pay cycle

Status: accepted (1.16.0)

The This month card on Bills & income (income, bills, savings, debt repayments, everyday spending and Free to spend) counts the calendar month, 1st to last day. Before 1.16.0 its figures mixed three different windows (calendar month, the funded pay cycle, and a window that started a few days before payday), so no figure matched what Transactions showed for the same month and the totals couldn't be checked. We chose the calendar month so that every figure equals the total of the transactions its link opens, and agrees with Transactions, Budgets and Reports, which already use the calendar month.

## Considered options

- **A: the pay cycle (payday to payday).** It matches how pay is actually spent, but Transactions, Budgets and Reports would then disagree with this card unless all of them moved too. Rejected because figures you can't check against Transactions are worse than figures that cut the month at the 1st.
- **B: the calendar month (chosen).**

## Consequences

- Income still counts by period: pay that lands a few days early (e.g. on the 28th for next month) is "rolled" into the month it is for, as Your pay always has been (see GLOSSARY.md, Pay cycle).
- Transfers made on payday count in the calendar month they happen, so savings made on the 28th count in that month, not the next one.
- The pace rings on Overview still follow the pay cycle. They answer "how am I doing until payday?", a different question.
- Don't "fix" the card back to the pay cycle without moving Transactions, Budgets and Reports with it.
