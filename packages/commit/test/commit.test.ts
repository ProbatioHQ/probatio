import { describe, expect, it } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { LEAF_BYTES, LeafError, encodeLeaf, hashLeaf, type TradeLeaf } from '../src/leaf';
import {
  MerkleError,
  buildProof,
  buildTree,
  computeRoot,
  equalHashes,
  fromHex,
  hashNode,
  merkleRoot,
  toHex,
  verifyProof,
} from '../src/merkle';
import { EMPTY_ACCUMULATOR, extendChain, replayChain } from '../src/chain';

const TRADER = '7xKXtg2CW3cWCLBmVvKcbAkKM6mzTuKMYqM9dAcuLNwr';
const MINT = '3SPyj7fHQ6TKGR5Agua1gPdCnb2oWHF8Zi8bY33bpump';

function leaf(overrides: Partial<TradeLeaf> = {}): TradeLeaf {
  return {
    sequence: 1,
    seasonOrdinal: 1,
    trader: TRADER,
    mint: MINT,
    side: 'buy',
    solAmount: 1_000_000_000n,
    tokenAmount: 30_876_109_580_266n,
    feeLamports: 12_345_680n,
    solReserve: 31_000_000_000n,
    tokenReserve: 1_000_000_000_000_000n,
    deliverableTokens: 700_000_000_000_000n,
    feeBps: 125,
    poolSource: 'pumpfun-curve',
    priceImpactBps: 318,
    partial: false,
    clickedAtSlot: 438_197_066,
    filledAtSlot: 438_197_068,
    latencyMs: 600,
    engineVersion: 1,
    createdAt: 1_786_278_374_000,
    ...overrides,
  };
}

describe('encodeLeaf', () => {
  it('is fixed width', () => {
    // Every trade encodes to the same size, so there is no way to construct
    // two different trades that serialize identically by shifting a boundary.
    expect(encodeLeaf(leaf())).toHaveLength(LEAF_BYTES);
    expect(encodeLeaf(leaf({ side: 'sell', partial: true }))).toHaveLength(LEAF_BYTES);
  });

  it('is deterministic', () => {
    expect(encodeLeaf(leaf())).toEqual(encodeLeaf(leaf()));
  });

  it('changes when any field changes', () => {
    const base = toHex(hashLeaf(leaf()));
    const variations: Partial<TradeLeaf>[] = [
      { sequence: 2 },
      { seasonOrdinal: 2 },
      { mint: '5CKuyx8kqzwHVZKoRMstBih9wteTv4XoSBq48j7Zpump' },
      { side: 'sell' },
      { solAmount: 1_000_000_001n },
      { tokenAmount: 1n },
      { feeLamports: 0n },
      { solReserve: 31_000_000_001n },
      { tokenReserve: 1n },
      { deliverableTokens: 1n },
      { feeBps: 30 },
      { poolSource: 'pumpswap' },
      { priceImpactBps: 319 },
      { partial: true },
      { clickedAtSlot: 438_197_067 },
      { filledAtSlot: 438_197_069 },
      { latencyMs: 601 },
      { engineVersion: 2 },
      { createdAt: 1_786_278_374_001 },
    ];

    for (const variation of variations) {
      expect(toHex(hashLeaf(leaf(variation)))).not.toBe(base);
    }
  });

  it('carries the reserves the fill was quoted against', () => {
    // Without these, verifying a trade would mean trusting our database for
    // the one number the result depends on — which is the trust the project
    // claims not to need.
    const encoded = encodeLeaf(leaf());
    const withDifferentReserves = encodeLeaf(leaf({ solReserve: 32_000_000_000n }));
    expect(encoded).not.toEqual(withDifferentReserves);
  });

  it('rejects a negative amount', () => {
    expect(() => encodeLeaf(leaf({ solAmount: -1n }))).toThrow(LeafError);
  });

  it('rejects an amount too large for the field', () => {
    expect(() => encodeLeaf(leaf({ tokenAmount: 1n << 128n }))).toThrow(LeafError);
  });

  it('rejects a malformed address', () => {
    expect(() => encodeLeaf(leaf({ trader: 'not-base58!' }))).toThrow(LeafError);
    expect(() => encodeLeaf(leaf({ mint: '1111' }))).toThrow(LeafError);
  });
});

describe('leaf and node domain separation', () => {
  it('hashes a leaf differently from raw data', () => {
    const encoded = encodeLeaf(leaf());
    // A leaf is tagged before hashing, so its hash is not simply sha256 of the
    // encoding — which is what stops an internal node being passed off as one.
    expect(toHex(hashLeaf(leaf()))).not.toBe(toHex(sha256(encoded)));
  });

  it('hashes a node differently from a leaf of the same bytes', () => {
    const a = hashLeaf(leaf());
    const b = hashLeaf(leaf({ sequence: 2 }));
    const node = hashNode(a, b);

    const combined = new Uint8Array(a.length + b.length);
    combined.set(a, 0);
    combined.set(b, a.length);
    expect(toHex(node)).not.toBe(toHex(sha256(combined)));
  });
});

