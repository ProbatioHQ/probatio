# @probatio/commit

The primitives that make a [Probatio](https://probatiotrade.com) trading record checkable by someone who does not trust Probatio: canonical trade encoding, merkle trees, proofs and a hash chain.

```bash
npm i @probatio/commit
```

Most people want [`@probatio/sdk`](https://www.npmjs.com/package/@probatio/sdk), which fetches a record and checks it in one call and re-exports everything here. Reach for this package directly when you already hold the data, or when you want the hashing on its own.

## Why a package at all

A trade is only checkable if two parties encode it the same way, byte for byte. If the encoding lives inside the server, "verify" means asking the thing under scrutiny to mark its own work. So the encoding is here, in the open, and it is the same module the engine seals fills with. There is no second implementation to drift.

```ts
import { hashLeaf, buildTree, buildProof, verifyProof, toHex } from '@probatio/commit';

const leaves = trades.map(hashLeaf);    // each fill's canonical hash
const tree = buildTree(leaves);         // fills, in order
toHex(tree.root);                       // one hash for the whole record

const proof = buildProof(tree, 3);      // fill 3 belongs to that root
verifyProof(leaves[3], proof, tree.root); // true
```

`merkleRoot(leaves)` gives the root on its own when you do not need proofs, and
`computeRoot(leafHash, proof)` rebuilds a root from one leaf and its proof,
which is what a verifier does when it holds a single fill rather than the set.

## What is in it

- **`leaf`** encodes a fill to fixed-width bytes and hashes it. The figures covered are the ones the fill was priced from: reserves, amounts, fee, the slot clicked and the slot filled.
- **`merkle`** builds trees, roots and inclusion proofs. Leaves and interior nodes are hashed under different prefixes, so a pair of hashes can never be read as a single trade.
- **`chain`** folds batch roots into a running accumulator.
- **`verify`** puts those together into a checked result with a readable explanation.

Dependencies are `@noble/hashes` and `bs58`. Nothing else, and nothing that touches a network.

## Licence

MIT. The [Probatio application itself](https://github.com/ProbatioHQ/probatio) is AGPL-3.0; this library is permissive on purpose, so that checking a record carries no licensing consequence for whoever checks it.
