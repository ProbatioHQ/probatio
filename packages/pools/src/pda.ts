import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import bs58 from 'bs58';
import { LayoutError } from './layout';

/**
 * Program-derived address derivation.
 *
 * Implemented here rather than pulled from @solana/web3.js because this package
 * needs exactly one function from it, and the derivation is short and fully
 * specified. It is checked against known mainnet addresses in the tests.
 *
 * A PDA is a hash that lands *off* the ed25519 curve, so no private key can
 * exist for it. The bump search walks downward from 255 until an off-curve
 * result appears.
 */

const PDA_MARKER = new TextEncoder().encode('ProgramDerivedAddress');
const MAX_SEED_LENGTH = 32;
const MAX_SEEDS = 16;

function isOnCurve(point: Uint8Array): boolean {
  try {
    ed25519.Point.fromBytes(point);
    return true;
  } catch {
    return false;
  }
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export interface DerivedAddress {
  readonly address: string;
  readonly bump: number;
}

export function findProgramAddress(
  seeds: readonly Uint8Array[],
  programId: string,
): DerivedAddress {
  if (seeds.length > MAX_SEEDS) {
    throw new LayoutError(`at most ${MAX_SEEDS} seeds, got ${seeds.length}`);
  }
  for (const seed of seeds) {
    if (seed.length > MAX_SEED_LENGTH) {
      throw new LayoutError(`each seed is at most ${MAX_SEED_LENGTH} bytes, got ${seed.length}`);
    }
  }

  const programBytes = bs58.decode(programId);

  for (let bump = 255; bump >= 0; bump -= 1) {
    const hash = sha256(concat([...seeds, Uint8Array.of(bump), programBytes, PDA_MARKER]));
    if (!isOnCurve(hash)) {
      return { address: bs58.encode(hash), bump };
    }
  }

  // Astronomically unlikely; every bump landing on the curve would be a
  // one-in-2^256 event.
  throw new LayoutError('no off-curve address found for these seeds');
}

export function utf8Seed(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function pubkeySeed(pubkey: string): Uint8Array {
  return bs58.decode(pubkey);
}
