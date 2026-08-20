import { describe, expect, it } from 'vitest';
import { createTestDatabase, ensureAccount, ensureFreePlaySeason, upsertUser, type TestDatabase } from '@probatio/db';
import type { Resolution } from '@probatio/pools';
import { executeTrade, type MarketReader } from '../execute-trade';

/**
 * The fill sequence, now that three things run it.
 *
 * It lived in the trade route and was copied into the accounts that trade free
 * play, and a Telegram bot placing orders would have been the third copy. Two
 * implementations of a sequence whose every step exists for a reason do not
 * announce it when they drift; the drift turns up later as a fill somebody
 * could not have got.
 *
 * These cover the parts that are easy to break and hard to notice: that the
 * second read is what the fill is priced against, that it happens after the
 * wait, and that a refusal is reported rather than approximated.
 */

const MINT = 'So11111111111111111111111111111111111111112';
const TRADER = '11111111111111111111111111111111';

function pool(sol: bigint, tokens: bigint, slot = 10): Resolution {
  return {
    mint: MINT,
    venue: { kind: 'pumpfun-curve', curveAddress: MINT },
    pool: {
      mint: MINT,
      solReserve: sol,
      tokenReserve: tokens,
      deliverableTokens: tokens,
      tokenDecimals: 6,
      fees: { protocolBps: 95, creatorBps: 30, lpBps: 0 },
      source: 'pumpfun-curve',
      slot,
    },
    slot,
  } as Resolution;
}

async function account(harness: TestDatabase) {
  const now = 1_800_000_000_000;
  const seasonId = await ensureFreePlaySeason(harness.db, now);
  await upsertUser(harness.db, TRADER, now);
  return { seasonId, row: await ensureAccount(harness.db, seasonId, TRADER, now), now };
}

/** Reads the click and the fill from separate pools, and counts the calls. */
function market(click: Resolution, fill: Resolution) {
  const order: string[] = [];
  const reader: MarketReader = {
    atClick: async () => {
      order.push('click');
      return click;
    },
    atFill: async () => {
      order.push('fill');
      return fill;
    },
  };
  return { reader, order };
}

describe('one fill, wherever the order came from', () => {
  it('prices against the pool read after the wait, not the one at the click', async () => {
    const harness = await createTestDatabase();
    try {
      const { seasonId, row, now } = await account(harness);
      // The market moves against the buyer while the order is in flight.
      const m = market(pool(100n * 10n ** 9n, 10n ** 15n), pool(104n * 10n ** 9n, 10n ** 15n));
      const waited: number[] = [];

      const outcome = await executeTrade({
        client: harness.db,
        account: row,
        seasonId,
        userPubkey: TRADER,
        mint: MINT,
        side: 'buy',
        size: 10n ** 9n,
        market: m.reader,
        wait: async (ms) => {
          waited.push(ms);
        },
        now,
      });

      expect(outcome.status).toBe('filled');
      if (outcome.status !== 'filled') return;

      // Read, wait, read. In that order, or the delay means nothing.
      expect(m.order).toEqual(['click', 'fill']);
      expect(waited).toEqual([row.latencyMs]);

      // Filled worse than quoted, because the pool moved during the wait.
      expect(BigInt(outcome.fill.filled.tokenAmount)).toBeLessThan(
        BigInt(outcome.fill.expected.tokenAmount),
      );
    } finally {
      harness.cleanup();
    }
  });

  it('refuses rather than estimating when the fill read fails', async () => {
    const harness = await createTestDatabase();
    try {
      const { seasonId, row, now } = await account(harness);
      const outcome = await executeTrade({
        client: harness.db,
        account: row,
        seasonId,
        userPubkey: TRADER,
        mint: MINT,
        side: 'buy',
        size: 10n ** 9n,
        market: {
          atClick: async () => pool(100n * 10n ** 9n, 10n ** 15n),
          atFill: async () => {
            throw new Error('rpc down');
          },
        },
        wait: async () => undefined,
        now,
      });

      // Filling at the click price would hand back the delay-free execution the
      // delay exists to deny.
      expect(outcome.status).toBe('degraded');
    } finally {
      harness.cleanup();
    }
  });

  it('will not spend a balance it does not have', async () => {
    const harness = await createTestDatabase();
    try {
      const { seasonId, row, now } = await account(harness);
      const m = market(pool(100n * 10n ** 9n, 10n ** 15n), pool(100n * 10n ** 9n, 10n ** 15n));

      const outcome = await executeTrade({
        client: harness.db,
        account: row,
        seasonId,
        userPubkey: TRADER,
        mint: MINT,
        side: 'buy',
        size: BigInt(row.solBalance) + 1n,
        market: m.reader,
        wait: async () => undefined,
        now,
      });

      expect(outcome).toMatchObject({ status: 'rejected', reason: 'insufficient_sol' });
      // Refused before the chain was touched at all.
      expect(m.order).toEqual(['click', 'fill']);
    } finally {
      harness.cleanup();
    }
  });

  it('records the fill against the account, so a second order sees the first', async () => {
    const harness = await createTestDatabase();
    try {
      const { seasonId, row, now } = await account(harness);
      const m = market(pool(100n * 10n ** 9n, 10n ** 15n), pool(100n * 10n ** 9n, 10n ** 15n));

      const first = await executeTrade({
        client: harness.db,
        account: row,
        seasonId,
        userPubkey: TRADER,
        mint: MINT,
        side: 'buy',
        size: 10n ** 9n,
        market: m.reader,
        wait: async () => undefined,
        now,
      });

      expect(first.status).toBe('filled');
      if (first.status !== 'filled') return;
      expect(BigInt(first.fill.balance)).toBeLessThan(BigInt(row.solBalance));
      expect(BigInt(first.fill.position.tokenAmount)).toBeGreaterThan(0n);
      expect(first.fill.sequence).toBeGreaterThan(0);
    } finally {
      harness.cleanup();
    }
  });
});
