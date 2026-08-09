# Load test

Two harnesses, because two different things can break.

    npx tsx scripts/load-db.mts [traders] [tradesEach]     # the write path
    npx tsx scripts/load-http.mts <baseUrl> [callers] [each] # read routes

The trade route is deliberately not driven over HTTP. It reads live pool state
from an RPC provider, so loading it would measure somebody else's endpoint and
risk having it taken away. What our own code does under concurrency is measured
directly against the database instead.

## What it found

**500 concurrent trades produced 499 `SQLITE_BUSY` failures and one write.**

The invariants all held — no duplicate sequences, no gaps, no orphaned rows —
because almost nothing was written. A safe failure, and a useless one.

Two obvious fixes were measured and neither worked:

| Attempt | Result |
|---|---|
| `PRAGMA busy_timeout = 5000` | 1 of 40 writes succeeded |
| `journal_mode = WAL` + busy_timeout | 1 of 40 writes succeeded |
| Serializing writes in process | 40 of 40 |

`busy_timeout` fails because libsql hands every transaction its own connection
and the pragma is per connection, so the setting never reaches the connection
that needs it. WAL fails because WAL allows one writer alongside many *readers*,
and this is many writers.

So writes to a local database are queued, one transaction at a time. That is
what `busy_timeout` would have done had it been reachable: SQLite permits a
single writer, and waiting for a turn is the honest response. Remote databases
are left alone — a server does its own concurrency control, and queueing there
would serialize network round trips for nothing.

**A second bug surfaced from the same run**: `ensureAccount` selected and then
inserted, which is a race. It runs on every authenticated request, so two
concurrent requests on a wallet's first visit both saw no account and both tried
to create one — and the loser got an exception on an ordinary first page load.
Now `ON CONFLICT DO NOTHING` with a re-read.

Both are covered by regression tests, so removing the queue on the grounds that
it looks unnecessary fails the suite.

## Numbers

Local file database, one process, on a laptop.

| Test | Result |
|---|---|
| 500 concurrent trades | 500 succeeded, 230 writes/sec |
| 1000 concurrent trades | 1000 succeeded, 229 writes/sec |
| 3000 concurrent trades | 3000 succeeded, 220 writes/sec |
| 6000 read requests, 30 callers | 787 req/sec, p95 57ms, p99 89ms |

Write throughput is flat as concurrency grows, which is what a queue should
look like. Reported latency is mostly queueing: 3000 writes in 13.7 seconds is
about 4.5ms of actual work each, and a p50 of 6.7 seconds is the wait for a turn
when all 3000 are fired at once — not something a real trader experiences, since
real trades arrive spread out.

The HTTP run refused 2059 of 6000 requests with `429`. That is the rate limiter
working, and a run where nothing is refused has not reached the limit and has
measured nothing. Latency stayed flat while it shed load, and there were no
server errors.

## What this does not tell us

Local SQLite is not Turso. These numbers describe a file on a laptop; a hosted
database has network latency, different locking, and its own limits. The
*invariants* are what transfer — sequences stay unique and gapless under
concurrency because the code makes them so, not because the storage happened to
be slow enough.

220 writes/sec is roughly 13,000 trades a minute. A season with a few hundred
active traders is nowhere near it. The number is recorded so that the day it
matters, it is a measurement rather than a guess.
