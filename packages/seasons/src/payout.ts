import type { PayoutBand, Ruleset } from './ruleset';
import { RulesetError } from './ruleset';

/**
 * Dividing the pot.
 *
 * Integer arithmetic that must balance exactly: every lamport paid in is paid
 * out or taken as the house cut, and never a lamport more. A split that loses
 * dust looks harmless until it is the reason a vault cannot be emptied, and a
 * split that creates dust is a transfer that fails.
 */

export interface Payout {
  readonly place: number;
  readonly lamports: bigint;
}

export interface Distribution {
  readonly pot: bigint;
  readonly house: bigint;
  readonly distributable: bigint;
  readonly payouts: readonly Payout[];
  /** The band chosen, for showing people what the next one pays. */
  readonly band: PayoutBand;
  readonly paidPlaces: number;
}

/** The band a pot of this size falls in. */
export function bandFor(ruleset: Ruleset, pot: bigint): PayoutBand {
  let chosen = ruleset.bands[0];
  for (const band of ruleset.bands) {
    if (pot >= band.minPotLamports) chosen = band;
  }
  if (!chosen) throw new RulesetError('the ruleset has no payout bands');
  return chosen;
}

/**
 * The house cut.
 *
 * Taken only above the threshold, and taken on the whole pot rather than on the
 * amount above it — the threshold decides whether there is a cut, not what it
 * applies to.
 *
 * `base` is what the cut applies to, which is not always the pot. A sponsored
 * prize is money somebody put up *as* the prize, and taking a tenth of it back
 * is both pointless — it is the sponsor paying themselves — and dishonest,
 * because the season advertises a prize larger than it pays. So the cut applies
 * to what the entrants paid in, and a season with no entry fee has no cut.
 */
export function houseCut(ruleset: Ruleset, pot: bigint, base = pot): bigint {
  if (pot <= ruleset.houseThreshold) return 0n;
  return (base * BigInt(ruleset.houseBps)) / 10_000n;
}

export function distribute(
  ruleset: Ruleset,
  pot: bigint,
  entrants: number,
  options: { readonly houseBaseLamports?: bigint } = {},
): Distribution {
  if (pot < 0n) throw new RulesetError('a pot cannot be negative');

  const band = bandFor(ruleset, pot);

  if (entrants <= 0 || pot === 0n) {
    // No entrants means no pot and no payout. The season closes empty rather
    // than paying somebody who was not there.
    return { pot, house: 0n, distributable: 0n, payouts: [], band, paidPlaces: 0 };
  }

  const house = houseCut(ruleset, pot, options.houseBaseLamports ?? pot);
  const distributable = pot - house;

  // Fewer entrants than the band pays places for. The shares are renormalized
  // over the places that exist rather than the rest being stranded in a vault
  // nobody can empty.
  const paidPlaces = Math.min(band.sharesBps.length, entrants);
  const shares = band.sharesBps.slice(0, paidPlaces);
  const shareTotal = shares.reduce((sum, share) => sum + share, 0);

  const payouts: Payout[] = [];
  let assigned = 0n;
  for (let index = 0; index < paidPlaces; index += 1) {
    const amount = (distributable * BigInt(shares[index]!)) / BigInt(shareTotal);
    payouts.push({ place: index + 1, lamports: amount });
    assigned += amount;
  }

  // Every share was floored, so there is at most a few lamports left. It goes
  // to first place: the alternative is leaving it in the vault forever, and
  // spreading it would need another rule to decide where it stops.
  const remainder = distributable - assigned;
  if (remainder > 0n && payouts[0]) {
    payouts[0] = { place: 1, lamports: payouts[0].lamports + remainder };
  }

  return { pot, house, distributable, payouts, band, paidPlaces };
}

/** What the pot has to reach before another place starts being paid. */
export function nextBand(ruleset: Ruleset, pot: bigint): PayoutBand | null {
  return ruleset.bands.find((band) => band.minPotLamports > pot) ?? null;
}
