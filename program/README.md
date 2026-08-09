# program

Probatio's on-chain half. It holds the two things a database cannot be trusted
with: the conditions a season ran under, and a commitment to every trade made
inside it.

## What is and is not on chain

The trades themselves are not here — a season with thousands of traders would
cost a fortune in rent. Each trader gets a `TraderRecord` holding a hash chain:

```text
accumulator = sha256(accumulator || batch_root || leaves || engine_version)
```

Thirty-two bytes commit to every batch ever made, in order. Anyone holding the
trade data can replay the chain and confirm it produces the value on chain, and
nobody — including the keeper that writes it — can alter an earlier batch
without changing every value after it, all of which were already witnessed on
chain at the time.

The engine version is folded into the hash rather than stored beside it, so a
batch stays checkable against the rules in force when it was written even if
the engine changes mid-season.

Season conditions are recorded because the claim being made is not merely
"these trades happened" but "these trades happened under these rules". Without
the latency, the slippage cap and the scoring formula on chain, anyone can say
they moved partway through and there is no answer.

## Two keys, on purpose

- **authority** creates seasons and publishes results
- **keeper** appends trade commitments, and nothing else

The keeper signs constantly and is therefore the likeliest key to be
compromised. Separating them means a compromise cannot rewrite a season's rules
or publish its results. Neither can alter a record already committed.

## Accounts

| Account | Seeds | Holds |
|---|---|---|
| `Season` | `["season", ordinal]` | Conditions, status, pot, results root |
| `Entry` | `["entry", season, trader]` | One registration. The address enforces one each. |
| `TraderRecord` | `["record", season, trader]` | The hash chain over a trader's trades |
| vault | `["vault", season]` | Entry fees, held until payout |

Ordinal `-1` is free play: unranked, no entry cost, and entries are refused.

## Building and testing

```
cargo test --release      # 32 tests, litesvm
anchor build              # deployable .so plus IDL
```

Tests run against litesvm rather than a validator, so the whole suite finishes
in well under a second.

## Toolchain

Anchor 1.1.2 requires Solana 3.x, which it installs alongside any older CLI.
That newer binary has to come first on PATH:

```
export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"
```

## Deployment

Nothing here is deployed anywhere. Development and testing run against
`solana-test-validator` and litesvm only; mainnet deployment is step 51.

**The program keypair at `target/deploy/probatio-keypair.json` is gitignored and
is the only thing that can deploy to this program address.** Back it up
somewhere safe before deploying — losing it means the program can never be
upgraded, and leaking it means someone else can.
