import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  StrategyError,
  automatedTradesSince,
  pruneStrategyEvents,
  createTestDatabase,
  mintStrategyKey,
  ownerOfKey,
  recordStrategyEvent,
  revokeStrategyKey,
  runningStrategies,
  saveStrategy,
  staleRunningStrategies,
  startStrategy,
  stopStrategy,
  strategyEvents,
  strategyFor,
  strategyKeys,
  type TestDatabase,
} from '../src/index';

/**
 * Strategies we run, and the keys that let a program run its own.
 *
 * The rules that matter here are the ones the schema enforces rather than the
 * ones a code path remembers: one running strategy per account per season, a key
 * that exists only as its hash, and a revocation that bites immediately because
 * there is nothing anywhere holding a list of live keys.
 */

let harness: TestDatabase;
const ALICE = 'Ai2mxc1cRp2FipsNRC8Vf9ZCe1CYzArUx7ck9YRZuvTs';
const BOB = 'BwXsScgm1Trbf3kV1JLGnPqPHKvKvxDLRhCPbBhdiWLU';
const NOW = 1_787_500_000_000;

async function season(id: number, ordinal: number): Promise<void> {
  await harness.db.execute({
    sql: `INSERT INTO seasons
            (id, ordinal, name, ranked, status, starting_balance, entry_cost,
             house_bps, house_threshold, latency_ms, max_price_impact_bps,
             engine_version, scoring_formula_hash, created_at)
          VALUES (?, ?, ?, 1, 'running', '10000000000', '50000000', 1000,
                  '1000000000', 600, 5000, 1, 'hash', ?)`,
    args: [id, ordinal, `Season ${ordinal}`, NOW],
  });
}

async function user(pubkey: string): Promise<void> {
  await harness.db.execute({
    sql: 'INSERT INTO users (pubkey, created_at) VALUES (?, ?)',
    args: [pubkey, NOW],
  });
}

beforeEach(async () => {
  harness = await createTestDatabase();
  await season(1, 1);
  await user(ALICE);
  await user(BOB);
});

afterEach(() => harness.cleanup());

