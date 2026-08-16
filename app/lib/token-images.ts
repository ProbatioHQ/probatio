import 'server-only';
import {
  getManyTokenMetadata,
  getTokenMetadata,
  launchByMint,
  recordOffchainFailure,
  recordOffchainMetadata,
  upsertOnchainMetadata,
} from '@probatio/db';
import { MetadataReader, fetchOffchainMetadata } from '@probatio/metadata';
import { db } from './db';
import { sharedRpc } from './rpc';

/**
 * Token pictures.
 *
 * A launch carries a metadata URI, not an image — the picture is a field inside
 * a JSON document on a host the token's creator chose. So resolving one means
 * fetching an arbitrary URL somebody else controls, which is why it happens
 * here on a leash rather than in the browser: the fetch is size-capped,
 * time-capped, and refuses anything that is not http or ipfs, and the result is
 * cached so the same document is never pulled twice.
 *
 * The image URL itself is only ever handed to a browser to render, never
 * fetched by this server. A failure is recorded as a failure with a timestamp,
 * so a token whose gateway is dead is not retried on every page load.
 */

/** Never hold up a feed for one slow gateway. */
const TIMEOUT_MS = 6_000;
/** How many documents to have in flight at once. */
const CONCURRENCY = 4;
/** Refresh an image at most this often. Metadata is mutable but rarely moves. */
const STALE_MS = 24 * 60 * 60 * 1_000;

/**
 * Mints being resolved right now, so two callers do not fetch the same one.
 *
 * Shared across bundles for the reason written out in lib/health.ts: this is
 * called both by the launch feed in the instrumentation bundle and by the
 * routes, and a per-bundle copy means each side happily fetches a document the
 * other is already fetching. Not a correctness bug — the write is idempotent —
 * but it is a stranger's IPFS gateway being asked twice for the same file, and
 * the whole point of the set is to not do that.
 */
const IN_FLIGHT_KEY = Symbol.for('probatio.token-images-inflight');

function inFlightSet(): Set<string> {
  const store = globalThis as typeof globalThis & { [IN_FLIGHT_KEY]?: Set<string> };
  store[IN_FLIGHT_KEY] ??= new Set();
  return store[IN_FLIGHT_KEY];
}

async function resolveOne(mint: string, now: number): Promise<void> {
  const inFlight = inFlightSet();
  if (inFlight.has(mint)) return;
  inFlight.add(mint);
  try {
    const client = await db();

    // Where the metadata URI comes from, cheapest first: the launch we recorded,
    // then the token metadata we cached, then the chain. A searched token was
    // never in the feed, so without the last two its picture could never resolve
    // and its page showed a placeholder — which is exactly what was reported.
    const launch = await launchByMint(client, mint);
    let uri = launch?.uri ?? null;
    let name = launch?.name ?? null;
    let symbol = launch?.symbol ?? null;

    if (!uri) {
      const cached = await getTokenMetadata(client, mint);
      uri = cached?.uri ?? null;
      name ??= cached?.name ?? null;
      symbol ??= cached?.symbol ?? null;
    }
    if (!uri) {
      try {
        const info = await new MetadataReader(sharedRpc()).read(mint);
        uri = info.uri ?? null;
        name = info.name ?? name;
        symbol = info.symbol ?? symbol;
      } catch {
        // An unreachable node is a missing picture, not a failure to record.
      }
    }

    if (!uri) return;

    await upsertOnchainMetadata(
      client,
      { mint, name: name || null, symbol: symbol || null, uri, updateAuthority: null, decimals: null },
      now,
    );

    try {
      const document = await fetchOffchainMetadata(uri, { timeoutMs: TIMEOUT_MS });
      await recordOffchainMetadata(
        client,
        mint,
        {
          name: document.name,
          symbol: document.symbol,
          description: document.description,
          imageUrl: document.image,
        },
        now,
      );
    } catch (error) {
      await recordOffchainFailure(
        client,
        mint,
        error instanceof Error ? error.message : 'fetch failed',
        now,
      );
    }
  } catch (error) {
    // A picture is never worth failing a request over.
    console.error('[images] could not resolve', mint, error);
  } finally {
    inFlightSet().delete(mint);
  }
}

/**
 * Fetch what is missing, in the background.
 *
 * Returns immediately. Callers that need the images now should read the cache
 * afterwards and accept that the newest tokens will not have one yet — which is
 * true of every client, because the document is fetched after the token exists.
 */
export function resolveLaunchImages(mints: readonly string[]): void {
  void (async () => {
    if (mints.length === 0) return;
    const client = await db();
    const now = Date.now();
    const cached = await getManyTokenMetadata(client, mints);

    const wanted = mints.filter((mint) => {
      const entry = cached.get(mint);
      if (!entry) return true;
      if (entry.offchainFetchedAt === null) return true;
      return entry.offchainFetchedAt < now - STALE_MS;
    });

    // A plain worker pool: a launch burst can be a hundred mints, and a
    // hundred simultaneous fetches to one IPFS gateway gets us rate limited
    // and gets the images nowhere faster.
    let cursor = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, wanted.length) }, async () => {
      while (cursor < wanted.length) {
        const mint = wanted[cursor];
        cursor += 1;
        if (mint) await resolveOne(mint, Date.now());
      }
    });
    await Promise.all(workers);
  })().catch(() => undefined);
}

/**
 * Remember pictures a search already found.
 *
 * The outside search index hands back an image URL with each hit, so clicking a
 * result should open a page that already has the picture rather than one that
 * resolves it from chain first. Recorded here, in the background, skipping any
 * mint that already has an image. Best effort: a picture is never worth failing
 * a search over.
 */
export function cacheImages(
  entries: readonly { mint: string; name: string; symbol: string; image: string | null }[],
): void {
  void (async () => {
    const withImage = entries.filter((entry) => entry.image);
    if (withImage.length === 0) return;
    const client = await db();
    const now = Date.now();
    const known = await getManyTokenMetadata(
      client,
      withImage.map((entry) => entry.mint),
    );
    for (const entry of withImage) {
      if (known.get(entry.mint)?.imageUrl) continue;
      try {
        await upsertOnchainMetadata(
          client,
          { mint: entry.mint, name: entry.name || null, symbol: entry.symbol || null, uri: null, updateAuthority: null, decimals: null },
          now,
        );
        await recordOffchainMetadata(
          client,
          entry.mint,
          { name: entry.name || null, symbol: entry.symbol || null, description: null, imageUrl: entry.image },
          now,
        );
      } catch {
        // A cached picture is never worth failing over.
      }
    }
  })().catch(() => undefined);
}

/** Cached image URLs for these mints. Only ever what is already known. */
export async function knownImages(mints: readonly string[]): Promise<Map<string, string>> {
  if (mints.length === 0) return new Map();
  const cached = await getManyTokenMetadata(await db(), mints);
  const images = new Map<string, string>();
  for (const [mint, entry] of cached) {
    if (entry.imageUrl) images.set(mint, entry.imageUrl);
  }
  return images;
}
