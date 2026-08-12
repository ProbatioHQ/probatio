import type { Sample, ValidationReport } from './replay';

/**
 * Watching for the simulator and reality coming apart.
 *
 * D11 asks "is the engine right today". This asks "is it still right", which is
 * a different question with a different threat model. Venue programs change —
 * fee tiers move, formulas get amended, new token variants appear — and the
 * engine will not notice on its own.
 *
 * The danger is not symmetric, and that is the whole design here. An engine
 * that fills a trader *worse* than reality is a bug: unfair, worth fixing,
 * harmless to the leaderboard. An engine that fills them *better* is an
 * exploit. Someone will find the token where the simulator is generous, trade
 * nothing else, and top the board on an arithmetic error. So drift is judged on
 * signed error, per token, and a generous divergence is treated as an incident
 * rather than a defect.
 */

export type DriftSeverity = 'ok' | 'watch' | 'divergent' | 'exploitable';

export interface DriftThresholds {
  /** Drift worth recording but not acting on. */
  readonly watchBps: number;
  /** The engine disagrees with reality by enough to be wrong. */
  readonly divergentBps: number;
  /** The engine is generous by enough to be farmed. */
  readonly exploitableBps: number;
  /** Below this many samples, a token is not judged at all. */
  readonly minSamples: number;
}

/**
 * Deliberately tight, because the engine reproduces the program's arithmetic
 * exactly. Measured drift is normally zero, so a single basis point is already
 * a signal rather than noise — there is no natural jitter to absorb.
 */
export const DEFAULT_THRESHOLDS: DriftThresholds = Object.freeze({
  watchBps: 1,
  divergentBps: 25,
  exploitableBps: 5,
  minSamples: 20,
});

export interface TokenDrift {
  readonly mint: string;
  readonly samples: number;
  /** Median signed error. Positive means the engine is being generous. */
  readonly medianSignedBps: number;
  readonly medianAbsBps: number;
  /** How many samples had the engine giving more than the chain did. */
  readonly generousSamples: number;
  readonly severity: DriftSeverity;
}

export interface DriftAssessment {
  readonly engineVersion: number;
  readonly overall: DriftSeverity;
  readonly tokens: readonly TokenDrift[];
  /**
   * Tokens that should be suspended from ranked trading until this is
   * resolved. Leaving a farmable token live while investigating is how a
   * season's results become worthless.
   */
  readonly suspend: readonly string[];
  readonly totalSamples: number;
  readonly summary: string;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1]! + sorted[middle]!) / 2)
    : sorted[middle]!;
}

function severityOf(
  generousBps: number,
  medianSignedBps: number,
  medianAbsBps: number,
  samples: number,
  thresholds: DriftThresholds,
): DriftSeverity {
  // Checked first and on the generous signal (the worst of the pooled and the
  // per-side medians): being generous is the dangerous direction, and it matters
  // at a far lower magnitude than being wrong. This carries its own sample floor
  // inside `generousBps`, so it can fire on a one-sided drift even when the
  // pooled sample count would gate the other checks.
  if (generousBps >= thresholds.exploitableBps) return 'exploitable';

  // Too little evidence to accuse the engine of anything else.
  if (samples < thresholds.minSamples) return 'ok';

  if (medianAbsBps >= thresholds.divergentBps) return 'divergent';
  if (medianAbsBps >= thresholds.watchBps) return 'watch';
  return 'ok';
}

const RANK: Readonly<Record<DriftSeverity, number>> = Object.freeze({
  ok: 0,
  watch: 1,
  divergent: 2,
  exploitable: 3,
});

function worst(severities: readonly DriftSeverity[]): DriftSeverity {
  return severities.reduce<DriftSeverity>(
    (highest, current) => (RANK[current] > RANK[highest] ? current : highest),
    'ok',
  );
}

export function assessToken(
  mint: string,
  samples: readonly Sample[],
  thresholds: DriftThresholds = DEFAULT_THRESHOLDS,
): TokenDrift {
  const signed = samples.map((sample) => sample.signedErrorBps);
  const absolute = samples.map((sample) => sample.errorBps);

  const medianSignedBps = median(signed);
  const medianAbsBps = median(absolute);

  // The generous (exploitable) direction is judged per side as well as pooled.
  // Buy and sell are separate engine code paths (fee off the input and floored,
  // vs fee off the output and ceiled), so the likely bug is one-sided, and a
  // single pooled median hides it: a token whose buys run +40bps generous but
  // whose sells are fair reads as zero when the two are mixed. A side that on
  // its own has enough samples and a generous median past the threshold is
  // exploitable, whichever way the pooled median lands.
  const generousBySide = (side: Sample['side']): number => {
    const sideSigned = samples.filter((sample) => sample.side === side).map((s) => s.signedErrorBps);
    return sideSigned.length >= thresholds.minSamples
      ? median(sideSigned)
      : Number.NEGATIVE_INFINITY;
  };
  const worstGenerousBps = Math.max(
    samples.length >= thresholds.minSamples ? medianSignedBps : Number.NEGATIVE_INFINITY,
    generousBySide('buy'),
    generousBySide('sell'),
  );

  return {
    mint,
    samples: samples.length,
    medianSignedBps,
    medianAbsBps,
    generousSamples: signed.filter((value) => value > 0).length,
    severity: severityOf(worstGenerousBps, medianSignedBps, medianAbsBps, samples.length, thresholds),
  };
}

/**
 * Assess a set of validation reports for drift.
 *
 * Judged per token rather than only in aggregate. A single divergent token
 * disappears into a healthy average, and that token is exactly the one a farmer
 * would find — the aggregate is the number that would let it through.
 */
export function assessDrift(
  reports: readonly ValidationReport[],
  thresholds: DriftThresholds = DEFAULT_THRESHOLDS,
): DriftAssessment {
  const tokens = reports
    .filter((report) => report.allSamples.length > 0)
    .map((report) => assessToken(report.mint, report.allSamples, thresholds));

  const suspend = tokens
    .filter((token) => token.severity === 'exploitable')
    .map((token) => token.mint);

  const overall = worst(tokens.map((token) => token.severity));
  const totalSamples = tokens.reduce((sum, token) => sum + token.samples, 0);

  return {
    engineVersion: reports[0]?.engineVersion ?? 0,
    overall,
    tokens,
    suspend,
    totalSamples,
    summary: summarise(overall, tokens, suspend, totalSamples),
  };
}

function summarise(
  overall: DriftSeverity,
  tokens: readonly TokenDrift[],
  suspend: readonly string[],
  totalSamples: number,
): string {
  if (tokens.length === 0) return 'no samples';

  if (overall === 'exploitable') {
    return (
      `the simulator is filling better than the chain on ${suspend.length} token(s) — ` +
      `suspend them from ranked trading now: ${suspend.join(', ')}`
    );
  }
  if (overall === 'divergent') {
    const affected = tokens.filter((token) => token.severity === 'divergent');
    return (
      `the engine disagrees with the chain on ${affected.length} token(s) by ` +
      `${Math.max(...affected.map((token) => token.medianAbsBps))}bps — traders are being ` +
      'short-changed, fix before the next season'
    );
  }
  if (overall === 'watch') {
    return `slight drift on some tokens, worth watching (${totalSamples} samples)`;
  }
  return `no drift across ${tokens.length} token(s), ${totalSamples} samples`;
}
