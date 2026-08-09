import { quoteBuy, quoteSell, type PoolState } from '@probatio/sim';
import { QuoteError } from '@probatio/sim';
import type { TradeEvent } from '@probatio/pools';
import { PUMPFUN_CURVE_FEES } from '@probatio/pools';

/**
 * Replaying real trades through the fill engine.
 *
 * This is the gate the rest of the project stands on. Every claim Probatio
 * makes — that a record means something, that a leaderboard reflects skill —
 * reduces to whether a simulated fill matches what the chain actually did. If
 * it does not, the seasons and the capital allocation are built on nothing.
 *
 * Pure. Takes events in, produces a report. The fetching lives elsewhere so
 * this can be tested without a network and rerun over stored samples.
 */

export interface OrderedEvent {
  readonly event: TradeEvent;
  readonly slot: number;
  /** Position within its transaction. Several trades can share a slot. */
  readonly indexInTx: number;
}

export type SkipReason =
  | 'not_consecutive'
  | 'unquotable'
  | 'first_event';

export interface Sample {
  readonly side: 'buy' | 'sell';
  /** Absolute relative error, in basis points. */
  readonly errorBps: number;
  /**
   * The same error, signed.
   *
   * Positive means the engine gave the trader *more* than the chain did. That
   * direction is the dangerous one: a simulator that is systematically generous
   * on some token is a free money printer for anyone who notices, and they will
   * trade nothing else. Negative is merely unfair to the trader, which is a bug
   * but not an exploit.
   */
  readonly signedErrorBps: number;
  readonly expected: bigint;
  readonly actual: bigint;
  readonly slot: number;
}

export interface ValidationReport {
  readonly mint: string;
  readonly engineVersion: number;
  readonly eventsSeen: number;
  readonly samples: number;
  readonly buys: number;
  readonly sells: number;
  readonly skipped: Readonly<Record<SkipReason, number>>;
  /** Basis points. Zero means exact to the smallest unit. */
  readonly medianErrorBps: number;
  readonly p95ErrorBps: number;
  readonly maxErrorBps: number;
  readonly exactMatches: number;
  readonly exactRate: number;
  readonly worst: readonly Sample[];
  /** Every sample, for the drift monitor to assess direction. */
  readonly allSamples: readonly Sample[];
}

function stateAfter(event: TradeEvent, mint: string): PoolState {
  return {
    mint,
    solReserve: event.virtualSolReserves,
    tokenReserve: event.virtualTokenReserves,
    deliverableTokens: event.realTokenReserves,
    tokenDecimals: 6,
    fees: PUMPFUN_CURVE_FEES,
    source: 'pumpfun-curve',
    slot: 0,
  };
}

/**
 * Whether one event genuinely follows another.
 *
 * Pure reserve arithmetic, independent of the fill engine: applying the
 * recorded amounts to the previous reserves must land exactly on the current
 * ones. If it does not, something moved the curve in between that this walk did
 * not see, and the pair says nothing about whether the engine is right.
 *
 * Checking this rather than tolerating outliers is what makes the resulting
 * error figure trustworthy. A harness that quietly accepts unrelated pairs and
 * then reports a low median has measured its own leniency.
 *
 * It also independently confirms that a TradeEvent's `sol_amount` is the
 * curve-side amount excluding fees — the arithmetic only closes if it is.
 */
export function isConsecutive(previous: TradeEvent, current: TradeEvent): boolean {
  const expectedSol = current.isBuy
    ? previous.virtualSolReserves + current.solAmount
    : previous.virtualSolReserves - current.solAmount;

  const expectedTokens = current.isBuy
    ? previous.virtualTokenReserves - current.tokenAmount
    : previous.virtualTokenReserves + current.tokenAmount;

  return (
    expectedSol === current.virtualSolReserves && expectedTokens === current.virtualTokenReserves
  );
}

/** Signed relative error in bps. Positive means the engine was generous. */
function signedErrorBps(mine: bigint, actual: bigint): number {
  if (actual === 0n) return mine === 0n ? 0 : 10_000;
  const difference = mine - actual;
  const magnitude = difference < 0n ? -difference : difference;
  const bps = Number((magnitude * 10_000n) / actual);
  return difference < 0n ? -bps : bps;
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index]!;
}

/**
 * Run the engine over an ordered run of events and measure how closely it
 * reproduces them.
 *
 * The comparison is made on the curve side, because that is what the event
 * records. A buy's gross input is reconstructed from it; a sell's gross output
 * is the engine's proceeds plus its fee.
 */
