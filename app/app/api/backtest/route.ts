import { rateLimit } from '@/lib/rate-limit';
import { runBacktest } from '@/lib/backtest';

/**
 * What a rule would have done on a token.
 *
 * Public and unauthenticated, because it touches no account and changes
 * nothing. It reads a token's recorded swaps and runs arithmetic over them, and
 * the answer is the same whoever asks.
 *
 * Every figure it can return is nullable, and that is deliberate rather than
 * sloppy: a number is reported only where a real exit could price one. A caller
 * that treats null as zero will report a total loss for a position that merely
 * could not be valued, which is the exact mistake the engine was fixed for.
 */

const MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Bounds on what may be asked for.
 *
 * Not validation for its own sake. A stake of a million SOL against a real pool
 * is refused by the impact cap anyway and would burn a walk to say so, and a
 * timeout measured in years describes a window nobody has recorded.
 */
const MAX_STAKE_LAMPORTS = 1_000_000_000_000n; // 1,000 SOL
const MAX_SECONDS = 30 * 24 * 60 * 60;

function bpsOrNull(value: unknown, max: number): number | null | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > max) return null;
  return Math.trunc(parsed);
}

export async function POST(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'read');
  if (throttled.response) return throttled.response;

  let body: Record<string, unknown>;
  try {
    body = ((await request.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return Response.json({ error: 'expected a JSON body' }, { status: 400 });
  }

  const mint = typeof body['mint'] === 'string' ? body['mint'] : '';
  if (!MINT_PATTERN.test(mint)) {
    return Response.json({ error: 'a valid mint is required' }, { status: 400 });
  }

  // Lamports arrive as a decimal string. A JSON number cannot hold a lamport
  // balance without rounding it, and a stake rounded is a result rounded.
  const stakeRaw = body['stake'];
  if (typeof stakeRaw !== 'string' || !/^[1-9]\d*$/.test(stakeRaw)) {
    return Response.json(
      { error: 'stake must be a positive integer string of lamports' },
      { status: 400 },
    );
  }
  const stake = BigInt(stakeRaw);
  if (stake > MAX_STAKE_LAMPORTS) {
    return Response.json({ error: 'that stake is larger than this will replay' }, { status: 400 });
  }

  const takeProfitBps = bpsOrNull(body['takeProfitBps'], 1_000_000);
  const stopLossBps = bpsOrNull(body['stopLossBps'], 10_000);
  const timeoutSeconds = bpsOrNull(body['timeoutSeconds'], MAX_SECONDS);
  const entryDelaySeconds = bpsOrNull(body['entryDelaySeconds'], MAX_SECONDS);

  /*
   * Null is how the parser reports out of range, so anything null is a refusal
   * rather than an omission. Narrowed here so the rule below cannot carry one
   * through into the engine.
   */
  if (
    takeProfitBps === null ||
    stopLossBps === null ||
    timeoutSeconds === null ||
    entryDelaySeconds === null
  ) {
    return Response.json({ error: 'a rule figure was out of range' }, { status: 400 });
  }

  const report = await runBacktest(mint, {
    stake,
    ...(takeProfitBps === undefined ? {} : { takeProfitBps }),
    ...(stopLossBps === undefined ? {} : { stopLossBps }),
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    ...(entryDelaySeconds === undefined ? {} : { entryDelaySeconds }),
  });

  if ('reason' in report && (report.reason === 'unwatched' || report.reason === 'too_thin')) {
    // Not an error. There is simply no history to answer over, and a 200 with a
    // stated reason is more useful than a status code somebody has to look up.
    return Response.json({ ran: false, ...report });
  }

  const { result, ...rest } = report as Extract<typeof report, { result: unknown }>;
  // `rest` carries mint, from, to, points, windowRanOut and truncated. Spread
  // rather than listed, so a field added to the report reaches a caller without
  // this route having to be remembered.
  return Response.json({
    ran: true,
    ...rest,
    result: {
      ...result,
      // Every lamport figure as a string, for the same reason the stake arrives
      // as one.
      stake: result.stake.toString(),
      proceeds: result.proceeds === null ? null : result.proceeds.toString(),
      feesPaid: result.feesPaid.toString(),
      entry: result.entry
        ? {
            ...result.entry,
            sol: result.entry.sol.toString(),
            tokens: result.entry.tokens.toString(),
            feeLamports: result.entry.feeLamports.toString(),
          }
        : null,
      exit: result.exit
        ? {
            ...result.exit,
            sol: result.exit.sol.toString(),
            tokens: result.exit.tokens.toString(),
            feeLamports: result.exit.feeLamports.toString(),
          }
        : null,
    },
  });
}
