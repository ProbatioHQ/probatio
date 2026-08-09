import bs58 from 'bs58';

/**
 * Primitives for reading Borsh-encoded Solana accounts.
 *
 * Every read is bounds-checked. A truncated account that decodes to plausible
 * garbage is far worse here than one that throws: a silently wrong reserve
 * becomes a silently wrong fill, which becomes a leaderboard nobody can trust.
 */

export class LayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LayoutError';
  }
}

export const DISCRIMINATOR_BYTES = 8;
export const PUBKEY_BYTES = 32;

function assertRange(data: Uint8Array, offset: number, length: number, what: string): void {
  if (offset < 0 || offset + length > data.length) {
    throw new LayoutError(
      `cannot read ${what} at offset ${offset}: account is ${data.length} bytes, needed ${offset + length}`,
    );
  }
}

/** Read a little-endian u64 as a bigint. Solana amounts exceed Number.MAX_SAFE_INTEGER. */
export function readU64(data: Uint8Array, offset: number): bigint {
  assertRange(data, offset, 8, 'u64');
  let value = 0n;
  for (let i = 7; i >= 0; i -= 1) {
    value = (value << 8n) | BigInt(data[offset + i]!);
  }
  return value;
}

export function readU16(data: Uint8Array, offset: number): number {
  assertRange(data, offset, 2, 'u16');
  return data[offset]! | (data[offset + 1]! << 8);
}

export function readU8(data: Uint8Array, offset: number): number {
  assertRange(data, offset, 1, 'u8');
  return data[offset]!;
}

/**
 * Borsh encodes a bool as exactly 0 or 1. Anything else means the offset is
 * wrong, so this refuses to coerce rather than reporting a confident `true`
 * from a byte that was really part of another field.
 */
export function readBool(data: Uint8Array, offset: number): boolean {
  const byte = readU8(data, offset);
  if (byte > 1) {
    throw new LayoutError(
      `expected a bool at offset ${offset} but found ${byte} — the layout is probably wrong`,
    );
  }
  return byte === 1;
}

/** Read a 32-byte public key and return it base58-encoded. */
export function readPubkey(data: Uint8Array, offset: number): string {
  assertRange(data, offset, PUBKEY_BYTES, 'pubkey');
  return bs58.encode(data.subarray(offset, offset + PUBKEY_BYTES));
}

export function readDiscriminator(data: Uint8Array): Uint8Array {
  assertRange(data, 0, DISCRIMINATOR_BYTES, 'discriminator');
  return data.subarray(0, DISCRIMINATOR_BYTES);
}

/**
 * Whether the data begins with this discriminator.
 *
 * A buffer too short to hold one simply does not match. This is asked while
 * sifting through log lines and account types, where "not this" is the ordinary
 * answer — throwing would turn one unrelated three-byte log line into a failure
 * of the entire scan.
 */
export function discriminatorMatches(data: Uint8Array, expected: Uint8Array): boolean {
  if (data.length < expected.length) return false;
  for (let i = 0; i < expected.length; i += 1) {
    if (data[i] !== expected[i]) return false;
  }
  return true;
}
