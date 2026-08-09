# Rate limits

Every API route is limited. Limits are chosen by what a request costs us, not by
which URL it arrives at — a limit chosen per route is wrong the first time that
route changes what it does.

| Class | Allowance | Applies to |
|---|---|---|
| `read` | 120/min | Cached or database-only reads: seasons, leaderboard, candles, launches, profiles, stats |
| `trade` | 30/min | Placing a simulated trade. Reads pool state from chain and writes several rows |
| `chainRead` | 40/min | Reads that hit a paid RPC provider: positions, proof bundles |
| `money` | 6/min | Anything that moves real money or asks for a signature |
| `paid` | 10/min | Requests that can cost money per call |
| `auth` | 20/min | Nonces and signature verification |
| `write` | 20/min | Cheap writes such as claiming a name |

Buckets refill continuously rather than resetting on a boundary, so an allowance
cannot be spent twice across a window edge.

A refused request returns `429` with `Retry-After` in seconds.

## How a caller is identified

By wallet when signed in, by address otherwise. Two traders behind one office
connection are two callers; one wallet moving between networks is one caller.
Neither is true if everything is keyed on an address.

The client address is counted from the **right** of `x-forwarded-for`, past
exactly as many proxies as sit in front of the server (`TRUSTED_PROXIES`,
default 1). Reading the leftmost entry — the obvious thing, and what most
examples do — would let a caller set the header themselves and get a fresh
bucket on every request, so the limiter would enforce nothing while appearing
to work.

Set `TRUSTED_PROXIES` to match the deployment. Too high limits a shared proxy as
one caller; too low lets a caller choose their own key. Too high is the safe
error.

## What this does not cover

**Limits are per process.** Running two instances doubles every number above.
This is deliberate: a shared store is a dependency that can fail, and a rate
limiter whose outage takes the site down has protected nothing. It is written
here so nobody has to rediscover it during an incident.

It follows that horizontal scaling needs this revisited, and that the numbers
above are a floor rather than a guarantee.
