import { buildProof, buildTree, computeRoot, equalHashes, fromHex, toHex, type ProofStep } from '@probatio/commit';
import { distribute, rulesetHashHex, type Ruleset } from '@probatio/seasons';
import { rankSeason, type Standing } from './rank';
import { EMPTY_SEASON_ROOT, hashResultLeaf, resultLeaves } from './results';

/**
 * Finalizing a season into something anyone can check.
 *
 * A season ends and somebody has to say who won and what they are owed. The
 * danger is that "somebody" is us: a payout the operator simply asserts is a
 * payout nobody can dispute and everybody has to trust. This turns the ending
 * into a document that recomputes.
 *
 * `buildFinalization` takes the raw inputs a season produced (every entrant's
 * final standing and the on-chain accumulator that ties it to their committed
 * trades) and derives everything else: the ranking, the split, the results
 * root, and a proof per winner. `verifyFinalization` runs the same derivation
 * from the published inputs and checks it lands on the same root, so a third
 * party arrives at the payout we did without our cooperation.
 *
 * What this layer proves and what it does not: it proves the ranking, the split,
 * and the root all follow deterministically from the published standings and the
 * committed ruleset, so the operator cannot pay the wrong people or the wrong
 * amounts for the standings on the table. It does not by itself prove that a
 * standing's finalEquity was itself computed honestly from the trades: the
 * accumulator ties each entrant to their committed trade history (checkable
 * against the chain), and replaying those trades to reproduce the equity is the
 * next layer, left for when the trade data is published.
 */

export class FinalizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FinalizeError';
  }
}

/** A season entrant and the commitment that anchors their result to the chain. */
export interface Entrant {
  readonly standing: Standing;
  /** Hex of the entrant's confirmed on-chain TraderRecord accumulator. */
  readonly accumulator: string;
}

export interface FinalizationInput {
  readonly seasonOrdinal: number;
  /** The ruleset hash the season published up front and committed to. */
  readonly rulesetHash: string;
  /** The parameters a verifier needs to reproduce the split. */
  readonly ruleset: Ruleset;
  readonly potLamports: bigint;
  /** What entrants paid in, the base the house cut applies to. */
  readonly houseBaseLamports: bigint;
  readonly entrants: readonly Entrant[];
}

export interface PlacePayout {
  readonly place: number;
  readonly lamports: bigint;
}

export interface FinalizedRow {
  readonly rank: number;
  readonly trader: string;
  readonly enteredAt: number;
  readonly startingBalance: bigint;
  readonly finalEquity: bigint;
  readonly returnBps: number;
  readonly tradeCount: number;
  readonly payoutLamports: bigint;
  /** The confirmed on-chain accumulator, for cross-checking against the chain. */
  readonly accumulator: string;
  /** Proof of this row's result leaf against `resultsRoot`. */
  readonly proof: readonly ProofStep[];
}

export interface Finalization {
  readonly seasonOrdinal: number;
  readonly rulesetHash: string;
  /** The 32 bytes finalize records and the distributor funds against, hex. */
  readonly resultsRoot: string;
  readonly potLamports: bigint;
  readonly houseBaseLamports: bigint;
  readonly houseLamports: bigint;
  readonly distributableLamports: bigint;
  readonly payouts: readonly PlacePayout[];
  /** Every entrant, in rank order, with their payout, accumulator, and proof. */
  readonly rows: readonly FinalizedRow[];
}

/**
 * Derive a season's finalization from its raw inputs.
 *
 * Deterministic: the same inputs always produce the same root, which is the
 * property the whole thing rests on.
 */
