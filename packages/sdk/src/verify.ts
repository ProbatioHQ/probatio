import {
  buildProof,
  buildTree,
  computeRoot,
  hashLeaf,
  toHex,
  type TradeLeaf,
} from '@probatio/commit';
import { getProof, type ReadOptions } from './read';
import type { ProofBundle, SealedLeaf, VerifiedRecord, VerifyCheck } from './types';

/**
 * Checking a record, the way the /verify page does, headless.
 *
 * Every fill is sealed with a hash the moment it lands, computed over the exact
 * figures it was priced from: the reserves, the amounts, the fee, the slot it
 * was clicked at and the slot it filled at. The proof endpoint hands over those
 * figures and the seals. Everything after that happens here, on the caller's
 * machine, with the same open-source hashing the engine uses.
 *
 * What it catches: if any field of a stored fill were altered after the fact, to
 * improve a price or shave a fee, the hash recomputed from it would stop
 * matching the seal recorded beside it. The server cannot make the comparison
 * come out right without forging the seal, and it cannot forge the seal without
 * the figures that produce it, which are the figures handed to the caller.
 *
 * There is no RPC endpoint and no account to read. This used to fold the batch
 * roots into an accumulator and compare that against a Solana account, which
 * required the record to have been committed first. Nothing is committed, so
 * every honest record failed the only check that counted while all the local
 * ones passed. A seal is written at fill time, so this works on any record.
 */

export interface VerifyOptions extends ReadOptions {
  /** A specific season ordinal, or the trader's latest when omitted. */
  readonly season?: number | undefined;
}

function toLeaf(raw: SealedLeaf): TradeLeaf {
  return {
    ...raw,
    solAmount: BigInt(raw.solAmount),
    tokenAmount: BigInt(raw.tokenAmount),
    feeLamports: BigInt(raw.feeLamports),
    solReserve: BigInt(raw.solReserve),
    tokenReserve: BigInt(raw.tokenReserve),
    deliverableTokens: BigInt(raw.deliverableTokens),
  };
}

/** Verify a record, either freshly fetched (`verifyRecord`) or already in hand. */
export function verifyBundle(bundle: ProofBundle): VerifiedRecord {
  const checks: VerifyCheck[] = [];
  const record = bundle.record ?? [];

  if (record.length === 0) {
    return {
      trader: bundle.trader,
      seasonOrdinal: bundle.seasonOrdinal,
      verified: false,
      root: '',
      broken: [],
      tradeCount: 0,
      checks: [
        {
          label: 'Record',
          passed: false,
          detail: 'this wallet has no fills on record, so there is nothing to check',
        },
      ],
    };
  }

  /*
   * 1. Every seal, recomputed.
   *
   * The whole point. Each fill is hashed again from the figures shipped with it
   * and compared to the seal stored beside it. Mismatches are collected rather
   * than thrown, because which fill disagrees is the only useful thing to know.
   */
  const rehashed = record.map((raw) => ({ raw, hash: toHex(hashLeaf(toLeaf(raw))) }));
  const broken = rehashed.filter((entry) => entry.hash !== entry.raw.recordedHash);

  checks.push({
    label: 'Seals',
    passed: broken.length === 0,
    detail:
      broken.length === 0
        ? `all ${rehashed.length} fills rehash to exactly the seal recorded with them`
        : `${broken.length} of ${rehashed.length} fills do not match their seal`,
  });
  for (const entry of broken) {
    checks.push({
      label: `Fill ${entry.raw.sequence}`,
      passed: false,
      detail:
        `its figures hash to ${entry.hash.slice(0, 16)}…, but ` +
        `${entry.raw.recordedHash.slice(0, 16)}… was recorded`,
    });
  }

  /*
   * 2. The root, and each fill proving it belongs to it.
   *
   * Recomputing the root from a leaf and its proof is what makes the root mean
   * anything. Without it the root is a number that was printed rather than one
   * that was checked, and reordering a record would go unnoticed.
   */
  const hashes = rehashed.map((entry) => hashLeaf(toLeaf(entry.raw)));
  const tree = buildTree(hashes);
  const root = toHex(tree.root);
  const membershipOk = hashes.every(
    (hash, index) => toHex(computeRoot(hash, buildProof(tree, index))) === toHex(tree.root),
  );
  checks.push({
    label: 'Membership',
    passed: membershipOk,
    detail: membershipOk
      ? 'every fill proves it belongs to the record, in the order it was made'
      : 'a fill does not belong to the record claiming it',
  });

  return {
    trader: bundle.trader,
    seasonOrdinal: bundle.seasonOrdinal,
    verified: broken.length === 0 && membershipOk,
    root,
    broken: broken.map((entry) => String(entry.raw.sequence)),
    tradeCount: rehashed.length,
    checks,
  };
}

/** Fetch a trader's record and verify it. The flagship call. */
export async function verifyRecord(trader: string, options: VerifyOptions = {}): Promise<VerifiedRecord> {
  const bundle = await getProof(trader, {
    apiBase: options.apiBase,
    fetchImpl: options.fetchImpl,
    season: options.season,
  });
  return verifyBundle(bundle);
}
