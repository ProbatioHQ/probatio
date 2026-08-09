import { LayoutError, readPubkey, readU16 } from '@probatio/pools';

/**
 * Token-2022 extensions, and the metadata that lives inside them.
 *
 * pump.fun does not use Metaplex. Its mints are Token-2022 accounts carrying
 * the TokenMetadata extension, so a token's name, symbol and URI sit inline in
 * the mint account that has to be read anyway for decimals — no second account,
 * no PDA, no separate round trip.
 *
 * Layout of an extended mint:
 *
 *   0    base Mint            82 bytes
 *   82   padding              up to offset 165
 *   165  account_type         u8  (1 = Mint)
 *   166  TLV entries          repeating: type u16, length u16, value
 */

export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/** Where the account-type byte sits, and where the TLV list begins after it. */
export const ACCOUNT_TYPE_OFFSET = 165;
export const TLV_START = 166;

/** ExtensionType::TokenMetadata */
export const TOKEN_METADATA_EXTENSION = 19;

const MAX_STRING_BYTES = 2048;

export interface Token2022Metadata {
  readonly updateAuthority: string | null;
  readonly mint: string;
  readonly name: string;
  readonly symbol: string;
  readonly uri: string;
  readonly additional: ReadonlyMap<string, string>;
}

function readU32(data: Uint8Array, offset: number): number {
  if (offset + 4 > data.length) {
    throw new LayoutError(`cannot read a u32 at offset ${offset}`);
  }
  return (
    (data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16)) +
    data[offset + 3]! * 0x1000000
  );
}

function readString(
  data: Uint8Array,
  offset: number,
  what: string,
): { value: string; next: number } {
  const length = readU32(data, offset);
  if (length > MAX_STRING_BYTES) {
    throw new LayoutError(`${what} claims ${length} bytes — the layout is probably wrong`);
  }
  const start = offset + 4;
  if (start + length > data.length) {
    throw new LayoutError(`${what} runs past the end of the account`);
  }
  const value = new TextDecoder('utf-8', { fatal: false })
    .decode(data.subarray(start, start + length))
    .replace(/\0+$/, '')
    .trim();
  return { value, next: start + length };
}

/** An all-zero pubkey encodes None. */
function readOptionalPubkey(data: Uint8Array, offset: number): string | null {
  let allZero = true;
  for (let i = offset; i < offset + 32; i += 1) {
    if (data[i] !== 0) {
      allZero = false;
      break;
    }
  }
  return allZero ? null : readPubkey(data, offset);
}

export interface TlvEntry {
  readonly type: number;
  readonly offset: number;
  readonly length: number;
}

/**
 * Walk the extension list.
 *
 * Stops at the first malformed entry rather than throwing, because a mint may
 * carry extensions this code does not know about and a future one must not
 * make the token unreadable.
 */
export function readExtensions(data: Uint8Array): TlvEntry[] {
  if (data.length <= TLV_START) return [];

  const entries: TlvEntry[] = [];
  let cursor = TLV_START;

  while (cursor + 4 <= data.length) {
    const type = readU16(data, cursor);
    const length = readU16(data, cursor + 2);
    const valueStart = cursor + 4;

    // Type 0 is Uninitialized — the end of the meaningful list.
    if (type === 0) break;
    if (valueStart + length > data.length) break;

    entries.push({ type, offset: valueStart, length });
    cursor = valueStart + length;
  }

  return entries;
}

/** Whether this account is a Token-2022 mint carrying extensions. */
export function hasExtensions(data: Uint8Array): boolean {
  return data.length > TLV_START && data[ACCOUNT_TYPE_OFFSET] === 1;
}

/**
 * Read the TokenMetadata extension, or null when the mint does not carry one.
 */
export function decodeToken2022Metadata(data: Uint8Array): Token2022Metadata | null {
  if (!hasExtensions(data)) return null;

  const entry = readExtensions(data).find((e) => e.type === TOKEN_METADATA_EXTENSION);
  if (!entry) return null;

  let cursor = entry.offset;
  const updateAuthority = readOptionalPubkey(data, cursor);
  cursor += 32;
  const mint = readPubkey(data, cursor);
  cursor += 32;

  const name = readString(data, cursor, 'name');
  const symbol = readString(data, name.next, 'symbol');
  const uri = readString(data, symbol.next, 'uri');

  const additional = new Map<string, string>();
  let pairCursor = uri.next;
  if (pairCursor + 4 <= data.length) {
    const count = readU32(data, pairCursor);
    pairCursor += 4;
    // A corrupt count must not spin: additional metadata is a short list.
    for (let i = 0; i < Math.min(count, 64); i += 1) {
      try {
        const key = readString(data, pairCursor, 'additional key');
        const value = readString(data, key.next, 'additional value');
        additional.set(key.value, value.value);
        pairCursor = value.next;
      } catch {
        break;
      }
    }
  }

  return {
    updateAuthority,
    mint,
    name: name.value,
    symbol: symbol.value,
    uri: uri.value,
    additional,
  };
}