export function replay(
  mint: string,
  ordered: readonly OrderedEvent[],
  engineVersion: number,
): ValidationReport {
  const samples: Sample[] = [];
  const skipped: Record<SkipReason, number> = {
    not_consecutive: 0,
    unquotable: 0,
    first_event: ordered.length > 0 ? 1 : 0,
  };

  for (let i = 1; i < ordered.length; i += 1) {
    const previous = ordered[i - 1]!.event;
    const current = ordered[i]!;
    const event = current.event;

    if (!isConsecutive(previous, event)) {
      skipped.not_consecutive += 1;
      continue;
    }

    const before = stateAfter(previous, mint);

    try {
      if (event.isBuy) {
        // The event records what reached the curve. A trader's gross input is
        // that plus the fee, and the program's own `- 1` means one more
        // lamport on top.
        const gross =
          (event.solAmount * 10_125n + 9_999n) / 10_000n + 1n;
        const quote = quoteBuy(before, gross);
        const signed = signedErrorBps(quote.tokenAmount, event.tokenAmount);
        samples.push({
          side: 'buy',
          errorBps: Math.abs(signed),
          signedErrorBps: signed,
          expected: event.tokenAmount,
          actual: quote.tokenAmount,
          slot: current.slot,
        });
      } else {
        const quote = quoteSell(before, event.tokenAmount);
        const gross = quote.solAmount + quote.feeLamports;
        const signed = signedErrorBps(gross, event.solAmount);
        samples.push({
          side: 'sell',
          errorBps: Math.abs(signed),
          signedErrorBps: signed,
          expected: event.solAmount,
          actual: gross,
          slot: current.slot,
        });
      }
    } catch (error) {
      if (!(error instanceof QuoteError)) throw error;
      skipped.unquotable += 1;
    }
  }

  const errors = samples.map((sample) => sample.errorBps).sort((a, b) => a - b);
  const exactMatches = errors.filter((error) => error === 0).length;

  return {
    mint,
    engineVersion,
    eventsSeen: ordered.length,
    samples: samples.length,
    buys: samples.filter((sample) => sample.side === 'buy').length,
    sells: samples.filter((sample) => sample.side === 'sell').length,
    skipped,
    medianErrorBps: percentile(errors, 0.5),
    p95ErrorBps: percentile(errors, 0.95),
    maxErrorBps: errors.length ? errors[errors.length - 1]! : 0,
    exactMatches,
    exactRate: samples.length ? exactMatches / samples.length : 0,
    worst: [...samples].sort((a, b) => b.errorBps - a.errorBps).slice(0, 5),
    allSamples: samples,
  };
}

/** Combine per-token reports into one figure for the whole run. */
export function combine(mint: string, reports: readonly ValidationReport[]): ValidationReport {
  const all: Sample[] = [];
  const skipped: Record<SkipReason, number> = {
    not_consecutive: 0,
    unquotable: 0,
    first_event: 0,
  };

  let eventsSeen = 0;
  let buys = 0;
  let sells = 0;

  for (const report of reports) {
    eventsSeen += report.eventsSeen;
    buys += report.buys;
    sells += report.sells;
    skipped.not_consecutive += report.skipped.not_consecutive;
    skipped.unquotable += report.skipped.unquotable;
    skipped.first_event += report.skipped.first_event;
    all.push(...report.worst);
  }

  // Percentiles cannot be averaged, so they are recomputed from the pooled
  // sample counts where possible and reported as the worst case otherwise.
  const totalSamples = reports.reduce((sum, report) => sum + report.samples, 0);
  const exactMatches = reports.reduce((sum, report) => sum + report.exactMatches, 0);

  return {
    mint,
    engineVersion: reports[0]?.engineVersion ?? 0,
    eventsSeen,
    samples: totalSamples,
    buys,
    sells,
    skipped,
    medianErrorBps: Math.max(...reports.map((report) => report.medianErrorBps), 0),
    p95ErrorBps: Math.max(...reports.map((report) => report.p95ErrorBps), 0),
    maxErrorBps: Math.max(...reports.map((report) => report.maxErrorBps), 0),
    exactMatches,
    exactRate: totalSamples ? exactMatches / totalSamples : 0,
    worst: all.sort((a, b) => b.errorBps - a.errorBps).slice(0, 5),
    allSamples: reports.flatMap((report) => report.allSamples),
  };
}
