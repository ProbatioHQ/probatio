# When something is broken

Published in advance, like the void policy, and for the same reason: the time to
decide what a service does under failure is before it fails.

Live status is at `/api/health`, which returns `503` when anything is genuinely
unavailable so that an uptime check sees it without parsing a body.

## The one thing that never degrades

**Trading stops when live prices cannot be read.** It does not fall back to a
cached price, it does not estimate, and it does not serve the last price it saw.

A fill quoted against a stale price is a fabricated fill, and a simulator that
fabricates fills has no reason to exist. Refusing to trade for ten minutes costs
a trader ten minutes. Filling them at a price that was never available costs
them the only thing this product sells, which is that the fills are honest.

The same applies mid-trade. The engine prices a click, waits a real delay, then
prices the fill. If prices become unreadable during that wait the trade is
refused rather than filled at the click price — filling it would hand the trader
the delay-free execution the whole engine exists to deny them.

Season entry stops for the same reason: a payment that cannot be verified on
chain must not be credited.

## What degrades instead

| Broken | What happens |
|---|---|
| Price data (RPC) | Charts show the last data received and say they are not updating. Leaderboard values open positions **at cost** rather than at market, so standings may shift when prices return — it says so. Trading and entry are off. |
| Launch feed | The token list stops growing. It shows what was seen before the feed dropped, with the age of the newest entry. Everything else is unaffected. |
| Coach | The coach is unavailable. Nothing else changes, and no allowance is consumed by a failed request. |
| Database | Almost everything is unavailable. Nothing "degrades" without it, because a page served without reading the database would be serving something it did not read. |

A token whose price cannot be read is never marked to zero. Wiping a position
because a network call failed would invent the number that decides who gets
paid.

## Downtime is recorded, not just noticed

Every outage is written down as an interval, and the total feeds the void
policy: a season is void if the price feed was unavailable for more than two
hours. A threshold nobody measures is a sentence in a document rather than a
rule, so the measurement exists.

Overlapping records are merged rather than summed. Two probes disagreeing, or
one incident seen by two instances, would otherwise report more downtime than
the clock contains — and that number decides whether a prize pool is paid.

A season with no recorded probes is reported as **unmeasured**, never as clean.
Those are different, and only one of them is evidence.

## Known limits

Probes run every thirty seconds, so an outage shorter than that may go
unrecorded. Rate limits are per process, so more than one instance multiplies
them. Both are written down here rather than left to be discovered during an
incident.
