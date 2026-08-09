import { LayoutError, RpcClient, decodeMintDecimals } from '@probatio/pools';
import { METADATA_PROGRAM_ID, decodeTokenMetadata, metadataAddress } from './metaplex';
import { decodeToken2022Metadata } from './token2022';

/**
 * Reading the on-chain half of a token's identity.
 *
 * Two standards are in play. pump.fun mints are Token-2022 and carry their
 * metadata inline in the mint account; older SPL mints keep it in a separate
 * Metaplex account at a derived address. The inline case is checked first
 * because it needs no extra read — the mint account is fetched anyway for
 * decimals — and the Metaplex account is only consulted when the inline
 * extension is absent.
 *
 * A discovery feed shows hundreds of tokens at once, so everything is batched.
 */

export type MetadataStandard = 'token-2022' | 'metaplex' | 'none';

export interface OnchainTokenInfo {
  readonly mint: string;
  readonly name: string | null;
  readonly symbol: string | null;
  readonly uri: string | null;
  readonly updateAuthority: string | null;
  readonly decimals: number | null;
  readonly standard: MetadataStandard;
}

/** getMultipleAccounts caps at 100 addresses. */
const BATCH = 100;

function empty(mint: string, decimals: number | null): OnchainTokenInfo {
  return {
    mint,
    name: null,
    symbol: null,
    uri: null,
    updateAuthority: null,
    decimals,
    standard: 'none',
  };
}

export class MetadataReader {
  readonly #rpc: RpcClient;

  constructor(rpc: RpcClient) {
    this.#rpc = rpc;
  }

  async read(mint: string): Promise<OnchainTokenInfo> {
    const [info] = await this.readMany([mint]);
    return info!;
  }

  /**
   * Read several mints at once.
   *
   * A token with no metadata, or with deliberate garbage at its metadata
   * address, comes back with null fields rather than throwing. Anyone can
   * deploy such a mint, and one bad token must not take down the feed it
   * happens to appear in.
   */
  async readMany(mints: readonly string[]): Promise<OnchainTokenInfo[]> {
    const results = new Map<string, OnchainTokenInfo>();
    const needsMetaplex: string[] = [];

    for (let i = 0; i < mints.length; i += BATCH) {
      const batch = mints.slice(i, i + BATCH);
      const accounts = await this.#rpc.getAccounts(batch);

      batch.forEach((mint, index) => {
        const account = accounts[index];
        if (!account) {
          results.set(mint, empty(mint, null));
          return;
        }

        let decimals: number | null = null;
        try {
          decimals = decodeMintDecimals(account.data);
        } catch {
          decimals = null;
        }

        let inline: ReturnType<typeof decodeToken2022Metadata> = null;
        try {
          inline = decodeToken2022Metadata(account.data);
        } catch (error) {
          if (!(error instanceof LayoutError)) throw error;
        }

        if (inline) {
          results.set(mint, {
            mint,
            name: inline.name || null,
            symbol: inline.symbol || null,
            uri: inline.uri || null,
            updateAuthority: inline.updateAuthority,
            decimals,
            standard: 'token-2022',
          });
          return;
        }

        results.set(mint, empty(mint, decimals));
        needsMetaplex.push(mint);
      });
    }

    // Only tokens without inline metadata cost a second round trip.
    for (let i = 0; i < needsMetaplex.length; i += BATCH) {
      const batch = needsMetaplex.slice(i, i + BATCH);
      const accounts = await this.#rpc.getAccounts(batch.map(metadataAddress));

      batch.forEach((mint, index) => {
        const account = accounts[index];
        if (!account || account.owner !== METADATA_PROGRAM_ID) return;

        try {
          const decoded = decodeTokenMetadata(account.data);
          const previous = results.get(mint)!;
          results.set(mint, {
            mint,
            name: decoded.name || null,
            symbol: decoded.symbol || null,
            uri: decoded.uri || null,
            updateAuthority: decoded.updateAuthority,
            decimals: previous.decimals,
            standard: 'metaplex',
          });
        } catch (error) {
          if (!(error instanceof LayoutError)) throw error;
        }
      });
    }

    return mints.map((mint) => results.get(mint) ?? empty(mint, null));
  }
}
