import 'server-only';
import type { CachedTokenMetadata } from '@probatio/db';
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

/**
 * Never hold up a feed for one slow gateway.
 *
 * Ten rather than six. Almost every one of these documents is on a public IPFS
 * gateway, which is slow under load rather than broken, and a six second leash
 * turned "busy" into "failed" often enough to blank a screenful of tokens.
 */
const TIMEOUT_MS = 10_000;
/** How many documents to have in flight at once. */
const CONCURRENCY = 6;
/** Refresh a picture we have at most this often. Metadata rarely moves. */
const STALE_MS = 24 * 60 * 60 * 1_000;

/**
 * How long to wait before trying a document that failed, by attempt.
 *
 * A success and a failure both stamped `offchain_fetched_at`, and the refetch
 * gate was `STALE_MS` for both, so one timed-out fetch hid a token's picture for
 * a full day. Measured before this changed: twenty mints asked to resolve, still
 * zero of twenty four minutes later.
 *
 * A failure is usually a busy gateway, so the first retry is soon. The wait
 * grows with each attempt so a genuinely dead host is not asked at the same rate
 * forever, and after the last step it falls back to the daily refresh, which is
 * where a document that truly does not exist belongs.
 */
const RETRY_AFTER_MS = [30_000, 2 * 60_000, 10 * 60_000, 60 * 60_000] as const;

function readyToRetry(entry: CachedTokenMetadata, now: number): boolean {
  if (entry.offchainFetchedAt === null) return true;

  // No error recorded means the last attempt worked; that is the daily refresh.
  if (entry.offchainError === null) return entry.offchainFetchedAt < now - STALE_MS;

  const wait = RETRY_AFTER_MS[Math.min(entry.offchainAttempts, RETRY_AFTER_MS.length - 1)] ?? STALE_MS;
  return entry.offchainFetchedAt < now - wait;
}

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

/**
 * pump.fun's own record of a coin, which carries the picture directly.
 *
 * The chain gives a metadata URI and the picture is a field inside a document
 * at the other end of it, so every step above can succeed and still leave no
 * image when that document's host is gone. This asks the launchpad instead,
 * which stores the image URL beside the coin and answers for tokens years old.
 *
 * Why it was needed. The Explore board ranks by market cap, so everything on it
 * is months old and none of it was ever in the launch feed, which is where this
 * resolver's cheap path gets its URI. Measured on a token reached from that
 * board: the card showed a picture and the token page showed a placeholder,
 * still a placeholder a minute later, because the two read from different
 * places. The board reads this endpoint. Now so does the page.
 */
const PUMP_COIN = 'https://frontend-api-v3.pump.fun/coins';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

interface LaunchpadCoin {
  image: string | null;
  name: string | null;
  symbol: string | null;
}

async function launchpadCoin(mint: string): Promise<LaunchpadCoin | null> {
  try {
    const response = await fetch(`${PUMP_COIN}/${mint}`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as Record<string, unknown>;
    const str = (value: unknown, max: number): string | null =>
      typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : null;
    const image = str(body['image_uri'], 400);
    if (!image) return null;
    return { image, name: str(body['name'], 120), symbol: str(body['symbol'], 40) };
  } catch {
    // Another service having a bad minute is a missing picture, nothing more.
    return null;
  }
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

    /*
     * The launchpad is the last resort, and it answers when nothing else does.
     *
     * Reached two ways: with no URI at all, which used to return here and leave
     * the token permanently without a picture, and with a URI whose document
     * cannot be fetched or carries no image. Both end the same way for the
     * person looking at the page, so both fall through to the same place.
     */
    if (!uri) {
      const coin = await launchpadCoin(mint);
      if (!coin) return;
      /*
       * The row has to exist before the picture can be written into it.
       *
       * `recordOffchainMetadata` is an UPDATE keyed on the mint, so against a
       * token that has never been seen it matches nothing and reports success.
       * That is the shape of this whole bug repeated one level down: the write
       * appeared to work and the page stayed blank. There is no URI to record
       * here, which the column allows, because the picture did not come from a
       * document this time.
       */
      await upsertOnchainMetadata(
        client,
        {
          mint,
          name: coin.name,
          symbol: coin.symbol,
          uri: null,
          updateAuthority: null,
          decimals: null,
        },
        now,
      );
      await recordOffchainMetadata(
        client,
        mint,
        {
          name: coin.name,
          symbol: coin.symbol,
          description: null,
          imageUrl: coin.image,
          twitterUrl: null,
          websiteUrl: null,
          telegramUrl: null,
        },
        now,
      );
      return;
    }

    await upsertOnchainMetadata(
      client,
      { mint, name: name || null, symbol: symbol || null, uri, updateAuthority: null, decimals: null },
      now,
    );

    try {
      const document = await fetchOffchainMetadata(uri, { timeoutMs: TIMEOUT_MS });
      // A document that resolved but has no picture in it is not a success as
      // far as the page is concerned, so it takes the fallback too.
      const image = document.image ?? (await launchpadCoin(mint))?.image ?? null;
      await recordOffchainMetadata(
        client,
        mint,
        {
          name: document.name,
          symbol: document.symbol,
          description: document.description,
          imageUrl: image,
          // Fetched all along, kept from now on.
          twitterUrl: document.twitter,
          websiteUrl: document.website,
          telegramUrl: document.telegram,
        },
        now,
      );
    } catch (error) {
      const coin = await launchpadCoin(mint);
      if (coin) {
        await recordOffchainMetadata(
          client,
          mint,
          {
            name: coin.name ?? name,
            symbol: coin.symbol ?? symbol,
            description: null,
            imageUrl: coin.image,
            twitterUrl: null,
            websiteUrl: null,
            telegramUrl: null,
          },
          now,
        );
        return;
      }
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
      return entry ? readyToRetry(entry, now) : true;
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
