/**
 * When a season does not count.
 *
 * This is the most dangerous page in the project, and it exists because
 * refusing to write it would be worse. A season can genuinely be ruined by
 * something nobody chose — a chain halt, a bug in the fill engine, a keeper
 * that stopped committing — and with a pot on the table, "we will decide at the
 * time" means the person who decides is the person the winner is arguing with.
 *
 * So the conditions are measured, not judged. Every one is a number taken from
 * recorded data, compared against a threshold that is part of the ruleset hash
 * and therefore fixed before anybody enters. The same measurements always
 * produce the same verdict, and nobody has a lever.
 *
 * Two rules do the real work:
 *
 * A season is void or it is not. There is no partial void, no adjusted
 * standings, no replay. Replaying a season is the most tempting remedy and the
 * worst one, because a replay's result is whatever the person running it says
 * it is.
 *
 * And a finalized season can never be voided. Once the results root is on
 * chain the season is settled forever, however unpopular the winner. Without
 * that bound, every void condition is a way to cancel a result somebody
 * dislikes after seeing it.
 */

export class VoidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoidError';
  }
}

/**
 * The thresholds, hashed into the ruleset.
 *
 * In the hash because they decide whether a pot is paid. Thresholds that could
 * be edited during a season are not a policy, they are an intention.
 */
export interface VoidPolicy {
  /**
   * Minutes the price feed may be unavailable before the season is void.
   *
   * Not zero: a public RPC hiccups, and a policy that voids on any interruption
   * would void every season. This is the point at which enough of the season
   * was untradeable that the results describe availability rather than skill.
   */
  readonly maxFeedOutageMinutes: number;
  /** Minutes the chain itself may stop producing blocks. */
  readonly maxChainHaltMinutes: number;
  /**
   * Trades that may be left uncommitted when the season closes.
   *
   * Zero. A trade that was never committed cannot be verified by anybody, and a
   * season whose record is partly unverifiable has no claim on anyone's trust.
   */
  readonly maxUncommittedTrades: number;
  /**
   * Trades whose stored leaf does not reproduce from its own inputs.
   *
   * Zero, for the same reason. One trade that cannot be rebuilt means the
   * engine and the record disagree, and there is no way to tell which is wrong.
   */
  readonly maxIrreproducibleTrades: number;
}

export const DEFAULT_VOID_POLICY: VoidPolicy = {
  // Two hours of a seven-day season. Long enough to survive a bad afternoon on
  // a public endpoint, short enough that a real outage is caught.
  maxFeedOutageMinutes: 120,
  // Solana has halted for hours before. That is not a season anybody traded.
  maxChainHaltMinutes: 60,
  maxUncommittedTrades: 0,
  maxIrreproducibleTrades: 0,
};

/** What is measured, all of it from recorded data. */
export interface VoidMeasurements {
  readonly feedOutageMinutes: number;
  readonly chainHaltMinutes: number;
  readonly uncommittedTrades: number;
  readonly irreproducibleTrades: number;
  /** Engine versions seen across the season's trades. More than one is fatal. */
  readonly engineVersions: readonly number[];
  /** The version the season was created with. */
  readonly declaredEngineVersion: number;
}

export type VoidCondition =
  | 'feed_outage'
  | 'chain_halt'
  | 'uncommitted_trades'
  | 'irreproducible_trades'
  | 'engine_changed';

export interface VoidVerdict {
  readonly isVoid: boolean;
  readonly conditions: readonly VoidCondition[];
  /** Every measurement against its threshold, whether it fired or not. */
  readonly report: readonly {
    condition: VoidCondition;
    measured: string;
    threshold: string;
    breached: boolean;
  }[];
}

export function assessVoid(
  measurements: VoidMeasurements,
  policy: VoidPolicy = DEFAULT_VOID_POLICY,
): VoidVerdict {
  // The engine version is not a threshold but an identity. A season is a
  // measurement taken under stated conditions; if the conditions changed
  // mid-way, the results are not comparable to each other, never mind to
  // another season.
  const versions = [...new Set(measurements.engineVersions)];
  const engineChanged =
    versions.length > 1 ||
    (versions.length === 1 && versions[0] !== measurements.declaredEngineVersion);

  const report = [
    {
      condition: 'feed_outage' as const,
      measured: `${measurements.feedOutageMinutes} minutes`,
      threshold: `${policy.maxFeedOutageMinutes} minutes`,
      breached: measurements.feedOutageMinutes > policy.maxFeedOutageMinutes,
    },
    {
      condition: 'chain_halt' as const,
      measured: `${measurements.chainHaltMinutes} minutes`,
      threshold: `${policy.maxChainHaltMinutes} minutes`,
      breached: measurements.chainHaltMinutes > policy.maxChainHaltMinutes,
    },
    {
      condition: 'uncommitted_trades' as const,
      measured: String(measurements.uncommittedTrades),
      threshold: String(policy.maxUncommittedTrades),
      breached: measurements.uncommittedTrades > policy.maxUncommittedTrades,
    },
    {
      condition: 'irreproducible_trades' as const,
      measured: String(measurements.irreproducibleTrades),
      threshold: String(policy.maxIrreproducibleTrades),
      breached: measurements.irreproducibleTrades > policy.maxIrreproducibleTrades,
    },
    {
      condition: 'engine_changed' as const,
      measured: versions.length === 0 ? 'none' : versions.join(', '),
      threshold: `only ${measurements.declaredEngineVersion}`,
      breached: engineChanged,
    },
  ];

  const conditions = report.filter((row) => row.breached).map((row) => row.condition);
  return { isVoid: conditions.length > 0, conditions, report };
}

/**
 * Whether a season may still be voided at all.
 *
 * The bound that makes the rest of this safe. Once the results root is on
 * chain, the season is over — however unpopular the winner is, and however
 * loudly anyone argues afterwards.
 */
export function voidableNow(finalizedAt: number | null): boolean {
  return finalizedAt === null;
}

export interface Refund {
  readonly trader: string;
  readonly lamports: bigint;
}

/**
 * What a void season pays.
 *
 * Everybody gets exactly what they paid, and the house takes nothing. Not a
 * share of the pot — the pot is not divided in a void season, it is unwound.
 * Taking a cut of a season that did not happen would make voiding one a way to
 * earn from failure.
 */
export function refunds(entries: readonly { trader: string; paid: bigint }[]): Refund[] {
  return entries.map((entry) => {
    if (entry.paid < 0n) throw new VoidError(`entry paid a negative amount: ${entry.paid}`);
    return { trader: entry.trader, lamports: entry.paid };
  });
}

export function explainCondition(condition: VoidCondition): string {
  switch (condition) {
    case 'feed_outage':
      return 'Prices were unavailable for longer than the season allows, so results would describe who could trade rather than who traded well.';
    case 'chain_halt':
      return 'The chain stopped producing blocks for longer than the season allows.';
    case 'uncommitted_trades':
      return 'Some trades were never committed on chain, so the record cannot be verified by anyone.';
    case 'irreproducible_trades':
      return 'Some trades cannot be rebuilt from their own recorded inputs, so the engine and the record disagree.';
    case 'engine_changed':
      return 'The fill engine changed during the season, so the results were not all produced under the same conditions.';
  }
}
