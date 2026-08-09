import { describe, expect, it } from 'vitest';
import { decodeMintDecimals } from '@probatio/pools';
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_METADATA_EXTENSION,
  decodeToken2022Metadata,
  hasExtensions,
  readExtensions,
} from '../src/token2022';
import { METADATA_PROGRAM_ID, decodeTokenMetadata } from '../src/metaplex';
import {
  METAPLEX_METADATA,
  TOKEN_2022_MINT,
  TOKEN_2022_MINT_B,
  bytes,
} from './fixtures/accounts';

describe('Token-2022 inline metadata', () => {
  const data = bytes(TOKEN_2022_MINT.base64);

  it('recognises an extended mint', () => {
    expect(TOKEN_2022_MINT.owner).toBe(TOKEN_2022_PROGRAM_ID);
    expect(hasExtensions(data)).toBe(true);
  });

  it('finds the metadata extension in the TLV list', () => {
    const types = readExtensions(data).map((e) => e.type);
    expect(types).toContain(TOKEN_METADATA_EXTENSION);
  });

  it('reads name, symbol and uri as strings', () => {
    const meta = decodeToken2022Metadata(data)!;
    expect(meta).not.toBeNull();
    // Guards the exact bug this decoder shipped with first: returning the
    // internal {value, next} cursor object instead of the string.
    expect(typeof meta.name).toBe('string');
    expect(typeof meta.symbol).toBe('string');
    expect(typeof meta.uri).toBe('string');
    expect(meta.name).toBe('wrapped CATE');
    expect(meta.symbol).toBe('wCATE');
    expect(meta.uri).toMatch(/^https:\/\/ipfs\.io\/ipfs\//);
  });

  it('reports the mint it belongs to', () => {
    expect(decodeToken2022Metadata(data)!.mint).toBe(TOKEN_2022_MINT.mint);
  });

  it('reads a second token with different string lengths', () => {
    const meta = decodeToken2022Metadata(bytes(TOKEN_2022_MINT_B.base64))!;
    expect(meta.name).toBe('The Purple Toad Pepe');
    expect(meta.symbol).toBe('PURPLETOAD');
    expect(meta.uri).toMatch(/^https:\/\/ipfs\.io\/ipfs\//);
  });

  it('still exposes decimals from the base mint layout', () => {
    // Token-2022 keeps the classic 82-byte mint at the front and appends
    // extensions, so the existing decimals reader keeps working unchanged.
    expect(decodeMintDecimals(data)).toBe(6);
  });

  it('returns null for a mint with no extensions', () => {
    expect(decodeToken2022Metadata(new Uint8Array(82))).toBeNull();
  });

  it('stops cleanly on a truncated TLV list', () => {
    const truncated = data.subarray(0, 200);
    expect(() => readExtensions(truncated)).not.toThrow();
  });
});

describe('Metaplex metadata', () => {
  const data = bytes(METAPLEX_METADATA.base64);

  it('is owned by the metadata program', () => {
    expect(METAPLEX_METADATA.owner).toBe(METADATA_PROGRAM_ID);
  });

  it('decodes and trims the NUL padding', () => {
    const meta = decodeTokenMetadata(data);
    expect(meta.name).toBe('USD Coin');
    expect(meta.symbol).toBe('USDC');
    // Metaplex pads to fixed widths; an untrimmed read carries dozens of
    // invisible characters into anything that compares names.
    expect(meta.name).not.toMatch(/\0/);
    expect(meta.symbol.length).toBe(4);
  });

  it('reports the mint', () => {
    expect(decodeTokenMetadata(data).mint).toBe(METAPLEX_METADATA.mint);
  });

  it('rejects a non-metadata account', () => {
    const wrong = data.slice();
    wrong[0] = 9;
    expect(() => decodeTokenMetadata(wrong)).toThrow(/MetadataV1/);
  });

  it('rejects a truncated account', () => {
    expect(() => decodeTokenMetadata(data.subarray(0, 40))).toThrow();
  });
});
