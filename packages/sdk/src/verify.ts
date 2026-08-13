import {
  EMPTY_ACCUMULATOR,
  buildProof,
  buildTree,
  computeRoot,
  extendChain,
  fromHex,
  hashLeaf,
  toHex,
  type TradeLeaf,
} from '@probatio/commit';
import { findProgramAddress } from '@probatio/pools';
import bs58 from 'bs58';
import {
  PROGRAM_ID,
  RECORD_SEED,
  SEASON_SEED,
  TRADER_RECORD_DISCRIMINATOR,
} from './constants';
import { ProbatioError, getProof, type ReadOptions } from './read';
import type { ProofBundle, RawLeaf, VerifiedRecord, VerifyCheck } from './types';

/**
 * Checking a record against the chain, the way the /verify page does, headless.
 *
 * The proof endpoint hands over the trades. Everything after that is done here
 * and against an RPC the caller chooses: the roots are rebuilt from the trades,
 * folded into an accumulator, and compared to the one Solana actually holds at
 * an address derived from the seeds in this package. Nothing in the verdict
 * comes from the server the proof came from.
 */

export interface VerifyOptions extends ReadOptions {
  /** A Solana RPC endpoint. Required: the chain read is the point. */
  readonly rpc: string;
  /** A specific season ordinal, or the latest committed when omitted. */
  readonly season?: number | undefined;
  /** Override the program id. Defaults to the canonical one. */
  readonly programId?: string | undefined;
}

function toLeaf(raw: RawLeaf): TradeLeaf {
  return {
    ...raw,
    solAmount: BigInt(raw.solAmount),
    tokenAmount: BigInt(raw.tokenAmount),
    feeLamports: BigInt(raw.feeLamports),
    solReserve: BigInt(raw.solReserve),
    tokenReserve: BigInt(raw.tokenReserve),
    deliverableTokens: BigInt(raw.deliverableTokens),
  };
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64ToBytes(input: string): Uint8Array {
  const clean = input.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let index = 0;
  for (const character of clean) {
    acc = (acc << 6) | B64.indexOf(character);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index] = (acc >> bits) & 0xff;
      index += 1;
    }
  }
  return out.subarray(0, index);
}

function seasonPda(ordinal: number, programId: string): string {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setInt16(0, ordinal, true);
  return findProgramAddress([SEASON_SEED, bytes], programId).address;
}

function recordPda(season: string, trader: string, programId: string): string {
  return findProgramAddress([RECORD_SEED, bs58.decode(season), bs58.decode(trader)], programId).address;
}

