import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../src/testing';
import {
  observedBoard,
  recordTraderWalk,
  walkCandidates,
  walkedTraderCount,
  observedCoverage,
  observedTraders,
  pruneObservedSwaps,
  recordObservedSwaps,
} from '../src/index';

const A = 'TraderAAA11111111111111111111111111111111111';
const B = 'TraderBBB22222222222222222222222222222222222';
const MINT1 = 'Mint111111111111111111111111111111111111111';
const MINT2 = 'Mint222222222222222222222222222222222222222';

const NOW_S = 1_800_000_000;
const NOW_MS = NOW_S * 1_000;

let harness: TestDatabase;
beforeEach(async () => {
  harness = await createTestDatabase();
});
afterEach(() => harness.cleanup());

let seq = 0;
function swap(
  trader: string,
  mint: string,
  isBuy: boolean,
  sol: string,
  tokens: string,
  at = NOW_S,
) {
  seq += 1;
  return {
    signature: `sig-${seq}`,
    trader,
    mint,
    isBuy,
    solAmount: sol,
    tokenAmount: tokens,
    slot: 1_000 + seq,
    blockTime: at,
  };
}

/** A bought-then-sold-out round trip on one token. */
function trip(trader: string, mint: string, spent: string, received: string, tokens = '1000') {
  return [
    swap(trader, mint, true, spent, tokens),
    swap(trader, mint, false, received, tokens),
  ];
}

describe('recording real swaps', () => {
  it('writes them and counts what it holds', async () => {
    await recordObservedSwaps(harness.db, trip(A, MINT1, '1000', '1500'), NOW_MS);

    expect(await observedCoverage(harness.db)).toEqual({ swaps: 2, traders: 1, tokens: 1 });
  });

  /*
   * A pool is walked again every time its chart refreshes, so the same swap
   * arrives repeatedly. Without the conflict clause one trade would be counted
   * once per refresh and every number on the board would inflate over time.
   */
  it('ignores a swap it already has', async () => {
    const batch = trip(A, MINT1, '1000', '1500');
    await recordObservedSwaps(harness.db, batch, NOW_MS);
    const second = await recordObservedSwaps(harness.db, batch, NOW_MS + 60_000);

    expect(second).toBe(0);
    expect((await observedCoverage(harness.db)).swaps).toBe(2);
  });
});

