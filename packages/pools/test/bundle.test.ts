import { describe, expect, it } from 'vitest';
import { launchBundle } from '../src/bundle';
import {
  TRADE_EVENT_DISCRIMINATOR,
  TRADE_EVENT_MIN_BYTES,
  TRADE_EVENT_OFFSETS,
} from '../src/events';
import type { RpcClient } from '../src/rpc';

/**
 * Totalling what was taken in a token's launch slot.
 *
 * The number a bundle filter turns on, and the one place in this feature where
 * giving up quietly would be worse than not offering the filter at all: a walk
 * that cannot reach the create must say so, because zero bought in the launch
 * slot is exactly the answer that passes a "not bundled" rule.
 */

const CURVE = 'CurveAddress1111111111111111111111111111111';
const SUPPLY = 1_000_000_000_000_000n;

/**
 * A pump.fun trade event, as the program logs it.
 *
 * The reserves have to be filled in, not left at zero. `decodeTradeEvent`
 * refuses an event whose virtual reserves are zero, because a wrong offset
 * would produce exactly that, so a fixture that leaves them blank is silently
 * discarded and every total comes back nought.
 */
function tradeLog(tokenAmount: bigint, isBuy: boolean): string {
  const o = TRADE_EVENT_OFFSETS;
  const body = new Uint8Array(TRADE_EVENT_MIN_BYTES);
  const view = new DataView(body.buffer);
  body.set(TRADE_EVENT_DISCRIMINATOR, 0);
  view.setBigUint64(o.solAmount, 1_000_000_000n, true);
  view.setBigUint64(o.tokenAmount, tokenAmount, true);
  body[o.isBuy] = isBuy ? 1 : 0;
  view.setBigUint64(o.timestamp, 1_787_500_000n, true);
  // Virtual always exceeds real, or the decoder reads it as a drifted layout.
  view.setBigUint64(o.virtualSolReserves, 30_000_000_000n, true);
  view.setBigUint64(o.virtualTokenReserves, 1_073_000_000_000_000n, true);
  view.setBigUint64(o.realSolReserves, 1_000_000_000n, true);
  view.setBigUint64(o.realTokenReserves, 793_000_000_000_000n, true);
  return `Program data: ${Buffer.from(body).toString('base64')}`;
}

interface Sig {
  signature: string;
  slot: number;
  err: unknown;
}

function chainOf(sigs: Sig[], logs: Record<string, string[]>) {
  let signatureCalls = 0;
  const rpc = {
    async getSignatures(_address: string, options: { limit?: number; before?: string } = {}) {
      signatureCalls += 1;
      const start = options.before
        ? sigs.findIndex((s) => s.signature === options.before) + 1
        : 0;
      return sigs.slice(start, start + (options.limit ?? 100)).map((s) => ({
        signature: s.signature,
        slot: s.slot,
        blockTime: null,
        err: s.err,
      }));
    },
    async getTransactionLogs(signature: string) {
      return { signature, slot: 0, blockTime: null, err: null, logMessages: logs[signature] ?? [] };
    },
  } as unknown as RpcClient;
  return { rpc, signatureCalls: () => signatureCalls };
}

describe('what went in the launch slot', () => {
  it('totals the buys that landed with the create', async () => {
    // Newest first, as the chain returns them. The create is the oldest.
    const sigs: Sig[] = [
      { signature: 'later', slot: 400, err: null },
      { signature: 'buy2', slot: 100, err: null },
      { signature: 'buy1', slot: 100, err: null },
      { signature: 'create', slot: 100, err: null },
    ];
    const { rpc } = chainOf(sigs, {
      later: [tradeLog(50_000_000_000_000n, true)], // a later buy, not in the slot
      buy2: [tradeLog(100_000_000_000_000n, true)],
      buy1: [tradeLog(100_000_000_000_000n, true)],
      create: [],
    });

    const found = await launchBundle(rpc, CURVE);
    expect(found).not.toBeNull();
    expect(found!.slot).toBe(100);
    // Two hundred trillion of a quadrillion: twenty percent.
    expect(found!.boughtTokens).toBe(200_000_000_000_000n);
    expect(found!.bundledBps).toBe(2_000);
    expect(found!.buys).toBe(2);
  });

  it('counts nothing when the launch slot held only the create', async () => {
    const sigs: Sig[] = [
      { signature: 'buy', slot: 300, err: null },
      { signature: 'create', slot: 100, err: null },
    ];
    const { rpc } = chainOf(sigs, { buy: [tradeLog(SUPPLY / 2n, true)], create: [] });

    // A real zero, which is what a clean launch looks like and is a different
    // fact from not knowing.
    const found = await launchBundle(rpc, CURVE);
    expect(found!.bundledBps).toBe(0);
    expect(found!.buys).toBe(0);
  });

  it('ignores sells and reverted transactions in the slot', async () => {
    const sigs: Sig[] = [
      { signature: 'failed', slot: 100, err: { InstructionError: [0, 'X'] } },
      { signature: 'sell', slot: 100, err: null },
      { signature: 'buy', slot: 100, err: null },
      { signature: 'create', slot: 100, err: null },
    ];
    const { rpc } = chainOf(sigs, {
      failed: [tradeLog(SUPPLY, true)],
      sell: [tradeLog(SUPPLY / 4n, false)],
      buy: [tradeLog(SUPPLY / 10n, true)],
      create: [],
    });

    // A trade that reverted bought nothing, and a sell is not a buy.
    const found = await launchBundle(rpc, CURVE);
    expect(found!.bundledBps).toBe(1_000);
    expect(found!.buys).toBe(1);
  });

  /*
   * The one that matters. An established token's create is thousands of
   * signatures back, and answering from the oldest one this happened to reach
   * would report some arbitrary later slot as the launch. That is a wrong
   * number rather than a missing one, and it would read as a clean launch.
   */
  it('refuses to answer when it cannot reach the create', async () => {
    const many: Sig[] = Array.from({ length: 900 }, (_, i) => ({
      signature: `s${i}`,
      slot: 1_000 - i,
      err: null,
    }));
    const { rpc } = chainOf(many, {});

    expect(await launchBundle(rpc, CURVE)).toBeNull();
  });

  it('gives up rather than paging for ever', async () => {
    const many: Sig[] = Array.from({ length: 5_000 }, (_, i) => ({
      signature: `s${i}`,
      slot: 1_000,
      err: null,
    }));
    const { rpc, signatureCalls } = chainOf(many, {});

    await launchBundle(rpc, CURVE);
    // Three pages of two hundred, and then it stops.
    expect(signatureCalls()).toBe(3);
  });

  it('says nothing for a curve with no history at all', async () => {
    const { rpc } = chainOf([], {});
    expect(await launchBundle(rpc, CURVE)).toBeNull();
  });
});
