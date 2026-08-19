import { lookup } from 'node:dns/promises';
import { stripInvisible } from './sanitize';
import { UnsafeUriError, addressIsPrivate, resolveMetadataUri } from './uri';

/**
 * Fetching the JSON document a token's metadata points at.
 *
 * Everything in that document is attacker-controlled: a token launcher chooses
 * the name, the description and the image URL, and can serve a different body
 * on every request. So the fetch is bounded (time, size, redirects) and the
 * result is treated as untrusted input rather than as a record.
 */

export class OffchainFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OffchainFetchError';
  }
}

export interface OffchainMetadata {
  readonly name: string | null;
  readonly symbol: string | null;
  readonly description: string | null;
  readonly image: string | null;
  /**
   * The links the launcher put in the document.
   *
   * Read because they are the ones every other pump.fun client shows and this
   * one did not: the fields were being fetched and dropped on the floor. They
   * are the launcher's own claims about themselves, so they are held to the
   * same scheme rule as the image and are never presented as verified.
   *
   * Empty rather than absent is the common case. A document that carries
   * `"telegram": ""` has not given you a telegram, so an empty string is
   * normalised to null here rather than becoming an icon that goes nowhere.
   */
  readonly twitter: string | null;
  readonly website: string | null;
  readonly telegram: string | null;
}

export interface FetchOptions {
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly fetchImpl?: typeof fetch;
  /** Resolve a hostname to its IP addresses. Injected in tests. */
  readonly resolveHost?: (hostname: string) => Promise<string[]>;
}

/** Every address a hostname resolves to, for the SSRF check. */
async function resolveAll(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true });
  return records.map((record) => record.address);
}

/**
 * Refuse a host that resolves to a private address.
 *
 * This is the check the URI allowlist could not make on its own: a public
 * hostname whose DNS record points inside the network. Resolved here, at the
 * fetch boundary, so what is judged is what will be connected to. A narrow
 * check-to-connect window remains (the OS may re-resolve); closing it fully
 * needs connecting to the pinned IP, which is a larger change than this holds.
 */
async function assertPublicHost(
  hostname: string,
  uri: string,
  resolve: (hostname: string) => Promise<string[]>,
): Promise<void> {
  let addresses: string[];
  try {
    addresses = await resolve(hostname);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new UnsafeUriError(`could not resolve ${hostname}: ${reason}`, uri);
  }
  if (addresses.length === 0) {
    throw new UnsafeUriError(`${hostname} resolved to no addresses`, uri);
  }
  for (const address of addresses) {
    if (addressIsPrivate(address)) {
      throw new UnsafeUriError(`${hostname} resolves to the private address ${address}`, uri);
    }
  }
}

const DEFAULT_TIMEOUT_MS = 8_000;
/** Metadata documents are a few hundred bytes. This is already generous. */
const DEFAULT_MAX_BYTES = 256 * 1024;

/** Strings are clamped so a hostile document cannot fill the database. */
const MAX_NAME_CHARS = 128;
const MAX_DESCRIPTION_CHARS = 2_000;
const MAX_URL_CHARS = 2_048;

/**
 * Read a response body as text, aborting once it passes the byte cap.
 *
 * A hostile host can stream an unbounded or very slow body; `.text()` would
 * buffer all of it before any size check ran. This sums chunk lengths as they
 * arrive and gives up the moment the total exceeds the cap, so memory is bounded
 * by the cap rather than by whatever the socket delivers.
 */
async function readCapped(
  response: Response,
  maxBytes: number,
  uri: string,
  controller: AbortController,
): Promise<string> {
  const body = response.body;
  if (!body) return '';

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        controller.abort();
        throw new OffchainFetchError(`${uri} returned more than ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

function clean(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null;
  const stripped = stripInvisible(value);
  if (!stripped) return null;
  return stripped.slice(0, maxChars);
}

export async function fetchOffchainMetadata(
  uri: string,
  options: FetchOptions = {},
): Promise<OffchainMetadata> {
  const safeUri = resolveMetadataUri(uri);
  const doFetch = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  // Resolve and vet the host before opening a socket, so a public name pointing
  // at an internal address is refused rather than fetched.
  await assertPublicHost(new URL(safeUri).hostname, uri, options.resolveHost ?? resolveAll);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await doFetch(safeUri, {
      signal: controller.signal,
      // Redirects are followed by default and could land somewhere the URI
      // check already rejected, so they are refused outright.
      redirect: 'error',
      headers: { accept: 'application/json' },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new OffchainFetchError(`could not fetch ${safeUri}: ${reason}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new OffchainFetchError(`${safeUri} returned HTTP ${response.status}`);
  }

  // A declared length over the cap is refused up front, cheaply.
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) {
    throw new OffchainFetchError(`${safeUri} declares ${declared} bytes, over the ${maxBytes} cap`);
  }

  // But content-length is optional and a chunked or slow response can omit or
  // lie about it, so it does not bound memory on its own. The body is read
  // incrementally and abandoned the moment the running byte total passes the
  // cap, rather than buffering all of it first with `.text()`.
  const text = await readCapped(response, maxBytes, safeUri, controller);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new OffchainFetchError(`${safeUri} did not return valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new OffchainFetchError(`${safeUri} returned ${Array.isArray(parsed) ? 'an array' : typeof parsed}, expected an object`);
  }

  const document = parsed as Record<string, unknown>;
  const image = clean(document['image'], MAX_URL_CHARS);

  /*
   * A link somebody else wrote, made safe to put in an href.
   *
   * https only. These are rendered as anchors a reader can click, so a
   * `javascript:` URL here would be a script the launcher gets to run in their
   * browser, and `ipfs://` is allowed for images because a browser can be asked
   * to render one but is not a page anyone should be sent to.
   */
  const link = (value: unknown): string | null => {
    const raw = clean(value, MAX_URL_CHARS);
    return raw && /^https:\/\//i.test(raw) ? raw : null;
  };

  return {
    name: clean(document['name'], MAX_NAME_CHARS),
    symbol: clean(document['symbol'], MAX_NAME_CHARS),
    description: clean(document['description'], MAX_DESCRIPTION_CHARS),
    // The image is only ever rendered by a browser, never fetched here, but it
    // is still held to the same scheme rules so a `javascript:` or `data:` URL
    // never reaches an <img src>.
    image: image && /^(https:\/\/|ipfs:\/\/)/i.test(image) ? image : null,
    twitter: link(document['twitter']),
    website: link(document['website']),
    telegram: link(document['telegram']),
  };
}
