/**
 * What a season costs the keeper to record.
 *
 * Not an operational nicety. If the keeper runs out of SOL mid-season, trades
 * stop being committed — and uncommitted trades are one of the conditions that
 * void a season under the published policy. An empty fee wallet does not
 * degrade the product, it cancels a competition and refunds a prize pool.
 *
 * Which means the number worth computing is not "how much have we spent" but
 * "can this wallet finish the season it is in". The first is bookkeeping; the
 * second is the only one that can be acted on while acting still helps.
 *
 * Costs measured against mainnet rather than derived from constants:
 *
 *   trader record rent   1_816_560 lamports (133 bytes)
 *   transaction fee          5_000 lamports per signature
 *
 * Rent dominates completely. A trader who makes one trade costs almost exactly
 * as much to record as one who makes a thousand, because the record account is
 * created once and the fee to append to it is noise beside its rent.
 */

/** Rent exemption for a TraderRecord, from `getMinimumBalanceForRentExemption`. */
export const RECORD_RENT_LAMPORTS = 1_816_560n;
/** Base fee per signature. Fixed by the network. */
export const SIGNATURE_FEE_LAMPORTS = 5_000n;

export interface SeasonShape {
  /** Traders expected to trade at all. Each one costs a record. */
  readonly traders: number;
  /** Trades each of them makes, on average. */
  readonly tradesEach: number;
  /** Trades folded into one commitment. */
  readonly batchSize: number;
}

export interface CostEstimate {
  readonly records: number;
  readonly commits: number;
  readonly rentLamports: bigint;
  readonly feeLamports: bigint;
  readonly totalLamports: bigint;
}

export function estimateSeasonCost(shape: SeasonShape): CostEstimate {
  const traders = BigInt(Math.max(0, Math.floor(shape.traders)));
  const batch = Math.max(1, Math.floor(shape.batchSize));
  const commitsEach = BigInt(Math.ceil(Math.max(0, shape.tradesEach) / batch));

  const commits = traders * commitsEach;
  const rent = traders * RECORD_RENT_LAMPORTS;
  const fees = commits * SIGNATURE_FEE_LAMPORTS;

  return {
    records: Number(traders),
    commits: Number(commits),
    rentLamports: rent,
    feeLamports: fees,
    totalLamports: rent + fees,
  };
}

export type TreasuryVerdict = 'ok' | 'low' | 'insufficient';

export interface TreasuryCheck {
  readonly verdict: TreasuryVerdict;
  readonly balanceLamports: bigint;
  readonly requiredLamports: bigint;
  readonly shortfallLamports: bigint;
  /** Traders that can still be recorded at this balance. */
  readonly tradersAffordable: number;
  readonly detail: string;
}

export interface TreasuryInput {
  readonly balanceLamports: bigint;
  /** What is still to come, not what the whole season costs. */
  readonly remaining: SeasonShape;
  /**
   * Multiple of the estimate to hold before calling a balance healthy.
   *
   * Above one because the estimate is an average and a season is not obliged
   * to be average. Running out is not recoverable — the season is void — so
   * being wrong in the cheap direction is worth paying for.
   */
  readonly marginBps?: number;
}

const DEFAULT_MARGIN_BPS = 15_000;

export function checkTreasury(input: TreasuryInput): TreasuryCheck {
  const estimate = estimateSeasonCost(input.remaining);
  const margin = BigInt(input.marginBps ?? DEFAULT_MARGIN_BPS);
  const required = (estimate.totalLamports * margin) / 10_000n;

  const affordable = Number(
    input.balanceLamports / (RECORD_RENT_LAMPORTS + SIGNATURE_FEE_LAMPORTS),
  );

  if (input.balanceLamports >= required) {
    return {
      verdict: 'ok',
      balanceLamports: input.balanceLamports,
      requiredLamports: required,
      shortfallLamports: 0n,
      tradersAffordable: affordable,
      detail: 'enough to finish the season with the margin held',
    };
  }

  // Below the estimate itself, not merely below the margin. This is the one
  // that ends a season.
  if (input.balanceLamports < estimate.totalLamports) {
    return {
      verdict: 'insufficient',
      balanceLamports: input.balanceLamports,
      requiredLamports: required,
      shortfallLamports: estimate.totalLamports - input.balanceLamports,
      tradersAffordable: affordable,
      detail:
        'not enough to record the rest of this season. Trades left uncommitted ' +
        'void it under the published policy, so this has to be fixed before it ' +
        'happens rather than after.',
    };
  }

  return {
    verdict: 'low',
    balanceLamports: input.balanceLamports,
    requiredLamports: required,
    shortfallLamports: required - input.balanceLamports,
    tradersAffordable: affordable,
    detail: 'above the estimate but inside the margin — top it up before it matters',
  };
}

/**
 * Whether the pot pays for recording itself.
 *
 * The house cut is the only revenue a season has, and it is taken only above a
 * threshold — so a small season is recorded at a loss by design. Worth knowing
 * which side of the line a season is on before running it rather than after.
 */
export function coversItsCosts(
  potLamports: bigint,
  houseBps: number,
  houseThresholdLamports: bigint,
  cost: CostEstimate,
): { revenueLamports: bigint; covered: boolean } {
  const revenue =
    potLamports > houseThresholdLamports ? (potLamports * BigInt(houseBps)) / 10_000n : 0n;
  return { revenueLamports: revenue, covered: revenue >= cost.totalLamports };
}
