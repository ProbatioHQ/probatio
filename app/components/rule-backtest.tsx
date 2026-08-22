'use client';

import { useState } from 'react';
import type { ExitReason } from '@probatio/sim';

/**
 * What an exit rule would have done on this token.
 *
 * The question somebody has while staring at a chart, answered against the pool
 * rather than against the chart. Everybody's rule works on a line: a take
 * profit fires wherever the line crossed it. What decides whether it works is
 * what a real sell would have fetched out of the reserves at that moment, after
 * your own order moved them and after the fee, and on a token thin enough to
 * double in a minute those two numbers are nowhere near each other.
 *
 * So this shows both, side by side, and the gap between them is the point. It
 * is the number a chart cannot tell you and the reason a rule that looks
 * obviously profitable often is not.
 *
 * Nothing runs until it is asked for. It is a replay through the fill engine
 * over thousands of recorded swaps, and nobody opening a token page has asked
 * for one yet.
 */

interface Leg {
  at: number;
  sol: string;
  tokens: string;
  feeLamports: string;
  priceImpactBps: number;
  partial: boolean;
}

interface Result {
  entered: boolean;
  /*
   * The engine's own union, imported rather than copied.
   *
   * A hand written copy drifts silently: the engine gains a reason, this keeps
   * compiling, and the panel renders the word undefined at somebody. The import
   * is type only, so it costs nothing at runtime.
   */
  reason: ExitReason;
  entry: Leg | null;
  exit: Leg | null;
  stake: string;
  proceeds: string | null;
  returnBps: number | null;
  heldSeconds: number;
  feesPaid: string;
  worstBps: number | null;
  bestBps: number | null;
  onChartBps: number | null;
}

interface Report {
  ran: boolean;
  truncated?: boolean;
  medianGapSeconds?: number;
  worstGapSeconds?: number;
  exitGapSeconds?: number | null;
  checkedPoints?: number;
  overshootBps?: number | null;
  reason?: string;
  detail?: string;
  points?: number;
  from?: number;
  to?: number;
  windowRanOut?: boolean;
  result?: Result;
}

const SOL = 1_000_000_000;

function sol(lamports: string | null): string {
  if (lamports === null) return '-';
  const value = Number(lamports) / SOL;
  if (value >= 100) return value.toFixed(1);
  if (value >= 1) return value.toFixed(3);
  return value.toFixed(4);
}

function pct(bps: number | null): string {
  if (bps === null) return '-';
  return `${bps >= 0 ? '+' : ''}${(bps / 100).toFixed(1)}%`;
}

/**
 * How far past a level counts as worth saying.
 *
 * Ten percentage points. Below that the rule landed roughly where it was set
 * and the figure means what it looks like. Above it, the gap between the level
 * and the exit is the sampling rather than the market, and reporting the exit
 * alone would be reporting the wrong thing.
 */
const OVERSHOOT_WORTH_SAYING = 1_000;

/**
 * Below how many checks a result is a coincidence rather than a test.
 *
 * Ten, borrowed from the reasoning behind the forty point floor on the record:
 * a rule either fires on the one swap that happened to cross it or never fires
 * at all, and which of those you get is luck rather than a property of the rule.
 * That argument is about how many times the rule was *checked*, and the floor
 * was only ever applied to how many swaps the token *had*.
 *
 * Which left a hole this panel warned about only by accident. The overshoot
 * warning catches a rule that landed far past its level, so a two check run on a
 * cliff gets a caveat. A two check run that landed near its level gets none, and
 * prints a confident figure decided by a single gap.
 */
const ENOUGH_CHECKS = 10;

function held(seconds: number): string {
  if (seconds >= 86_400) return `${Math.round(seconds / 86_400)}d`;
  if (seconds >= 3_600) return `${Math.round(seconds / 3_600)}h`;
  if (seconds >= 60) return `${Math.round(seconds / 60)}m`;
  return `${seconds}s`;
}

/**
 * A percentage as somebody typed it, in basis points.
 *
 * Empty means they left the rule off, which is allowed. Anything else that is
 * not a positive number is a mistake worth refusing rather than ignoring.
 */
