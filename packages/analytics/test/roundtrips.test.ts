import { describe, expect, it } from 'vitest';
import { applyFill, emptyPosition, type AccountState } from '@probatio/trading';
import { reconstruct, type LoggedTrade } from '../src/roundtrips';

const MINT = 'So11111111111111111111111111111111111111112';
const OTHER = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function trade(overrides: Partial<LoggedTrade> = {}): LoggedTrade {
  return {
    mint: MINT,
    side: 'buy',
    solAmount: 1_000_000_000n,
    tokenAmount: 1_000_000n,
    feeLamports: 12_500_000n,
    priceImpactBps: 40,
    at: 1_700_000_000_000,
    ...overrides,
  };
}

describe('reconstructing round trips', () => {
  it('pairs a buy with the sell that closes it', () => {
    const { closed, open, skipped } = reconstruct([
      trade({ at: 1_000 }),
      trade({ side: 'sell', solAmount: 1_500_000_000n, at: 61_000 }),
    ]);

    expect(open).toHaveLength(0);
    expect(skipped).toHaveLength(0);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.realized).toBe(500_000_000n);
    expect(closed[0]!.heldMs).toBe(60_000);
    expect(closed[0]!.buys).toBe(1);
    expect(closed[0]!.sells).toBe(1);
  });

  it('holds a position open until the last token is gone', () => {
    const { closed, open } = reconstruct([
      trade(),
      trade({ side: 'sell', tokenAmount: 400_000n, solAmount: 600_000_000n }),
    ]);

    expect(closed).toHaveLength(0);
    expect(open).toHaveLength(1);
    expect(open[0]!.position.tokenAmount).toBe(600_000n);
  });

  it('treats scaling in as one trip, not several', () => {
    const { closed } = reconstruct([
      trade({ at: 1_000 }),
      trade({ at: 2_000, solAmount: 500_000_000n, tokenAmount: 400_000n }),
      trade({ side: 'sell', tokenAmount: 1_400_000n, solAmount: 2_000_000_000n, at: 9_000 }),
    ]);

    expect(closed).toHaveLength(1);
    expect(closed[0]!.buys).toBe(2);
    expect(closed[0]!.invested).toBe(1_500_000_000n);
    expect(closed[0]!.realized).toBe(500_000_000n);
    // Held from the FIRST entry, not the last. A trader who averages down has
    // been in the trade the whole time.
    expect(closed[0]!.heldMs).toBe(8_000);
  });

  it('starts a new trip when the same token is bought again', () => {
    const { closed } = reconstruct([
      trade({ at: 1_000 }),
      trade({ side: 'sell', solAmount: 1_200_000_000n, at: 2_000 }),
      trade({ at: 3_000 }),
      trade({ side: 'sell', solAmount: 800_000_000n, at: 4_000 }),
    ]);

    expect(closed).toHaveLength(2);
    expect(closed[0]!.realized).toBe(200_000_000n);
    expect(closed[1]!.realized).toBe(-200_000_000n);
  });

  it('keeps two tokens apart', () => {
    const { closed, open } = reconstruct([
      trade({ mint: MINT, at: 1_000 }),
      trade({ mint: OTHER, at: 1_100 }),
      trade({ mint: MINT, side: 'sell', solAmount: 1_100_000_000n, at: 2_000 }),
    ]);

    expect(closed).toHaveLength(1);
    expect(closed[0]!.mint).toBe(MINT);
    expect(open).toHaveLength(1);
    expect(open[0]!.mint).toBe(OTHER);
  });

  it('records the peak size across a scale-out', () => {
    const { closed } = reconstruct([
      trade({ tokenAmount: 1_000_000n }),
      trade({ side: 'sell', tokenAmount: 300_000n, solAmount: 400_000_000n }),
      trade({ tokenAmount: 100_000n, solAmount: 200_000_000n }),
      trade({ side: 'sell', tokenAmount: 800_000n, solAmount: 900_000_000n }),
    ]);

    expect(closed[0]!.peakTokens).toBe(1_000_000n);
    expect(closed[0]!.tokensBought).toBe(1_100_000n);
    expect(closed[0]!.tokensSold).toBe(1_100_000n);
  });

  it('adds up the fees across every fill in the trip', () => {
    const { closed } = reconstruct([
      trade({ feeLamports: 10n }),
      trade({ feeLamports: 20n, solAmount: 1n, tokenAmount: 1n }),
      trade({ side: 'sell', tokenAmount: 1_000_001n, solAmount: 5n, feeLamports: 30n }),
    ]);

    expect(closed[0]!.feesPaid).toBe(60n);
  });
});

