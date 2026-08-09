import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@libsql/client';
import { createTestDatabase, pendingCommits, commitHistory, type TestDatabase } from '@probatio/db';
import { EMPTY_ACCUMULATOR, extendChain, fromHex, toHex } from '@probatio/commit';
import { Keeper } from '../src/keeper';
import { auditRecords } from '../src/audit';
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
let temp: TestDatabase;
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
                latency_ms, engine_version, pool_snapshot_id, leaf_hash, sequence, created_at
              ) VALUES (?, ?, ?, 'mint', 'buy', '1000000', '1000', '100', 10, 0,
                        'pumpfun-curve', 1, 2, 600, 1, ?, ?, ?, ?)`,
        // A real sequence: the unique index refuses two trades sharing one,
        // which is the whole reason it exists.
        args: [accountId, seasonId, trader, snapshotId, `leaf${trader}${i}`, i + 1, now + i],
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
  temp = await createTestDatabase();
  db = temp.db;
  chain = new FakeChain();
  keeper = new Keeper(db, chain);
});

afterEach(() => {
  temp.cleanup();
});

/** A season with one confirmed commit for each trader. */
async function commitBoth(): Promise<number> {
  const seasonId = await seedSeason();
  for (const trader of [TRADER, OTHER]) {
    const ids = await tradeIdsFor(seasonId, trader);
    await keeper.commit(request(seasonId, ids.slice(0, 10), { userPubkey: trader }));
  }
  return seasonId;
}

describe('auditing what the chain holds', () => {
  it('is clean when only the keeper has written', async () => {
    const seasonId = await commitBoth();
    void seasonId;

    const result = await auditRecords(db, chain, ordinalFor);
    expect(result.compromised).toBe(false);
    expect(result.findings).toEqual([]);
    expect(result.checked).toBe(2);
  });

  it('catches a commit the keeper never made', async () => {
    // The case the existing halt logic misses entirely. The keeper only
    // notices a foreign write on a trader it happens to have work in flight
    // for — a stolen key would be used everywhere else.
    await commitBoth();

    await chain.commitRoot({
      seasonOrdinal: 1,
      trader: TRADER,
      merkleRoot: 'ff'.repeat(32),
      leaves: 3,
      engineVersion: 1,
    });

    const result = await auditRecords(db, chain, ordinalFor);
    expect(result.compromised).toBe(true);

    const finding = result.findings.find((f) => f.trader === TRADER);
    expect(finding?.verdict).toBe('foreign_commit');
    expect(finding?.detail).toContain('somebody else');
  });

  it('names only the traders that were touched', async () => {
    await commitBoth();

    await chain.commitRoot({
      seasonOrdinal: 1,
      trader: OTHER,
      merkleRoot: 'ff'.repeat(32),
      leaves: 1,
      engineVersion: 1,
    });

    const result = await auditRecords(db, chain, ordinalFor);
    expect(result.findings.map((f) => f.trader)).toEqual([OTHER]);
  });

  it('reports a record the chain does not have', async () => {
    await commitBoth();
    chain.records.clear();

    const result = await auditRecords(db, chain, ordinalFor);
    expect(result.findings.every((f) => f.verdict === 'missing_record')).toBe(true);
    // Not a compromise. A commit that never landed is a different problem.
    expect(result.compromised).toBe(false);
  });

  it('reports an unreadable chain without calling it a compromise', async () => {
    await commitBoth();

    const broken = {
      commitRoot: chain.commitRoot.bind(chain),
      readRecord: async () => {
        throw new Error('rpc unreachable');
      },
    };

    const result = await auditRecords(db, broken, ordinalFor);
    expect(result.findings.every((f) => f.verdict === 'unreadable')).toBe(true);
    expect(result.compromised).toBe(false);
  });

  it('has nothing to check before anything is committed', async () => {
    await seedSeason();
    const result = await auditRecords(db, chain, ordinalFor);
    expect(result.checked).toBe(0);
    expect(result.compromised).toBe(false);
  });
});