describe('buildTree', () => {
  function hashes(count: number): Uint8Array[] {
    return Array.from({ length: count }, (_, i) => hashLeaf(leaf({ sequence: i + 1 })));
  }

  it('refuses an empty tree', () => {
    expect(() => buildTree([])).toThrow(MerkleError);
  });

  it('makes a single leaf its own root', () => {
    const [only] = hashes(1);
    expect(toHex(merkleRoot([only!]))).toBe(toHex(only!));
  });

  it('builds balanced and unbalanced trees alike', () => {
    for (const count of [1, 2, 3, 4, 5, 7, 8, 9, 16, 33, 100]) {
      const tree = buildTree(hashes(count));
      expect(tree.leafCount).toBe(count);
      expect(tree.root).toHaveLength(32);
    }
  });

  it('promotes an odd node rather than duplicating it', () => {
    // Duplicating the last node — the Bitcoin approach — lets two different
    // trees share a root, which would let a record be swapped for a different
    // one with the same commitment.
    const three = hashes(3);
    const duplicated = [...three, three[2]!];

    expect(toHex(merkleRoot(three))).not.toBe(toHex(merkleRoot(duplicated)));
  });

  it('changes the root when a leaf changes', () => {
    const leaves = hashes(8);
    const before = toHex(merkleRoot(leaves));
    leaves[3] = hashLeaf(leaf({ sequence: 99 }));
    expect(toHex(merkleRoot(leaves))).not.toBe(before);
  });

  it('changes the root when leaves are reordered', () => {
    const leaves = hashes(8);
    const before = toHex(merkleRoot(leaves));
    [leaves[0], leaves[1]] = [leaves[1]!, leaves[0]!];
    expect(toHex(merkleRoot(leaves))).not.toBe(before);
  });
});

describe('proofs', () => {
  function treeOf(count: number) {
    const leaves = Array.from({ length: count }, (_, i) => hashLeaf(leaf({ sequence: i + 1 })));
    return { tree: buildTree(leaves), leaves };
  }

  it('proves every leaf in trees of many shapes', () => {
    // Unbalanced trees are where naive implementations break, so every size is
    // checked at every index rather than a convenient power of two.
    for (const count of [1, 2, 3, 5, 8, 13, 33]) {
      const { tree, leaves } = treeOf(count);
      for (let i = 0; i < count; i += 1) {
        const proof = buildProof(tree, i);
        expect(verifyProof(leaves[i]!, proof, tree.root)).toBe(true);
      }
    }
  });

  it('rejects a proof for the wrong leaf', () => {
    const { tree, leaves } = treeOf(8);
    const proof = buildProof(tree, 3);
    expect(verifyProof(leaves[4]!, proof, tree.root)).toBe(false);
  });

  it('rejects a tampered proof', () => {
    const { tree, leaves } = treeOf(8);
    const proof = buildProof(tree, 3);
    const tampered = proof.map((step, index) =>
      index === 0 ? { ...step, sibling: new Uint8Array(32) } : step,
    );
    expect(verifyProof(leaves[3]!, tampered, tree.root)).toBe(false);
  });

  it('rejects a proof with the sides swapped', () => {
    // Order matters to the hash, so flipping it must not still verify.
    const { tree, leaves } = treeOf(8);
    const proof = buildProof(tree, 3).map((step) => ({
      ...step,
      siblingOnLeft: !step.siblingOnLeft,
    }));
    expect(verifyProof(leaves[3]!, proof, tree.root)).toBe(false);
  });

  it('rejects a proof against a different root', () => {
    const { tree, leaves } = treeOf(8);
    const proof = buildProof(tree, 3);

    // The realistic forgery: a same-size tree built from DIFFERENT leaves, so
    // its root differs. The old test built `other` the same deterministic way,
    // so its root was byte-identical and it only ever asserted a proof verifies
    // against its own root. This asserts the proof does NOT verify against a
    // genuinely different root.
    const otherLeaves = Array.from({ length: 8 }, (_, i) =>
      hashLeaf(leaf({ sequence: i + 1, solAmount: 999_999n })),
    );
    const otherRoot = buildTree(otherLeaves).root;
    expect(toHex(otherRoot)).not.toBe(toHex(tree.root));
    expect(verifyProof(leaves[3]!, proof, otherRoot)).toBe(false);

    // And a different size, the other way a root can differ.
    const different = treeOf(7);
    expect(verifyProof(leaves[3]!, proof, different.tree.root)).toBe(false);
  });

  it('refuses an out-of-range index', () => {
    const { tree } = treeOf(4);
    expect(() => buildProof(tree, 4)).toThrow(MerkleError);
    expect(() => buildProof(tree, -1)).toThrow(MerkleError);
  });

  it('keeps proofs short', () => {
    // A thousand trades should cost about ten hashes to prove, not a thousand.
    const { tree } = treeOf(1_000);
    expect(buildProof(tree, 500).length).toBeLessThanOrEqual(10);
  });

  it('computes the root a verifier would arrive at', () => {
    const { tree, leaves } = treeOf(5);
    expect(toHex(computeRoot(leaves[2]!, buildProof(tree, 2)))).toBe(toHex(tree.root));
  });
});

