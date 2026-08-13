import type { TradeLeaf } from '@probatio/commit';

/**
 * The public shapes the SDK reads and returns.
 *
 * A `RawLeaf` is a trade as the proof endpoint serves it: the same fields as a
 * `TradeLeaf`, but the six integer amounts arrive as decimal strings because
 * JSON has no bigint. `toLeaf` turns one back into the leaf the hash is computed
 * over.
 */

/** The amount fields that cross the wire as strings rather than bigint. */
export type AmountField =
  | 'solAmount'
  | 'tokenAmount'
  | 'feeLamports'
  | 'solReserve'
  | 'tokenReserve'
  | 'deliverableTokens';

export type RawLeaf = Omit<TradeLeaf, AmountField> & Record<AmountField, string>;

export interface ProofBatch {
  readonly batchIndex: number;
  /** The merkle root over this batch's trades, hex. */
  readonly root: string;
  readonly leaves: number;
  readonly engineVersion: number;
  readonly previousAccumulator: string;
  readonly predictedAccumulator: string;
  readonly txSignature: string | null;
  readonly slot: number | null;
  readonly trades: readonly RawLeaf[];
}

/** Everything a stranger needs to check a record, straight from `/api/proof`. */
export interface ProofBundle {
  readonly trader: string;
  readonly seasonId: number;
  readonly seasonOrdinal: number;
  readonly batches: readonly ProofBatch[];
  /** Present when there is nothing committed to prove. */
  readonly note?: string;
}

export interface VerifyCheck {
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string;
}

/**
 * The result of checking a record against the chain.
 *
 * `verified` is true only when the trades rebuild their roots, the roots fold to
 * the accumulator the record claims, and that accumulator is the one Solana
 * actually holds. `checks` carries each step so a caller can show its work.
 */
export interface VerifiedRecord {
  readonly trader: string;
  readonly seasonOrdinal: number;
  readonly verified: boolean;
  /** The accumulator these committed trades produce, hex. */
  readonly computedAccumulator: string;
  /** The accumulator on chain, hex, or null when there is no record account. */
  readonly onChainAccumulator: string | null;
  readonly tradeCount: number;
  readonly batchCount: number;
  readonly checks: readonly VerifyCheck[];
}

/**
 * A trader's standing in one season, as `/api/profile` serves it.
 *
 * The endpoint keys a season by its row id; it does not carry the ordinal or the
 * display name, so neither is here. The returns it reports are a trader's own
 * metrics (win rate, realised PnL), not a season rank; a season's ranked return
 * lives on the leaderboard, in `SeasonStanding`.
 */
export interface ProfileSeason {
  readonly seasonId: number;
  readonly ranked: boolean;
  readonly freePlay: boolean;
  /** Trades logged in the season. */
  readonly trades: number;
  readonly roundTrips: number;
  /** Win rate over closed round trips, in basis points. */
  readonly winRateBps: number;
  /** Net realised PnL, in base units, as a decimal string. */
  readonly netPnl: string;
  /** How much of the record is on chain: batches committed, and the trades under them. */
  readonly committedBatches: number;
  readonly committedTrades: number;
}

/** A trader's public record, from `/api/profile`. */
export interface ProfileRecord {
  readonly trader: string;
  readonly name: string | null;
  readonly display: string;
  readonly exists: boolean;
  readonly enteredRanked?: boolean;
  readonly seasons: readonly ProfileSeason[];
  /** The path to this trader's proof bundle. */
  readonly proof?: string;
}

export interface SeasonStanding {
  readonly rank: number;
  readonly trader: string;
  readonly name: string | null;
  readonly returnBps: number;
  readonly finalEquity: string;
  readonly startingBalance: string;
  readonly tradeCount: number;
  readonly payoutLamports: string;
}

/** Where a season is in its lifecycle. Mirrors `@probatio/seasons`. */
export type SeasonStatus = 'pending' | 'entry_open' | 'running' | 'closed' | 'finalized';

/** A season's standings, from `/api/leaderboard`. */
export interface Standings {
  readonly season: {
    readonly ordinal: number;
    readonly name: string;
    readonly status: SeasonStatus;
    /** Entrants on the board. */
    readonly entrants: number;
    /** The prize pool, in lamports, as a decimal string. */
    readonly potLamports: string;
    /** The rule the season is ranked by. */
    readonly scoring: string;
  } | null;
  readonly standings: readonly SeasonStanding[];
  /** Total entrants, which may exceed the returned page. Absent when no season is running. */
  readonly total?: number;
  /** True once the season is finalized; until then the board moves with the market. */
  readonly final: boolean;
}