/** The accumulator inside a TraderRecord account, or null if it is not one. */
function accumulatorFrom(base64: string): string | null {
  const data = base64ToBytes(base64);
  // 8 discriminator, 32 season, 32 trader, then 32 accumulator.
  if (data.length < 104) return null;
  const hex = (from: number, to: number): string =>
    [...data.subarray(from, to)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  if (hex(0, 8) !== TRADER_RECORD_DISCRIMINATOR) return null;
  return hex(72, 104);
}

async function rpcCall<T>(url: string, method: string, params: unknown[], doFetch: typeof fetch): Promise<T> {
  const response = await doFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const body = (await response.json().catch(() => null)) as { result?: T; error?: { message?: string } } | null;
  if (!body || body.error) {
    throw new ProbatioError(`rpc ${method} failed: ${body?.error?.message ?? `HTTP ${response.status}`}`);
  }
  return body.result as T;
}

/** Verify a record, either freshly fetched (`verifyRecord`) or already in hand (`verifyBundle`). */
export async function verifyBundle(bundle: ProofBundle, options: VerifyOptions): Promise<VerifiedRecord> {
  if (!options.rpc) {
    throw new ProbatioError('verifyRecord needs an rpc endpoint to check the record against the chain');
  }
  const doFetch = options.fetchImpl ?? (globalThis.fetch as typeof fetch);
  const programId = options.programId ?? PROGRAM_ID;
  const checks: VerifyCheck[] = [];

  if (bundle.batches.length === 0) {
    return {
      trader: bundle.trader,
      seasonOrdinal: bundle.seasonOrdinal,
      verified: false,
      computedAccumulator: toHex(EMPTY_ACCUMULATOR),
      onChainAccumulator: null,
      tradeCount: 0,
      batchCount: 0,
      checks: [
        {
          label: 'Committed record',
          passed: false,
          detail: bundle.note ?? 'nothing has been committed for this trader',
        },
      ],
    };
  }

  // 1. Each batch's root is rebuilt from its own trades, and every trade proves
  //    membership of it. If either fails the trades do not match the root.
  let rootsOk = true;
  let membershipOk = true;
  let tradeCount = 0;
  for (const batch of bundle.batches) {
    const hashes = batch.trades.map((raw) => hashLeaf(toLeaf(raw)));
    tradeCount += hashes.length;
    const tree = buildTree(hashes);
    if (toHex(tree.root) !== batch.root || hashes.length !== batch.leaves) rootsOk = false;
    for (let i = 0; i < hashes.length; i += 1) {
      if (toHex(computeRoot(hashes[i]!, buildProof(tree, i))) !== toHex(tree.root)) membershipOk = false;
    }
  }
  checks.push({
    label: 'Roots rebuilt from trades',
    passed: rootsOk,
    detail: rootsOk
      ? `${bundle.batches.length} batch(es) rebuild to the roots claimed`
      : 'a batch does not rebuild to the root it claims',
  });
  checks.push({
    label: 'Membership proofs',
    passed: membershipOk,
    detail: membershipOk ? 'every trade proves against its batch root' : 'a trade does not belong to its batch',
  });

  // 2. The accumulator folded from the roots, in order.
  let accumulator = EMPTY_ACCUMULATOR;
  for (const batch of bundle.batches) {
    accumulator = extendChain(accumulator, fromHex(batch.root), batch.leaves, batch.engineVersion);
  }
  const computed = toHex(accumulator);
  const claimed = bundle.batches[bundle.batches.length - 1]!.predictedAccumulator;
  const chainFoldOk = computed === claimed;
  checks.push({
    label: 'Accumulator chain',
    passed: chainFoldOk,
    detail: chainFoldOk
      ? `${computed.slice(0, 16)}… from ${bundle.batches.length} batch(es)`
      : `folds to ${computed.slice(0, 16)}…, record claims ${claimed.slice(0, 16)}…`,
  });

  // 3. The comparison the whole thing exists for: the accumulator on chain, at
  //    an address derived here, read from the caller's endpoint.
  let onChainAccumulator: string | null = null;
  let onChainOk = false;
  const account = recordPda(seasonPda(bundle.seasonOrdinal, programId), bundle.trader, programId);
  try {
    const result = await rpcCall<{ value: { data?: [string, string]; owner?: string } | null }>(
      options.rpc,
      'getAccountInfo',
      [account, { encoding: 'base64', commitment: 'confirmed' }],
      doFetch,
    );
    const value = result.value;
    if (!value) {
      checks.push({ label: 'On-chain comparison', passed: false, detail: `no account at ${account.slice(0, 8)}… on this endpoint` });
    } else if (value.owner !== programId) {
      checks.push({ label: 'On-chain comparison', passed: false, detail: `that account is owned by ${value.owner?.slice(0, 8)}…, not the program` });
    } else {
      onChainAccumulator = accumulatorFrom(value.data?.[0] ?? '');
      onChainOk = onChainAccumulator === computed;
      checks.push({
        label: 'On-chain comparison',
        passed: onChainOk,
        detail:
          onChainAccumulator === null
            ? 'the account exists but is not a trader record'
            : onChainOk
              ? `the chain holds ${onChainAccumulator.slice(0, 16)}…, which is what these trades produce`
              : `the chain holds ${onChainAccumulator.slice(0, 16)}…, these trades produce ${computed.slice(0, 16)}…`,
      });
    }
  } catch (error) {
    checks.push({ label: 'On-chain comparison', passed: false, detail: (error as Error).message });
  }

  return {
    trader: bundle.trader,
    seasonOrdinal: bundle.seasonOrdinal,
    verified: rootsOk && membershipOk && chainFoldOk && onChainOk,
    computedAccumulator: computed,
    onChainAccumulator,
    tradeCount,
    batchCount: bundle.batches.length,
    checks,
  };
}

/** Fetch a trader's proof and verify it against the chain. The flagship call. */
export async function verifyRecord(trader: string, options: VerifyOptions): Promise<VerifiedRecord> {
  const bundle = await getProof(trader, { apiBase: options.apiBase, fetchImpl: options.fetchImpl, season: options.season });
  return verifyBundle(bundle, options);
}