describe('the hash chain', () => {
  const root = new Uint8Array(32).fill(1);

  it('starts from an empty accumulator', () => {
    expect(EMPTY_ACCUMULATOR).toHaveLength(32);
    expect(EMPTY_ACCUMULATOR.every((byte) => byte === 0)).toBe(true);
  });

  it('moves on every commit', () => {
    const first = extendChain(EMPTY_ACCUMULATOR, root, 5, 1);
    const second = extendChain(first, root, 5, 1);
    expect(toHex(first)).not.toBe(toHex(second));
  });

  it('depends on the order of batches', () => {
    // The property that makes history unrewritable. If order did not change
    // the result, batches could be quietly rearranged after the fact.
    const a = new Uint8Array(32).fill(1);
    const b = new Uint8Array(32).fill(2);

    const forward = replayChain([
      { root: a, leaves: 5, engineVersion: 1 },
      { root: b, leaves: 5, engineVersion: 1 },
    ]);
    const backward = replayChain([
      { root: b, leaves: 5, engineVersion: 1 },
      { root: a, leaves: 5, engineVersion: 1 },
    ]);

    expect(toHex(forward)).not.toBe(toHex(backward));
  });

  it('depends on the leaf count', () => {
    expect(toHex(extendChain(EMPTY_ACCUMULATOR, root, 5, 1))).not.toBe(
      toHex(extendChain(EMPTY_ACCUMULATOR, root, 6, 1)),
    );
  });

  it('depends on the engine version', () => {
    // Folded in rather than stored beside, so a batch stays checkable against
    // the rules in force when it was written.
    expect(toHex(extendChain(EMPTY_ACCUMULATOR, root, 5, 1))).not.toBe(
      toHex(extendChain(EMPTY_ACCUMULATOR, root, 5, 2)),
    );
  });

  it('replays to the same value it was built with', () => {
    const batches = [
      { root: new Uint8Array(32).fill(1), leaves: 3, engineVersion: 1 },
      { root: new Uint8Array(32).fill(2), leaves: 7, engineVersion: 1 },
      { root: new Uint8Array(32).fill(3), leaves: 2, engineVersion: 2 },
    ];

    let stepwise = EMPTY_ACCUMULATOR;
    for (const batch of batches) {
      stepwise = extendChain(stepwise, batch.root, batch.leaves, batch.engineVersion);
    }

    expect(toHex(replayChain(batches))).toBe(toHex(stepwise));
  });

  it('matches the on-chain program byte for byte', () => {
    // The chain exists in two languages: Rust, where it is authoritative, and
    // here, where the keeper predicts it and a verifier replays it. Two
    // implementations of the same algorithm drift, and the drift would not
    // surface until a verification failed in front of a user.
    //
    // The identical assertions live in
    // program/programs/probatio/tests/test_chain_vectors.rs. If either side
    // changes, one of them fails.
    const first = extendChain(EMPTY_ACCUMULATOR, new Uint8Array(32).fill(0xab), 5, 1);
    expect(toHex(first)).toBe(
      '225ef35de89111df19cb0074343a4bab472cf40fa2540b9f30bc75403e133197',
    );

    const second = extendChain(first, new Uint8Array(32).fill(0xcd), 7, 2);
    expect(toHex(second)).toBe(
      '10dc9eb327056f634bf4c810b1e91dabe2ba8016f078c1e5de4b056b5939478f',
    );
  });

  it('rejects malformed input', () => {
    expect(() => extendChain(new Uint8Array(31), root, 5, 1)).toThrow();
    expect(() => extendChain(EMPTY_ACCUMULATOR, new Uint8Array(31), 5, 1)).toThrow();
    expect(() => extendChain(EMPTY_ACCUMULATOR, root, 0, 1)).toThrow();
  });
});

describe('hex helpers', () => {
  it('round-trip', () => {
    const bytes = hashLeaf(leaf());
    expect(equalHashes(fromHex(toHex(bytes)), bytes)).toBe(true);
  });

  it('rejects malformed hex', () => {
    expect(() => fromHex('abc')).toThrow(MerkleError);
    expect(() => fromHex('zz')).toThrow(MerkleError);
  });
});
