import { sha256 } from '@noble/hashes/sha2.js';
import type { VoidPolicy } from './void';

/**
 * A season's rules, pinned.
 *
 * The hash of this goes on chain when the season is created, before anybody
 * enters. That is the entire point: a trader can read the published rules,
 * hash them themselves, and see the same 32 bytes the program recorded — so
 * the rules cannot be adjusted afterwards to suit a result.
 *
 * Fixed-width and fixed-order, never JSON. Two JSON encoders can order keys
 * differently and produce different bytes for the same rules, and a hash that
 * changes with the encoder commits to nothing. Same discipline as a trade leaf,
 * for the same reason.
 */

export class RulesetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RulesetError';
  }
}

/**
 * How a pot is divided.
 *
 * Chosen by pot size at close, not fixed when the season opens: a season with
 * four entrants and a season with four hundred should not pay out the same
 * shape, and which one it turns out to be is not known in advance.
 */
export interface PayoutBand {
  /** The band applies while the pot is at least this. */
  readonly minPotLamports: bigint;
  /** Shares in basis points, first place first. Must total 10000. */
  readonly sharesBps: readonly number[];
}

export interface Ruleset {
  readonly ordinal: number;
  /** Milliseconds. */
  readonly durationMs: number;
  /** How long after the start entries are accepted. */
  readonly entryWindowMs: number;
  readonly startingBalance: bigint;
  readonly entryCost: bigint;
  readonly houseBps: number;
  /** No house cut is taken at or below this pot. */
  readonly houseThreshold: bigint;

  // The simulation conditions. These are what make a result reproducible.
  readonly latencyMs: number;
  readonly slippageBps: number;
  readonly maxPriceImpactBps: number;
  readonly engineVersion: number;

  /** Identifies the scoring rule in words the published page also uses. */
  readonly scoring: ScoringRule;
  readonly tiebreak: Tiebreak;
  /**
   * When the season does not count.
   *
   * In the hash because these thresholds decide whether a pot is paid at all.
   * A void policy that could be edited once a season is running is not a
   * policy, it is an intention — and the moment it matters is exactly the
   * moment somebody would want to edit it.
   */
  readonly voidPolicy: VoidPolicy;
  readonly bands: readonly PayoutBand[];
}

/**
 * Highest return wins.
 *
 * Risk-adjusted scoring was the original plan and is gone. With no minimum
 * trade count — which is deliberate, because one good call can win a season —
 * a single trade produces almost no drawdown and therefore a near-infinite
 * risk-adjusted score. The formula would have crowned whoever traded least.
 */
export type ScoringRule = 'highest_return';

/**
 * How a tie is broken.
 *
 * In the hash because it decides who gets paid. Two traders finishing on the
 * same return is not a curiosity to be settled later by whoever is running the
 * season — with a pot on the line it is the most contestable moment there is,
 * so the rule is published up front and cannot move afterwards.
 *
 * `entered_then_pubkey`: the earlier entrant wins, and if they entered in the
 * same millisecond, the public key that sorts first in base58 order (the string
 * compared as-is, which is what `compareStandings` runs). Naming the exact
 * comparison matters: "the lower key" could mean byte order, and byte order and
 * base58 order disagree for keys whose encodings differ in length, so anyone
 * reproducing the ranking has to know which one. The last step is arbitrary and
 * says so; it exists so that the ordering is total, because a ranking that can
 * report two firsts cannot pay one.
 */
export type Tiebreak = 'entered_then_pubkey';

const SCORING_CODES: Record<ScoringRule, number> = { highest_return: 0 };
const TIEBREAK_CODES: Record<Tiebreak, number> = { entered_then_pubkey: 0 };

const AMOUNT_BYTES = 16;
/** Bands are fixed-width so the encoding has no length-dependent boundaries. */
const MAX_BANDS = 8;
const MAX_SHARES = 16;

export function validateRuleset(ruleset: Ruleset): void {
  if (ruleset.durationMs <= 0) throw new RulesetError('a season must last longer than nothing');
  if (ruleset.entryWindowMs <= 0) throw new RulesetError('the entry window must be open for some time');
  if (ruleset.entryWindowMs > ruleset.durationMs) {
    throw new RulesetError('entries cannot stay open past the end of the season');
  }
  if (ruleset.startingBalance <= 0n) throw new RulesetError('traders must start with something');
  if (ruleset.entryCost < 0n) throw new RulesetError('entry cannot cost less than nothing');
  if (ruleset.houseBps < 0 || ruleset.houseBps > 10_000) {
    throw new RulesetError(`house cut out of range: ${ruleset.houseBps}`);
  }
  for (const [name, value] of [
    ['maxFeedOutageMinutes', ruleset.voidPolicy.maxFeedOutageMinutes],
    ['maxChainHaltMinutes', ruleset.voidPolicy.maxChainHaltMinutes],
    ['maxUncommittedTrades', ruleset.voidPolicy.maxUncommittedTrades],
    ['maxIrreproducibleTrades', ruleset.voidPolicy.maxIrreproducibleTrades],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      throw new RulesetError(`${name} must be a whole number of at least zero`);
    }
  }

  if (ruleset.bands.length === 0) throw new RulesetError('a season needs at least one payout band');
  if (ruleset.bands.length > MAX_BANDS) throw new RulesetError(`at most ${MAX_BANDS} bands`);

  let previous = -1n;
  for (const band of ruleset.bands) {
    if (band.minPotLamports <= previous) {
      throw new RulesetError('bands must be ordered by pot size, smallest first');
    }
    previous = band.minPotLamports;

    if (band.sharesBps.length === 0) throw new RulesetError('a band must pay somebody');
    if (band.sharesBps.length > MAX_SHARES) throw new RulesetError(`at most ${MAX_SHARES} places`);

    const total = band.sharesBps.reduce((sum, share) => sum + share, 0);
    if (total !== 10_000) {
      // A band that does not total 100% either loses money or invents it.
      throw new RulesetError(`band shares must total 10000 bps, got ${total}`);
    }
    if (band.sharesBps.some((share) => share <= 0)) {
      throw new RulesetError('a paid place must be paid something');
    }
  }
  if (ruleset.bands[0]!.minPotLamports !== 0n) {
    throw new RulesetError('the first band must start at zero, or a small pot pays nobody');
  }
}

