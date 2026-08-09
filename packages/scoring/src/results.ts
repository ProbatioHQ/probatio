import bs58 from 'bs58';
import { sha256 } from '@noble/hashes/sha2.js';
import { merkleRoot, toHex } from '@probatio/commit';
import type { RankedStanding } from './rank';

/**
 * The final standings, committed.
 *
 * `finalize_season` records one 32-byte root. This is what it is a root of: a
 * merkle tree over every trader's place, return and payout. A trader can prove
 * their own row against it without us publishing anybody else's, and cannot be
 * quietly moved down it afterwards.
 *
 * Fixed-width, same discipline as a trade leaf. Every field a payout depends on
 * is inside the leaf, so the amount owed is provable rather than asserted.
 */

export class ResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResultError';
  }
}

export interface ResultLeaf {
  readonly seasonOrdinal: number;
  readonly rank: number;
  readonly trader: string;
  readonly startingBalance: bigint;
  readonly finalEquity: bigint;
  readonly returnBps: number;
  readonly tradeCount: number;
  readonly payoutLamports: bigint;
}

const AMOUNT_BYTES = 16;
const PUBKEY_BYTES = 32;

export const RESULT_LEAF_BYTES =
  2 + // seasonOrdinal (i16)
  4 + // rank
  PUBKEY_BYTES + // trader
  AMOUNT_BYTES + // startingBalance
  AMOUNT_BYTES + // finalEquity
  4 + // returnBps (i32, signed)
  4 + // tradeCount
  AMOUNT_BYTES; // payoutLamports

function writeUint(view: DataView, offset: number, value: bigint, bytes: number): void {
  if (value < 0n) throw new ResultError(`value cannot be negative: ${value}`);
  if (value >= 1n << BigInt(bytes * 8)) {
    throw new ResultError(`value does not fit in ${bytes} bytes: ${value}`);
  }
  let remaining = value;
  for (let i = bytes - 1; i >= 0; i -= 1) {
    view.setUint8(offset + i, Number(remaining & 0xffn));
    remaining >>= 8n;
  }
}

export function encodeResultLeaf(leaf: ResultLeaf): Uint8Array {
  if (leaf.rank < 1) throw new ResultError(`rank starts at 1, got ${leaf.rank}`);

  const bytes = new Uint8Array(RESULT_LEAF_BYTES);
  const view = new DataView(bytes.buffer);
  let offset = 0;

  view.setInt16(offset, leaf.seasonOrdinal);
  offset += 2;
  view.setUint32(offset, leaf.rank);
  offset += 4;

  let trader: Uint8Array;
  try {
    trader = bs58.decode(leaf.trader);
  } catch {
    throw new ResultError(`not a valid base58 address: ${leaf.trader}`);
  }
  if (trader.length !== PUBKEY_BYTES) {
    throw new ResultError(`address must be ${PUBKEY_BYTES} bytes, got ${trader.length}`);
  }
  bytes.set(trader, offset);
  offset += PUBKEY_BYTES;

  writeUint(view, offset, leaf.startingBalance, AMOUNT_BYTES);
  offset += AMOUNT_BYTES;
  writeUint(view, offset, leaf.finalEquity, AMOUNT_BYTES);
  offset += AMOUNT_BYTES;

  // Signed: a season where everybody lost money is an ordinary season.
  view.setInt32(offset, leaf.returnBps);
  offset += 4;
  view.setUint32(offset, leaf.tradeCount);
  offset += 4;
  writeUint(view, offset, leaf.payoutLamports, AMOUNT_BYTES);

  return bytes;
}

/**
 * Domain tag for a result leaf.
 *
 * Distinct from the trade leaf's tag. The two trees are separate and the two
 * encodings are different lengths, so nothing could be confused for anything
 * today — but that argument depends on a length staying different, and a
 * distinct byte does not.
 */
export const RESULT_LEAF_PREFIX = 0x02;

export function hashResultLeaf(leaf: ResultLeaf): Uint8Array {
  const encoded = encodeResultLeaf(leaf);
  const tagged = new Uint8Array(encoded.length + 1);
  tagged[0] = RESULT_LEAF_PREFIX;
  tagged.set(encoded, 1);
  return sha256(tagged);
}

/**
 * Build the results leaves for a finished season.
 *
 * Payouts are matched to places by rank. A place the band does not pay gets
 * zero rather than being left out — a trader who came eleventh is still in the
 * season and their result is still part of what was committed.
 */
export function resultLeaves(
  seasonOrdinal: number,
  ranked: readonly RankedStanding[],
  payouts: readonly { place: number; lamports: bigint }[],
): ResultLeaf[] {
  const byPlace = new Map(payouts.map((payout) => [payout.place, payout.lamports]));

  return ranked.map((standing) => ({
    seasonOrdinal,
    rank: standing.rank,
    trader: standing.trader,
    startingBalance: standing.startingBalance,
    finalEquity: standing.finalEquity,
    returnBps: standing.returnBps,
    tradeCount: standing.tradeCount,
    payoutLamports: byPlace.get(standing.rank) ?? 0n,
  }));
}

/**
 * The root of a season nobody entered.
 *
 * A season with no entrants still has to be finalizable — the spec says a
 * season with zero entries closes empty, and a season that cannot be closed
 * blocks the one after it. An empty merkle tree has no root, so this stands in.
 *
 * Deliberately not thirty-two zero bytes: on chain, a zero `results_root` means
 * *not finalized*. An empty season is finalized and its result is that nobody
 * entered, which is a different thing and must not encode the same way.
 */
export const EMPTY_SEASON_ROOT = sha256(new TextEncoder().encode('probatio:empty-season:v1'));

/** The 32 bytes `finalize_season` records. */
export function resultsRoot(leaves: readonly ResultLeaf[]): Uint8Array {
  if (leaves.length === 0) return EMPTY_SEASON_ROOT;
  return merkleRoot(leaves.map(hashResultLeaf));
}

export function resultsRootHex(leaves: readonly ResultLeaf[]): string {
  return toHex(resultsRoot(leaves));
}