describe('trades the replay cannot use', () => {
  it('skips a sell with no position behind it', () => {
    const { closed, open, skipped } = reconstruct([
      trade({ side: 'sell', solAmount: 900_000_000n }),
    ]);

    expect(closed).toHaveLength(0);
    expect(open).toHaveLength(0);
    expect(skipped).toHaveLength(1);
  });

  it('skips a sell larger than the position and keeps the rest', () => {
    const { closed, open, skipped } = reconstruct([
      trade({ tokenAmount: 100n }),
      trade({ side: 'sell', tokenAmount: 500n, solAmount: 1n }),
      trade({ side: 'sell', tokenAmount: 100n, solAmount: 1_100_000_000n }),
    ]);

    expect(skipped).toHaveLength(1);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.realized).toBe(100_000_000n);
    expect(open).toHaveLength(0);
  });

  it('returns nothing at all for an empty log', () => {
    const result = reconstruct([]);
    expect(result.closed).toHaveLength(0);
    expect(result.open).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
  });
});

describe('agreement with the ledger', () => {
  /**
   * The number on a public profile has to be the number the chain committed
   * to. Anything computed twice can disagree, so this replays the same log
   * through `applyFill` directly and demands the same answer.
   */
  it('matches applyFill to the lamport across a messy sequence', () => {
    const log: LoggedTrade[] = [
      trade({ solAmount: 1_000_000_000n, tokenAmount: 999_999n }),
      trade({ solAmount: 333_333_333n, tokenAmount: 271_828n }),
      trade({ side: 'sell', solAmount: 700_000_007n, tokenAmount: 500_001n }),
      trade({ solAmount: 111_111_111n, tokenAmount: 77_777n }),
      trade({ side: 'sell', solAmount: 1_234_567_891n, tokenAmount: 849_603n }),
    ];

    let state: AccountState = { solBalance: 10n ** 18n, position: emptyPosition(MINT) };
    for (const entry of log) {
      state = applyFill(
        state,
        {
          side: entry.side,
          solAmount: entry.solAmount,
          tokenAmount: entry.tokenAmount,
          feeLamports: entry.feeLamports,
          priceImpactBps: entry.priceImpactBps,
          partial: false,
          engineVersion: 0,
        },
        MINT,
      ).account;
    }

    const { closed, open } = reconstruct(log);

    expect(open).toHaveLength(0);
    expect(closed).toHaveLength(1);
    expect(state.position?.tokenAmount).toBe(0n);
    expect(closed[0]!.realized).toBe(state.position?.realizedPnl);
  });

  it('agrees on a trip that lost money', () => {
    const log: LoggedTrade[] = [
      trade({ solAmount: 5_000_000_000n, tokenAmount: 3_000_000n }),
      trade({ side: 'sell', solAmount: 1_000_000_000n, tokenAmount: 3_000_000n }),
    ];

    let state: AccountState = { solBalance: 10n ** 18n, position: emptyPosition(MINT) };
    for (const entry of log) {
      state = applyFill(
        state,
        {
          side: entry.side,
          solAmount: entry.solAmount,
          tokenAmount: entry.tokenAmount,
          feeLamports: entry.feeLamports,
          priceImpactBps: 0,
          partial: false,
          engineVersion: 0,
        },
        MINT,
      ).account;
    }

    expect(reconstruct(log).closed[0]!.realized).toBe(state.position?.realizedPnl);
    expect(reconstruct(log).closed[0]!.realized).toBe(-4_000_000_000n);
  });
});
