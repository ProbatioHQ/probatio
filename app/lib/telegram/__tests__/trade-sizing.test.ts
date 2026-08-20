import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * How much a percentage actually sells.
 *
 * Resolved against what is held at the moment of the fill, not baked into the
 * button. A card sat in a chat for an hour would otherwise try to sell tokens
 * that are no longer there.
 */

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

let holding = 0n;
const sizes: bigint[] = [];

vi.mock('../../db', () => ({ db: async () => ({}) }));
vi.mock('../../season', () => ({
  activeSeason: async () => ({
    account: { id: 1, solBalance: '10000000000', startingBalance: '10000000000' },
    seasonId: 1,
    ranked: false,
    rankedSeasonId: null,
  }),
}));
vi.mock('../../activity', () => ({ noteActivity: async () => undefined }));
vi.mock('../../rpc', () => ({ resolveMint: async () => ({}), resolveFill: async () => ({}) }));
vi.mock('@probatio/db', () => ({
  lastPrices: async () => new Map(),
  openPositions: async () => (holding > 0n ? [{ mint: MINT, tokenAmount: holding.toString(), costBasis: '1', realizedPnl: '0' }] : []),
}));
vi.mock('../../execute-trade', () => ({
  executeTrade: async ({ size }: { size: bigint }) => {
    sizes.push(size);
    return { status: 'rejected' as const, reason: 'test', detail: 'not filled' };
  },
}));

beforeEach(() => {
  sizes.length = 0;
});

describe('selling a share of a position', () => {
  it('sells the share it was asked for', async () => {
    holding = 1_000_000n;
    const { tradeFromChat } = await import('../trade');
    await tradeFromChat({ pubkey: WALLET, mint: MINT, side: 'sell', amount: 25, now: 1 });
    expect(sizes).toEqual([250_000n]);
  });

  /*
   * A hundred percent means the position, not ninety-nine point nine of it.
   * Rounding a full exit down leaves dust that can never be sold and a position
   * that never closes, which is exactly how the free-play accounts ended up
   * with forty fills and no round trips.
   */
  it('closes the position exactly when asked for all of it', async () => {
    holding = 1_000_001n;
    const { tradeFromChat } = await import('../trade');
    await tradeFromChat({ pubkey: WALLET, mint: MINT, side: 'sell', amount: 100, now: 1 });
    expect(sizes).toEqual([1_000_001n]);
  });

  it('refuses rather than placing an empty sell', async () => {
    holding = 0n;
    const { tradeFromChat } = await import('../trade');
    const outcome = await tradeFromChat({ pubkey: WALLET, mint: MINT, side: 'sell', amount: 100, now: 1 });
    expect(outcome.status).toBe('no_position');
    expect(sizes).toEqual([]);
  });

  /*
   * A share so small it rounds to nothing is refused too. A zero size fill is
   * a row in the record that says nothing happened.
   */
  it('refuses a share that rounds away to nothing', async () => {
    holding = 50n;
    const { tradeFromChat } = await import('../trade');
    const outcome = await tradeFromChat({ pubkey: WALLET, mint: MINT, side: 'sell', amount: 1, now: 1 });
    expect(outcome.status).toBe('no_position');
    expect(sizes).toEqual([]);
  });

  it('will not spend SOL that is not there', async () => {
    const { tradeFromChat } = await import('../trade');
    const outcome = await tradeFromChat({
      pubkey: WALLET,
      mint: MINT,
      side: 'buy',
      amount: 50_000_000_000n,
      now: 1,
    });
    expect(outcome.status).toBe('no_balance');
    expect(sizes).toEqual([]);
  });
});