export function buildFinalization(input: FinalizationInput): Finalization {
  const dist = distribute(input.ruleset, input.potLamports, input.entrants.length, {
    houseBaseLamports: input.houseBaseLamports,
  });
  const payouts = dist.payouts.map((payout) => ({ place: payout.place, lamports: payout.lamports }));

  const base = {
    seasonOrdinal: input.seasonOrdinal,
    rulesetHash: input.rulesetHash,
    potLamports: input.potLamports,
    houseBaseLamports: input.houseBaseLamports,
    houseLamports: dist.house,
    distributableLamports: dist.distributable,
    payouts,
  };

  // An empty season still finalizes, with the stand-in root that means "nobody
  // entered" rather than "not finalized".
  if (input.entrants.length === 0) {
    return { ...base, resultsRoot: toHex(EMPTY_SEASON_ROOT), rows: [] };
  }

  const ranked = rankSeason(input.entrants.map((entrant) => entrant.standing));
  const leaves = resultLeaves(input.seasonOrdinal, ranked, dist.payouts);
  const tree = buildTree(leaves.map(hashResultLeaf));

  const accumulators = new Map(
    input.entrants.map((entrant) => [entrant.standing.trader, entrant.accumulator]),
  );

  const rows: FinalizedRow[] = ranked.map((standing, index) => {
    const accumulator = accumulators.get(standing.trader);
    if (accumulator === undefined) {
      throw new FinalizeError(`no accumulator for ranked trader ${standing.trader}`);
    }
    return {
      rank: standing.rank,
      trader: standing.trader,
      enteredAt: standing.enteredAt,
      startingBalance: standing.startingBalance,
      finalEquity: standing.finalEquity,
      returnBps: standing.returnBps,
      tradeCount: standing.tradeCount,
      payoutLamports: leaves[index]!.payoutLamports,
      accumulator,
      proof: buildProof(tree, index),
    };
  });

  return { ...base, resultsRoot: toHex(tree.root), rows };
}

export interface VerifyResult {
  readonly ok: boolean;
  /** Null when ok; otherwise the first thing that did not check out. */
  readonly reason: string | null;
}

function fail(reason: string): VerifyResult {
  return { ok: false, reason };
}

/**
 * Recompute a finalization from its own published contents and confirm it.
 *
 * Takes only the finalization and the ruleset it names, treats the ranks and
 * payouts in the rows as claims to be re-derived rather than trusted, and checks
 * three things: the ruleset really hashes to the committed hash, rebuilding the
 * ranking and split from the raw standings reproduces the same root, and every
 * row's proof leads to that root. Anything an operator changed to pay the wrong
 * person breaks one of the three.
 */
export function verifyFinalization(final: Finalization, ruleset: Ruleset): VerifyResult {
  // The ruleset a verifier was handed must be the one the season committed to,
  // or the split it recomputes is against different rules than were published.
  if (rulesetHashHex(ruleset) !== final.rulesetHash) {
    return fail('the ruleset does not hash to the committed ruleset hash');
  }

  const entrants: Entrant[] = final.rows.map((row) => ({
    standing: {
      trader: row.trader,
      enteredAt: row.enteredAt,
      startingBalance: row.startingBalance,
      finalEquity: row.finalEquity,
      tradeCount: row.tradeCount,
    },
    accumulator: row.accumulator,
  }));

  const rebuilt = buildFinalization({
    seasonOrdinal: final.seasonOrdinal,
    rulesetHash: final.rulesetHash,
    ruleset,
    potLamports: final.potLamports,
    houseBaseLamports: final.houseBaseLamports,
    entrants,
  });

  if (rebuilt.resultsRoot !== final.resultsRoot) {
    return fail('recomputing the ranking and split does not reproduce the results root');
  }

  // The rows themselves, re-derived, must match what was published, so a swapped
  // rank or amount that happened to leave the root alone still cannot slip by.
  if (rebuilt.rows.length !== final.rows.length) {
    return fail('the number of rows changed when recomputed');
  }
  for (let i = 0; i < final.rows.length; i += 1) {
    const published = final.rows[i]!;
    const derived = rebuilt.rows[i]!;
    if (
      published.rank !== derived.rank ||
      published.trader !== derived.trader ||
      published.payoutLamports !== derived.payoutLamports ||
      published.returnBps !== derived.returnBps
    ) {
      return fail(`row ${i} does not match its recomputed rank, trader, return, or payout`);
    }
  }

  // Every proof must lead to the root, independently of the rebuild above.
  const root = fromHex(final.resultsRoot);
  for (const row of final.rows) {
    const leafHash = hashResultLeaf({
      seasonOrdinal: final.seasonOrdinal,
      rank: row.rank,
      trader: row.trader,
      startingBalance: row.startingBalance,
      finalEquity: row.finalEquity,
      returnBps: row.returnBps,
      tradeCount: row.tradeCount,
      payoutLamports: row.payoutLamports,
    });
    if (!equalHashes(computeRoot(leafHash, row.proof), root)) {
      return fail(`the proof for ${row.trader} does not lead to the results root`);
    }
  }

  return { ok: true, reason: null };
}
