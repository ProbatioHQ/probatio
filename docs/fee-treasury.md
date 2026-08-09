# The fee treasury

The keeper spends SOL to record trades. If it runs out mid-season the trades
after that point are never committed — and uncommitted trades void a season
under the published policy.

So this is not operational housekeeping. **An empty fee wallet cancels a
competition and refunds a prize pool.** It sits in the same category as a feed
outage, and is checked the same way: before it happens, while acting still
helps.

## What it costs

Measured against mainnet with `getMinimumBalanceForRentExemption`, not derived
from constants.

| Item | Lamports | |
|---|---|---|
| Trader record rent | 1,816,560 | 0.00182 SOL, once per trader per season |
| Signature fee | 5,000 | per commitment |
| Season vault rent | 890,880 | once, paid by the authority |
| Entry account rent | 1,572,960 | paid by the trader, not us |

**Rent dominates completely.** A trader who makes one trade costs almost exactly
as much to record as one who makes a thousand, because the record account is
created once and appending to it is noise beside its rent. Batching harder saves
fees, which are already negligible; it does nothing about the real cost.

The consequence worth planning around: cost scales with **traders**, not with
trading.

## Whether a season pays for itself

The only revenue is the house cut — a tenth of the pot, and only above one SOL.

| Entrants | Recording costs | House cut | |
|---|---|---|---|
| 20 | 0.036 SOL | 0.000 SOL | at a loss |
| 100 | 0.182 SOL | 0.500 SOL | covered |
| 500 | 0.911 SOL | 2.500 SOL | covered |

Break-even is somewhere around twenty-five entrants. Below that a season is
recorded at a loss **by design** rather than by accident: the threshold exists
so a small pot is not taxed, and the cost of eating that is a few cents.

Free play is never committed and therefore costs nothing to record.

## Checking it

    DATABASE_URL=<url> KEEPER_ADDRESS=<pubkey> npx tsx scripts/treasury.mts

Reports what the season has cost so far, what finishing it needs, and whether
the wallet holds enough — with a 1.5x margin, because the estimate is an average
and a season is not obliged to be average. Running out is not recoverable, so
being wrong in the cheap direction is worth paying for.

Exit codes: `2` insufficient, `1` low, `0` fine. It is meant to be run on a
schedule and to fail loudly.

## Rent is not recovered

A trader record could in principle be closed after a season finalizes, returning
its rent. There is no instruction to do that and there will not be: closing the
account deletes the record, which is the one thing the whole design exists to
prevent.

So the rent is a permanent cost of about 0.0018 SOL per trader per season. Ten
thousand trader-seasons is roughly 18 SOL, spent once and never returned. That
is affordable and it is not free, and it grows with success rather than with
usage.

## Keys

The keeper's fee wallet is not the treasury that receives entry fees, and
neither is the authority. Three separate keys:

- **keeper** — hot, on the server, spends SOL to commit, can do nothing else
- **treasury** — receives entry payments, never on the server
- **authority** — creates and finalizes seasons, signs rarely, not on the server

A compromise of the fee wallet costs whatever SOL is in it and stops commits.
It cannot touch the pot.

## Not done

No automatic top-up and no alert on a failing check — the script exists and
running it on a schedule is a deployment concern. The keeper does not yet refuse
to start on an insufficient balance, because the concrete chain gateway arrives
with deployment; the check it would call is written and tested.