describe('ranking real traders', () => {
  it('scores a wallet on what it made, after fees', async () => {
    await recordObservedSwaps(
      harness.db,
      [
        ...trip(A, MINT1, '1000', '1500'),
        ...trip(A, MINT2, '2000', '2500'),
        ...trip(A, 'Mint333333333333333333333333333333333333333', '1000', '900'),
      ],
      NOW_MS,
    );

    const [top] = await observedTraders(harness.db, { minTrips: 3 });
    expect(top?.trader).toBe(A);
    expect(top?.closedTrips).toBe(3);
    expect(top?.wins).toBe(2);
    // 500 up, 500 up, 100 down.
    expect(top?.realizedPnl).toBe('900');
    expect(top?.solTraded).toBe('4000');
  });

  /*
   * A wallet still holding is holding something this table cannot price, so
   * scoring it would mean inventing a number. Sold out is the honest measure.
   */
  it('ignores a position that has not been sold out', async () => {
    await recordObservedSwaps(
      harness.db,
      [...trip(A, MINT1, '1000', '1500'), swap(A, MINT2, true, '5000', '9999')],
      NOW_MS,
    );

    const [top] = await observedTraders(harness.db, { minTrips: 1 });
    expect(top?.closedTrips).toBe(1);
    expect(top?.realizedPnl).toBe('500');
  });

  /*
   * Selling in parts is the normal case, and each part is scored as it happens
   * at the average of what the whole position cost.
   */
  it('scores each part of a position sold down', async () => {
    await recordObservedSwaps(
      harness.db,
      [
        swap(A, MINT1, true, '1000', '100000'),
        swap(A, MINT1, false, '900', '60000'),
        swap(A, MINT1, false, '700', '39950'),
      ],
      NOW_MS,
    );

    const [top] = await observedTraders(harness.db, { minTrips: 2 });
    expect(top?.closedTrips).toBe(2);
    // 900 back on 600 of cost, then 700 back on 399 of it.
    expect(top?.realizedPnl).toBe('601');
  });

  /*
   * The failure this board actually had, and the reason it scores this way.
   *
   * A wallet read straight off the chain had bought eight tokens sixteen times
   * each, sold each of them eight times, and finished holding every one. Scored
   * on completed round trips it had made nothing, out of a hundred and
   * ninety-nine real trades. Scaling out and keeping a tail is how most people
   * trade, and a board that cannot see it is a board of nobody.
   */
  it('scores a wallet that scales out and keeps a tail', async () => {
    await recordObservedSwaps(
      harness.db,
      [
        swap(A, MINT1, true, '1000', '1000'),
        swap(A, MINT1, true, '1000', '1000'),
        swap(A, MINT1, false, '900', '500'),
        swap(A, MINT1, false, '900', '500'),
        swap(A, MINT1, false, '900', '500'),
      ],
      NOW_MS,
    );

    const [top] = await observedTraders(harness.db, { minTrips: 3 });
    expect(top?.closedTrips).toBe(3);
    // Half the tokens cost 1 each, so each 500 sold cost 500 and fetched 900.
    expect(top?.realizedPnl).toBe('1200');
    // Still holding 500, which is not priced and never appears here.
    expect(top?.solTraded).toBe('1500');
  });

  it('needs enough finished trips to be ranked at all', async () => {
    await recordObservedSwaps(harness.db, trip(A, MINT1, '1000', '9000'), NOW_MS);

    // One enormous winner is not a record, which is the whole reason for a floor.
    expect(await observedTraders(harness.db, { minTrips: 3 })).toEqual([]);
    expect((await observedTraders(harness.db, { minTrips: 1 })).length).toBe(1);
  });

  it('ranks the more profitable wallet first', async () => {
    await recordObservedSwaps(
      harness.db,
      [
        ...trip(A, MINT1, '1000', '1100'),
        ...trip(A, MINT2, '1000', '1100'),
        // Deliberately a different size from A. Same exits, same wins and the
        // same amount traded is the fingerprint of one operator on several
        // addresses, and the board collapses those to one row.
        ...trip(B, MINT1, '4000', '20000'),
        ...trip(B, MINT2, '4000', '20000'),
      ],
      NOW_MS,
    );

    const board = await observedTraders(harness.db, { minTrips: 2 });
    expect(board.map((row) => row.trader)).toEqual([B, A]);
  });

  it('only scores inside the window', async () => {
    const old = NOW_S - 200 * 24 * 60 * 60;
    await recordObservedSwaps(
      harness.db,
      [
        swap(A, MINT1, true, '1000', '1000', old),
        swap(A, MINT1, false, '5000', '1000', old),
      ],
      NOW_MS,
    );

    expect(await observedTraders(harness.db, { since: NOW_S - 86_400, minTrips: 1 })).toEqual([]);
  });
});

