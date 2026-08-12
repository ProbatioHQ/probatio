import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THRESHOLDS,
  assessDrift,
  assessToken,
  type DriftThresholds,
} from '../src/drift';
import type { Sample, ValidationReport } from '../src/replay';

function sample(signedErrorBps: number): Sample {
  return {
    side: 'buy',
    errorBps: Math.abs(signedErrorBps),
    signedErrorBps,
    expected: 1_000n,
    actual: 1_000n,
    slot: 1,
  };
}

function samples(signedBps: number, count = 40): Sample[] {
  return Array.from({ length: count }, () => sample(signedBps));
}

function report(mint: string, allSamples: Sample[]): ValidationReport {
  return {
    mint,
    engineVersion: 1,
    eventsSeen: allSamples.length + 1,
    samples: allSamples.length,
    buys: allSamples.length,
    sells: 0,
    skipped: { not_consecutive: 0, unquotable: 0, first_event: 1 },
    medianErrorBps: 0,
    p95ErrorBps: 0,
    maxErrorBps: 0,
    exactMatches: 0,
    exactRate: 0,
    worst: [],
    allSamples,
  };
}

describe('assessToken', () => {
  it('reports ok when the engine matches', () => {
    expect(assessToken('m', samples(0)).severity).toBe('ok');
  });

  it('reports watch for slight drift', () => {
    expect(assessToken('m', samples(2)).severity).toBe('watch');
  });

  it('reports divergent when the engine is badly wrong against the trader', () => {
    // Filling worse than reality is a bug: unfair, worth fixing, but nobody
    // can profit from it.
    const drift = assessToken('m', samples(-40));
    expect(drift.severity).toBe('divergent');
    expect(drift.medianSignedBps).toBeLessThan(0);
  });

  it('reports exploitable at a far smaller generous drift', () => {
    // The asymmetry is the whole point. 10bps in the trader's favour is an
    // incident; 10bps against them is barely worth a ticket.
    expect(assessToken('m', samples(10)).severity).toBe('exploitable');
    expect(assessToken('m', samples(-10)).severity).toBe('watch');
  });

  it('escalates to exploitable before divergent when generous and large', () => {
    // A large generous drift is both, and the dangerous label has to win or
    // the token stays live while someone farms it.
    expect(assessToken('m', samples(200)).severity).toBe('exploitable');
  });

  it('does not judge a token on too few samples', () => {
    // Noise is not evidence. Suspending a token on three trades would make the
    // monitor worse than useless.
    expect(assessToken('m', samples(500, 3)).severity).toBe('ok');
  });

  it('counts how many samples ran generous', () => {
    const mixed = [...samples(5, 10), ...samples(-5, 30)];
    expect(assessToken('m', mixed).generousSamples).toBe(10);
  });

  it('uses the median, so a single outlier cannot trip it', () => {
    const mostlyFine = [...samples(0, 39), sample(9_000)];
    expect(assessToken('m', mostlyFine).severity).toBe('ok');
  });

  it('flags a one-sided generous drift a pooled median would hide', () => {
    // The engine hands out too many tokens on buys but is fair on sells. Buy and
    // sell are separate code paths, so a one-sided bug is the likely one. Thirty
    // fair sells outnumber twenty-one generous buys, so the pooled median sits at
    // zero and the old single-median check read this exploitable token as ok.
    const sells = Array.from({ length: 30 }, () => ({ ...sample(0), side: 'sell' as const }));
    const buys = Array.from({ length: 21 }, () => sample(40));
    const mixed = [...sells, ...buys];

    expect(assessToken('m', mixed).medianSignedBps).toBeLessThan(DEFAULT_THRESHOLDS.exploitableBps);
    expect(assessToken('m', mixed).severity).toBe('exploitable');
  });

  it('respects custom thresholds', () => {
    const strict: DriftThresholds = { ...DEFAULT_THRESHOLDS, exploitableBps: 1 };
    expect(assessToken('m', samples(2), strict).severity).toBe('exploitable');
  });
});

describe('assessDrift', () => {
  it('is ok when every token agrees', () => {
    const assessment = assessDrift([report('a', samples(0)), report('b', samples(0))]);
    expect(assessment.overall).toBe('ok');
    expect(assessment.suspend).toEqual([]);
  });

  it('takes the worst token, not the average', () => {
    // A single farmable token disappears into a healthy average, and that
    // token is precisely the one someone would find.
    const assessment = assessDrift([
      report('healthy1', samples(0)),
      report('healthy2', samples(0)),
      report('farmable', samples(50)),
    ]);

    expect(assessment.overall).toBe('exploitable');
    expect(assessment.suspend).toEqual(['farmable']);
  });

  it('names every token to suspend', () => {
    const assessment = assessDrift([
      report('bad1', samples(30)),
      report('bad2', samples(40)),
      report('fine', samples(0)),
    ]);
    expect(assessment.suspend).toEqual(['bad1', 'bad2']);
  });

  it('does not suspend on a divergence that only hurts the trader', () => {
    const assessment = assessDrift([report('unfair', samples(-100))]);
    expect(assessment.overall).toBe('divergent');
    // Nothing to farm here, so nothing to suspend — but it still has to be
    // reported and fixed.
    expect(assessment.suspend).toEqual([]);
  });

  it('says what to do rather than only what it found', () => {
    const assessment = assessDrift([report('farmable', samples(50))]);
    expect(assessment.summary).toMatch(/suspend/);
    expect(assessment.summary).toContain('farmable');
  });

  it('handles having nothing to assess', () => {
    expect(assessDrift([]).overall).toBe('ok');
    expect(assessDrift([]).summary).toBe('no samples');
  });

  it('ignores reports with no samples', () => {
    const assessment = assessDrift([report('empty', []), report('real', samples(0))]);
    expect(assessment.tokens).toHaveLength(1);
  });

  it('carries the engine version it judged', () => {
    // A drift figure without a version says nothing — the engine changes, and
    // an old reading does not describe the current one.
    expect(assessDrift([report('a', samples(0))]).engineVersion).toBe(1);
  });
});
