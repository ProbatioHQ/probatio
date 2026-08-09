# Probatio

A proving ground for traders.

Trade live Solana markets with simulated money, against fills that model real
slippage and real latency. Every trade is committed on chain as it happens, so
the record cannot be backdated, edited, or cherry-picked. An AI coach reads
your closed trades and tells you what is actually costing you money. Ranked
seasons put that record on a leaderboard where the conditions themselves are
provable.

*Probatio* is Latin for a proving — a trial that establishes what something
really is.

## Why the fills matter more than anything else

Every paper trading tool fills you at mid-price, instantly, with no slippage.
That makes their results fantasy and their leaderboards meaningless. Probatio
quotes against actual pool reserves at a specific slot, applies a latency
penalty between click and fill, and partially fills when depth is thin.

The engine is validated by replaying thousands of real historical swaps and
comparing its output against what actually happened on chain. If that
comparison fails, nothing built on top of it is worth anything.

## Layout

```
packages/sim    Fill engine. Pure functions, no network, no clock, no I/O.
app             Next.js front end.
program         Anchor program for season and trade commitments.
```

`packages/sim` is sealed off deliberately. The replay harness compares its
output against real chain history, and that comparison only means something if
the engine cannot reach anything the replay does not control.

## Two rules that are not negotiable

**Amounts are fixed-point integers.** Never floats, anywhere, for any balance,
fill, fee or PnL figure. A double carries about 15 significant digits and a
lamport balance can need 19. The whole claim of this project is that a record
can be independently recomputed and will match, and it cannot match if the
arithmetic drifts.

**The engine is versioned.** `ENGINE_VERSION` goes into every merkle leaf
committed on chain. Anyone can re-check a trade against the exact rules in
force when it happened, rather than whatever the engine does today.

## Development

```
npm install
npm test          # vitest, all packages
npm run typecheck
```

The app:

```
cd app && npm run dev
```

Anchor is not yet installed on this machine — see `program/README.md`. It is
not needed until the on-chain program work begins.

## Status

Early. Foundations only. Nothing is deployed anywhere.

## License

AGPL-3.0. The name, logo and token are reserved and cannot be reused in public
deployments.
