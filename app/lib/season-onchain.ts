import 'server-only';
import { readFileSync } from 'node:fs';
import bs58 from 'bs58';
import { ed25519 } from '@noble/curves/ed25519.js';
import { rulesetFor, rulesetHashHex } from '@probatio/seasons';
import { seasonParamsFrom, type SeasonParams } from '@probatio/vault';

/**
 * The keys and parameters the on-chain season lifecycle runs on.
 *
 * Two keys matter here and they are different from the keeper's. The authority
 * creates and finalizes seasons; the keeper's public key is written into the
 * season as the only key allowed to commit its records. Both are read the same
 * way as the keeper key — a path to a keypair file, or the array inline — so a
 * host with no persistent file can still run them from a variable.
 */

export interface Keypair {
  readonly secret: Uint8Array;
  readonly publicKey: string;
}

function loadKeypair(envVar: string): Keypair | null {
  const configured = process.env[envVar];
  if (!configured) return null;
  try {
    const json = configured.trim().startsWith('[') ? configured : readFileSync(configured, 'utf8');
    const secret = Uint8Array.from(JSON.parse(json) as number[]);
    if (secret.length !== 64) {
      console.error(`[onchain] ${envVar} is not a 64-byte keypair`);
      return null;
    }
    return { secret, publicKey: bs58.encode(ed25519.getPublicKey(secret.subarray(0, 32))) };
  } catch (error) {
    console.error(`[onchain] ${envVar} is set but could not be read`, error);
    return null;
  }
}

/** The authority keypair, or null when the operator has not configured one. */
export function authorityKeypair(): Keypair | null {
  return loadKeypair('AUTHORITY_KEYPAIR');
}

/** The keeper's public key, written into a season as its only committer. */
export function keeperPublicKey(): string | null {
  return loadKeypair('KEEPER_KEYPAIR')?.publicKey ?? null;
}

/** The season's schedule, as the lifecycle worker sees it. */
export interface SeasonSchedule {
  readonly ordinal: number;
  readonly startsAt: number | null;
  readonly endsAt: number | null;
  readonly entryClosesAt: number | null;
  readonly rulesetHash: string;
}

/**
 * Build the on-chain params for a season from its ruleset and schedule.
 *
 * Everything the scoring hash covers comes from the ruleset, so the season's
 * on-chain hash is exactly the one it published; the schedule comes from the
 * row. It refuses if the published hash is not the one today's ruleset produces
 * — that means the rules changed under a season, and it must not be created with
 * a hash a verifier will reject.
 */
export function seasonParamsForRow(row: SeasonSchedule, keeper: string): SeasonParams {
  const ruleset = rulesetFor(row.ordinal);
  if (rulesetHashHex(ruleset) !== row.rulesetHash) {
    throw new Error(
      `season ${row.ordinal} published hash ${row.rulesetHash} is not the current ruleset's`,
    );
  }
  if (row.startsAt === null || row.endsAt === null || row.entryClosesAt === null) {
    throw new Error(`season ${row.ordinal} has no schedule to create on chain`);
  }
  return seasonParamsFrom({
    ordinal: row.ordinal,
    keeper,
    startsAtMs: row.startsAt,
    endsAtMs: row.endsAt,
    entryClosesAtMs: row.entryClosesAt,
    startingBalance: ruleset.startingBalance,
    entryCost: ruleset.entryCost,
    houseBps: ruleset.houseBps,
    houseThreshold: ruleset.houseThreshold,
    latencyMs: ruleset.latencyMs,
    slippageBps: ruleset.slippageBps,
    maxPriceImpactBps: ruleset.maxPriceImpactBps,
    engineVersion: ruleset.engineVersion,
    scoringFormulaHashHex: row.rulesetHash,
  });
}
