import 'server-only';
import { getTokenMetadata, launchByMint, upsertOnchainMetadata } from '@probatio/db';
import { MetadataReader } from '@probatio/metadata';
import { RpcClient } from '@probatio/pools';
import { db } from './db';
import { rpcEndpoint } from './env';

/**
 * What to call a token.
 *
 * A page headed with a truncated mint address tells a visitor nothing and
 * reads like a database that has not been filled in. Three sources, cheapest
 * first: the launch we recorded, then the metadata cache, then the chain.
 *
 * Falls back to the shortened mint rather than failing — a token can genuinely
 * have no metadata, and that is not an error worth showing anyone.
 */

export interface TokenName {
  readonly name: string;
  readonly symbol: string | null;
  /** True when the name came from the chain rather than the address itself. */
  readonly known: boolean;
}

export function shortMint(mint: string): string {
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

export async function tokenName(mint: string): Promise<TokenName> {
  const client = await db();

  const launch = await launchByMint(client, mint);
  if (launch?.name) return { name: launch.name, symbol: launch.symbol || null, known: true };

  const cached = await getTokenMetadata(client, mint);
  const cachedName = cached?.name ?? cached?.offchainName;
  if (cachedName) {
    return {
      name: cachedName,
      symbol: cached?.symbol ?? cached?.offchainSymbol ?? null,
      known: true,
    };
  }

  try {
    const rpc = new RpcClient({ endpoint: rpcEndpoint(), timeoutMs: 8_000, minIntervalMs: 110 });
    const info = await new MetadataReader(rpc).read(mint);
    if (info.name) {
      // Cached so the next visitor does not pay for the same read.
      await upsertOnchainMetadata(client, info, Date.now());
      return { name: info.name, symbol: info.symbol, known: true };
    }
  } catch {
    // An unreachable node must not stop the page from rendering.
  }

  return { name: shortMint(mint), symbol: null, known: false };
}
