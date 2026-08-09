import { sha256 } from '@noble/hashes/sha2.js';
import bs58 from 'bs58';

/**
 * Turning a trade into a merkle leaf.
 *
 * A leaf has to carry everything a stranger needs to recheck the trade without
 * asking us for anything. That includes the pool reserves it was quoted
 * against — otherwise verification would mean trusting our database for the
 * one number the whole result depends on, which is precisely the trust the
 * project claims not to need.
 *
 * The encoding is fixed-width and fixed-order. Not JSON: two encoders can
 * order keys differently or space them differently and produce different bytes
 * for the same trade, and a hash that changes with the encoder is not a
 * commitment to anything.
 */

export class LeafError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeafError';
  }
}

/** Everything committed about a single simulated trade. */
export interface TradeLeaf {
  /** Position in the trader's season, from 1. Makes ordering explicit. */
  readonly sequence: number;
  readonly seasonOrdinal: number;
  readonly trader: string;
  readonly mint: string;
  readonly side: 'buy' | 'sell';

  readonly solAmount: bigint;
  readonly tokenAmount: bigint;
  readonly feeLamports: bigint;

  /** The reserves the fill was quoted against. Without these it is unverifiable. */
  readonly solReserve: bigint;
  readonly tokenReserve: bigint;
  readonly deliverableTokens: bigint;
  readonly feeBps: number;
  readonly poolSource: 'pumpfun-curve' | 'pumpswap' | 'raydium';

  readonly priceImpactBps: number;
  readonly partial: boolean;
  readonly clickedAtSlot: number;
  readonly filledAtSlot: number;
  readonly latencyMs: number;
  readonly engineVersion: number;
  /** Unix milliseconds. */
  readonly createdAt: number;
}

const SIDES = { buy: 0, sell: 1 } as const;
const SOURCES = { 'pumpfun-curve': 0, pumpswap: 1, raydium: 2 } as const;

/** Amounts are u128 so a token supply can never overflow the field. */
const AMOUNT_BYTES = 16;
const PUBKEY_BYTES = 32;

function writeUint(view: DataView, offset: number, value: bigint, bytes: number): void {
  if (value < 0n) throw new LeafError(`amount cannot be negative: ${value}`);
  if (value >= 1n << BigInt(bytes * 8)) {
    throw new LeafError(`amount does not fit in ${bytes} bytes: ${value}`);
  }
  // Big-endian, so the bytes read in the same order a human would.
  let remaining = value;
  for (let i = bytes - 1; i >= 0; i -= 1) {
    view.setUint8(offset + i, Number(remaining & 0xffn));
    remaining >>= 8n;
  }
}

function writeKey(target: Uint8Array, offset: number, address: string): void {
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(address);
  } catch {
    throw new LeafError(`not a valid base58 address: ${address}`);
  }
  if (decoded.length !== PUBKEY_BYTES) {
    throw new LeafError(`address must be ${PUBKEY_BYTES} bytes, got ${decoded.length}`);
  }
  target.set(decoded, offset);
}

/**
 * The exact bytes a trade commits to.
 *
 * Deliberately one fixed-size record with no length prefixes and no optional
 * fields. Every trade encodes to the same number of bytes, so there is no way
 * to construct two different trades that serialize identically by shifting a
 * boundary.
 */
export const LEAF_BYTES =
  4 + // sequence
  2 + // seasonOrdinal (i16)
  PUBKEY_BYTES + // trader
  PUBKEY_BYTES + // mint
  1 + // side
  AMOUNT_BYTES * 3 + // sol, token, fee
  AMOUNT_BYTES * 3 + // reserves
  2 + // feeBps
  1 + // poolSource
  4 + // priceImpactBps
  1 + // partial
  8 + // clickedAtSlot
  8 + // filledAtSlot
  4 + // latencyMs
  4 + // engineVersion
  8; // createdAt

export function encodeLeaf(leaf: TradeLeaf): Uint8Array {
  const bytes = new Uint8Array(LEAF_BYTES);
  const view = new DataView(bytes.buffer);
  let offset = 0;

  view.setUint32(offset, leaf.sequence);
  offset += 4;
  view.setInt16(offset, leaf.seasonOrdinal);
  offset += 2;

  writeKey(bytes, offset, leaf.trader);
  offset += PUBKEY_BYTES;
  writeKey(bytes, offset, leaf.mint);
  offset += PUBKEY_BYTES;

  const side = SIDES[leaf.side];
  if (side === undefined) throw new LeafError(`unknown side: ${leaf.side}`);
  view.setUint8(offset, side);
  offset += 1;

  for (const amount of [leaf.solAmount, leaf.tokenAmount, leaf.feeLamports]) {
    writeUint(view, offset, amount, AMOUNT_BYTES);
    offset += AMOUNT_BYTES;
  }
  for (const amount of [leaf.solReserve, leaf.tokenReserve, leaf.deliverableTokens]) {
    writeUint(view, offset, amount, AMOUNT_BYTES);
    offset += AMOUNT_BYTES;
  }

  view.setUint16(offset, leaf.feeBps);
  offset += 2;

  const source = SOURCES[leaf.poolSource];
  if (source === undefined) throw new LeafError(`unknown pool source: ${leaf.poolSource}`);
  view.setUint8(offset, source);
  offset += 1;

  view.setUint32(offset, leaf.priceImpactBps);
  offset += 4;
  view.setUint8(offset, leaf.partial ? 1 : 0);
  offset += 1;

  view.setBigUint64(offset, BigInt(leaf.clickedAtSlot));
  offset += 8;
  view.setBigUint64(offset, BigInt(leaf.filledAtSlot));
  offset += 8;
  view.setUint32(offset, leaf.latencyMs);
  offset += 4;
  view.setUint32(offset, leaf.engineVersion);
  offset += 4;
  view.setBigUint64(offset, BigInt(leaf.createdAt));
  offset += 8;

  if (offset !== LEAF_BYTES) {
    throw new LeafError(`encoder wrote ${offset} bytes, expected ${LEAF_BYTES}`);
  }
  return bytes;
}

/**
 * Domain separator for leaves.
 *
 * Leaves and internal nodes are hashed with different prefixes so an internal
 * node can never be presented as a leaf. Without this, a proof could pass off
 * a pair of hashes as a single trade — the second-preimage weakness that has
 * bitten merkle implementations repeatedly.
 */
export const LEAF_PREFIX = 0x00;
export const NODE_PREFIX = 0x01;

export function hashLeaf(leaf: TradeLeaf): Uint8Array {
  const encoded = encodeLeaf(leaf);
  const tagged = new Uint8Array(encoded.length + 1);
  tagged[0] = LEAF_PREFIX;
  tagged.set(encoded, 1);
  return sha256(tagged);
}
