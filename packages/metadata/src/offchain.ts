import { resolveMetadataUri } from './uri';

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
}

export interface FetchOptions {
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 8_000;
/** Metadata documents are a few hundred bytes. This is already generous. */
const DEFAULT_MAX_BYTES = 256 * 1024;

/** Strings are clamped so a hostile document cannot fill the database. */
const MAX_NAME_CHARS = 128;
const MAX_DESCRIPTION_CHARS = 2_000;
const MAX_URL_CHARS = 2_048;

/**
 * Characters that are invisible but not harmless.
 *
 * C0 and C1 control codes, the zero-width family, and the bidirectional
 * overrides — the last of which let a token render its name right-to-left so
 * it displays as something other than what it is. These names appear on the
 * leaderboard and in the positions panel, next to money, so they are stripped
 * here rather than escaped somewhere downstream and hoped about.
 */
const INVISIBLE_CHARACTERS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;

function clean(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null;
  const stripped = value.replace(INVISIBLE_CHARACTERS, '').trim();
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

  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) {
    throw new OffchainFetchError(`${safeUri} declares ${declared} bytes, over the ${maxBytes} cap`);
  }

  const text = await response.text();
  // Checked again after reading, because content-length is optional and a
  // chunked response can lie about its size or omit it entirely.
  if (text.length > maxBytes) {
    throw new OffchainFetchError(`${safeUri} returned more than ${maxBytes} bytes`);
  }

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

  return {
    name: clean(document['name'], MAX_NAME_CHARS),
    symbol: clean(document['symbol'], MAX_NAME_CHARS),
    description: clean(document['description'], MAX_DESCRIPTION_CHARS),
    // The image is only ever rendered by a browser, never fetched here, but it
    // is still held to the same scheme rules so a `javascript:` or `data:` URL
    // never reaches an <img src>.
    image: image && /^(https:\/\/|ipfs:\/\/)/i.test(image) ? image : null,
  };
}
