# @probatio/sdk

Read a [Probatio](https://probatiotrade.com) trading record and verify it yourself.

Probatio is a trading simulator: practice money, real pump.fun prices, fills modelled against the pool reserves a trade was actually quoted from. The point of it is that a record does not need Probatio to be believed. This is that in a library.

```bash
npm i @probatio/sdk
```

```ts
import { verifyRecord } from '@probatio/sdk';

const result = await verifyRecord('7xKXtg2CW3cWCLBmVvKcbAkKM6mzTuKMYqM9dAcuLNwr');

console.log(result.verified);   // true
console.log(result.tradeCount); // 9
console.log(result.root);       // 4f2c9a1d8b3e…
console.log(result.broken);     // [] , or the fills that failed
```

## What it actually checks

Every fill is sealed with a hash the moment it lands, taken over the exact figures it was priced from: the pool reserves, the amounts, the fee, the slot it was clicked at and the slot it filled at.

This library asks an instance for those figures and the seals, then does the rest on your machine:

1. **Seals.** Recompute the hash of each fill from its own figures and compare it to the seal stored beside it.
2. **Membership.** Fold the fills into a tree, in order, and rebuild the root.

Change any field of a stored fill afterwards, to improve a price or shave a fee, and its recomputed hash stops matching its seal. The server cannot make that come out right without forging the seal, and it cannot forge the seal without the figures that produce it, which are the figures it just handed you.

`verified: true` is arithmetic you ran. It is never a server's say-so.

## What it does not do

**There is no chain in this.** No RPC, no program, no account to read. Verification is entirely over hashes and is synchronous once the data is in hand. If you want an on-chain commitment, this library is not where you would get it.

**It cannot tell you the figures were true when they were recorded.** It proves they have not been altered since. Whether the reserves quoted at fill time matched the real pool is a separate question, and the honest answer is on the [trust page](https://probatiotrade.com/trust).

## API

```ts
// One call, fetch and check.
verifyRecord(trader: string, options?: VerifyOptions): Promise<VerifiedRecord>

// Already hold the data? This is local, synchronous, and does no I/O.
verifyBundle(bundle: ProofBundle): VerifiedRecord

// Reads, without verification.
getProof(trader, options?)      // the figures and seals
getRecord(trader, options?)     // a trader's public record
getSeason(options?)             // the current season
getStandings(options?)          // the leaderboard

// Or hold a configured client.
new Probatio({ apiBase?, fetchImpl? })
```

`verifyBundle` is the one to reach for in a CI step or an audit: hand it a bundle you obtained however you like and it never touches the network.

Every primitive it verifies with is re-exported, so you can do the hashing yourself:

```ts
import { hashLeaf, buildTree, computeRoot, verifyProof } from '@probatio/sdk';
```

Those come from [`@probatio/commit`](https://www.npmjs.com/package/@probatio/commit), which is the same code the engine seals with.

## Checking another instance

Probatio is open source and anyone can run it. Point the client at any instance; the checking is unchanged, because none of it trusts the source of the data.

```ts
const result = await verifyRecord(wallet, { apiBase: 'https://example.com' });
```

## Also available

- [`@probatio/commit`](https://www.npmjs.com/package/@probatio/commit), the primitives on their own
- `npx @probatio/cli verify <wallet>`, the same check from a terminal, exit code as the verdict

## Licence

MIT. The [Probatio application itself](https://github.com/ProbatioHQ/probatio) is AGPL-3.0; this library is permissive on purpose, so that checking a record carries no licensing consequence for whoever checks it.
