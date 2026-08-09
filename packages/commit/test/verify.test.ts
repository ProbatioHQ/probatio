import { describe, expect, it } from 'vitest';
import { hashLeaf, type TradeLeaf } from '../src/leaf';
import { buildTree, fromHex, toHex } from '../src/merkle';
import { EMPTY_ACCUMULATOR, extendChain } from '../src/chain';
import { explainVerification, verifyTrade, type CommittedBatch } from '../src/verify';

const TRADER = '7xKXtg2CW3cWCLBmVvKcbAkKM6mzTuKMYqM9dAcuLNwr';
const MINT = '3SPyj7fHQ6TKGR5Agua1gPdCnb2oWHF8Zi8bY33bpump';

function leaf(sequence: number, overrides: Partial<TradeLeaf> = {}): TradeLeaf {
  return {
    sequence,
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

function rootOf(leaves: readonly TradeLeaf[]): string {
  return toHex(buildTree(leaves.map((entry) => hashLeaf(entry))).root);
}

/**
 * A trader with three committed batches, exactly as the keeper would have
 * produced them.
 */
function scenario() {
  const batches = [
    Array.from({ length: 5 }, (_, i) => leaf(i + 1)),
    Array.from({ length: 3 }, (_, i) => leaf(i + 6)),
    Array.from({ length: 8 }, (_, i) => leaf(i + 9)),
  ];

  const history: CommittedBatch[] = batches.map((leaves) => ({
    root: rootOf(leaves),
    leaves: leaves.length,
    engineVersion: 1,
  }));

  let accumulator = EMPTY_ACCUMULATOR;
  for (const entry of history) {
    accumulator = extendChain(
      accumulator,
      fromHex(entry.root),
      entry.leaves,
      entry.engineVersion,
    );
  }

  return { batches, history, onChainAccumulator: toHex(accumulator) };
}

describe('a genuine trade', () => {
  it('verifies', () => {
    const { batches, history, onChainAccumulator } = scenario();
    const result = verifyTrade({
      trade: batches[1]![1]!,
      batchLeaves: batches[1]!,
      batchIndex: 1,
      history,
      onChainAccumulator,
    });

    expect(result.status).toBe('verified');
    expect(result.verified).toBe(true);
    expect(result.expectedAccumulator).toBe(onChainAccumulator);
  });

  it('verifies every trade in every batch', () => {
    const { batches, history, onChainAccumulator } = scenario();
    for (let b = 0; b < batches.length; b += 1) {
      for (const trade of batches[b]!) {
        const result = verifyTrade({
          trade,
          batchLeaves: batches[b]!,
          batchIndex: b,
          history,
          onChainAccumulator,
        });
        expect(result.verified).toBe(true);
      }
    }
  });

  it('shows each step it took', () => {
    // A bare yes is not much use on a verification page; the point is that a
    // reader can follow the argument.
    const { batches, history, onChainAccumulator } = scenario();
    const result = verifyTrade({
      trade: batches[0]![0]!,
      batchLeaves: batches[0]!,
      batchIndex: 0,
      history,
      onChainAccumulator,
    });

    expect(result.steps.map((s) => s.name)).toEqual([
      'hash the trade',
      'find the trade in its batch',
      'rebuild the batch root',
      'match the chain',
    ]);
    expect(result.steps.every((s) => s.ok)).toBe(true);
  });
});

describe('a tampered trade', () => {
  it('fails when any field is altered', () => {
    const { batches, history, onChainAccumulator } = scenario();
    const genuine = batches[0]![2]!;

    const alterations: Partial<TradeLeaf>[] = [
      { solAmount: 1_000_000_001n },
      { tokenAmount: 99n },
      { feeLamports: 0n },
      { solReserve: 1n },
      { priceImpactBps: 1 },
      { filledAtSlot: 999 },
      { engineVersion: 2 },
      { side: 'sell' },
    ];

    for (const alteration of alterations) {
      const result = verifyTrade({
        trade: { ...genuine, ...alteration },
        batchLeaves: batches[0]!,
        batchIndex: 0,
        history,
        onChainAccumulator,
      });
      expect(result.verified).toBe(false);
      expect(result.status).toBe('leaf_not_in_batch');
    }
  });

  it('fails a trade that was never committed at all', () => {
    const { batches, history, onChainAccumulator } = scenario();
    const result = verifyTrade({
      trade: leaf(999),
      batchLeaves: batches[0]!,
      batchIndex: 0,
      history,
      onChainAccumulator,
    });
    expect(result.status).toBe('leaf_not_in_batch');
  });
});

describe('a tampered batch', () => {
  it('fails when a sibling trade is altered', () => {
    // The trade being checked is untouched, but its neighbour is not — so the
    // batch no longer produces the root that was committed. Someone editing
    // history cannot leave the target trade alone and get away with it.
    const { batches, history, onChainAccumulator } = scenario();
    const tampered = [...batches[0]!];
    tampered[4] = leaf(5, { solAmount: 42n });

    const result = verifyTrade({
      trade: batches[0]![0]!,
      batchLeaves: tampered,
      batchIndex: 0,
      history,
      onChainAccumulator,
    });

    expect(result.status).toBe('batch_root_mismatch');
  });

  it('fails when the batch is reordered', () => {
    // A merkle root is not a set.
    const { batches, history, onChainAccumulator } = scenario();
    const reordered = [...batches[0]!];
    [reordered[0], reordered[1]] = [reordered[1]!, reordered[0]!];

    const result = verifyTrade({
      trade: reordered[0]!,
      batchLeaves: reordered,
      batchIndex: 0,
      history,
      onChainAccumulator,
    });

    expect(result.status).toBe('batch_root_mismatch');
  });

  it('fails when a trade is removed from the batch', () => {
    const { batches, history, onChainAccumulator } = scenario();
    const shortened = batches[0]!.slice(0, 4);

    const result = verifyTrade({
      trade: shortened[0]!,
      batchLeaves: shortened,
      batchIndex: 0,
      history,
      onChainAccumulator,
    });

    expect(result.status).toBe('batch_root_mismatch');
  });
});

describe('a tampered history', () => {
  it('fails when a later batch is hidden', () => {
    // Dropping batches is how someone would try to erase a bad run. The chain
    // still holds the accumulator that includes them.
    const { batches, history, onChainAccumulator } = scenario();
    const result = verifyTrade({
      trade: batches[0]![0]!,
      batchLeaves: batches[0]!,
      batchIndex: 0,
      history: history.slice(0, 2),
      onChainAccumulator,
    });

    expect(result.status).toBe('chain_mismatch');
    expect(result.detail).toMatch(/not the one that was committed/);
  });

  it('fails when a batch is inserted', () => {
    const { batches, history, onChainAccumulator } = scenario();
    const inflated = [...history, { root: 'ab'.repeat(32), leaves: 2, engineVersion: 1 }];

    const result = verifyTrade({
      trade: batches[0]![0]!,
      batchLeaves: batches[0]!,
      batchIndex: 0,
      history: inflated,
      onChainAccumulator,
    });

    expect(result.status).toBe('chain_mismatch');
  });

  it('fails when later batches are reordered', () => {
    // The trade's own batch stays at index 0 so the root check still passes,
    // which isolates the chain step. Reordering anything at all changes the
    // accumulator, because a chain is a sequence and not a set.
    const { batches, history, onChainAccumulator } = scenario();
    const swapped = [history[0]!, history[2]!, history[1]!];

    const result = verifyTrade({
      trade: batches[0]![0]!,
      batchLeaves: batches[0]!,
      batchIndex: 0,
      history: swapped,
      onChainAccumulator,
    });

    expect(result.status).toBe('chain_mismatch');
  });

  it('fails at the root step when a batch is swapped under the trade', () => {
    // Swapping the trade's own batch fails earlier and for a different reason,
    // which is worth pinning: the verifier reports the first thing that is
    // actually wrong rather than the last.
    const { batches, history, onChainAccumulator } = scenario();
    const swapped = [history[1]!, history[0]!, history[2]!];

    const result = verifyTrade({
      trade: batches[0]![0]!,
      batchLeaves: batches[0]!,
      batchIndex: 0,
      history: swapped,
      onChainAccumulator,
    });

    expect(result.status).toBe('batch_root_mismatch');
  });

  it('fails when the claimed engine version differs', () => {
    const { batches, history, onChainAccumulator } = scenario();
    const rewritten = history.map((entry, i) =>
      i === 0 ? { ...entry, engineVersion: 2 } : entry,
    );

    const result = verifyTrade({
      trade: batches[0]![0]!,
      batchLeaves: batches[0]!,
      batchIndex: 0,
      history: rewritten,
      onChainAccumulator,
    });

    expect(result.status).toBe('chain_mismatch');
  });
});

describe('missing or malformed input', () => {
  it('reports when the chain has no record', () => {
    const { batches, history } = scenario();
    const result = verifyTrade({
      trade: batches[0]![0]!,
      batchLeaves: batches[0]!,
      batchIndex: 0,
      history,
      onChainAccumulator: null,
    });

    expect(result.status).toBe('chain_mismatch');
    expect(result.detail).toMatch(/no record/);
  });

  it('reports an out-of-range batch index', () => {
    const { batches, history, onChainAccumulator } = scenario();
    const result = verifyTrade({
      trade: batches[0]![0]!,
      batchLeaves: batches[0]!,
      batchIndex: 9,
      history,
      onChainAccumulator,
    });

    expect(result.status).toBe('batch_not_found');
  });
});

describe('explainVerification', () => {
  it('renders a pass', () => {
    const { batches, history, onChainAccumulator } = scenario();
    const text = explainVerification(
      verifyTrade({
        trade: batches[0]![0]!,
        batchLeaves: batches[0]!,
        batchIndex: 0,
        history,
        onChainAccumulator,
      }),
    );

    expect(text).toMatch(/^VERIFIED/);
    expect(text).toContain('match the chain');
  });

  it('renders a failure with the failing step marked', () => {
    const { batches, history, onChainAccumulator } = scenario();
    const text = explainVerification(
      verifyTrade({
        trade: leaf(999),
        batchLeaves: batches[0]!,
        batchIndex: 0,
        history,
        onChainAccumulator,
      }),
    );

    expect(text).toMatch(/^NOT VERIFIED/);
    expect(text).toContain('FAIL find the trade in its batch');
  });
});
