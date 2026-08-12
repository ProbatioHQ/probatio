import { describe, expect, it } from 'vitest';
import type { ConfirmedTransaction, PumpSwapPool } from '@probatio/pools';
import { asPoolSwap, joins, swapCount } from '../src/pumpswap';

/**
 * Deciding what counts as a reading.
 *
 * Every rejection in here was learned by being wrong on real data first, and
 * each one moved a reported "engine error" by orders of magnitude while the
 * engine never changed. They are tested directly because a harness that accepts
 * bad evidence reports a number that looks like a measurement and is not one.
 */

const POOL: PumpSwapPool = {
  poolBump: 255,
  index: 0,
  creator: 'Cr8888888888888888888888888888888888888888888',
  baseMint: 'Ba8888888888888888888888888888888888888888888',
  quoteMint: 'So11111111111111111111111111111111111111112',
  lpMint: 'Lp8888888888888888888888888888888888888888888',
  baseVault: 'BASEVAULT',
  quoteVault: 'QUOTEVAULT',
  lpSupply: 1_000n,
  coinCreator: '11111111111111111111111111111111',
};

const WSOL = 'So11111111111111111111111111111111111111112';
const FEE_RECIPIENT = 'FEE_RECIPIENT';
const KEYS = ['trader', 'BASEVAULT', 'QUOTEVAULT', FEE_RECIPIENT, 'AGGREGATOR'];

interface Balances {
  readonly baseBefore: bigint;
  readonly baseAfter: bigint;
  readonly quoteBefore: bigint;
  readonly quoteAfter: bigint;
  readonly feeGain?: bigint;
  readonly aggregatorGain?: bigint;
  readonly instructions?: readonly string[];
}

function transaction(b: Balances): ConfirmedTransaction {
  const instructions = b.instructions ?? ['Buy'];
  return {
    signature: 'sig',
    slot: 10,
    blockTime: 1,
    err: null,
    accountKeys: KEYS,
    preBalances: [],
    postBalances: [],
    preTokenBalances: [
      { accountIndex: 1, mint: POOL.baseMint, amount: b.baseBefore },
      { accountIndex: 2, mint: WSOL, amount: b.quoteBefore },
      { accountIndex: 3, mint: WSOL, amount: 0n },
      { accountIndex: 4, mint: WSOL, amount: 0n },
    ],
    postTokenBalances: [
      { accountIndex: 1, mint: POOL.baseMint, amount: b.baseAfter },
      { accountIndex: 2, mint: WSOL, amount: b.quoteAfter },
      { accountIndex: 3, mint: WSOL, amount: b.feeGain ?? 0n },
      { accountIndex: 4, mint: WSOL, amount: b.aggregatorGain ?? 0n },
    ],
    logMessages: instructions.map((name) => `Program log: Instruction: ${name}`),
  };
}

