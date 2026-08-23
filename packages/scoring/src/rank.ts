/**
 * Putting a season in order.
 *
 * Highest return wins. That is the whole formula, and it is deliberately not
 * risk-adjusted: with no minimum trade count — which is on purpose, because one
 * good call should be able to win a season — a single trade produces almost no
 * drawdown and therefore a near-infinite risk-adjusted score. The clever
 * formula would have crowned whoever traded least.
 *
 * Ranks are strict. Two traders on the same return do not share a place,
 * because a ranking that reports two firsts cannot pay one, and the money is
 * the reason this function exists.
 */

export interface Standing {
  readonly trader: string;
  /** When they paid to enter. The first tie-break. */
  readonly enteredAt: number;
  readonly startingBalance: bigint;
  /** Cash plus the marked value of anything still held. */
  readonly finalEquity: bigint;
  readonly tradeCount: number;
  /**
   * How many of those were placed by a program rather than by a person.
   *
   * Deliberately absent from `compareStandings` below. How a record was made
   * changes nothing about where it places: an automated entrant is ranked
   * against everybody else on return and on nothing else. This exists to be
   * shown, not weighed.
   *
   * Optional, and that is not laziness. A verifier rebuilds standings out of a
   * published finalization in order to recompute the split, and a finalization
   * does not carry this — it cannot, because the fields in a result leaf are
   * fixed by the hash every already-published season committed to, and adding
   * one would break the verification of all of them. So a standing reconstructed
   * for verification legitimately does not know, and must not be required to.
   * Absent means unrecorded, which is different from zero, and only the board
   * reads it.
   */
  readonly automatedTrades?: number;
}

export interface RankedStanding extends Standing {
  /** From 1, always distinct. */
  readonly rank: number;
  readonly returnBps: number;
}

/**
 * Return in basis points, truncated toward zero.
 *
 * Toward zero rather than down, so a loss is never rounded into a deeper loss
 * and a gain is never rounded into one the trader did not quite make.
 */
export function returnBps(startingBalance: bigint, finalEquity: bigint): number {
  if (startingBalance <= 0n) return 0;
  return Number(((finalEquity - startingBalance) * 10_000n) / startingBalance);
}

/**
 * Compare two standings.
 *
 * Exported because it is the published rule, and a rule nobody can run is a
 * claim. Anyone holding the same standings can sort them and get our order.
 */
export function compareStandings(left: Standing, right: Standing): number {
  const leftReturn = returnBps(left.startingBalance, left.finalEquity);
  const rightReturn = returnBps(right.startingBalance, right.finalEquity);
  if (leftReturn !== rightReturn) return rightReturn - leftReturn;

  // Comparing equity directly rather than trusting the truncated bps: two
  // traders can round to the same basis point while one genuinely finished
  // ahead, and the tie-break should not be spent on a rounding artefact.
  const leftGain = left.finalEquity - left.startingBalance;
  const rightGain = right.finalEquity - right.startingBalance;
  if (leftGain !== rightGain) return rightGain > leftGain ? 1 : -1;

  if (left.enteredAt !== right.enteredAt) return left.enteredAt - right.enteredAt;

  // Arbitrary, and it is meant to be. It exists so the ordering is total. The
  // comparison is the base58 string as-is, which the published ruleset now names
  // exactly (base58 order, not byte order) so a third party reproduces this tie.
  return left.trader < right.trader ? -1 : left.trader > right.trader ? 1 : 0;
}

export function rankSeason(standings: readonly Standing[]): RankedStanding[] {
  return [...standings]
    .sort(compareStandings)
    .map((standing, index) => ({
      ...standing,
      rank: index + 1,
      returnBps: returnBps(standing.startingBalance, standing.finalEquity),
    }));
}

/** Where one trader placed, or null if they were not in the season. */
export function placeOf(ranked: readonly RankedStanding[], trader: string): RankedStanding | null {
  return ranked.find((standing) => standing.trader === trader) ?? null;
}