describe('counting trips the way they actually happen', () => {
  /*
   * The bug this board shipped with. Summing a wallet's buys against its sells
   * scored a scalper's six round trips as one, so a three-trip floor could only
   * be cleared by trading three separate tokens, and a board of two hundred
   * real wallets came out empty.
   */
  it('counts every exit on one token, not one per token', async () => {
    await recordObservedSwaps(
      harness.db,
      [
        ...trip(A, MINT1, '1000', '1400'),
        ...trip(A, MINT1, '1000', '900'),
        ...trip(A, MINT1, '1000', '1200'),
      ],
      NOW_MS,
    );

    const [top] = await observedTraders(harness.db, { minTrips: 3 });
    expect(top?.closedTrips).toBe(3);
    expect(top?.wins).toBe(2);
    expect(top?.tokens).toBe(1);
    // 400 up, 100 down, 200 up.
    expect(top?.realizedPnl).toBe('500');
  });

  /*
   * The walk reads a slice of a pool's recent history, so a wallet's opening
   * buy is regularly older than anything on the table. Counting the sell alone
   * would book its entire proceeds as profit against no cost at all.
   */
  it('ignores a sell of something it never saw bought', async () => {
    await recordObservedSwaps(
      harness.db,
      [swap(A, MINT1, false, '9000', '1000'), ...trip(A, MINT1, '1000', '1100')],
      NOW_MS,
    );

    const [top] = await observedTraders(harness.db, { minTrips: 1 });
    expect(top?.closedTrips).toBe(1);
    expect(top?.realizedPnl).toBe('100');
  });

  /* Same reason, half a step milder: only the part it can account for. */
  it('charges an oversized sell for the part it can account for', async () => {
    await recordObservedSwaps(
      harness.db,
      [swap(A, MINT1, true, '1000', '500'), swap(A, MINT1, false, '4000', '1000')],
      NOW_MS,
    );

    const [top] = await observedTraders(harness.db, { minTrips: 1 });
    // Half the tokens sold were this wallet's, so half the proceeds count.
    expect(top?.realizedPnl).toBe('1000');
  });

  it('leaves an unfinished trip out and keeps the finished one', async () => {
    await recordObservedSwaps(
      harness.db,
      [...trip(A, MINT1, '1000', '1500'), swap(A, MINT1, true, '4000', '900')],
      NOW_MS,
    );

    const [top] = await observedTraders(harness.db, { minTrips: 1 });
    expect(top?.closedTrips).toBe(1);
    expect(top?.solTraded).toBe('1000');
  });

  /*
   * An empty board should be able to say whether nothing has been read or
   * nothing has cleared the floor. From the outside those looked identical,
   * which is most of why the first failure took as long as it did to see.
   */
  /*
   * pump.fun is full of wallets running the same script on hundredths of a SOL.
   * Thirty arrived on this board identical: five exits, sixty per cent, nothing
   * made, all tied at zero and all above anybody real.
   */
  it('keeps a wallet trading dust off the board', async () => {
    await recordObservedSwaps(
      harness.db,
      [
        ...trip(A, MINT1, '1000000', '1100000'),
        ...trip(A, MINT2, '1000000', '1100000'),
        ...trip(A, 'Mint333333333333333333333333333333333333333', '1000000', '1100000'),
        ...trip(B, MINT1, '200000000', '150000000'),
        ...trip(B, MINT2, '200000000', '150000000'),
        ...trip(B, 'Mint333333333333333333333333333333333333333', '200000000', '150000000'),
      ],
      NOW_MS,
    );

    const board = await observedBoard(harness.db, { minTrips: 3, minStaked: 100_000_000n });
    // The dust wallet made money and the real one lost it. Size still decides
    // who is on the page, because nobody is copying three thousandths of a SOL.
    expect(board.traders.map((row) => row.trader)).toEqual([B]);
    expect(board.scoreable).toBe(2);
  });

  it('reports wallets that scored at all, separately from the floor', async () => {
    await recordObservedSwaps(harness.db, [...trip(A, MINT1, '1000', '1100')], NOW_MS);

    const board = await observedBoard(harness.db, { minTrips: 3 });
    expect(board.traders).toEqual([]);
    expect(board.scoreable).toBe(1);
  });
});

