# @probatio/cli

Verify a [Probatio](https://probatiotrade.com) trading record from your terminal.

```bash
npx @probatio/cli verify 7xKXtg2CW3cWCLBmVvKcbAkKM6mzTuKMYqM9dAcuLNwr
```

```
  PASS  Seals: all 9 fills rehash to exactly the seal recorded with them
  PASS  Membership: every fill proves it belongs to the record, in the order it was made

VERIFIED  7xKXtg2CW3cWCLBmVvKcbAkKM6mzTuKMYqM9dAcuLNwr, 9 fill(s) checked
ROOT      4f2c9a1d8b3e57069c4a1f8d2e6b03571a9c4e8f2d6b0357194c8ea3f7d20b6c1
```

A record with a fill edited after it was sealed fails, and names the fill rather than condemning the whole record:

```
  FAIL  Seals: 1 of 9 fills do not match their seal
  FAIL  Fill 4: its figures hash to 91c04ae7f2b6…, but 3d8f1c6b0a45… was recorded

NOT VERIFIED  7xKXtg…, fill(s) 4 do not match their seal
```

**The exit code is the verdict**, so this drops into a script or a CI step without anything parsing its output: `0` verified, `1` not verified, `2` the command was wrong or the instance unreachable.

```bash
probatio verify "$WALLET" || echo "that record does not check out"
```

## Commands

```
probatio verify <wallet>      check a record, exit code as the verdict
probatio record <wallet>      the trader's public record
probatio proof <wallet>       the raw figures and seals, as JSON
probatio standings            the current leaderboard
probatio season               the season in progress
probatio help
```

Flags: `--api <url>` to point at another instance, `--season <n>` for a specific season, `--limit <n>` on the standings, `--json` where a machine is reading.

## What it is actually doing

Every fill is sealed with a hash the moment it lands, over the exact figures it was priced from: pool reserves, amounts, fee, the slot clicked and the slot filled. This asks an instance for those figures and their seals, then does the arithmetic locally: recompute each hash, compare it to the seal, fold the fills into a tree and rebuild the root.

Change any stored figure afterwards and its hash stops matching its seal. The server cannot make that come out right without forging the seal, and it cannot forge the seal without the figures it just handed you.

There is no chain in this, no RPC and no account to read. `VERIFIED` is arithmetic that ran on your machine.

## It is the SDK as a command

This is a thin wrapper over [`@probatio/sdk`](https://www.npmjs.com/package/@probatio/sdk), which it depends on rather than bundles, so the verifier you run is the one you can read. Reach for the SDK directly to check records inside your own code.

## Checking a different instance

Probatio is open source and anyone can run it. Nothing here trusts the source of the data, so the check is unchanged:

```bash
probatio verify <wallet> --api https://example.com
```

## Licence

MIT. The [Probatio application itself](https://github.com/ProbatioHQ/probatio) is AGPL-3.0; this is permissive on purpose, so checking a record carries no licensing consequence for whoever checks it.
