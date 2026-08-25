import { beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@libsql/client';
import { openDatabase } from '../src/client';
import { migrate } from '../src/migrate';
import {
  DuelError,
  acceptDuel,
  closeOffer,
  duelById,
  duelRecord,
  duelSeal,
  dueDuels,
  expireOffers,
  liveDuelFor,
  offerDuel,
  returnBps,
  settleDuel,
} from '../src/duels';

/**
 * Head to head duels.
 *
 * The rules that matter here are the ones a second code path would forget: one
 * live duel per person, an accept that cannot be applied twice, a settle that
 * cannot overwrite a result, and a return computed the same way in both
 * directions. Everything else is bookkeeping.
 */

const ALICE = '7xKXtg2CW3cWCLBmVvKcbAkKM6mzTuKMYqM9dAcuLNwr';
const BOB = '4Nd1mQ6vFvBmMSAcCEHSKm3StTLvNCTLnFXQyBnGZAaB';
const CARA = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

let db: Client;
let seasonId: number;

async function user(pubkey: string, now: number): Promise<void> {
  await db.execute({
    sql: 'INSERT INTO users (pubkey, created_at) VALUES (?, ?)',
    args: [pubkey, now],
  });
}

beforeEach(async () => {
  db = openDatabase({ url: ':memory:' });
  await migrate(db);

  const now = 1_000_000;
  for (const pubkey of [ALICE, BOB, CARA]) await user(pubkey, now);

  const season = await db.execute({
    sql: `INSERT INTO seasons (
            ordinal, name, ranked, status, starting_balance, entry_cost,
            house_bps, house_threshold,
            latency_ms, max_price_impact_bps, engine_version,
            scoring_formula_hash, created_at
          ) VALUES (1, 'S1', 1, 'entry_open', '10000000000', '0',
                    1000, '1000000000', 500, 5000, 1, 'h', ?)
          RETURNING id`,
    args: [now],
  });
  seasonId = Number(season.rows[0]!['id']);
});

const offer = (challenger: string, opponent: string, now: number, windowSeconds = 3_600) =>
  offerDuel(db, { seasonId, challenger, opponent, windowSeconds }, now);

describe('offering', () => {
  it('refuses to let somebody duel themselves', async () => {
    await expect(offer(ALICE, ALICE, 1)).rejects.toBeInstanceOf(DuelError);
  });

  it('refuses a window nobody offered', async () => {
    await expect(offer(ALICE, BOB, 1, 47)).rejects.toBeInstanceOf(DuelError);
  });

  it('refuses a second offer between the same pair', async () => {
    await offer(ALICE, BOB, 1);
    await expect(offer(ALICE, BOB, 2)).rejects.toBeInstanceOf(DuelError);
    // And in the other direction, which is the same open question twice.
    await expect(offer(BOB, ALICE, 3)).rejects.toBeInstanceOf(DuelError);
  });

  it('lets the pair offer again once the first has lapsed', async () => {
    const first = await offer(ALICE, BOB, 1);
    await expireOffers(db, first.offerExpiresAt + 1);
    await expect(offer(ALICE, BOB, first.offerExpiresAt + 2)).resolves.toBeTruthy();
  });

  it('caps how many offers one person can have out', async () => {
    // Five is the cap and the pair rule allows only one offer per opponent, so
    // this needs five more traders. Real rows, because `opponent` is a foreign
    // key onto users and inventing a pubkey is refused by the database.
    for (let i = 0; i < 5; i += 1) {
      const pubkey = `Stub${i}${'1'.repeat(38)}`;
      await user(pubkey, 1);
      await offer(ALICE, pubkey, 1);
    }
    await expect(offer(ALICE, BOB, 2)).rejects.toThrow(/offers out/);
  });
});

describe('accepting', () => {
  it('starts the clock at accept, not at offer', async () => {
    const offered = await offer(ALICE, BOB, 1_000);
    const live = await acceptDuel(
      db,
      { id: offered.id, opponent: BOB, challengerOpen: 100n, opponentOpen: 200n, unpriced: 0 },
      50_000,
    );
    expect(live.status).toBe('live');
    expect(live.startedAt).toBe(50_000);
    // Fifty thousand, not one thousand. Sitting on an offer while a position
    // runs must not buy a head start.
    expect(live.endsAt).toBe(50_000 + 3_600_000);
  });

  it('refuses anybody but the person it was offered to', async () => {
    const offered = await offer(ALICE, BOB, 1);
    await expect(
      acceptDuel(
        db,
        { id: offered.id, opponent: CARA, challengerOpen: 1n, opponentOpen: 1n, unpriced: 0 },
        2,
      ),
    ).rejects.toBeInstanceOf(DuelError);
  });

  it('refuses an offer that has lapsed', async () => {
    const offered = await offer(ALICE, BOB, 1);
    await expect(
      acceptDuel(
        db,
        { id: offered.id, opponent: BOB, challengerOpen: 1n, opponentOpen: 1n, unpriced: 0 },
        offered.offerExpiresAt + 1,
      ),
    ).rejects.toBeInstanceOf(DuelError);
  });

  /*
   * The one that matters. Two accepts arriving together would both pass a
   * check-then-write, and the second would overwrite the first's opening
   * snapshot with one taken later: a duel that began at a different moment for
   * each trader, which is not a duel.
   */
  it('cannot be accepted twice', async () => {
    const offered = await offer(ALICE, BOB, 1);
    await acceptDuel(
      db,
      { id: offered.id, opponent: BOB, challengerOpen: 100n, opponentOpen: 100n, unpriced: 0 },
      10,
    );
    await expect(
      acceptDuel(
        db,
        { id: offered.id, opponent: BOB, challengerOpen: 999n, opponentOpen: 999n, unpriced: 0 },
        20,
      ),
    ).rejects.toBeInstanceOf(DuelError);
    const after = await duelById(db, offered.id);
    expect(after!.challengerOpen).toBe('100');
  });

  /*
   * The bug this exists for.
   *
   * The pair rule stops two offers between the same two people. It does not
   * stop two different people challenging the same person, which is ordinary.
   * So somebody can hold two open challenges and try to accept both, and the
   * second one used to reach the partial unique index directly and come back as
   * a raw SQLITE_CONSTRAINT_UNIQUE, which the route turned into a five hundred.
   * Two challenges and an eager accept is not an exotic sequence.
   */
  it('answers a second accept with a sentence rather than a constraint error', async () => {
    const one = await offer(ALICE, BOB, 1);
    const two = await offer(CARA, BOB, 1);

    await acceptDuel(
      db,
      { id: one.id, opponent: BOB, challengerOpen: 1n, opponentOpen: 1n, unpriced: 0 },
      10,
    );

    const second = acceptDuel(
      db,
      { id: two.id, opponent: BOB, challengerOpen: 1n, opponentOpen: 1n, unpriced: 0 },
      11,
    );
    await expect(second).rejects.toBeInstanceOf(DuelError);
    await expect(second).rejects.toThrow(/already in a duel/);
    // And the one they did accept is untouched.
    expect((await duelById(db, one.id))!.status).toBe('live');
    expect((await duelById(db, two.id))!.status).toBe('offered');
  });

  it('refuses when the challenger went live elsewhere after offering', async () => {
    // Alice offers Bob, then Alice is drawn into a duel with Cara. Bob's
    // acceptance now cannot stand, and he is owed the reason rather than an
    // error page.
    const offered = await offer(ALICE, BOB, 1);
    const other = await offer(CARA, ALICE, 1);
    await acceptDuel(
      db,
      { id: other.id, opponent: ALICE, challengerOpen: 1n, opponentOpen: 1n, unpriced: 0 },
      5,
    );

    await expect(
      acceptDuel(
        db,
        { id: offered.id, opponent: BOB, challengerOpen: 1n, opponentOpen: 1n, unpriced: 0 },
        6,
      ),
    ).rejects.toThrow(/already in a duel/);
  });

  it('refuses a second live duel on either side', async () => {
    const first = await offer(ALICE, BOB, 1);
    await acceptDuel(
      db,
      { id: first.id, opponent: BOB, challengerOpen: 1n, opponentOpen: 1n, unpriced: 0 },
      10,
    );
    /*
     * Two live duels off one account would both be scoring the same trades, so
     * one good fill would win both. Refused at the offer, before somebody is
     * looking at a challenge they can never accept.
     */
    await expect(offer(CARA, ALICE, 20)).rejects.toThrow(/already in a duel/);
    await expect(offer(ALICE, CARA, 20)).rejects.toThrow(/already in a duel/);
  });
});

describe('declining and withdrawing', () => {
  it('lets the opponent decline and the challenger withdraw', async () => {
    const a = await offer(ALICE, BOB, 1);
    expect((await closeOffer(db, { id: a.id, by: BOB, status: 'declined' })).status).toBe('declined');

    const b = await offer(ALICE, CARA, 2);
    expect((await closeOffer(db, { id: b.id, by: ALICE, status: 'withdrawn' })).status).toBe(
      'withdrawn',
    );
  });

  it('does not let the challenger decline their own offer', async () => {
    const a = await offer(ALICE, BOB, 1);
    await expect(
      closeOffer(db, { id: a.id, by: ALICE, status: 'declined' }),
    ).rejects.toBeInstanceOf(DuelError);
  });

  it('keeps refusals rather than deleting them', async () => {
    const a = await offer(ALICE, BOB, 1);
    await closeOffer(db, { id: a.id, by: BOB, status: 'declined' });
    expect((await duelById(db, a.id))!.status).toBe('declined');
  });
});

describe('the return between two equities', () => {
  it('is symmetric and signed', () => {
    expect(returnBps(100n, 150n)).toBe(5_000);
    expect(returnBps(100n, 50n)).toBe(-5_000);
    expect(returnBps(100n, 100n)).toBe(0);
  });

  it('reports nothing rather than infinity for an account that opened at nothing', () => {
    // Dividing by it would be an error, not a very large number. It neither won
    // nor lost anything it had.
    expect(returnBps(0n, 5_000n)).toBe(0);
    expect(returnBps(-5n, 5n)).toBe(0);
  });
});

describe('settling', () => {
  async function live(now = 10): Promise<number> {
    const offered = await offer(ALICE, BOB, 1);
    const started = await acceptDuel(
      db,
      { id: offered.id, opponent: BOB, challengerOpen: 1_000n, opponentOpen: 1_000n, unpriced: 0 },
      now,
    );
    return started.id;
  }

  it('names the higher return as the winner', async () => {
    const id = await live();
    const settled = await settleDuel(
      db,
      { id, challengerClose: 1_200n, opponentClose: 1_100n, unpriced: 0 },
      99,
    );
    expect(settled!.winner).toBe(ALICE);
    expect(settled!.challengerBps).toBe(2_000);
    expect(settled!.opponentBps).toBe(1_000);
    expect(settled!.status).toBe('settled');
  });

  it('calls an exact tie a draw rather than picking one', async () => {
    const id = await live();
    const settled = await settleDuel(
      db,
      { id, challengerClose: 1_100n, opponentClose: 1_100n, unpriced: 0 },
      99,
    );
    expect(settled!.winner).toBeNull();
  });

  it('lets the loser of the raw balance win on return', async () => {
    // Both opened at the same figure here, so this is really a check that the
    // comparison is on return and not on what is left in the account.
    const id = await live();
    const settled = await settleDuel(
      db,
      { id, challengerClose: 900n, opponentClose: 1_050n, unpriced: 0 },
      99,
    );
    expect(settled!.winner).toBe(BOB);
    expect(settled!.challengerBps).toBe(-1_000);
  });

  it('cannot settle the same duel twice', async () => {
    const id = await live();
    await settleDuel(db, { id, challengerClose: 1_200n, opponentClose: 1_000n, unpriced: 0 }, 99);
    // A settler that ran twice must not rewrite a result with snapshots taken
    // later, which would let the outcome depend on when it happened to run.
    expect(
      await settleDuel(db, { id, challengerClose: 1n, opponentClose: 9_000n, unpriced: 0 }, 120),
    ).toBeNull();
    const after = await duelById(db, id);
    expect(after!.winner).toBe(ALICE);
  });

  it('frees both traders to duel again', async () => {
    const id = await live();
    expect(await liveDuelFor(db, ALICE)).not.toBeNull();
    await settleDuel(db, { id, challengerClose: 1_200n, opponentClose: 1_000n, unpriced: 0 }, 99);
    expect(await liveDuelFor(db, ALICE)).toBeNull();
    await expect(offer(ALICE, CARA, 200)).resolves.toBeTruthy();
  });

  it('only offers duels whose window has actually closed', async () => {
    const id = await live(10);
    const endsAt = (await duelById(db, id))!.endsAt!;
    expect(await dueDuels(db, endsAt - 1)).toHaveLength(0);
    expect((await dueDuels(db, endsAt)).map((duel) => duel.id)).toEqual([id]);
  });

  it('carries the unpriced count onto the result', async () => {
    const id = await live();
    const settled = await settleDuel(
      db,
      { id, challengerClose: 1_200n, opponentClose: 1_000n, unpriced: 2 },
      99,
    );
    expect(settled!.unpricedClose).toBe(2);
  });
});

describe('the seal', () => {
  const base = {
    id: 1,
    seasonId: 1,
    challenger: ALICE,
    opponent: BOB,
    startedAt: 10,
    endsAt: 20,
    challengerOpen: '100',
    opponentOpen: '100',
    challengerClose: '120',
    opponentClose: '110',
    unpricedOpen: 0,
    unpricedClose: 0,
  };

  it('is the same for the same result', () => {
    expect(duelSeal(base)).toBe(duelSeal(base));
  });

  it('changes when any number the result depends on changes', () => {
    for (const change of [
      { challengerClose: '121' },
      { opponentOpen: '101' },
      { startedAt: 11 },
      { endsAt: 21 },
    ]) {
      expect(duelSeal({ ...base, ...change })).not.toBe(duelSeal(base));
    }
  });

  /*
   * A result measured throughout and a result partly assumed are different
   * claims. If they hashed the same, a seal could be quoted as proof of a
   * number that was in part a fallback.
   */
  it('does not hash a measured result the same as an assumed one', () => {
    expect(duelSeal({ ...base, unpricedClose: 1 })).not.toBe(duelSeal(base));
    expect(duelSeal({ ...base, unpricedOpen: 1 })).not.toBe(duelSeal(base));
  });
});

describe('a head to head record', () => {
  it('counts wins, losses and draws from the winner column', async () => {
    const now = 1;
    for (const [challengerClose, opponentClose] of [
      [1_200n, 1_000n],
      [900n, 1_000n],
      [1_000n, 1_000n],
    ] as const) {
      const offered = await offer(ALICE, BOB, now);
      const started = await acceptDuel(
        db,
        { id: offered.id, opponent: BOB, challengerOpen: 1_000n, opponentOpen: 1_000n, unpriced: 0 },
        now,
      );
      await settleDuel(db, { id: started.id, challengerClose, opponentClose, unpriced: 0 }, now);
    }

    expect(await duelRecord(db, ALICE)).toEqual({ won: 1, lost: 1, drawn: 1 });
    // The same three duels read from the other side.
    expect(await duelRecord(db, BOB)).toEqual({ won: 1, lost: 1, drawn: 1 });
  });

  it('counts nothing for somebody who has not duelled', async () => {
    expect(await duelRecord(db, CARA)).toEqual({ won: 0, lost: 0, drawn: 0 });
  });
});

describe('lapsing offers', () => {
  it('expires only offers past their time', async () => {
    const a = await offer(ALICE, BOB, 1);
    const b = await offer(ALICE, CARA, 1);
    expect(await expireOffers(db, a.offerExpiresAt - 1)).toBe(0);
    expect(await expireOffers(db, b.offerExpiresAt + 1)).toBe(2);
    expect((await duelById(db, a.id))!.status).toBe('expired');
  });

  it('leaves a live duel alone', async () => {
    const offered = await offer(ALICE, BOB, 1);
    await acceptDuel(
      db,
      { id: offered.id, opponent: BOB, challengerOpen: 1n, opponentOpen: 1n, unpriced: 0 },
      2,
    );
    await expireOffers(db, offered.offerExpiresAt + 10_000);
    expect((await duelById(db, offered.id))!.status).toBe('live');
  });
});

describe('reading an account without creating one', () => {
  it('returns null rather than minting an account at the starting balance', async () => {
    const { accountFor, ensureAccount } = await import('../src/trading');

    // The hole this closes: `ensureAccount` builds an account for whatever
    // season it is handed, so a background job reaching for it can hand
    // somebody ten SOL in a season they never entered. The same shape of bug
    // was found once already in the strategy runner.
    expect(await accountFor(db, seasonId, ALICE)).toBeNull();

    const made = await ensureAccount(db, seasonId, ALICE, 1);
    const read = await accountFor(db, seasonId, ALICE);
    expect(read).not.toBeNull();
    expect(read!.id).toBe(made.id);
    // And the joined columns are the season's, not something aliased over.
    expect(read!.startingBalance).toBe('10000000000');
    expect(read!.seasonOrdinal).toBe(1);
    expect(read!.solBalance).toBe(made.solBalance);
  });
});
