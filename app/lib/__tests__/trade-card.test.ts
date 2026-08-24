import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The numbers a card puts in front of strangers.
 *
 * A card is the one artefact from this site that travels without its context,
 * so a figure that is wrong here is wrong in somebody else's timeline with this
 * project's name under it. The two that matter most are the ones nobody else
 * publishes: what the round trip returned on what went in, and what it cost in
 * fees and impact to make.
 */

const history: Array<Record<string, unknown>> = [];

vi.mock('@probatio/db', async () => {
  const actual = await vi.importActual<typeof import('@probatio/db')>('@probatio/db');
  return {
    ...actual,
    tradeHistory: async () => history,
    getTokenMetadata: async (_client: unknown, mint: string) => ({
      mint,
      name: 'Cyberdog',
      symbol: 'CYBERDOG',
      imageUrl: 'https://example.test/art.png',
      offchainName: null,
      offchainSymbol: null,
    }),
    displayName: (entry: { name: string | null }) => entry.name ?? '',
    displaySymbol: (entry: { symbol: string | null }) => entry.symbol ?? '',
  };
});

const { cardsFor } = await import('../trade-card');

const MINT = 'D3KxoUnQdZZUnQcpmxb9Ktb26rDndURseog6DPsVpump';
const T0 = 1_787_500_000_000;

/** One fill, in the shape the log stores. Newest first, as the log returns. */
function fill(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 1,
    sequence: 1,
    mint: MINT,
    side: 'buy',
    solAmount: '250000000',
    tokenAmount: '1000000000',
    fee: '2500000',
    priceImpactBps: 40,
    partial: false,
    latencyMs: 600,
    engineVersion: 1,
    leafHash: 'leaf-1',
    createdAt: T0,
    ...over,
  };
}

beforeEach(() => {
  history.length = 0;
});

describe('a card for a closed round trip', () => {
  it('reports the return on what went in', async () => {
    // 0.25 SOL in, 0.75 SOL back out. Three times the money.
    history.push(
      fill({ side: 'sell', solAmount: '750000000', createdAt: T0 + 240_000, leafHash: 'leaf-out' }),
      fill({ side: 'buy', solAmount: '250000000', createdAt: T0 }),
    );

    const [card] = await cardsFor({} as never, 1);
    expect(card).toBeDefined();
    expect(card!.returnBps).toBe(20_000);
    expect(card!.invested).toBe('250000000');
    expect(card!.proceeds).toBe('750000000');
    expect(card!.heldMs).toBe(240_000);
  });

  it('names the closing fill, so a reader can check the record', async () => {
    history.push(
      fill({ side: 'sell', solAmount: '400000000', createdAt: T0 + 60_000, leafHash: 'leaf-out' }),
      fill({ side: 'buy', createdAt: T0, leafHash: 'leaf-in' }),
    );

    // The seal the card points at has to be the one that closed the trip, not
    // the one that opened it.
    const [card] = await cardsFor({} as never, 1);
    expect(card!.leafHash).toBe('leaf-out');
  });

  it('carries what getting out cost', async () => {
    history.push(
      fill({
        side: 'sell', solAmount: '400000000', fee: '4000000',
        priceImpactBps: 310, createdAt: T0 + 60_000, leafHash: 'leaf-out',
      }),
      fill({ side: 'buy', fee: '2500000', priceImpactBps: 63, createdAt: T0 }),
    );

    const [card] = await cardsFor({} as never, 1);
    // Fees add across the legs; impact does not, so the worst is reported
    // rather than a sum that would look precise and mean nothing.
    expect(card!.feesPaid).toBe('6500000');
    expect(card!.worstImpactBps).toBe(310);
    expect(card!.fills).toBe(2);
  });

  it('reports a loss as a loss', async () => {
    history.push(
      fill({ side: 'sell', solAmount: '100000000', createdAt: T0 + 60_000, leafHash: 'leaf-out' }),
      fill({ side: 'buy', solAmount: '250000000', createdAt: T0 }),
    );

    const [card] = await cardsFor({} as never, 1);
    // Offered at all, which is the point: a feed of only winners is the thing
    // nobody believes.
    expect(card!.returnBps).toBe(-6_000);
    expect(BigInt(card!.realized) < 0n).toBe(true);
  });

  it('leaves out a position that is still open', async () => {
    history.push(fill({ side: 'buy', createdAt: T0 }));
    // Half a story. Nobody posts "I bought something".
    expect(await cardsFor({} as never, 1)).toHaveLength(0);
  });

  it('has nothing to show for an account that has never traded', async () => {
    expect(await cardsFor({} as never, 1)).toEqual([]);
  });

  /*
   * What truncation actually does, pinned because the alternative would have
   * been the bad kind of wrong.
   *
   * Only a bounded slice of the log is read, so an active trader's oldest buys
   * fall off the edge. If the replay quietly costed a sell against the part of
   * the position it could still see, "invested" would be smaller and the return
   * *larger* — a flattering wrong number on a public card. It does not: a sell
   * bigger than the position it is against throws, so no trip is opened at all.
   */
  it('makes no card from a sell whose buys fell outside the window', async () => {
    history.push(
      fill({ side: 'sell', solAmount: '900000000', createdAt: T0 + 30_000, leafHash: 'orphan' }),
    );
    expect(await cardsFor({} as never, 1)).toHaveLength(0);
  });

  it('still makes cards for the trips it can follow in that same token', async () => {
    history.push(
      fill({ side: 'sell', solAmount: '400000000', createdAt: T0 + 90_000, leafHash: 'good-out' }),
      fill({ side: 'buy', solAmount: '250000000', createdAt: T0 + 60_000, leafHash: 'good-in' }),
      // An orphan on the same token, which is what the edge of the window
      // leaves behind. It must not cost the trader the complete trip above.
      fill({ side: 'sell', solAmount: '900000000', createdAt: T0 + 30_000, leafHash: 'orphan' }),
    );

    const cards = await cardsFor({} as never, 1);
    expect(cards.map((card) => card.leafHash)).toEqual(['good-out']);
  });

  it('puts the newest trip first', async () => {
    const OTHER = '9Hz3QeJfNaRZsiwGL3rT8edrLG73qV3rd2eCGM5opump';
    history.push(
      fill({ mint: OTHER, side: 'sell', solAmount: '300000000', createdAt: T0 + 500_000, leafHash: 'b-out' }),
      fill({ mint: OTHER, side: 'buy', createdAt: T0 + 400_000, leafHash: 'b-in' }),
      fill({ side: 'sell', solAmount: '300000000', createdAt: T0 + 60_000, leafHash: 'a-out' }),
      fill({ side: 'buy', createdAt: T0, leafHash: 'a-in' }),
    );

    const cards = await cardsFor({} as never, 1);
    expect(cards.map((card) => card.leafHash)).toEqual(['b-out', 'a-out']);
  });
});