describe('choosing whose history to read in full', () => {
  /*
   * A pool walk cannot score anybody; it can only say who is worth reading.
   *
   * Ordering by how many tokens a wallet appeared in was tried first and it
   * selects for exactly the wrong wallet: whoever shows up in the most pools is
   * usually making a market in all of them. The first wallet picked that way
   * had bought eight tokens sixteen times each and finished holding all eight.
   * A sell is the only thing that can be scored, so sells decide.
   */
  it('puts the wallet selling the most SOL first', async () => {
    await recordObservedSwaps(
      harness.db,
      [
        // Busy and tiny: one script, run over and over. The shape of the farm
        // that filled thirty rows of this board with 0.017 SOL apiece.
        swap(A, MINT1, false, '1000', '1'),
        swap(A, MINT2, false, '1000', '1'),
        swap(A, 'Mint333333333333333333333333333333333333333', false, '1000', '1'),
        // Quiet and large. Size is the ordering a farm cannot fake, because
        // faking it costs the money it is pretending to have.
        swap(B, MINT1, false, '500000000', '1'),
      ],
      NOW_MS,
    );

    expect(await walkCandidates(harness.db, { since: 0, staleBefore: NOW_MS })).toEqual([B, A]);
  });

  it('does not offer a wallet whose history was just read', async () => {
    await recordObservedSwaps(harness.db, [swap(A, MINT1, true, '1', '1')], NOW_MS);
    await recordTraderWalk(harness.db, A, 12, NOW_MS);

    expect(await walkCandidates(harness.db, { since: 0, staleBefore: NOW_MS - 1 })).toEqual([]);
    // Stale again a day later, because a trader keeps trading.
    expect(await walkCandidates(harness.db, { since: 0, staleBefore: NOW_MS + 1 })).toEqual([A]);
    expect(await walkedTraderCount(harness.db)).toBe(1);
  });

  /*
   * A wallet that turns out not to trade still costs a walk to find out, and
   * must not cost one again tomorrow.
   */
  it('remembers a wallet that turned out to have nothing', async () => {
    await recordTraderWalk(harness.db, B, 0, NOW_MS);
    await recordTraderWalk(harness.db, B, 0, NOW_MS + 5);

    expect(await walkedTraderCount(harness.db)).toBe(1);
  });
});

describe('retention', () => {
  it('drops swaps past the window and keeps recent ones', async () => {
    await recordObservedSwaps(
      harness.db,
      [
        swap(A, MINT1, true, '1', '1', NOW_S - 200 * 24 * 60 * 60),
        swap(A, MINT1, false, '1', '1', NOW_S),
      ],
      NOW_MS,
    );

    expect(await pruneObservedSwaps(harness.db, NOW_MS)).toBe(1);
    expect((await observedCoverage(harness.db)).swaps).toBe(1);
  });
});

/**
 * One row per operator, and nothing with a flawless record.
 *
 * A size floor was the wrong instrument and the farms simply came back above
 * it: seven wallets with nine exits, nine wins and 3.6 SOL traded, then five
 * more at 3.7, then four with seventy-two exits and sixty-five wins. Identical
 * to two significant figures on all three is one script across a spread of
 * addresses, and no floor expressed in SOL can tell that apart from a person.
 */
describe('keeping a farm from filling the page', () => {
  it('collapses wallets with the same fingerprint to one row', async () => {
    const farm = Array.from(
      { length: 5 },
      (_, i) => `Farm${i}11111111111111111111111111111111111`.slice(0, 43),
    );
    const swaps = farm.flatMap((wallet) => [
      ...trip(wallet, MINT1, '1000000000', '1100000000'),
      ...trip(wallet, MINT2, '1000000000', '1100000000'),
      ...trip(wallet, 'Mint333333333333333333333333333333333333333', '1000000000', '900000000'),
    ]);
    await recordObservedSwaps(harness.db, swaps, NOW_MS);

    const board = await observedBoard(harness.db, { minTrips: 3 });
    expect(board.traders.length).toBe(1);
    // Still counted as scoreable, because they are real wallets that really
    // traded. They are just not five separate traders.
    expect(board.scoreable).toBe(5);
  });

  it('drops a wallet that has never once been wrong', async () => {
    const swaps = Array.from({ length: 7 }, (_, i) =>
      trip(A, `Mint${i}11111111111111111111111111111111111`.slice(0, 43), '1000000', '1500000'),
    ).flat();
    await recordObservedSwaps(harness.db, swaps, NOW_MS);

    expect((await observedBoard(harness.db, { minTrips: 3 })).traders).toEqual([]);
  });
});