describe('reading a transaction as one swap', () => {
  it('reads a buy, with the reserves either side of it', () => {
    const swap = asPoolSwap(
      transaction({
        baseBefore: 1_000_000n,
        baseAfter: 900_000n,
        quoteBefore: 500_000n,
        quoteAfter: 600_000n,
        feeGain: 50n,
      }),
      POOL,
      [FEE_RECIPIENT],
    );

    expect(swap?.isBuy).toBe(true);
    expect(swap?.tokens).toBe(100_000n);
    expect(swap?.solBefore).toBe(500_000n);
    // What the trader put in: what reached the pool plus the venue's fee.
    expect(swap?.grossIn).toBe(100_050n);
  });

  it('reads a sell net of the fee taken out of the proceeds', () => {
    const swap = asPoolSwap(
      transaction({
        baseBefore: 900_000n,
        baseAfter: 1_000_000n,
        quoteBefore: 600_000n,
        quoteAfter: 500_000n,
        feeGain: 50n,
        instructions: ['Sell'],
      }),
      POOL,
      [FEE_RECIPIENT],
    );

    expect(swap?.isBuy).toBe(false);
    expect(swap?.tokens).toBe(100_000n);
    expect(swap?.netOut).toBe(99_950n);
  });

  it('refuses a liquidity deposit, which moves both vaults the same way', () => {
    // This one first reported a fee of ninety percent.
    expect(
      asPoolSwap(
        transaction({
          baseBefore: 900_000n,
          baseAfter: 1_000_000n,
          quoteBefore: 500_000n,
          quoteAfter: 600_000n,
        }),
        POOL,
        [FEE_RECIPIENT],
      ),
    ).toBeNull();
  });

  it('ignores a fee taken by somebody who is not the venue', () => {
    // A front end taking one percent in the same transaction is not a cost of
    // trading here. Counting it made the engine look generous by 124 bps —
    // almost exactly that one percent, which was the clue.
    const swap = asPoolSwap(
      transaction({
        baseBefore: 1_000_000n,
        baseAfter: 900_000n,
        quoteBefore: 500_000n,
        quoteAfter: 600_000n,
        feeGain: 50n,
        aggregatorGain: 1_000n,
      }),
      POOL,
      [FEE_RECIPIENT],
    );

    expect(swap?.grossIn).toBe(100_050n);
  });

  it('refuses a transaction that swapped more than once', () => {
    // Balances are transaction-level, so an arbitrage that buys then sells
    // solves as one badly priced swap. On a botted pool that reported a median
    // error of thousands of basis points against an engine that was fine.
    expect(
      asPoolSwap(
        transaction({
          baseBefore: 1_000_000n,
          baseAfter: 900_000n,
          quoteBefore: 500_000n,
          quoteAfter: 600_000n,
          instructions: ['Sell', 'BuyExactSolIn'],
        }),
        POOL,
        [FEE_RECIPIENT],
      ),
    ).toBeNull();
  });

  it('refuses a transaction whose swap it does not recognise', () => {
    // Costing samples is the safe direction; inventing them is not.
    expect(
      asPoolSwap(
        transaction({
          baseBefore: 1_000_000n,
          baseAfter: 900_000n,
          quoteBefore: 500_000n,
          quoteAfter: 600_000n,
          instructions: ['SomethingNew'],
        }),
        POOL,
        [FEE_RECIPIENT],
      ),
    ).toBeNull();
  });

  it('refuses a failed transaction', () => {
    const failed = { ...transaction({
      baseBefore: 1_000_000n, baseAfter: 900_000n,
      quoteBefore: 500_000n, quoteAfter: 600_000n,
    }), err: { InstructionError: [0, 'Custom'] } };
    expect(asPoolSwap(failed, POOL, [FEE_RECIPIENT])).toBeNull();
  });

  it('refuses a transaction that never touched this pool', () => {
    const elsewhere = { ...transaction({
      baseBefore: 1_000_000n, baseAfter: 900_000n,
      quoteBefore: 500_000n, quoteAfter: 600_000n,
    }), accountKeys: ['trader', 'other', 'other2', FEE_RECIPIENT, 'AGGREGATOR'] };
    expect(asPoolSwap(elsewhere, POOL, [FEE_RECIPIENT])).toBeNull();
  });
});

describe('counting swaps in a transaction', () => {
  it('counts the venue\'s own instructions and not the router around them', () => {
    expect(
      swapCount([
        'Program log: Instruction: RouteV2',
        'Program log: Instruction: BuyExactQuoteIn',
        'Program log: Instruction: GetFees',
      ]),
    ).toBe(1);
  });

  it('sees both halves of an arbitrage', () => {
    expect(
      swapCount([
        'Program log: Instruction: SwapTob',
        'Program log: Instruction: Sell',
        'Program log: Instruction: BuyExactSolIn',
      ]),
    ).toBe(2);
  });

  it('counts nothing in a transaction that did not swap', () => {
    expect(swapCount(['Program log: Instruction: CreateTokenAccount'])).toBe(0);
  });
});

describe('whether one swap follows another', () => {
  const base = {
    signature: 's', slot: 1, blockTime: 1, isBuy: true,
    grossIn: 0n, netOut: 0n, tokens: 0n,
  };

  it('joins when the reserves left are the reserves found', () => {
    expect(
      joins(
        { ...base, solBefore: 1n, tokenBefore: 9n, solAfter: 2n, tokenAfter: 8n },
        { ...base, solBefore: 2n, tokenBefore: 8n, solAfter: 3n, tokenAfter: 7n },
      ),
    ).toBe(true);
  });

  it('does not join when something moved the pool in between', () => {
    // The pair says nothing about the engine, so it must not be scored.
    expect(
      joins(
        { ...base, solBefore: 1n, tokenBefore: 9n, solAfter: 2n, tokenAfter: 8n },
        { ...base, solBefore: 5n, tokenBefore: 4n, solAfter: 6n, tokenAfter: 3n },
      ),
    ).toBe(false);
  });
});
