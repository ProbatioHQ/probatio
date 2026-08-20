import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../src/testing';
import {
  follow,
  followCounts,
  followerList,
  followers,
  following,
  followingList,
  isFollowing,
  markFollowersSeen,
  newFollowerCount,
  unfollow,
  upsertUser,
} from '../src/index';

const A = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const B = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const C = '6RP8z43ACh7VxmhY7oxBhHvvGdifRPUHPAvaCK3xWrGc';
const NOBODY = '4t7dhzcuXKGqK4h4EiCXWBAULmYqUKMYqM9dAcuLNwrZ';
const NOW = 1_800_000_000_000;

let harness: TestDatabase;

beforeEach(async () => {
  harness = await createTestDatabase();
  for (const key of [A, B, C]) await upsertUser(harness.db, key, NOW);
});
afterEach(() => harness.cleanup());

describe('following', () => {
  it('records a follow and reports it from both directions', async () => {
    await follow(harness.db, A, B, NOW);

    expect(await isFollowing(harness.db, A, B)).toBe(true);
    expect(await isFollowing(harness.db, B, A)).toBe(false);
    expect(await following(harness.db, A)).toEqual([B]);
    expect(await followers(harness.db, B)).toEqual([A]);
  });

  /*
   * The button is idempotent from the caller's side, and a double tap on a
   * phone is the ordinary case rather than the exceptional one. Two rows would
   * mean a follower count that climbs every time somebody presses it twice.
   */
  it('counts a repeated follow once', async () => {
    await follow(harness.db, A, B, NOW);
    await follow(harness.db, A, B, NOW + 1_000);

    expect(await followCounts(harness.db, B)).toEqual({ followers: 1, following: 0 });
  });

  it('unfollows, and unfollowing again is not an error', async () => {
    await follow(harness.db, A, B, NOW);
    await unfollow(harness.db, A, B);
    await unfollow(harness.db, A, B);

    expect(await isFollowing(harness.db, A, B)).toBe(false);
    expect(await followCounts(harness.db, B)).toEqual({ followers: 0, following: 0 });
  });

  it('gives both counts for one wallet', async () => {
    await follow(harness.db, A, C, NOW);
    await follow(harness.db, B, C, NOW);
    await follow(harness.db, C, A, NOW);

    expect(await followCounts(harness.db, C)).toEqual({ followers: 2, following: 1 });
  });

  /*
   * Following yourself is not a relationship, and permitting it would mean
   * every follower count needs a special case at read time.
   */
  it('refuses to follow yourself', async () => {
    await follow(harness.db, A, A, NOW);
    expect(await followCounts(harness.db, A)).toEqual({ followers: 0, following: 0 });
  });

  /*
   * The foreign key is what stops a follower count being inflated from
   * addresses that never signed in. Without it, anybody could manufacture an
   * audience, and a number nobody can trust is worse here than no number.
   */
  it('will not follow a wallet with no record', async () => {
    await expect(follow(harness.db, A, NOBODY, NOW)).rejects.toThrow();
    expect(await followCounts(harness.db, A)).toEqual({ followers: 0, following: 0 });
  });

  it('will not let a wallet with no record follow anybody', async () => {
    await expect(follow(harness.db, NOBODY, A, NOW)).rejects.toThrow();
    expect(await followCounts(harness.db, A)).toEqual({ followers: 0, following: 0 });
  });

  /*
   * A user row going away should take its follows with it. The account outage
   * this month was a session outliving its users row, and this table should not
   * be able to leave rows pointing at somebody who is gone.
   */
  it('drops follows when the user goes', async () => {
    await follow(harness.db, A, B, NOW);
    await harness.db.execute({ sql: 'DELETE FROM users WHERE pubkey = ?', args: [A] });

    expect(await followCounts(harness.db, B)).toEqual({ followers: 0, following: 0 });
  });

  it('lists the most recently followed first', async () => {
    await follow(harness.db, A, B, NOW);
    await follow(harness.db, A, C, NOW + 5_000);

    expect(await following(harness.db, A)).toEqual([C, B]);
  });
});

describe('the audience, listed', () => {
  it('names the followers, most recent first', async () => {
    await follow(harness.db, A, C, NOW);
    await follow(harness.db, B, C, NOW + 5_000);

    const list = await followerList(harness.db, C);
    expect(list.map((entry) => entry.pubkey)).toEqual([B, A]);
    // No display name claimed, so the list carries nulls and the UI shortens
    // the address rather than inventing something.
    expect(list.every((entry) => entry.name === null)).toBe(true);
  });

  it('names who somebody follows', async () => {
    await follow(harness.db, A, B, NOW);
    await follow(harness.db, A, C, NOW + 1_000);

    expect((await followingList(harness.db, A)).map((entry) => entry.pubkey)).toEqual([C, B]);
  });

  it('carries a display name when there is one', async () => {
    await harness.db.execute({
      sql: `INSERT INTO display_names (user_pubkey, name, name_key, claimed_at)
            VALUES (?, ?, ?, ?)`,
      args: [A, 'Ada', 'ada', NOW],
    });
    await follow(harness.db, A, C, NOW);

    expect((await followerList(harness.db, C))[0]?.name).toBe('Ada');
  });
});

describe('new followers', () => {
  it('counts everybody until the list is read', async () => {
    await follow(harness.db, A, C, NOW);
    await follow(harness.db, B, C, NOW + 1_000);

    expect(await newFollowerCount(harness.db, C)).toBe(2);
  });

  it('drops to zero once seen, and counts only what arrives after', async () => {
    await follow(harness.db, A, C, NOW);
    await markFollowersSeen(harness.db, C, NOW + 500);
    expect(await newFollowerCount(harness.db, C)).toBe(0);

    await follow(harness.db, B, C, NOW + 1_000);
    expect(await newFollowerCount(harness.db, C)).toBe(1);
  });

  /*
   * Two tabs on one account would otherwise let the older response undo the
   * newer one and resurrect a notification somebody has already read.
   */
  it('never moves the mark backwards', async () => {
    await follow(harness.db, A, C, NOW);
    await markFollowersSeen(harness.db, C, NOW + 5_000);
    await markFollowersSeen(harness.db, C, NOW + 1_000);

    expect(await newFollowerCount(harness.db, C)).toBe(0);
  });

  it('forgets a follower who unfollows', async () => {
    await follow(harness.db, A, C, NOW);
    expect(await newFollowerCount(harness.db, C)).toBe(1);

    await unfollow(harness.db, A, C);
    expect(await newFollowerCount(harness.db, C)).toBe(0);
  });
});
