import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@libsql/client';
import { createTestDatabase, type TestDatabase } from '../src/testing';
import { FREE_PLAY_ORDINAL } from '../src/constants';
import { ensureAccount, ensureFreePlaySeason } from '../src/trading';
import { createPaymentIntent, settlePayment } from '../src/payments';
import { upsertUser } from '../src/index';

/**
 * Buying practice balance.
 *
 * The credit and the payment share a transaction, and the credit may only ever
 * reach the free-play account. Both are tested directly: one is money given
 * away if it breaks, the other is a leaderboard that measures spending.
 */

const USER = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const TREASURY = 'Vote111111111111111111111111111111111111111';
const NOW = 1_700_000_000_000;
const TEN_SOL = 10_000_000_000n;

let harness: TestDatabase;
let db: Client;
let freePlayId: number;

async function buy(reference: string, signature: string, credit: bigint, price = 60_000_000n) {
  await createPaymentIntent(
    db,
    {
      reference,
      userPubkey: USER,
      seasonId: null,
      purpose: 'practice_sol',
      recipient: TREASURY,
      amount: price.toString(),
      expiresAt: NOW + 600_000,
    },
    NOW,
  );
  return settlePayment(db, {
    reference,
    txSignature: signature,
    userPubkey: USER,
    seasonId: null,
    purpose: 'practice_sol',
    amount: price.toString(),
    amountCredited: credit.toString(),
    now: NOW,
  });
}

async function balance(seasonId: number): Promise<bigint> {
  const row = await db.execute({
    sql: 'SELECT sol_balance FROM accounts WHERE user_pubkey = ? AND season_id = ?',
    args: [USER, seasonId],
  });
  return BigInt(String(row.rows[0]!['sol_balance']));
}

beforeEach(async () => {
  // A file, not `:memory:`. settlePayment opens a transaction, libsql gives a
  // transaction its own connection, and two connections to `:memory:` are two
  // different databases — the schema simply vanishes mid-test.
  harness = await createTestDatabase();
  db = harness.db;
  await upsertUser(db, USER, NOW);
  freePlayId = await ensureFreePlaySeason(db, NOW);
  await ensureAccount(db, freePlayId, USER, NOW);
});

afterEach(() => harness?.cleanup());

describe('crediting practice balance', () => {
  it('adds the balance that was paid for', async () => {
    await buy('ref-1', 'sig-1', TEN_SOL);
    expect(await balance(freePlayId)).toBe(TEN_SOL * 2n);
  });

  it('credits once, however many times the payment is confirmed', async () => {
    // A buyer refreshing, or a retry after a timeout, must not buy twice.
    await buy('ref-1', 'sig-1', TEN_SOL);
    const again = await settlePayment(db, {
      reference: 'ref-1',
      txSignature: 'sig-1',
      userPubkey: USER,
      seasonId: null,
      purpose: 'practice_sol',
      amount: '60000000',
      amountCredited: TEN_SOL.toString(),
      now: NOW,
    });

    expect(again.fresh).toBe(false);
    expect(await balance(freePlayId)).toBe(TEN_SOL * 2n);
  });

  it('adds up across separate purchases', async () => {
    await buy('ref-1', 'sig-1', TEN_SOL);
    await buy('ref-2', 'sig-2', TEN_SOL * 5n);
    expect(await balance(freePlayId)).toBe(TEN_SOL * 7n);
  });

  it('never touches a ranked season', async () => {
    /*
     * The reason the store exists in this shape. A season ranks by percentage
     * return, so somebody down fifty percent could buy the loss away and the
     * board would measure spending instead of trading.
     */
    const ranked = await db.execute({
      sql: `INSERT INTO seasons
              (ordinal, name, ranked, status, starts_at, ends_at, entry_opens_at, entry_closes_at,
               starting_balance, entry_cost, house_bps, house_threshold, latency_ms,
               max_price_impact_bps, engine_version, scoring_formula_hash, sponsor_lamports, created_at)
            VALUES (1, 'Season 1', 1, 'running', ?, ?, ?, ?, ?, '0', 0, '0', 600, 500, 1, ?, '0', ?)
            RETURNING id`,
      args: [NOW, NOW + 1, NOW, NOW + 1, TEN_SOL.toString(), 'a'.repeat(64), NOW],
    });
    const rankedId = Number(ranked.rows[0]!['id']);
    await ensureAccount(db, rankedId, USER, NOW);

    await buy('ref-1', 'sig-1', TEN_SOL * 10n);

    expect(await balance(rankedId)).toBe(TEN_SOL);
    expect(await balance(freePlayId)).toBe(TEN_SOL * 11n);
  });

  it('refuses to record a payment it cannot credit', async () => {
    // Recording the payment without the credit would take money for nothing.
    await db.execute({ sql: 'DELETE FROM accounts WHERE user_pubkey = ?', args: [USER] });
    await expect(buy('ref-1', 'sig-1', TEN_SOL)).rejects.toThrow(/free play account/i);

    const payments = await db.execute('SELECT COUNT(*) AS n FROM payments');
    expect(Number(payments.rows[0]!['n'])).toBe(0);
  });

  it('still records an entry payment without crediting anything', async () => {
    // The other purposes must be untouched by this.
    await createPaymentIntent(
      db,
      {
        reference: 'entry-1',
        userPubkey: USER,
        seasonId: freePlayId,
        purpose: 'season_entry',
        recipient: TREASURY,
        amount: '50000000',
        expiresAt: NOW + 600_000,
      },
      NOW,
    );
    await settlePayment(db, {
      reference: 'entry-1',
      txSignature: 'entry-sig',
      userPubkey: USER,
      seasonId: freePlayId,
      purpose: 'season_entry',
      amount: '50000000',
      now: NOW,
    });

    expect(await balance(freePlayId)).toBe(TEN_SOL);
  });

  it('keeps payments recorded before the store existed', async () => {
    // The migration rebuilds both tables to widen a CHECK constraint, and a
    // rebuild that drops rows would erase who had paid for what.
    const seasons = await db.execute({
      sql: 'SELECT id FROM seasons WHERE ordinal = ?',
      args: [FREE_PLAY_ORDINAL],
    });
    expect(seasons.rows).toHaveLength(1);

    await buy('ref-1', 'sig-1', TEN_SOL);
    const rows = await db.execute('SELECT purpose FROM payments');
    expect(rows.rows.map((row) => String(row['purpose']))).toEqual(['practice_sol']);
  });
});
