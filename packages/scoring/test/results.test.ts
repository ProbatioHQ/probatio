import { describe, expect, it } from 'vitest';
import { buildProof, buildTree, computeRoot, equalHashes, toHex } from '@probatio/commit';
import { distribute, rulesetFor } from '@probatio/seasons';
import {
  RESULT_LEAF_BYTES,
  VOID_SEASON_ROOT,
  ResultError,
  encodeResultLeaf,
  hashResultLeaf,
  resultLeaves,
  resultsRoot,
  resultsRootHex,
  type ResultLeaf,
} from '../src/results';
import { rankSeason, type Standing } from '../src/rank';

const A = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const B = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const C = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL = 1_000_000_000n;

function leaf(overrides: Partial<ResultLeaf> = {}): ResultLeaf {
  return {
    seasonOrdinal: 1,
    rank: 1,
    trader: A,
    startingBalance: 10n * SOL,
    finalEquity: 20n * SOL,
    returnBps: 10_000,
    tradeCount: 12,
    payoutLamports: SOL,
    ...overrides,
  };
}

describe('encoding a result', () => {
  it('is always the same size', () => {
    expect(encodeResultLeaf(leaf())).toHaveLength(RESULT_LEAF_BYTES);
    expect(encodeResultLeaf(leaf({ rank: 9_999, payoutLamports: 0n }))).toHaveLength(
      RESULT_LEAF_BYTES,
    );
  });

  it('carries a losing season', () => {
    // A negative return is an ordinary result, not an error.
    const encoded = encodeResultLeaf(leaf({ returnBps: -9_999, finalEquity: 1n }));
    expect(encoded).toHaveLength(RESULT_LEAF_BYTES);
  });

  it('refuses a rank below one', () => {
    expect(() => encodeResultLeaf(leaf({ rank: 0 }))).toThrow(ResultError);
  });

  it('refuses an address that is not a key', () => {
    expect(() => encodeResultLeaf(leaf({ trader: 'nope' }))).toThrow(ResultError);
  });
});

describe('what changes the hash', () => {
  const base = toHex(hashResultLeaf(leaf()));

  it('changes with the place', () => {
    expect(toHex(hashResultLeaf(leaf({ rank: 2 })))).not.toBe(base);
  });

  it('changes with the payout', () => {
    // The number a trader is owed. If it were outside the commitment it could
    // be changed after the fact.
    expect(toHex(hashResultLeaf(leaf({ payoutLamports: 2n * SOL })))).not.toBe(base);
  });

  it('changes with the trader', () => {
    expect(toHex(hashResultLeaf(leaf({ trader: B })))).not.toBe(base);
  });

  it('changes with the season', () => {
    expect(toHex(hashResultLeaf(leaf({ seasonOrdinal: 2 })))).not.toBe(base);
  });
});

describe('the committed root', () => {
  const standings: Standing[] = [
    { trader: A, enteredAt: 1, startingBalance: 10n * SOL, finalEquity: 30n * SOL, tradeCount: 8 },
    { trader: B, enteredAt: 2, startingBalance: 10n * SOL, finalEquity: 20n * SOL, tradeCount: 3 },
    { trader: C, enteredAt: 3, startingBalance: 10n * SOL, finalEquity: 4n * SOL, tradeCount: 40 },
  ];

  const rules = rulesetFor(1);
  const ranked = rankSeason(standings);
  // A pot under one SOL: winner takes all, so the others are committed with
  // nothing. Third place in a three-place band would be paid.
  const split = distribute(rules, SOL / 2n, standings.length);
  const leaves = resultLeaves(1, ranked, split.payouts);

  it('has a row for everybody, paid or not', () => {
    // An unpaid place is still in the season, and their result is still part
    // of what was committed.
    expect(leaves).toHaveLength(3);
    expect(leaves[0]!.payoutLamports).toBeGreaterThan(0n);
    expect(leaves[1]!.payoutLamports).toBe(0n);
    expect(leaves[2]!.payoutLamports).toBe(0n);
  });

  it('matches payouts to places', () => {
    expect(leaves[0]!.rank).toBe(1);
    expect(leaves[0]!.payoutLamports).toBe(split.payouts[0]!.lamports);
  });

  it('is 32 bytes', () => {
    expect(resultsRootHex(leaves)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    expect(resultsRootHex(leaves)).toBe(resultsRootHex(resultLeaves(1, rankSeason(standings), split.payouts)));
  });

  it('lets one trader prove their place without the others being published', () => {
    // The whole reason for a tree rather than a list.
    const tree = buildTree(leaves.map(hashResultLeaf));
    const proof = buildProof(tree, 1);
    const recomputed = computeRoot(hashResultLeaf(leaves[1]!), proof);

    expect(equalHashes(recomputed, resultsRoot(leaves))).toBe(true);
  });

  it('refuses a proof for a result that was altered', () => {
    // Somebody quietly promoted from second to first.
    const tree = buildTree(leaves.map(hashResultLeaf));
    const proof = buildProof(tree, 1);
    const tampered = { ...leaves[1]!, rank: 1, payoutLamports: 10n * SOL };

    expect(equalHashes(computeRoot(hashResultLeaf(tampered), proof), resultsRoot(leaves))).toBe(
      false,
    );
  });

  it('changes when anybody in the season moves', () => {
    const moved = [...leaves];
    moved[2] = { ...moved[2]!, tradeCount: 41 };
    expect(resultsRootHex(moved)).not.toBe(resultsRootHex(leaves));
  });

  it('commits a season nobody entered', () => {
    // A season that cannot be closed blocks the one after it.
    expect(() => resultsRootHex([])).not.toThrow();
    expect(resultsRootHex([])).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not encode an empty season as not-finalized', () => {
    // On chain a zero root means the season has not been finalized. An empty
    // season IS finalized; its result is that nobody entered.
    expect(resultsRootHex([])).not.toBe('0'.repeat(64));
  });

  it('tells an empty season from one with entrants', () => {
    expect(resultsRootHex(leaves)).not.toBe(resultsRootHex([]));
  });

  it('keeps the three endings distinct', () => {
    // Nobody entered, everybody refunded, and not yet finalized are three
    // different things and must not encode alike.
    const roots = new Set([
      toHex(VOID_SEASON_ROOT),
      resultsRootHex([]),
      resultsRootHex(leaves),
      '0'.repeat(64),
    ]);
    expect(roots.size).toBe(4);
  });
});
