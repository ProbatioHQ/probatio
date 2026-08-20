import 'server-only';
import { verifyBundle } from '@probatio/sdk';
import type { ProofBundle, VerifiedRecord } from '@probatio/sdk';

/**
 * Checking somebody's record from a chat.
 *
 * The claim this makes is stronger than the usual one and it is worth being
 * precise about why. The bot does not look the answer up and repeat it. It
 * fetches the sealed fills and recomputes every hash, with the same open source
 * code anybody else can run, and reports what the arithmetic says. If a figure
 * in a stored fill had been altered afterwards, to improve a price or shave a
 * fee, the recomputed hash would stop matching the seal recorded beside it, and
 * this is where that would show.
 *
 * It goes through the site's own proof endpoint rather than reading the database
 * directly, and that is deliberate. Reading the tables would be faster and would
 * quietly make the bot a privileged observer, checking something nobody outside
 * could check the same way. The whole point is that the check is available to
 * everyone, so the bot takes the public route like everybody else.
 */

const SITE = process.env['PROBATIO_SITE'] ?? 'https://probatiotrade.com';

/** A wallet address, near enough to reject typing before spending a request. */
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function looksLikeWallet(value: string): boolean {
  return ADDRESS.test(value.trim());
}

/**
 * Pull the first thing that could be a wallet out of arbitrary text.
 *
 * People paste addresses into sentences, inside brackets, at the end of a line
 * with a full stop against them. Base58 contains no punctuation at all, so
 * anything that is not base58 can be stripped from either end without ever
 * eating part of a real address.
 */
const EDGES = /^[^1-9A-HJ-NP-Za-km-z]+|[^1-9A-HJ-NP-Za-km-z]+$/g;

export function findWallet(text: string | undefined): string | null {
  if (!text) return null;
  for (const word of text.split(/\s+/)) {
    const cleaned = word.replace(EDGES, '');
    if (looksLikeWallet(cleaned)) return cleaned;
  }
  return null;
}

export interface VerifyResult {
  readonly trader: string;
  readonly record: VerifiedRecord | null;
  /** Absent when the wallet has never traded, which is not a failure. */
  readonly empty: boolean;
  readonly unreachable: boolean;
}

export async function verifyWallet(trader: string): Promise<VerifyResult> {
  let bundle: ProofBundle;
  try {
    const response = await fetch(`${SITE}/api/proof?trader=${encodeURIComponent(trader)}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) {
      return { trader, record: null, empty: response.status === 404, unreachable: response.status !== 404 };
    }
    bundle = (await response.json()) as ProofBundle;
  } catch {
    return { trader, record: null, empty: false, unreachable: true };
  }

  if (!bundle.record || bundle.record.length === 0) {
    return { trader, record: null, empty: true, unreachable: false };
  }

  return { trader, record: verifyBundle(bundle), empty: false, unreachable: false };
}

export type { VerifiedRecord };
