import { describe, expect, it } from 'vitest';
import { LAMPORTS_PER_SOL, rulesetFor, rulesetHashHex, type Ruleset } from '@probatio/seasons';
import { verifyProof, fromHex } from '@probatio/commit';
import { EMPTY_SEASON_ROOT, resultsRootHex } from '../src/results';
import { hashResultLeaf } from '../src/results';
import { buildFinalization, verifyFinalization, type Entrant } from '../src/finalize';
import type { Standing } from '../src/rank';

const RULES: Ruleset = rulesetFor(1);
const RULESET_HASH = rulesetHashHex(RULES);
const START = 10_000_000_000n;

// Real 32-byte base58 addresses, distinct.
const TRADERS = [
  '7xKXtg2CW3cWCLBmVvKcbAkKM6mzTuKMYqM9dAcuLNwr',
  '3SPyj7fHQ6TKGR5Agua1gPdCnb2oWHF8Zi8bY33bpump',
  '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
  'CjkJKZ8sYkQ6mZnA1nZ1Tn2dK9m4b6Yc7dEfGhJkLmNo',
  'Es9vMFrzaCERmJfrF4H2FYD4KConky11McCe8BenwNYB',
];

function entrant(index: number, finalEquity: bigint, enteredAt = 1_000 + index): Entrant {
  const standing: Standing = {
    trader: TRADERS[index]!,
    enteredAt,
    startingBalance: START,
    finalEquity,
    tradeCount: 3 + index,
  };
  // A stand-in accumulator, distinct per trader. The finalization layer only
  // carries it through for a verifier to cross-check against the chain.
  return { standing, accumulator: `ac${index.toString(16).padStart(62, '0')}` };
}

function input(entrants: Entrant[], pot: bigint) {
  return {
    seasonOrdinal: 1,
    rulesetHash: RULESET_HASH,
    ruleset: RULES,
    potLamports: pot,
    houseBaseLamports: 0n, // sponsor-funded: no entries, no house cut
    entrants,
  };
}

describe('buildFinalization', () => {
  it('ranks by return and pays the split, in one document', () => {
    // Three traders: +50%, +10%, -20%. First place is the +50% trader.
    const entrants = [
      entrant(0, START + START / 2n),
      entrant(1, START + START / 10n),
      entrant(2, START - START / 5n),
    ];
    const pot = 3n * LAMPORTS_PER_SOL;
    const final = buildFinalization(input(entrants, pot));

    expect(final.rows.map((row) => row.rank)).toEqual([1, 2, 3]);
    expect(final.rows[0]!.trader).toBe(TRADERS[0]);
    expect(final.rows[2]!.trader).toBe(TRADERS[2]);

    // Every lamport of the distributable is paid out, and to real places.
    const paid = final.payouts.reduce((sum, p) => sum + p.lamports, 0n);
    expect(paid).toBe(final.distributableLamports);
    // The winner's row carries the first-place payout.
    expect(final.rows[0]!.payoutLamports).toBe(final.payouts[0]!.lamports);
  });

  it('is deterministic: the same inputs give the same root', () => {
    const entrants = [entrant(0, START + 1n), entrant(1, START + 2n)];
    const a = buildFinalization(input(entrants, LAMPORTS_PER_SOL));
    const b = buildFinalization(input(entrants, LAMPORTS_PER_SOL));
    expect(a.resultsRoot).toBe(b.resultsRoot);
  });

  it('finalizes an empty season with the empty-season root, not zero', () => {
    const final = buildFinalization(input([], 0n));
    expect(final.resultsRoot).toBe(resultsRootHex([]));
    expect(final.resultsRoot).toBe(
      Array.from(EMPTY_SEASON_ROOT, (b) => b.toString(16).padStart(2, '0')).join(''),
    );
    expect(final.rows).toHaveLength(0);
    expect(verifyFinalization(final, RULES).ok).toBe(true);
  });

  it('gives each winner a proof that leads to the results root', () => {
    const entrants = [entrant(0, START * 2n), entrant(1, START + 5n), entrant(2, START)];
    const final = buildFinalization(input(entrants, 2n * LAMPORTS_PER_SOL));
    const root = fromHex(final.resultsRoot);

    for (const row of final.rows) {
      const leaf = hashResultLeaf({
        seasonOrdinal: final.seasonOrdinal,
        rank: row.rank,
        trader: row.trader,
        startingBalance: row.startingBalance,
        finalEquity: row.finalEquity,
        returnBps: row.returnBps,
        tradeCount: row.tradeCount,
        payoutLamports: row.payoutLamports,
      });
      expect(verifyProof(leaf, row.proof, root)).toBe(true);
    }
  });
});

describe('verifyFinalization', () => {
  const entrants = [entrant(0, START * 2n), entrant(1, START + 100n), entrant(2, START - 1n)];
  const final = buildFinalization(input(entrants, 5n * LAMPORTS_PER_SOL));

  it('accepts a finalization recomputed from its own contents', () => {
    expect(verifyFinalization(final, RULES)).toEqual({ ok: true, reason: null });
  });

  it('rejects a ruleset that does not match the committed hash', () => {
    const other = rulesetFor(2);
    const result = verifyFinalization(final, other);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/ruleset/);
  });

  it('rejects a payout amount that was tampered with', () => {
    // Move a lamport to the winner without touching the root: the recompute
    // catches it because the published rows no longer match the derived ones.
    const tampered = {
      ...final,
      rows: final.rows.map((row, i) =>
        i === 0 ? { ...row, payoutLamports: row.payoutLamports + 1n } : row,
      ),
    };
    expect(verifyFinalization(tampered, RULES).ok).toBe(false);
  });

  it('rejects a swapped winner', () => {
    // Put the last-place trader in the first row. The recomputed ranking and the
    // proofs both disagree.
    const swapped = {
      ...final,
      rows: [{ ...final.rows[0]!, trader: final.rows[2]!.trader }, ...final.rows.slice(1)],
    };
    expect(verifyFinalization(swapped, RULES).ok).toBe(false);
  });

  it('rejects a tampered results root', () => {
    const badRoot = { ...final, resultsRoot: '00'.repeat(32) };
    expect(verifyFinalization(badRoot, RULES).ok).toBe(false);
  });
});
