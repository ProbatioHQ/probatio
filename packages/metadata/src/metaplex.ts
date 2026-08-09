import { LayoutError, findProgramAddress, pubkeySeed, readPubkey, readU8, utf8Seed } from '@probatio/pools';

/** Metaplex Token Metadata. */
export const METADATA_PROGRAM_ID = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';

/**
 * Metadata account layout.
 *
 *   0   key                u8
 *   1   update_authority   Pubkey
 *   33  mint               Pubkey
 *   65  name               String
 *       symbol             String
 *       uri                String
 *       seller_fee_bps     u16
 *       ...
 *
 * The three strings are Borsh — a u32 length followed by that many bytes — so
 * everything after `mint` has to be walked sequentially rather than read at a
 * fixed offset.
 *
 * Metaplex pads these strings to fixed maximums (32, 10, 200) with NUL bytes,
 * and the stored length is the padded length rather than the real one. Failing
 * to trim leaves names carrying dozens of invisible characters, which then
 * flow into the UI and into anything that compares them.
 */
const FIXED_PREFIX = 65;

/** Generous ceilings that still refuse to allocate against a corrupt length. */
const MAX_NAME_BYTES = 256;
const MAX_SYMBOL_BYTES = 128;
const MAX_URI_BYTES = 1024;

export interface TokenMetadataAccount {
  readonly key: number;
  readonly updateAuthority: string;
  readonly mint: string;
  readonly name: string;
  readonly symbol: string;
  readonly uri: string;
}

function readU32(data: Uint8Array, offset: number): number {
  if (offset + 4 > data.length) {
    throw new LayoutError(`cannot read a string length at offset ${offset}`);
  }
  return (
    (data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16)) +
    data[offset + 3]! * 0x1000000
  );
}

function readBorshString(
  data: Uint8Array,
  offset: number,
  maxBytes: number,
  what: string,
): { value: string; next: number } {
  const length = readU32(data, offset);
  if (length > maxBytes) {
    throw new LayoutError(
      `${what} claims ${length} bytes, above the ${maxBytes} ceiling — the layout is probably wrong`,
    );
  }
  const start = offset + 4;
  if (start + length > data.length) {
    throw new LayoutError(`${what} runs past the end of the account`);
  }

  const raw = new TextDecoder('utf-8', { fatal: false }).decode(
    data.subarray(start, start + length),
  );

  // Trim the NUL padding Metaplex writes, then ordinary whitespace. Both are
  // invisible and both break equality comparisons.
  return { value: raw.replace(/\0+$/, '').trim(), next: start + length };
}

export function decodeTokenMetadata(data: Uint8Array): TokenMetadataAccount {
  if (data.length < FIXED_PREFIX) {
    throw new LayoutError(
      `metadata account is ${data.length} bytes, expected at least ${FIXED_PREFIX}`,
    );
  }

  const key = readU8(data, 0);
  // 4 is MetadataV1. Anything else at this address is a different account.
  if (key !== 4) {
    throw new LayoutError(`metadata account key is ${key}, expected 4 (MetadataV1)`);
  }

  const updateAuthority = readPubkey(data, 1);
  const mint = readPubkey(data, 33);

  const name = readBorshString(data, FIXED_PREFIX, MAX_NAME_BYTES, 'name');
  const symbol = readBorshString(data, name.next, MAX_SYMBOL_BYTES, 'symbol');
  const uri = readBorshString(data, symbol.next, MAX_URI_BYTES, 'uri');

  return {
    key,
    updateAuthority,
    mint,
    name: name.value,
    symbol: symbol.value,
    uri: uri.value,
  };
}

/** The metadata PDA for a mint. */
export function metadataAddress(mint: string): string {
  return findProgramAddress(
    [utf8Seed('metadata'), pubkeySeed(METADATA_PROGRAM_ID), pubkeySeed(mint)],
    METADATA_PROGRAM_ID,
  ).address;
}