function ruleBps(value: string): number | undefined | 'bad' {
  if (value.trim() === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 'bad';
  return Math.round(parsed * 100);
}

/** Said in the words somebody would use, not in the enum's. */
const ENDED: Record<Result['reason'], string> = {
  take_profit: 'hit the take profit',
  stop_loss: 'hit the stop',
  timeout: 'ran out of time',
  still_open: 'never triggered, still holding at the end',
  illiquid: 'could not be sold at any price by the end',
  no_entry: 'never got in',
};

export function RuleBacktest({ mint }: { mint: string }) {
  const [stake, setStake] = useState('1');
  const [take, setTake] = useState('100');
  const [stop, setStop] = useState('50');
  const [report, setReport] = useState<Report | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(): Promise<void> {
    setRunning(true);
    setError(null);
    setReport(null);
    try {
      const lamports = Math.round(Number(stake) * SOL);
      if (!Number.isFinite(lamports) || lamports <= 0) {
        setError('Give me a stake in SOL.');
        return;
      }

      /*
       * A field that cannot be read is refused rather than dropped.
       *
       * `Number('abc') * 100 || undefined` is undefined, which removed the rule
       * and ran the replay without it. Somebody typed a take profit, it was
       * quietly ignored, and they got a confident answer to a question they had
       * not asked. That is the same silent wrong answer the engine was fixed
       * for twice, arriving through the form instead.
       */
      const takeProfitBps = ruleBps(take);
      const stopLossBps = ruleBps(stop);
      if (takeProfitBps === 'bad' || stopLossBps === 'bad') {
        setError('A take profit and a stop have to be percentages, or left empty.');
        return;
      }

      const response = await fetch('/api/backtest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mint,
          stake: String(lamports),
          ...(takeProfitBps === undefined ? {} : { takeProfitBps }),
          ...(stopLossBps === undefined ? {} : { stopLossBps }),
        }),
      });
      const body = (await response.json()) as Report & { error?: string };
      if (!response.ok) {
        setError(body.error ?? 'That could not be replayed.');
        return;
      }
      setReport(body);
    } catch {
      setError('That could not be replayed just now.');
    } finally {
      setRunning(false);
    }
  }

  const result = report?.result;

  return (
    <section className="term bt-panel">
      <header className="term-bar">
        <span className="prompt">~/backtest</span>
        <span className="term-note">priced at a real exit, not at the chart</span>
      </header>

      <div className="bt-body">
        <div className="bt-rule">
          <label className="bt-field">
            <span className="bt-caption">Stake</span>
            <span className="bt-input">
              <input value={stake} onChange={(event) => setStake(event.target.value)} inputMode="decimal" />
              <span className="bt-unit">SOL</span>
            </span>
          </label>
          <label className="bt-field">
            <span className="bt-caption">Take profit</span>
            <span className="bt-input">
              <input value={take} onChange={(event) => setTake(event.target.value)} inputMode="decimal" />
              <span className="bt-unit">%</span>
            </span>
          </label>
          <label className="bt-field">
            <span className="bt-caption">Stop</span>
            <span className="bt-input">
              <input value={stop} onChange={(event) => setStop(event.target.value)} inputMode="decimal" />
              <span className="bt-unit">%</span>
            </span>
          </label>
          <button type="button" className="bt-run" onClick={() => void run()} disabled={running}>
            {running ? 'Replaying' : 'Replay it'}
          </button>
        </div>

        {error && <p className="bt-said">{error}</p>}

        {/*
          A refusal is a sentence, not an empty result. "Nothing recorded for
          this token" and "it lost money" are entirely different answers and a
          blank panel would read as the second.
        */}
        {report && !report.ran && <p className="bt-said">{report.detail}</p>}

        {result && (
          <>
            {!result.entered ? (
              <p className="bt-said">
                No entry was possible anywhere in the recorded window. Either the stake was
                larger than the pool would take, or the delay ran past the end of it.
              </p>
            ) : (
              <>
                <div className="bt-headline">
                  <div className="bt-big">
                    <span className={result.returnBps !== null && result.returnBps < 0 ? 'loss' : 'gain'}>
                      {pct(result.returnBps)}
                    </span>
                    <span className="bt-big-note">what you would have got</span>
                  </div>
                  <div className="bt-big bt-dim">
                    <span>{pct(result.onChartBps)}</span>
                    <span className="bt-big-note">what the chart said</span>
                  </div>
                </div>

                {/*
                  The caveat that decides what the headline means.

                  These points are what the site has walked rather than every
                  swap a token ever had, so a rule is checked at moments that
                  can be hours apart. A stop set at fifty percent whose first
                  recorded point past the level was already at ninety-six is not
                  a fifty percent stop, and the number alone reads as though it
                  were.
                */}
                {(report.overshootBps ?? 0) >= OVERSHOOT_WORTH_SAYING && (
                  <p className="bt-warn">
                    The first recorded swap past your level was already{' '}
                    {pct(result.returnBps)}, so this is where the rule could have got out rather
                    than where you set it.
                    {report.exitGapSeconds
                      ? ` Nothing was recorded for ${held(report.exitGapSeconds)} before that swap,
                         and a rule is only ever checked at a recorded swap.`
                      : ''}
                  </p>
                )}

                {/*
                  The other way a figure can mean less than it looks like.

                  Said separately from the overshoot, and only when that has not
                  already been said, because they are different complaints: one
                  is a rule that got out far past its level, the other is a rule
                  that was barely tested. A run can be the second without being
                  the first, and that combination is the one that prints a clean
                  number nobody has any reason to doubt.
                */}
                {(report.checkedPoints ?? 0) < ENOUGH_CHECKS &&
                  (report.overshootBps ?? 0) < OVERSHOOT_WORTH_SAYING && (
                    <p className="bt-warn">
                      This rule was only ever checked at {report.checkedPoints} recorded{' '}
                      {report.checkedPoints === 1 ? 'swap' : 'swaps'} while the position was open,
                      so the figure above turns on one or two moments rather than on anything the
                      rule reliably does. Read it as a single outcome, not as a result.
                    </p>
                  )}

                <p className="bt-said">
                  It {ENDED[result.reason]} after {held(result.heldSeconds)}.
                  {report.truncated
                    ? ' This token has more recorded swaps than a replay reads, so the window stops' +
                      ' before the token does.'
                    : report.windowRanOut
                      ? ' The recorded window ends here, so this is where it got to rather than how' +
                        ' it finished.'
                      : ''}
                </p>

                <dl className="bt-facts">
                  <div>
                    <dt>In</dt>
                    <dd>{sol(result.entry?.sol ?? null)} SOL</dd>
                  </div>
                  <div>
                    <dt>Out</dt>
                    <dd>{sol(result.proceeds)} SOL</dd>
                  </div>
                  <div>
                    <dt>Fees</dt>
                    <dd>{sol(result.feesPaid)} SOL</dd>
                  </div>
                  <div>
                    <dt>Your impact</dt>
                    <dd>
                      {((result.entry?.priceImpactBps ?? 0) / 100).toFixed(2)}%
                      {result.exit ? ` then ${(result.exit.priceImpactBps / 100).toFixed(2)}%` : ''}
                    </dd>
                  </div>
                  <div>
                    <dt>Worst it got</dt>
                    <dd className={result.worstBps !== null && result.worstBps < 0 ? 'loss' : ''}>
                      {pct(result.worstBps)}
                    </dd>
                  </div>
                  <div>
                    <dt>Best it got</dt>
                    <dd>{pct(result.bestBps)}</dd>
                  </div>
                </dl>

                {/*
                  What the run actually touched, not what the record holds.

                  Two separate ways this sentence used to overstate itself. It
                  claimed the whole record as the test, when a position that
                  stops out three days into a fifty day record was never checked
                  against the rest of it. And it gave a single typical gap, which
                  on points that arrive in bursts measures the inside of a burst:
                  half of Fartcoin's are under eighteen seconds while the longest
                  is most of a fortnight.
                */}
                <p className="bt-foot">
                  The rule was checked at {report.checkedPoints} of this token&apos;s{' '}
                  {report.points} recorded swaps, the ones between getting in and getting out.
                  {(report.checkedPoints ?? 0) > 2
                    ? ` Half the gaps between those are under ${held(report.medianGapSeconds ?? 0)},
                       and the longest is ${held(report.worstGapSeconds ?? 0)}.`
                    : ''}{' '}
                  A rule is checked at a recorded swap and nowhere between them, so a gap is a
                  stretch where it could not have acted at all. Every exit is priced by the same
                  engine that quotes a live fill, so the position is only ever worth what selling
                  it would really have fetched.
                </p>
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}
