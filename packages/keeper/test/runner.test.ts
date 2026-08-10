import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@libsql/client';
import { createTestDatabase, recordTrade, commitHistory, type TestDatabase } from '@probatio/db';
import {
  EMPTY_ACCUMULATOR,
  extendChain,
  fromHex,
  hashLeaf,
  toHex,
  verifyTrade,
  type CommittedBatch,
} from '@probatio/commit';
import { Keeper } from '../src/keeper';
import { runOnce } from '../src/runner';
import { leavesFor, loadTrades } from '../src/leaves';
import type { ChainGateway, CommitReceipt, OnChainRecord } from '../src/gateway';

const TRADER = '7xKXtg2CW3cWCLBmVvKcbAkKM6mzTuKMYqM9dAcuLNwr';
const MINT = '3SPyj7fHQ6TKGR5Agua1gPdCnb2oWHF8Zi8bY33bpump';

/** Behaves like the program: keeps a real hash chain using the same function. */
class FakeChain implements ChainGateway {
  readonly records = new Map<string, OnChainRecord>();
  #signature = 0;

  async commitRoot(input: {
    seasonOrdinal: number;
    trader: string;
    merkleRoot: string;
    leaves: number;
    engineVersion: number;
  }): Promise<CommitReceipt> {
    const key = `${input.seasonOrdinal}:${input.trader}`;
    const existing = this.records.get(key);
    const previous = existing ? fromHex(existing.accumulator) : EMPTY_ACCUMULATOR;

    this.records.set(key, {
      accumulator: toHex(
        extendChain(previous, fromHex(input.merkleRoot), input.leaves, input.engineVersion),
      ),
      commitCount: (existing?.commitCount ?? 0) + 1,
      leafCount: (existing?.leafCount ?? 0) + input.leaves,
    });

    this.#signature += 1;
    return { signature: `sig${this.#signature}`, slot: 1_000 + this.#signature };
  }

  async readRecord(seasonOrdinal: number, trader: string): Promise<OnChainRecord | null> {
    return this.records.get(`${seasonOrdinal}:${trader}`) ?? null;
  }
}

let db: Client;
let temp: TestDatabase;
let chain: FakeChain;
let keeper: Keeper;
let seasonId: number;
let accountId: number;

const options = { seasonOrdinalFor: () => 1, maxBatchSize: 4 };

async function seed(): Promise<void> {
  const now = Date.now();
  await db.execute({
    sql: 'INSERT INTO users (pubkey, created_at) VALUES (?, ?)',
    args: [TRADER, now],
  });
  const season = await db.execute({
    sql: `INSERT INTO seasons (ordinal, name, ranked, status, starting_balance, entry_cost,
            house_bps, house_threshold, latency_ms, max_price_impact_bps, engine_version,
            scoring_formula_hash, created_at)
          VALUES (1, 'S1', 1, 'running', '10000000000', '50000000', 1000, '1000000000',
                  600, 5000, 1, 'h', ?) RETURNING id`,
    args: [now],
  });
  seasonId = Number(season.rows[0]!['id']);

  const account = await db.execute({
    sql: `INSERT INTO accounts (season_id, user_pubkey, sol_balance, created_at, updated_at)
          VALUES (?, ?, '10000000000', ?, ?) RETURNING id`,
    args: [seasonId, TRADER, now, now],
  });
  accountId = Number(account.rows[0]!['id']);
}

/** Write a trade exactly as the trade route does, sequence and all. */
async function writeTrade(
  index: number,
  /**
   * Which trade this one follows, when that differs from its content.
   *
   * `recordTrade` now writes conditionally on the balance and holding it was
   * quoted against, so writing the same content twice has to say that the
   * second one follows the first. Without this the two are indistinguishable
   * from a double-spend, which is exactly what that check exists to stop.
   */
  after: number = index,
): Promise<number> {
  const now = Date.now() + index;
  const base = {
    seasonOrdinal: 1,
    trader: TRADER,
    mint: MINT,
    side: 'buy' as const,
    solAmount: BigInt(1_000_000 + index),
    tokenAmount: BigInt(30_000 + index),
    feeLamports: 12_500n,
    solReserve: 31_000_000_000n,
    tokenReserve: 1_000_000_000_000_000n,
    deliverableTokens: 1_000_000_000_000_000n,
    feeBps: 125,
    poolSource: 'pumpfun-curve' as const,
    priceImpactBps: 10 + index,
    partial: false,
    clickedAtSlot: 1_000 + index,
    filledAtSlot: 1_002 + index,
    latencyMs: 600,
    engineVersion: 1,
    createdAt: now,
  };

  const recorded = await recordTrade(db, {
    snapshot: {
      mint: MINT,
      solReserve: '31000000000',
      tokenReserve: '1000000000000000',
      tokenDecimals: 6,
      feeBps: 125,
      source: 'pumpfun-curve',
      slot: 1_002 + index,
    },
    trade: {
      accountId,
      seasonId,
      userPubkey: TRADER,
      mint: MINT,
      side: 'buy',
      solAmount: base.solAmount.toString(),
      tokenAmount: base.tokenAmount.toString(),
      fee: base.feeLamports.toString(),
      priceImpactBps: base.priceImpactBps,
      partial: false,
      poolSource: 'pumpfun-curve',
      clickedAtSlot: base.clickedAtSlot,
      filledAtSlot: base.filledAtSlot,
      latencyMs: 600,
      engineVersion: 1,
    },
    position: {
      accountId,
      mint: MINT,
      tokenAmount: String(30_000 * (index + 1)),
      costBasis: String(1_000_000 * (index + 1)),
      realizedPnl: '0',
      closed: false,
    },
    // Each trade is quoted against what the one before it left behind: the
    // balance the last fill wrote, and the holding it built up. Null on the
    // first, because there is no position yet.
    expected: {
      solBalance: String(10_000_000_000 - 1_000_000 * after),
      tokenAmount: after === 0 ? null : String(30_000 * after),
    },
    newBalance: String(10_000_000_000 - 1_000_000 * (index + 1)),
    leafHashFor: (sequence) => toHex(hashLeaf({ ...base, sequence })),
    now,
  });

  return recorded.sequence;
}

beforeEach(async () => {
  // A file, not ':memory:'. recordTrade opens a transaction, and libsql gives a
  // transaction its own connection — two connections to ':memory:' are two
  // different databases, so the migrated schema disappears mid-test.
  temp = await createTestDatabase();
  db = temp.db;
  chain = new FakeChain();
  keeper = new Keeper(db, chain);
  await seed();
});

afterEach(() => {
  temp.cleanup();
});

describe('trade sequences', () => {
  it('numbers trades from one, in order', async () => {
    expect(await writeTrade(0)).toBe(1);
    expect(await writeTrade(1)).toBe(2);
    expect(await writeTrade(2)).toBe(3);
  });

  it('gives two trades different leaves', async () => {
    // The bug this replaced: every leaf was hashed with a sequence of zero, so
    // two identical trades committed to the same hash.
    await writeTrade(0);
    // Identical content, written after the first. The leaves must still differ,
    // because the sequence is hashed into them.
    await writeTrade(0, 1);

    const trades = await loadTrades(db, seasonId, TRADER, 1, 999);
    expect(trades[0]!.leafHash).not.toBe(trades[1]!.leafHash);
  });
});

describe('rebuilding leaves', () => {
  it('reproduces the hash stored at trade time', async () => {
    await writeTrade(0);
    await writeTrade(1);

    // If a single field read back differently the rebuild throws, which is the
    // point: a root over leaves that disagree with the record would commit to
    // trades that never happened in that form.
    const trades = await loadTrades(db, seasonId, TRADER, 1, 999);
    expect(() => leavesFor(trades)).not.toThrow();
  });

  it('refuses a trade whose stored hash disagrees', async () => {
    await writeTrade(0);
    const trades = await loadTrades(db, seasonId, TRADER, 1, 999);
    const tampered = [{ ...trades[0]!, leafHash: 'ff'.repeat(32) }];

    expect(() => leavesFor(tampered)).toThrow(/disagree/);
  });
});

describe('running the keeper', () => {
  it('does nothing when there is nothing to commit', async () => {
    const result = await runOnce(db, keeper, options);
    expect(result.batches).toBe(0);
    expect(result.committed).toBe(0);
  });

  it('commits the trades that exist', async () => {
    for (let i = 0; i < 3; i += 1) await writeTrade(i);

    const result = await runOnce(db, keeper, options);
    expect(result.committed).toBe(1);
    expect(result.tradesCommitted).toBe(3);

    const record = await chain.readRecord(1, TRADER);
    expect(record!.leafCount).toBe(3);
  });

  it('does not commit the same trade twice', async () => {
    for (let i = 0; i < 3; i += 1) await writeTrade(i);
    await runOnce(db, keeper, options);

    // The second pass finds nothing outstanding, because the first pass's
    // range now covers those trades.
    const second = await runOnce(db, keeper, options);
    expect(second.batches).toBe(0);
    expect((await chain.readRecord(1, TRADER))!.leafCount).toBe(3);
  });

  it('picks up trades made after the last pass', async () => {
    await writeTrade(0);
    await runOnce(db, keeper, options);

    await writeTrade(1);
    const second = await runOnce(db, keeper, options);

    expect(second.tradesCommitted).toBe(1);
    expect((await chain.readRecord(1, TRADER))!.commitCount).toBe(2);
  });

  it('splits a long run into batches', async () => {
    for (let i = 0; i < 10; i += 1) await writeTrade(i);

    const result = await runOnce(db, keeper, options);
    expect(result.batches).toBe(3);
    expect(result.tradesCommitted).toBe(10);
  });
});

describe('a trade proves itself end to end', () => {
  it('verifies against the chain after being committed', async () => {
    // The whole point of the proof layer, exercised in one go: a trade is
    // written, the keeper commits it, and a stranger holding only the trade
    // and a chain read can confirm it.
    for (let i = 0; i < 3; i += 1) await writeTrade(i);
    await runOnce(db, keeper, options);

    const commits = await commitHistory(db, seasonId, TRADER);
    expect(commits).toHaveLength(1);

    const trades = await loadTrades(
      db,
      seasonId,
      TRADER,
      commits[0]!.fromTradeId,
      commits[0]!.toTradeId,
    );
    const leaves = leavesFor(trades);

    const history: CommittedBatch[] = commits.map((commit) => ({
      root: commit.merkleRoot,
      leaves: commit.leafCount,
      engineVersion: commit.engineVersion,
    }));

    const onChain = (await chain.readRecord(1, TRADER))!.accumulator;

    for (let index = 0; index < leaves.length; index += 1) {
      const result = verifyTrade({
        trade: leaves[index]!,
        batchLeaves: leaves,
        batchIndex: 0,
        history,
        onChainAccumulator: onChain,
      });
      expect(result.verified).toBe(true);
    }
  });

  it('fails verification for a trade that was never made', async () => {
    for (let i = 0; i < 3; i += 1) await writeTrade(i);
    await runOnce(db, keeper, options);

    const commits = await commitHistory(db, seasonId, TRADER);
    const trades = await loadTrades(db, seasonId, TRADER, commits[0]!.fromTradeId, commits[0]!.toTradeId);
    const leaves = leavesFor(trades);

    const invented = { ...leaves[0]!, solAmount: 999_999_999n };
    const result = verifyTrade({
      trade: invented,
      batchLeaves: leaves,
      batchIndex: 0,
      history: commits.map((commit) => ({
        root: commit.merkleRoot,
        leaves: commit.leafCount,
        engineVersion: commit.engineVersion,
      })),
      onChainAccumulator: (await chain.readRecord(1, TRADER))!.accumulator,
    });

    expect(result.verified).toBe(false);
  });

  it('verifies across several commits', async () => {
    for (let i = 0; i < 6; i += 1) await writeTrade(i);
    await runOnce(db, keeper, { ...options, maxBatchSize: 2 });

    const commits = await commitHistory(db, seasonId, TRADER);
    expect(commits.length).toBe(3);

    const history: CommittedBatch[] = commits.map((commit) => ({
      root: commit.merkleRoot,
      leaves: commit.leafCount,
      engineVersion: commit.engineVersion,
    }));
    const onChain = (await chain.readRecord(1, TRADER))!.accumulator;

    // A trade in the middle batch still verifies, which means the chain
    // replay covers everything before and after it.
    const middle = await loadTrades(db, seasonId, TRADER, commits[1]!.fromTradeId, commits[1]!.toTradeId);
    const leaves = leavesFor(middle);

    const result = verifyTrade({
      trade: leaves[0]!,
      batchLeaves: leaves,
      batchIndex: 1,
      history,
      onChainAccumulator: onChain,
    });

    expect(result.verified).toBe(true);
  });
});
