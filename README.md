<div align="center">

<img src="docs/banner.svg?v=3" alt="Probatio" width="100%" />

<br/>

<a href="https://readme-typing-svg.demolab.com">
  <img src="https://readme-typing-svg.demolab.com?font=JetBrains+Mono&weight=600&size=21&duration=2600&pause=900&color=3FE08A&center=true&vCenter=true&width=800&height=44&lines=Trade+fake+money+on+real+tokens.;Prove+you're+good.;Get+paid+for+it.;Every+trade+committed+on-chain%2C+verified+by+anyone." alt="Probatio" />
</a>

<br/><br/>

![License](https://img.shields.io/badge/license-AGPL--3.0-3fe08a?style=flat-square)
![Tests](https://img.shields.io/badge/tests-1308%20passing-3fe08a?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-Anchor-dea584?style=flat-square&logo=rust&logoColor=white)
![Self-hostable](https://img.shields.io/badge/self--hostable-yes-3fe08a?style=flat-square)

<br/>

<img src="https://skillicons.dev/icons?i=ts,rust,nextjs,react,tailwind,solana,sqlite,nodejs,vitest" alt="stack" />

</div>

<br/>

**An open prop firm.** Trade fake money on live markets with fills that model real
slippage and real delay, prove you can do it with a record that cannot be revised,
and get paid for a season you win. Every trade is committed to the chain as it is
made, so the result is verified by anyone, without trusting the site that produced
it.

---

## How it works

Three things, and each is a fact you can check rather than a claim you take.

### The fills are accurate

The engine is measured against trades that actually happened: real swaps pulled
from the chain, each re-quoted from the reserves that stood immediately before it,
and compared against what the market produced.

```
RPC_VALIDATION=1 npx vitest run packages/validation/test/mainnet.test.ts
```

A recent run, 221 events off mainnet:

| | |
|---|---|
| Scored pairs | 128 |
| Median error | **0 bps** |
| 95th percentile | **0 bps** |
| Worst case | **0 bps** |
| Exact matches | **128 of 128** |

Not close. Identical, to the lamport, on every sample. A pair is only scored when
the reserves prove the two trades were consecutive, so that run discarded 91 of 221
events. Throwing away most of the data is what makes the number mean anything.

### The records cannot be revised

Each fill is hashed into a fixed-width leaf carrying the pool reserves it was quoted
against, so a verifier needs nothing from us. Leaves are batched into a merkle root,
and roots are folded one at a time into a running value:

```
accumulator = sha256(accumulator ‖ root ‖ leaves ‖ engine_version)
```

Thirty-two bytes on chain covering every trade in order. Changing an old trade
changes every value after it, and those were already witnessed publicly at the time.
The `/verify` page rebuilds every trade from its own recorded inputs, recomputes each
root, folds the chain, and compares against Solana, in the reader's browser, against
an endpoint they choose.

### Winning a season pays

Seasons are ranked by return, on a scoring rule published and hashed up front. When
one ends, the standings, the split and the payout root are derived from the committed
records, and any winner claims their prize on chain against a merkle proof. The root
follows provably from the trades, so who gets paid is not something the operator
decides. Nobody has to trust that the leaderboard is honest; they can recompute it.

---

## SDK, CLI and MCP

A record does not need Probatio to be believed, so the same verification the site
runs ships three ways: a library, a command, and an MCP server. All three do the one
thing that matters, and none of them takes a server's word for it. They fetch the
trades a trader committed, rebuild the hashes, fold them into an accumulator, and
compare it to the one Solana holds, at an address derived from constants in the
package, over an RPC you choose. A `verified: true` is a claim about the chain, not
about us.

### `@probatio/sdk`

The library. A configured client, or a standalone function for each call.

```ts
import { Probatio } from '@probatio/sdk';

const probatio = new Probatio({ rpc: 'https://api.mainnet-beta.solana.com' });

// Check a trader's record against the chain, yourself.
const result = await probatio.verifyRecord(wallet);
result.verified;             // true only when the chain holds what these trades produce
result.checks;               // every step, so you can show your work

// Read the public record, the raw proof inputs, and the standings.
const record = await probatio.getRecord(wallet);
const proof = await probatio.getProof(wallet);
const board = await probatio.getStandings({ season: 1 });
```

Point it at your own instance with `apiBase`, and pass a `season` to check a past one.
Every method is also a standalone function (`verifyRecord`, `getProof`, `getRecord`,
`getStandings`), and the low-level primitives (`hashLeaf`, `buildTree`, `verifyProof`,
`extendChain`) are re-exported for callers who already hold the data. It carries no
web3 dependency; verification is a raw JSON-RPC call over `fetch`, so it runs in a
browser, a worker, or a server unchanged.

### `@probatio/cli`

The same core from a terminal, which is the plainest form of "do not trust us, check".

```bash
npx @probatio/cli verify <wallet> --rpc https://api.mainnet-beta.solana.com
npx @probatio/cli record <wallet>
npx @probatio/cli standings --season 1
npx @probatio/cli proof <wallet>        # the raw inputs verify recomputes from
```

`verify` prints each check, then exits `0` when the record holds against the chain and
`1` when it does not, so it drops straight into a script or a CI step. `--rpc` names the
endpoint it checks against, `--api` points at an instance, `--season` picks a past one,
and `--json` prints the raw result instead of a summary.

### `@probatio/mcp`

An MCP server, so an agent can vet or back a trader on proof rather than on a
leaderboard's word. It speaks over stdio and exposes four tools, `verify_record`,
`get_record`, `get_standings` and `get_proof`, over the same SDK.

```json
{
  "mcpServers": {
    "probatio": {
      "command": "npx",
      "args": ["-y", "@probatio/mcp"],
      "env": { "PROBATIO_RPC": "https://api.mainnet-beta.solana.com" }
    }
  }
}
```

`PROBATIO_RPC` is the endpoint `verify_record` checks against when a call omits one, and
`PROBATIO_API` points at an instance. The verdict the agent sees is one it could have
recomputed itself.

---

## Architecture

An npm workspace of 24 TypeScript packages plus an Anchor program. Most packages are
pure (no clock, no network, no database), which is why the whole suite runs offline in
about ten seconds. The ones that reach outside are marked, and they are the only ones
that can.

| Package | Responsibility | Reaches out |
|---|---|---|
| `sim` | Fixed-point arithmetic and the fill engine | |
| `trading` | Applying fills to balances and positions | |
| `pools` | Venue decoding and the only RPC client | network |
| `candles` | Prices and chart series from pool reserves | network |
| `metadata` | Token names, on-chain and off, with the untrusted half fenced off | network |
| `feed` | The live launch websocket | network |
| `commit` | Leaf encoding, merkle trees, the accumulator chain | |
| `keeper` | Batching and committing, reconcilable after a crash | network, database |
| `validation` | The accuracy harness above | network |
| `analytics` | What a trade log says about the trader | |
| `coach` | Turning that into advice without letting a model invent a number | network |
| `seasons` | Rulesets, their hash, lifecycle and payout maths | |
| `scoring` | Ranking, the results commitment, and the verifiable finalization | |
| `payments` | Solana transactions, built and verified by hand | |
| `sybil` | Making a track record expensive to fake | network |
| `profile` | Display names and the rules against impersonation | |
| `limits` | Rate limiting | |
| `health` | What is working, and how long it has not been | |
| `retention` | Whether people come back | |
| `auth` | Sign-in with Solana, and sessions. No email anywhere | |
| `db` | Schema, migrations, and every query | database |
| `sdk` | Read and verify a record against the chain, no web3 dependency | network |
| `cli` | The `probatio` command, over the SDK | network |
| `mcp` | An MCP server exposing the SDK to agents | network |

Plus `app` (Next.js 16) and `program` (Anchor).

Amounts are integers everywhere: `bigint` in TypeScript, fixed-point on chain. Nothing
in this repository stores money in a float.

---

## Run your own

Requires Node 22 or later and a Solana RPC endpoint.

```bash
npm install
cp app/.env.example app/.env.local     # then fill in SESSION_SECRET
npm test                                # 1308 tests, no network
npm --prefix app run dev
```

The Anchor program is separate and needs the Solana toolchain:

```bash
cd program && cargo test               # runs under litesvm
```

Use `cargo build-sbf` rather than `cargo build`, or the tests run against a stale
program.

The [docs](docs/) directory holds the operator's reasoning: the [void
policy](docs/void-policy.md), the [program review](docs/program-review.md), the
[keeper key](docs/keeper-key.md), and more.

---

## Licence

[AGPL-3.0](LICENSE). Run a modified version as a service and the source of your version
has to be available too, which is the point, for a product whose argument is that it
can be checked.