describe('a strategy', () => {
  it('saves as a draft and is found again', async () => {
    const saved = await saveStrategy(harness.db, {
      userPubkey: ALICE,
      seasonId: 1,
      name: 'fresh launches',
      rules: '{"entry":{"maxAgeSeconds":90}}',
      rulesVersion: 1,
      now: NOW,
    });

    expect(saved.status).toBe('draft');
    const found = await strategyFor(harness.db, ALICE, 1);
    expect(found?.id).toBe(saved.id);
    expect(found?.rules).toBe('{"entry":{"maxAgeSeconds":90}}');
  });

  it('replaces the draft rather than piling up copies', async () => {
    for (const max of [60, 90, 120]) {
      await saveStrategy(harness.db, {
        userPubkey: ALICE,
        seasonId: 1,
        name: 's',
        rules: `{"maxAgeSeconds":${max}}`,
        rulesVersion: 1,
        now: NOW,
      });
    }

    const all = await harness.db.execute({
      sql: 'SELECT COUNT(*) AS n FROM strategies WHERE user_pubkey = ?',
      args: [ALICE],
    });
    expect(Number(all.rows[0]!['n'])).toBe(1);
    expect((await strategyFor(harness.db, ALICE, 1))?.rules).toBe('{"maxAgeSeconds":120}');
  });

  it('runs, and is listed as running', async () => {
    const saved = await saveStrategy(harness.db, {
      userPubkey: ALICE, seasonId: 1, name: 's', rules: '{}', rulesVersion: 1, now: NOW,
    });
    await startStrategy(harness.db, saved.id, NOW);

    const running = await runningStrategies(harness.db, 1);
    expect(running).toHaveLength(1);
    expect(running[0]!.userPubkey).toBe(ALICE);
    expect(running[0]!.startedAt).toBe(NOW);
  });

  /*
   * The rule the schema owns. Two strategies on one balance would each size
   * their entries against SOL the other is spending, so whichever lost the race
   * would fail a balance check it had every reason to expect to pass.
   */
  it('refuses a second running strategy on the same account and season', async () => {
    const first = await saveStrategy(harness.db, {
      userPubkey: ALICE, seasonId: 1, name: 'a', rules: '{}', rulesVersion: 1, now: NOW,
    });
    await startStrategy(harness.db, first.id, NOW);

    // A second row, inserted directly, because saveStrategy would have reused
    // the draft. This is the case the unique index exists for.
    const second = await harness.db.execute({
      sql: `INSERT INTO strategies
              (user_pubkey, season_id, name, rules, rules_version, status, created_at, updated_at)
            VALUES (?, 1, 'b', '{}', 1, 'draft', ?, ?) RETURNING id`,
      args: [ALICE, NOW, NOW],
    });

    await expect(
      startStrategy(harness.db, Number(second.rows[0]!['id']), NOW),
    ).rejects.toThrow(StrategyError);
  });

  it('lets a different trader run one in the same season', async () => {
    for (const who of [ALICE, BOB]) {
      const saved = await saveStrategy(harness.db, {
        userPubkey: who, seasonId: 1, name: 's', rules: '{}', rulesVersion: 1, now: NOW,
      });
      await startStrategy(harness.db, saved.id, NOW);
    }
    expect(await runningStrategies(harness.db, 1)).toHaveLength(2);
  });

  /*
   * A season ending is not an event anything watches. The runner asks for the
   * strategies of the season running now, so one left over from the last season
   * is never looked at again and sits marked running for ever. Nothing breaks,
   * which is exactly why it would have gone unnoticed.
   */
  it('can be found after the season it belonged to has been replaced', async () => {
    await season(2, 2);
    const old = await saveStrategy(harness.db, {
      userPubkey: ALICE, seasonId: 1, name: 'last season', rules: '{}', rulesVersion: 1, now: NOW,
    });
    await startStrategy(harness.db, old.id, NOW);

    const current = await saveStrategy(harness.db, {
      userPubkey: BOB, seasonId: 2, name: 'this season', rules: '{}', rulesVersion: 1, now: NOW,
    });
    await startStrategy(harness.db, current.id, NOW);

    const stale = await staleRunningStrategies(harness.db, 2);
    expect(stale.map((row) => row.id)).toEqual([old.id]);

    await stopStrategy(harness.db, old.id, 'that season has finished', NOW + 1);
    expect(await staleRunningStrategies(harness.db, 2)).toHaveLength(0);
    // And the one that is genuinely running is untouched.
    expect(await runningStrategies(harness.db, 2)).toHaveLength(1);
  });

  it('stops with a reason, and says what it was', async () => {
    const saved = await saveStrategy(harness.db, {
      userPubkey: ALICE, seasonId: 1, name: 's', rules: '{}', rulesVersion: 1, now: NOW,
    });
    await startStrategy(harness.db, saved.id, NOW);
    await stopStrategy(harness.db, saved.id, 'the season ended', NOW + 1_000);

    const after = await strategyFor(harness.db, ALICE, 1);
    expect(after?.status).toBe('stopped');
    // "It is not running" and "it stopped twelve hours ago because the balance
    // ran out" are different facts, and the owner is owed the second one.
    expect(after?.stoppedReason).toBe('the season ended');
    expect(await runningStrategies(harness.db, 1)).toHaveLength(0);
  });

  /*
   * A row lands here every time a running strategy declines to do something,
   * which is most ticks of most strategies. The one table on this site that grew
   * on a timer with nothing sweeping it filled the volume and took production
   * down; this would have been the second.
   */
  it('has its log swept, so it cannot grow for ever', async () => {
    const saved = await saveStrategy(harness.db, {
      userPubkey: ALICE, seasonId: 1, name: 's', rules: '{}', rulesVersion: 1, now: NOW,
    });
    const SEASON_MS = 14 * 24 * 60 * 60 * 1_000;
    await recordStrategyEvent(harness.db, saved.id, {
      at: NOW - SEASON_MS - 1_000, kind: 'skipped', mint: null, detail: 'ancient',
    });
    await recordStrategyEvent(harness.db, saved.id, {
      at: NOW - 1_000, kind: 'skipped', mint: null, detail: 'recent',
    });

    expect(await pruneStrategyEvents(harness.db, NOW)).toBe(1);
    const left = await strategyEvents(harness.db, saved.id);
    expect(left.map((event) => event.detail)).toEqual(['recent']);
  });

  it('records what it did and what it declined to do', async () => {
    const saved = await saveStrategy(harness.db, {
      userPubkey: ALICE, seasonId: 1, name: 's', rules: '{}', rulesVersion: 1, now: NOW,
    });
    await recordStrategyEvent(harness.db, saved.id, {
      at: NOW, kind: 'entered', mint: 'MINT', detail: 'bought 0.25 SOL',
    });
    await recordStrategyEvent(harness.db, saved.id, {
      at: NOW + 1, kind: 'skipped', mint: 'MINT', detail: 'would have moved the price 812 bps',
    });

    const log = await strategyEvents(harness.db, saved.id);
    // Newest first, and the refusal is in there. A log of successes only would
    // be a log that flatters the runner.
    expect(log.map((e) => e.kind)).toEqual(['skipped', 'entered']);
    expect(log[0]!.detail).toContain('812 bps');
  });
});

