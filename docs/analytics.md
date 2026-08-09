# What is measured, and what is not

## What is collected

One row per wallet per day:

| Column | Meaning |
|---|---|
| `user_pubkey` | The wallet address |
| `day` | The UTC day, as a whole number |
| `traded` | Whether they placed a trade that day |

That is the entire product analytics.

## What is not collected

No IP addresses. No user agents. No page views. No referrers. No device
fingerprints. No session recordings. No cookies beyond the sign-in session
itself. No third-party script of any kind.

There is no analytics vendor, and that is a decision rather than an omission.
A hosted analytics account is an account — an email, a payment method, and a
company that knows who runs this. Adding one would trade away the anonymity
this project is built with, in exchange for numbers that a single table already
answers.

A wallet address is public by construction; it sits on chain beside every trade
this product commits. A date is the coarsest unit that can answer whether
somebody came back. Storing a timestamp instead would let this table describe
habits, which is more than it needs to know.

A test asserts the table has exactly those three columns, so adding a fourth
fails the suite and somebody has to decide to do it on purpose.

## Reading the numbers

    DATABASE_URL=<url> npx tsx scripts/retention.mts

Reports cohorts by joining day, with return rates at day 1, 2, 3 and 7, plus
activation — the share of wallets that ever placed a trade.

A cohort too young to have reached a day reports `—`, never `0%`. A cohort that
joined yesterday has not failed to return on day 7; it has not reached day 7,
and averaging it in would drag the number toward zero and call it churn.

The day-7 figure states how many cohorts it rests on, because a retention number
computed from one day of arrivals is a fact about that day and will be quoted as
though it were a fact about the product.

## Not a dashboard

Deliberately a script, not an endpoint. A page would need authentication, a role
and a UI — three things to get wrong — in exchange for a number that reads fine
from a terminal.
