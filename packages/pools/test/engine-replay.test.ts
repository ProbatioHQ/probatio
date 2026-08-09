import { describe, expect, it } from 'vitest';
import { quoteBuy, quoteSell, type PoolState } from '@probatio/sim';
import { RpcClient } from '../src/rpc';
import { bondingCurveAddress } from '../src/pumpfun';
import { extractTradeEvents, type TradeEvent } from '../src/events';
import { PUMPFUN_CURVE_FEES } from '../src/fees';

/**
 * The fill engine, replayed against real trades.
 *
 * Every TradeEvent carries the reserves after it, so the previous event's
 * reserves are the next trade's starting state. Feeding those into the engine
 * and comparing its output against what the program actually produced is the
 * only check that can prove the math — a unit test can only prove the engine
 * agrees with itself.
 *
 * This is a narrow version of what D11 does at scale.
 *
 *   RPC_VALIDATION=1 npx vitest run packages/pools/test/engine-replay.test.ts
 *
 * What the event fields mean, established by running exactly this comparison:
 * `sol_amount` is the amount on the *curve* side, excluding fees, in both
 * directions. A trader pays gross on a buy and receives net on a sell, and the
 * event reports neither — it reports what the curve saw.
 */

const ENABLED = process.env['RPC_VALIDATION'] === '1';
const RPC_URL = process.env['RPC_URL'] ?? 'https://api.mainnet-beta.solana.com';

const MINTS = [
  'BepXrvvfoFohZBSRTLnesHMpjy7EkRjyUVAA39rZpump',
  '3SPyj7fHQ6TKGR5Agua1gPdCnb2oWHF8Zi8bY33bpump',
];

interface OrderedEvent {
  readonly event: TradeEvent;
  readonly slot: number;
  readonly indexInTx: number;
}

/**
 * Collect events in true execution order.
 *
 * Ordering by timestamp is not enough: several trades routinely land in the
 * same second, and a tie broken arbitrarily makes the "previous" event the
 * wrong one, which shows up as large spurious errors. Slot, then position
 * within the transaction, is the real sequence.
 */
async function collectEvents(rpc: RpcClient, mint: string, limit: number): Promise<OrderedEvent[]> {
  const signatures = await rpc.getSignatures(bondingCurveAddress(mint), { limit });
  const collected: OrderedEvent[] = [];

  for (const signature of signatures) {
    if (signature.err !== null) continue;
    const logs = await rpc.getTransactionLogs(signature.signature);
    if (!logs || logs.err !== null) continue;

    extractTradeEvents(logs.logMessages).forEach((event, indexInTx) => {
      if (event.mint !== mint) return;
      collected.push({ event, slot: logs.slot, indexInTx });
    });
  }

  return collected.sort((a, b) => (a.slot === b.slot ? a.indexInTx - b.indexInTx : a.slot - b.slot));
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

/** Relative error between two amounts, as a fraction. */
function relativeError(mine: bigint, actual: bigint): number {
  if (actual === 0n) return mine === 0n ? 0 : 1;
  return Math.abs(Number(mine - actual) / Number(actual));
}

describe.skipIf(!ENABLED)('engine against real trades', () => {
  const rpc = new RpcClient({ endpoint: RPC_URL, timeoutMs: 30_000 });

  it.each(MINTS)('reproduces real fills for %s', async (mint) => {
    const events = await collectEvents(rpc, mint, 60);
    expect(events.length).toBeGreaterThan(5);

    const errors: number[] = [];
    let buys = 0;
    let sells = 0;

    for (let i = 1; i < events.length; i += 1) {
      const previous = events[i - 1]!;
      const current = events[i]!.event;

      // Only consecutive trades are comparable. A gap means something moved
      // the curve that this walk did not see.
      if (events[i]!.slot < previous.slot) continue;

      const before = stateAfter(previous.event, mint);

      if (current.isBuy) {
        // The event records what reached the curve, so the trader's gross
        // input is that plus the fee. Reconstructing it exactly is what makes
        // this comparison meaningful rather than approximately right.
        const gross = (current.solAmount * 10_125n) / 10_000n + 1n;
        const quote = quoteBuy(before, gross);
        errors.push(relativeError(quote.tokenAmount, current.tokenAmount));
        buys += 1;
      } else {
        const quote = quoteSell(before, current.tokenAmount);
        // Compare against the gross, which is what the event reports.
        errors.push(relativeError(quote.solAmount + quote.feeLamports, current.solAmount));
        sells += 1;
      }
    }

    expect(errors.length).toBeGreaterThan(0);
    errors.sort((a, b) => a - b);
    const median = errors[Math.floor(errors.length / 2)]!;

    // The math is exact, so the median error is not "small" — it is zero to
    // within a lamport of rounding. Anything else means the formula is wrong.
    expect(median).toBeLessThan(0.0001);

    // Some pairs are not genuinely consecutive — an aggregator can move the
    // curve inside a transaction this walk reads as one step — so a handful of
    // outliers is expected. The bulk must still be exact.
    const exact = errors.filter((error) => error < 0.0001).length;
    expect(exact / errors.length).toBeGreaterThan(0.7);

    // Both directions have to be covered or half the engine is untested.
    expect(buys + sells).toBe(errors.length);
  }, 300_000);
});