describe('a strategy key', () => {
  it('is returned once and never stored', async () => {
    const { key, row } = await mintStrategyKey(harness.db, {
      userPubkey: ALICE, name: 'laptop', now: NOW,
    });

    expect(key.startsWith('pk_live_')).toBe(true);
    expect(row.prefix).toBe(key.slice(0, 12));

    // The table must not contain anything worth stealing.
    const stored = await harness.db.execute('SELECT * FROM strategy_keys');
    const columns = Object.values(stored.rows[0]!).map(String);
    expect(columns.some((value) => value.includes(key))).toBe(false);
    expect(columns).toContain(row.prefix);
  });

  it('identifies its owner', async () => {
    const { key } = await mintStrategyKey(harness.db, {
      userPubkey: ALICE, name: 'laptop', now: NOW,
    });
    const owner = await ownerOfKey(harness.db, key, NOW);
    expect(owner?.userPubkey).toBe(ALICE);
  });

  it('does not recognise a key that was never minted', async () => {
    await mintStrategyKey(harness.db, { userPubkey: ALICE, name: 'laptop', now: NOW });
    expect(await ownerOfKey(harness.db, 'pk_live_nonsense', NOW)).toBeNull();
  });

  it('stops working the moment it is revoked', async () => {
    const { key, row } = await mintStrategyKey(harness.db, {
      userPubkey: ALICE, name: 'laptop', now: NOW,
    });
    expect(await ownerOfKey(harness.db, key, NOW)).not.toBeNull();

    expect(await revokeStrategyKey(harness.db, ALICE, row.id, NOW + 5)).toBe(true);

    // Immediate rather than eventual: nothing anywhere caches live keys.
    expect(await ownerOfKey(harness.db, key, NOW + 6)).toBeNull();
  });

  it('cannot be revoked by somebody else', async () => {
    const { key, row } = await mintStrategyKey(harness.db, {
      userPubkey: ALICE, name: 'laptop', now: NOW,
    });
    expect(await revokeStrategyKey(harness.db, BOB, row.id, NOW + 5)).toBe(false);
    expect(await ownerOfKey(harness.db, key, NOW + 6)).not.toBeNull();
  });

  it('is kept in the list after revocation', async () => {
    const { row } = await mintStrategyKey(harness.db, {
      userPubkey: ALICE, name: 'laptop', now: NOW,
    });
    await revokeStrategyKey(harness.db, ALICE, row.id, NOW + 5);

    // A key that traded a season stays explicable afterwards.
    const listed = await strategyKeys(harness.db, ALICE);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.revokedAt).toBe(NOW + 5);
  });

  it('notes when it was last used', async () => {
    const { key } = await mintStrategyKey(harness.db, {
      userPubkey: ALICE, name: 'laptop', now: NOW,
    });
    await ownerOfKey(harness.db, key, NOW + 1_000);
    expect((await strategyKeys(harness.db, ALICE))[0]!.lastUsedAt).toBe(NOW + 1_000);
  });
});

describe('the daily cap', () => {
  /**
   * Counted from the trades rather than from a counter, because a counter is a
   * second copy of a fact and the copy is what drifts across a restart.
   */
  async function trade(source: string, at: number): Promise<void> {
    await harness.db.execute({
      sql: `INSERT INTO trades
              (account_id, season_id, user_pubkey, mint, side, sol_amount, token_amount,
               fee, price_impact_bps, partial, pool_source, clicked_at_slot, filled_at_slot,
               latency_ms, engine_version, pool_snapshot_id, leaf_hash, sequence, created_at, source)
            VALUES (1, 1, ?, 'MINT', 'buy', '1', '1', '0', 10, 0, 'pumpfun-curve', 1, 2,
                    600, 1, 1, ?, ?, ?, ?)`,
      args: [ALICE, `leaf${at}${source}`, at, at, source],
    });
  }

  beforeEach(async () => {
    await harness.db.execute({
      sql: `INSERT INTO accounts (id, season_id, user_pubkey, generation, sol_balance, created_at, updated_at)
            VALUES (1, 1, ?, 0, '10000000000', ?, ?)`,
      args: [ALICE, NOW, NOW],
    });
    await harness.db.execute({
      sql: `INSERT INTO pool_snapshots
              (id, mint, sol_reserve, token_reserve, deliverable_tokens, token_decimals,
               fee_bps, source, slot, observed_at)
            VALUES (1, 'MINT', '1', '1', '1', 6, 100, 'pumpfun-curve', 1, ?)`,
      args: [NOW],
    });
  });

  it('counts only the automated trades', async () => {
    await trade('web', NOW);
    await trade('telegram', NOW + 1);
    await trade('form', NOW + 2);
    await trade('api', NOW + 3);

    // A person clicking is not spending the strategy's allowance.
    expect(await automatedTradesSince(harness.db, 1, NOW)).toBe(2);
  });

  it('ignores anything before the window', async () => {
    await trade('form', NOW - 1);
    await trade('form', NOW + 1);
    expect(await automatedTradesSince(harness.db, 1, NOW)).toBe(1);
  });

  it('defaults an unlabelled trade to the website', async () => {
    await harness.db.execute({
      sql: `INSERT INTO trades
              (account_id, season_id, user_pubkey, mint, side, sol_amount, token_amount,
               fee, price_impact_bps, partial, pool_source, clicked_at_slot, filled_at_slot,
               latency_ms, engine_version, pool_snapshot_id, leaf_hash, sequence, created_at)
            VALUES (1, 1, ?, 'MINT', 'buy', '1', '1', '0', 10, 0, 'pumpfun-curve', 1, 2,
                    600, 1, 1, 'leafold', 99, ?)`,
      args: [ALICE, NOW],
    });

    // Every row that predates this column was placed on the site.
    const row = await harness.db.execute("SELECT source FROM trades WHERE leaf_hash = 'leafold'");
    expect(row.rows[0]!['source']).toBe('web');
    expect(await automatedTradesSince(harness.db, 1, NOW)).toBe(0);
  });
});