function writeUint(view: DataView, offset: number, value: bigint, bytes: number): void {
  if (value < 0n) throw new RulesetError(`value cannot be negative: ${value}`);
  if (value >= 1n << BigInt(bytes * 8)) {
    throw new RulesetError(`value does not fit in ${bytes} bytes: ${value}`);
  }
  let remaining = value;
  for (let i = bytes - 1; i >= 0; i -= 1) {
    view.setUint8(offset + i, Number(remaining & 0xffn));
    remaining >>= 8n;
  }
}

export const RULESET_BYTES =
  2 + // ordinal (i16)
  8 + // durationMs
  8 + // entryWindowMs
  AMOUNT_BYTES + // startingBalance
  AMOUNT_BYTES + // entryCost
  2 + // houseBps
  AMOUNT_BYTES + // houseThreshold
  4 + // latencyMs
  2 + // slippageBps
  2 + // maxPriceImpactBps
  4 + // engineVersion
  1 + // scoring
  1 + // tiebreak
  4 + // maxFeedOutageMinutes
  4 + // maxChainHaltMinutes
  4 + // maxUncommittedTrades
  4 + // maxIrreproducibleTrades
  1 + // band count
  MAX_BANDS * (AMOUNT_BYTES + 1 + MAX_SHARES * 2);

export function encodeRuleset(ruleset: Ruleset): Uint8Array {
  validateRuleset(ruleset);

  const bytes = new Uint8Array(RULESET_BYTES);
  const view = new DataView(bytes.buffer);
  let offset = 0;

  view.setInt16(offset, ruleset.ordinal);
  offset += 2;
  writeUint(view, offset, BigInt(ruleset.durationMs), 8);
  offset += 8;
  writeUint(view, offset, BigInt(ruleset.entryWindowMs), 8);
  offset += 8;
  writeUint(view, offset, ruleset.startingBalance, AMOUNT_BYTES);
  offset += AMOUNT_BYTES;
  writeUint(view, offset, ruleset.entryCost, AMOUNT_BYTES);
  offset += AMOUNT_BYTES;
  view.setUint16(offset, ruleset.houseBps);
  offset += 2;
  writeUint(view, offset, ruleset.houseThreshold, AMOUNT_BYTES);
  offset += AMOUNT_BYTES;
  view.setUint32(offset, ruleset.latencyMs);
  offset += 4;
  view.setUint16(offset, ruleset.slippageBps);
  offset += 2;
  view.setUint16(offset, ruleset.maxPriceImpactBps);
  offset += 2;
  view.setUint32(offset, ruleset.engineVersion);
  offset += 4;
  view.setUint8(offset, SCORING_CODES[ruleset.scoring]);
  offset += 1;
  view.setUint8(offset, TIEBREAK_CODES[ruleset.tiebreak]);
  offset += 1;

  view.setUint32(offset, ruleset.voidPolicy.maxFeedOutageMinutes);
  offset += 4;
  view.setUint32(offset, ruleset.voidPolicy.maxChainHaltMinutes);
  offset += 4;
  view.setUint32(offset, ruleset.voidPolicy.maxUncommittedTrades);
  offset += 4;
  view.setUint32(offset, ruleset.voidPolicy.maxIrreproducibleTrades);
  offset += 4;

  view.setUint8(offset, ruleset.bands.length);
  offset += 1;

  // Every band slot is written whether it is used or not. Unused slots stay
  // zero, so adding a band changes the count byte and one slot rather than
  // shifting everything after it.
  for (let index = 0; index < MAX_BANDS; index += 1) {
    const band = ruleset.bands[index];
    if (band) {
      writeUint(view, offset, band.minPotLamports, AMOUNT_BYTES);
      view.setUint8(offset + AMOUNT_BYTES, band.sharesBps.length);
      band.sharesBps.forEach((share, place) => {
        view.setUint16(offset + AMOUNT_BYTES + 1 + place * 2, share);
      });
    }
    offset += AMOUNT_BYTES + 1 + MAX_SHARES * 2;
  }

  return bytes;
}

/** The 32 bytes recorded on chain. */
export function rulesetHash(ruleset: Ruleset): Uint8Array {
  return sha256(encodeRuleset(ruleset));
}

export function rulesetHashHex(ruleset: Ruleset): string {
  return [...rulesetHash(ruleset)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
