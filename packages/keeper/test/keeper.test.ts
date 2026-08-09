import { beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@libsql/client';
import { migrate, openDatabase, pendingCommits, commitHistory } from '@probatio/db';
import { EMPTY_ACCUMULATOR, extendChain, fromHex, toHex } from '@probatio/commit';
import { Keeper, KeeperHalt, predictAccumulator } from '../src/keeper';
import type { ChainGateway, CommitReceipt, OnChainRecord } from '../src/gateway';
import { planBatches } from '../src/plan';

const TRADER = '7xKXtg2CW3cWCLBmVvKcbAkKM6mzTuKMYqM9dAcuLNwr';
const OTHER = 'J5reXJehdCV86HPHg2ewbeGYfMkxQT2YmLcg4DVfpump';
const ROOT_A = 'ab'.repeat(32);
const ROOT_B = 'cd'.repeat(32);

/**
 * A gateway that behaves like the program: it keeps a real hash chain, using
 * the same function the on-chain code does. Stubbing the accumulator instead
 * would let the keeper's logic pass against arithmetic the chain never
 * performs.
 */
class FakeChain implements ChainGateway {
  readonly records = new Map<string, OnChainRecord>();
  #signature = 0;

  /** Set to make the next commit reject after it has already been applied. */
  loseResponseOnce = false;
  /** Set to make the next commit reject without applying. */
  failOnce = false;

  #key(ordinal: number, trader: string): string {
    return `${ordinal}:${trader}`;
  }

  async commitRoot(input: {
    seasonOrdinal: number;
    trader: string;
    merkleRoot: string;
    leaves: number;
    engineVersion: number;
  }): Promise<CommitReceipt> {
    if (this.failOnce) {
      this.failOnce = false;
      throw new Error('transaction rejected');
    }

    const key = this.#key(input.seasonOrdinal, input.trader);
    const existing = this.records.get(key);
    const previous = existing ? fromHex(existing.accumulator) : EMPTY_ACCUMULATOR;

    this.records.set(key, {
      accumulator: toHex(
        extendChain(previous, fromHex(input.merkleRoot), input.leaves, input.engineVersion),
      ),
      commitCount: (existing?.commitCount ?? 0) + 1,
      leafCount: (existing?.leafCount ?? 0) + input.leaves,
    });

    if (this.loseResponseOnce) {
      this.loseResponseOnce = false;
      // Landed, but the caller never finds out. The dangerous case.
      throw new Error('connection lost');
    }

    this.#signature += 1;
    return { signature: `sig${this.#signature}`, slot: 1_000 + this.#signature };
  }

  async readRecord(seasonOrdinal: number, trader: string): Promise<OnChainRecord | null> {
    return this.records.get(this.#key(seasonOrdinal, trader)) ?? null;
  }
}

let db: Client;
let chain: FakeChain;
let keeper: Keeper;

const ordinalFor = (): number => 1;

/**
 * A season with real trades behind it.
 *
 * Commits reference trades by foreign key, which is correct — a commit that
 * points at trades which do not exist is meaningless — so the fixture has to
 * produce them rather than invent ids.
 */
async function seedSeason(tradesEach = 20): Promise<number> {
  const now = Date.now();
  await db.execute({
    sql: 'INSERT INTO users (pubkey, created_at) VALUES (?, ?), (?, ?)',
    args: [TRADER, now, OTHER, now],
  });

  const season = await db.execute({
    sql: `INSERT INTO seasons (ordinal, name, ranked, status, starting_balance, entry_cost,
            house_bps, house_threshold, latency_ms, max_price_impact_bps, engine_version,
            scoring_formula_hash, created_at)
          VALUES (1, 'S1', 1, 'running', '10000000000', '50000000', 1000, '1000000000',
                  600, 5000, 1, 'h', ?)
          RETURNING id`,
    args: [now],
  });
  const seasonId = Number(season.rows[0]!['id']);

  const snapshot = await db.execute({
    sql: `INSERT INTO pool_snapshots
            (mint, sol_reserve, token_reserve, token_decimals, fee_bps, source, slot, observed_at)
          VALUES ('mint', '31000000000', '1000000000000000', 6, 125, 'pumpfun-curve', 1, ?)
          RETURNING id`,
    args: [now],
  });
  const snapshotId = Number(snapshot.rows[0]!['id']);

  for (const trader of [TRADER, OTHER]) {
    const account = await db.execute({
      sql: `INSERT INTO accounts (season_id, user_pubkey, sol_balance, created_at, updated_at)
            VALUES (?, ?, '10000000000', ?, ?) RETURNING id`,
      args: [seasonId, trader, now, now],
    });
    const accountId = Number(account.rows[0]!['id']);

    for (let i = 0; i < tradesEach; i += 1) {
      await db.execute({
        sql: `INSERT INTO trades (
                account_id, season_id, user_pubkey, mint, side, sol_amount, token_amount,
                fee, price_impact_bps, partial, pool_source, clicked_at_slot, filled_at_slot,
                latency_ms, engine_version, pool_snapshot_id, leaf_hash, created_at
              ) VALUES (?, ?, ?, 'mint', 'buy', '1000000', '1000', '100', 10, 0,
                        'pumpfun-curve', 1, 2, 600, 1, ?, ?, ?)`,
        args: [accountId, seasonId, trader, snapshotId, `leaf${trader}${i}`, now + i],
      });
    }
  }

  return seasonId;
}

/** The ids of a trader's trades, in order. */
async function tradeIdsFor(seasonId: number, trader: string): Promise<number[]> {
  const result = await db.execute({
    sql: 'SELECT id FROM trades WHERE season_id = ? AND user_pubkey = ? ORDER BY id',
    args: [seasonId, trader],
  });
  return result.rows.map((row) => Number(row['id']));
}

function request(
  seasonId: number,
  tradeIds: readonly number[],
  overrides: Partial<Parameters<Keeper['commit']>[0]> = {},
) {
  return {
    seasonId,
    seasonOrdinal: 1,
    userPubkey: TRADER,
    merkleRoot: ROOT_A,
    leafCount: tradeIds.length,
    fromTradeId: tradeIds[0]!,
    toTradeId: tradeIds[tradeIds.length - 1]!,
    engineVersion: 1,
    ...overrides,
  };
}

beforeEach(async () => {
  db = openDatabase({ url: ':memory:' });
  await migrate(db);
  chain = new FakeChain();
  keeper = new Keeper(db, chain);
});

describe('committing', () => {
  it('commits a batch and records it', async () => {
    const seasonId = await seedSeason();
    const ids = await tradeIdsFor(seasonId, TRADER);
    const id = await keeper.commit(request(seasonId, ids.slice(0, 10)));

    expect(id).not.toBeNull();
    expect(await pendingCommits(db)).toEqual([]);

    const history = await commitHistory(db, seasonId, TRADER);
    expect(history).toHaveLength(1);
    expect(history[0]!.merkleRoot).toBe(ROOT_A);
    expect(history[0]!.txSignature).toBe('sig1');
  });

  it('predicts the accumulator the chain arrives at', async () => {
    const seasonId = await seedSeason();
    const ids = await tradeIdsFor(seasonId, TRADER);
    await keeper.commit(request(seasonId, ids.slice(0, 10)));

    const [stored] = await commitHistory(db, seasonId, TRADER);
    const onChain = await chain.readRecord(1, TRADER);
    expect(onChain!.accumulator).toBe(stored!.predictedAccumulator);
  });

  it('chains a second commit onto the first', async () => {
    const seasonId = await seedSeason();
    const ids = await tradeIdsFor(seasonId, TRADER);
    await keeper.commit(request(seasonId, ids.slice(0, 10)));
    await keeper.commit(request(seasonId, ids.slice(10, 20), { merkleRoot: ROOT_B }));

    const history = await commitHistory(db, seasonId, TRADER);
    expect(history).toHaveLength(2);
    expect(history[1]!.previousAccumulator).toBe(history[0]!.predictedAccumulator);

    const onChain = await chain.readRecord(1, TRADER);
    expect(onChain!.accumulator).toBe(history[1]!.predictedAccumulator);
    expect(onChain!.leafCount).toBe(20);
  });

  it('keeps traders on separate chains', async () => {
    const seasonId = await seedSeason();
    const ids = await tradeIdsFor(seasonId, TRADER);
    await keeper.commit(request(seasonId, ids.slice(0, 10)));
    const otherIds = await tradeIdsFor(seasonId, OTHER);
    await keeper.commit(request(seasonId, otherIds.slice(0, 10), { userPubkey: OTHER }));

    const a = await chain.readRecord(1, TRADER);
    const b = await chain.readRecord(1, OTHER);
    expect(a!.accumulator).toBe(b!.accumulator); // same batch, both from empty
    expect(a!.leafCount).toBe(10);
    expect(b!.leafCount).toBe(10);
  });

  it('writes the intent before sending', async () => {
    const seasonId = await seedSeason();
    const ids = await tradeIdsFor(seasonId, TRADER);
    chain.failOnce = true;

    const id = await keeper.commit(request(seasonId, ids.slice(0, 10)));
    expect(id).toBeNull();

    // The row survives the failure, which is the only thing that makes the
    // crash recoverable.
    const pending = await pendingCommits(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.failedReason).toMatch(/rejected/);
    expect(pending[0]!.attempts).toBe(1);
  });
});

describe('reconciling after a crash', () => {
  it('confirms an intent whose transaction actually landed', async () => {
    const seasonId = await seedSeason();
    const ids = await tradeIdsFor(seasonId, TRADER);
    // The dangerous case: the chain applied it, the caller never heard back.
    chain.loseResponseOnce = true;
    await keeper.commit(request(seasonId, ids.slice(0, 10)));

    expect(await pendingCommits(db)).toHaveLength(1);

    const result = await keeper.reconcile(ordinalFor);
    expect(result.reconciled).toBe(1);
    expect(result.discarded).toBe(0);
    expect(await pendingCommits(db)).toEqual([]);
  });

  it('does not commit the same batch twice after a lost response', async () => {
    const seasonId = await seedSeason();
    const ids = await tradeIdsFor(seasonId, TRADER);
    chain.loseResponseOnce = true;
    await keeper.commit(request(seasonId, ids.slice(0, 10)));
    await keeper.reconcile(ordinalFor);

    // Folding the same batch in twice could never be undone.
    const onChain = await chain.readRecord(1, TRADER);
    expect(onChain!.commitCount).toBe(1);
    expect(onChain!.leafCount).toBe(10);
  });

  it('discards an intent whose transaction never landed', async () => {
    const seasonId = await seedSeason();
    const ids = await tradeIdsFor(seasonId, TRADER);
    chain.failOnce = true;
    await keeper.commit(request(seasonId, ids.slice(0, 10)));

    const result = await keeper.reconcile(ordinalFor);
    expect(result.discarded).toBe(1);
    expect(await pendingCommits(db)).toEqual([]);

    // Discarded means the trades are free to be batched again.
    const id = await keeper.commit(request(seasonId, ids.slice(0, 10)));
    expect(id).not.toBeNull();
  });

  it('halts when the chain holds something unaccounted for', async () => {
    const seasonId = await seedSeason();
    const ids = await tradeIdsFor(seasonId, TRADER);
    chain.failOnce = true;
    await keeper.commit(request(seasonId, ids.slice(0, 10)));

    // Someone else moved this record while our intent was outstanding.
    await chain.commitRoot({
      seasonOrdinal: 1,
      trader: TRADER,
      merkleRoot: 'ef'.repeat(32),
      leaves: 3,
      engineVersion: 1,
    });

    const result = await keeper.reconcile(ordinalFor);
    expect(result.halt).toMatch(/neither the expected/);
    expect(keeper.halted).not.toBeNull();
  });

  it('refuses to keep working once halted', async () => {
    const seasonId = await seedSeason();
    const ids = await tradeIdsFor(seasonId, TRADER);
    chain.failOnce = true;
    await keeper.commit(request(seasonId, ids.slice(0, 10)));
    await chain.commitRoot({
      seasonOrdinal: 1,
      trader: TRADER,
      merkleRoot: 'ef'.repeat(32),
      leaves: 3,
      engineVersion: 1,
    });
    await keeper.reconcile(ordinalFor);

    // Continuing would build on a history it cannot account for.
    await expect(keeper.commit(request(seasonId, ids.slice(0, 10)))).rejects.toThrow(KeeperHalt);
  });

  it('has nothing to do when everything is settled', async () => {
    const seasonId = await seedSeason();
    const ids = await tradeIdsFor(seasonId, TRADER);
    await keeper.commit(request(seasonId, ids.slice(0, 10)));

    const result = await keeper.reconcile(ordinalFor);
    expect(result).toEqual({ reconciled: 0, discarded: 0 });
  });
});

describe('verifying against the chain', () => {
  it('halts when the chain disagrees with the prediction', async () => {
    const seasonId = await seedSeason();
    const ids = await tradeIdsFor(seasonId, TRADER);

    // A chain that applies something other than what was asked for. If this
    // went unnoticed, every later commit would compound the divergence.
    const wrong: ChainGateway = {
      async commitRoot() {
        return { signature: 'sig', slot: 1 };
      },
      async readRecord() {
        return { accumulator: '99'.repeat(32), commitCount: 1, leafCount: 10 };
      },
    };

    const strict = new Keeper(db, wrong);
    await expect(strict.commit(request(seasonId, ids.slice(0, 10)))).rejects.toThrow(KeeperHalt);
    expect(strict.halted).toMatch(/but .* was expected/);
  });
});

describe('predictAccumulator', () => {
  it('agrees with the chain function it mirrors', () => {
    const predicted = predictAccumulator(toHex(EMPTY_ACCUMULATOR), ROOT_A, 10, 1);
    const direct = toHex(extendChain(EMPTY_ACCUMULATOR, fromHex(ROOT_A), 10, 1));
    expect(predicted).toBe(direct);
  });
});

describe('planBatches', () => {
  const trade = (id: number, seasonId = 1, userPubkey = TRADER, engineVersion = 1) => ({
    id,
    seasonId,
    userPubkey,
    engineVersion,
  });

  it('returns nothing for no trades', () => {
    expect(planBatches([])).toEqual([]);
  });

  it('groups a trader’s trades into one batch', () => {
    const batches = planBatches([trade(1), trade(2), trade(3)]);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.tradeIds).toEqual([1, 2, 3]);
    expect(batches[0]!.fromTradeId).toBe(1);
    expect(batches[0]!.toTradeId).toBe(3);
  });

  it('never mixes two traders', () => {
    // A record is per trader, so a mixed batch would produce a root belonging
    // to nobody.
    const batches = planBatches([trade(1), trade(2, 1, OTHER), trade(3)]);
    expect(batches).toHaveLength(2);
    for (const batch of batches) {
      expect(new Set([batch.userPubkey])).toHaveProperty('size', 1);
    }
  });

  it('never mixes two seasons', () => {
    const batches = planBatches([trade(1, 1), trade(2, 2)]);
    expect(batches).toHaveLength(2);
  });

  it('never mixes engine versions', () => {
    // The version is folded into the chain, so a batch spanning a change could
    // not be checked against either set of rules.
    const batches = planBatches([trade(1, 1, TRADER, 1), trade(2, 1, TRADER, 2)]);
    expect(batches).toHaveLength(2);
    expect(batches[0]!.engineVersion).toBe(1);
    expect(batches[1]!.engineVersion).toBe(2);
  });

  it('splits at the size limit', () => {
    const trades = Array.from({ length: 10 }, (_, i) => trade(i + 1));
    const batches = planBatches(trades, 4);
    expect(batches.map((b) => b.tradeIds.length)).toEqual([4, 4, 2]);
  });

  it('sorts trades that arrive out of order', () => {
    const batches = planBatches([trade(3), trade(1), trade(2)]);
    expect(batches[0]!.tradeIds).toEqual([1, 2, 3]);
  });

  it('refuses a nonsensical batch size', () => {
    expect(() => planBatches([trade(1)], 0)).toThrow();
  });
});
