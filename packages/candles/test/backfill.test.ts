import { describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import type { RpcClient, SignatureInfo, TransactionLogs } from '@probatio/pools';
import { backfillFromCurve } from '../src/backfill';
import { buildCandles } from '../src/candles';

const MINT = '3SPyj7fHQ6TKGR5Agua1gPdCnb2oWHF8Zi8bY33bpump';
const CURVE = 'FHeBR39zwYtUuXQFLbShSsVKkEG6ti5Eup3zUdopiegi';

/**
 * A TradeEvent log line, built the way the chain emits it.
 *
 * Constructing real bytes rather than stubbing the decoder means these tests
 * exercise the same parsing path production uses.
 */
function tradeEventLog(options: {
  mint: string;
  timestamp: number;
  virtualSol: bigint;
  virtualToken: bigint;
  solAmount?: bigint;
}): string {
  const data = Buffer.alloc(200);
  Buffer.from([0xbd, 0xdb, 0x7f, 0xd3, 0x4e, 0xe6, 0x61, 0xee]).copy(data, 0);

  Buffer.from(bs58.decode(options.mint)).copy(data, 8);

  data.writeBigUInt64LE(options.solAmount ?? 1_000_000n, 40);
  data.writeBigUInt64LE(1_000n, 48);
  data.writeUInt8(1, 56);
  Buffer.from(bs58.decode(CURVE)).copy(data, 57);
  data.writeBigInt64LE(BigInt(options.timestamp), 89);
  data.writeBigUInt64LE(options.virtualSol, 97);
  data.writeBigUInt64LE(options.virtualToken, 105);
  // Real reserves must not exceed virtual ones or the decoder rejects them.
  data.writeBigUInt64LE(options.virtualSol - 30_000_000_000n, 113);
  data.writeBigUInt64LE(options.virtualToken - 279_900_000_000_000n, 121);

  return `Program data: ${data.toString('base64')}`;
}

interface StubOptions {
  signatures: SignatureInfo[];
  logs: Record<string, TransactionLogs | null>;
}

function stubRpc(options: StubOptions): RpcClient {
  const calls: string[] = [];
  const rpc = {
    calls,
    async getSignatures(_address: string, opts: { before?: string; limit?: number } = {}) {
      calls.push('getSignatures');
      const start = opts.before
        ? options.signatures.findIndex((s) => s.signature === opts.before) + 1
        : 0;
      return options.signatures.slice(start, start + (opts.limit ?? 100));
    },
    async getTransactionLogs(signature: string) {
      calls.push('getTransactionLogs');
      return options.logs[signature] ?? null;
    },
  };
  return rpc as unknown as RpcClient;
}

function signature(name: string, blockTime: number, err: unknown = null): SignatureInfo {
  return { signature: name, slot: blockTime, blockTime, err };
}

function logs(name: string, blockTime: number, lines: string[]): TransactionLogs {
  return { signature: name, slot: blockTime, blockTime, err: null, logMessages: lines };
}

describe('backfillFromCurve', () => {
  it('turns trade events into observations', async () => {
    const rpc = stubRpc({
      signatures: [signature('a', 200), signature('b', 100)],
      logs: {
        a: logs('a', 200, [
          tradeEventLog({ mint: MINT, timestamp: 200, virtualSol: 31_000_000_000n, virtualToken: 1_000_000_000_000_000n }),
        ]),
        b: logs('b', 100, [
          tradeEventLog({ mint: MINT, timestamp: 100, virtualSol: 30_500_000_000n, virtualToken: 1_010_000_000_000_000n }),
        ]),
      },
    });

    const result = await backfillFromCurve(rpc, MINT, CURVE);
    expect(result.eventsFound).toBe(2);
    expect(result.observations).toHaveLength(2);
  });

  it('returns observations oldest first', async () => {
    // Chain history arrives newest first. A caller reading the raw list should
    // not be handed a reversed series.
    const rpc = stubRpc({
      signatures: [signature('a', 200), signature('b', 100)],
      logs: {
        a: logs('a', 200, [
          tradeEventLog({ mint: MINT, timestamp: 200, virtualSol: 31_000_000_000n, virtualToken: 1_000_000_000_000_000n }),
        ]),
        b: logs('b', 100, [
          tradeEventLog({ mint: MINT, timestamp: 100, virtualSol: 30_500_000_000n, virtualToken: 1_010_000_000_000_000n }),
        ]),
      },
    });

    const { observations } = await backfillFromCurve(rpc, MINT, CURVE);
    expect(observations[0]!.timestamp).toBe(100);
    expect(observations[1]!.timestamp).toBe(200);
  });

  it('skips reverted transactions', async () => {
    // A trade that failed never moved the price, so drawing a candle for it
    // would show something that did not happen.
    const rpc = stubRpc({
      signatures: [signature('a', 200, { InstructionError: [0, 'Custom'] }), signature('b', 100)],
      logs: {
        b: logs('b', 100, [
          tradeEventLog({ mint: MINT, timestamp: 100, virtualSol: 30_500_000_000n, virtualToken: 1_010_000_000_000_000n }),
        ]),
      },
    });

    const result = await backfillFromCurve(rpc, MINT, CURVE);
    expect(result.eventsFound).toBe(1);
  });

  it('ignores events for a different mint in the same transaction', async () => {
    const other = 'J5reXJehdCV86HPHg2ewbeGYfMkxQT2YmLcg4DVfpump';
    const rpc = stubRpc({
      signatures: [signature('a', 200)],
      logs: {
        a: logs('a', 200, [
          tradeEventLog({ mint: other, timestamp: 200, virtualSol: 31_000_000_000n, virtualToken: 1_000_000_000_000_000n }),
          tradeEventLog({ mint: MINT, timestamp: 200, virtualSol: 31_000_000_000n, virtualToken: 1_000_000_000_000_000n }),
        ]),
      },
    });

    const result = await backfillFromCurve(rpc, MINT, CURVE);
    expect(result.eventsFound).toBe(1);
    expect(result.observations).toHaveLength(1);
  });

  it('ignores unrelated log lines', async () => {
    const rpc = stubRpc({
      signatures: [signature('a', 200)],
      logs: {
        a: logs('a', 200, [
          'Program log: Instruction: Buy',
          'Program data: bm90IGFuIGV2ZW50',
          tradeEventLog({ mint: MINT, timestamp: 200, virtualSol: 31_000_000_000n, virtualToken: 1_000_000_000_000_000n }),
        ]),
      },
    });

    expect((await backfillFromCurve(rpc, MINT, CURVE)).eventsFound).toBe(1);
  });

  it('reports truncation when a limit stops the walk', async () => {
    const signatures = Array.from({ length: 300 }, (_, i) => signature(`s${i}`, 1000 - i));
    const rpc = stubRpc({ signatures, logs: {} });

    const result = await backfillFromCurve(rpc, MINT, CURVE, { maxTransactions: 100 });
    // A caller must be able to tell "this is all of it" from "this is what we
    // could afford to read".
    expect(result.truncated).toBe(true);
    expect(result.transactionsScanned).toBe(100);
  });

  it('does not report truncation when history simply ran out', async () => {
    const rpc = stubRpc({ signatures: [signature('a', 200)], logs: {} });
    const result = await backfillFromCurve(rpc, MINT, CURVE, { maxTransactions: 100 });
    expect(result.truncated).toBe(false);
  });

  it('stops at the since boundary', async () => {
    const signatures = [signature('a', 300), signature('b', 200), signature('c', 100)];
    const rpc = stubRpc({
      signatures,
      logs: {
        a: logs('a', 300, [
          tradeEventLog({ mint: MINT, timestamp: 300, virtualSol: 31_000_000_000n, virtualToken: 1_000_000_000_000_000n }),
        ]),
        b: logs('b', 200, [
          tradeEventLog({ mint: MINT, timestamp: 200, virtualSol: 31_000_000_000n, virtualToken: 1_000_000_000_000_000n }),
        ]),
        c: logs('c', 100, [
          tradeEventLog({ mint: MINT, timestamp: 100, virtualSol: 31_000_000_000n, virtualToken: 1_000_000_000_000_000n }),
        ]),
      },
    });

    const result = await backfillFromCurve(rpc, MINT, CURVE, { since: 200 });
    expect(result.observations.map((o) => o.timestamp)).toEqual([200, 300]);
  });

  it('handles a token with no history', async () => {
    const rpc = stubRpc({ signatures: [], logs: {} });
    const result = await backfillFromCurve(rpc, MINT, CURVE);
    expect(result.observations).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it('produces observations that build into candles', async () => {
    const rpc = stubRpc({
      signatures: [signature('a', 130), signature('b', 70), signature('c', 10)],
      logs: {
        a: logs('a', 130, [
          tradeEventLog({ mint: MINT, timestamp: 130, virtualSol: 32_000_000_000n, virtualToken: 1_000_000_000_000_000n }),
        ]),
        b: logs('b', 70, [
          tradeEventLog({ mint: MINT, timestamp: 70, virtualSol: 31_000_000_000n, virtualToken: 1_000_000_000_000_000n }),
        ]),
        c: logs('c', 10, [
          tradeEventLog({ mint: MINT, timestamp: 10, virtualSol: 30_500_000_000n, virtualToken: 1_000_000_000_000_000n }),
        ]),
      },
    });

    const { observations } = await backfillFromCurve(rpc, MINT, CURVE);
    const candles = buildCandles(observations, 'm1');
    expect(candles.map((c) => c.openTime)).toEqual([0, 60, 120]);
    // Rising reserves against a fixed token side means a rising price.
    expect(candles[0]!.close).toBeLessThan(candles[2]!.close);
  });
});
