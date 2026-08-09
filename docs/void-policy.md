# When a season does not count

Published before season 1 opened. The thresholds below are part of the ruleset
hash recorded on chain with the season, so they cannot be changed once a season
is running without that change being visible to anyone who checks.

## Why this document exists

Something can ruin a season that nobody chose: the chain halts, the fill engine
has a bug, the process that writes records to the chain stops. With a prize pool
on the table, "we will decide at the time" means the person deciding is the
person the winner is arguing with. So the decision is made here, in advance,
by people who do not yet know who wins.

## The two rules that matter most

**A season is void or it is not.** There is no partial void, no adjusted
standings, no replay. Replaying a season is the most tempting remedy and the
worst one, because a replay's result is whatever the person running it says it
is.

**A finalized season can never be voided.** Once the results are committed on
chain the season is settled permanently, however unpopular the winner. Without
that bound, every condition below becomes a way to cancel a result somebody
dislikes after seeing it.

## The conditions

A season is void if, and only if, one of these is true. Each is a number taken
from recorded data and compared against a fixed threshold. No judgement is
applied at any point, and the full measurement is published whether it fired or
not.

| Condition | Threshold | Why |
|---|---|---|
| Price feed unavailable | more than **120 minutes** | Beyond this, results describe who could trade rather than who traded well. Not zero: public infrastructure hiccups, and a policy that voided on any interruption would void every season. |
| Chain stopped producing blocks | more than **60 minutes** | Solana has halted for hours before. That is not a season anybody traded. |
| Trades never committed on chain | more than **0** | A trade nobody can verify is the one thing this product cannot ship. |
| Trades that will not rebuild from their own inputs | more than **0** | The engine and the record disagree, and there is no way to tell which is wrong. |
| Fill engine changed mid-season | any change | Results produced under two different engines are not comparable to each other, never mind to another season. |

Anything not on this list does not void a season. A season with an unpopular
winner, a lucky winner, a single-trade winner, or one entrant stands. Those are
outcomes, not faults.

## What happens

Every entrant is refunded exactly what they paid. The house takes nothing —
voiding a season must never be a way to earn from failure. No placings are
awarded and no prize is paid.

The season is then finalized on chain with a root that means *void*, which is
distinct from the root for a season nobody entered and from the zero value that
means not yet finalized. Those three endings are different and are recorded
differently.

## What this does not cover

This policy governs seasons. It says nothing about individual trades: a trade
that filled badly because the market moved is a trade that filled correctly.
The simulator models real delay and real slippage on purpose, and losing money
to either is the product working.
