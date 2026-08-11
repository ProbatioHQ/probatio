/**
 * Turning exact prices into readable ones.
 *
 * Everything upstream keeps prices as integers scaled by 1e18 — lamports per
 * token base unit — because that is the only form that survives arithmetic
 * intact. Charts take doubles, so the conversion happens here, once, at the
 * edge. Nothing converted by this file may ever go back into a calculation.
 */

/** Matches PRICE_SCALE in @probatio/candles. */
const PRICE_SCALE = 10n ** 18n;
const LAMPORTS_PER_SOL = 1_000_000_000;

export type PriceUnit = 'market-cap' | 'per-token';

/**
 * SOL per whole token.
 *
 * A live memecoin lands somewhere near 3e-8, which is technically correct and
 * almost unreadable — which is why market cap is the default below.
 */
export function solPerToken(scaledPrice: string, tokenDecimals: number): number {
  const lamportsPerBaseUnit = Number(BigInt(scaledPrice)) / Number(PRICE_SCALE);
  return (lamportsPerBaseUnit * 10 ** tokenDecimals) / LAMPORTS_PER_SOL;
}

/**
 * Market cap in SOL.
 *
 * The number people on pump.fun actually talk in. It is the price multiplied
 * by a fixed supply, so the chart's shape is identical either way — only the
 * axis changes, and this axis reads in tens rather than in scientific
 * notation.
 */
export function marketCapSol(
  scaledPrice: string,
  tokenDecimals: number,
  totalSupply: string,
): number {
  const supplyWholeTokens = Number(BigInt(totalSupply)) / 10 ** tokenDecimals;
  return solPerToken(scaledPrice, tokenDecimals) * supplyWholeTokens;
}

export function toDisplay(
  scaledPrice: string,
  unit: PriceUnit,
  tokenDecimals: number,
  totalSupply: string,
  /**
   * SOL in dollars, when it is known.
   *
   * A market cap in SOL is not the number anybody quotes. Everywhere a trader
   * looks — pump.fun, a screenshot, a chat — it is dollars, so a chart reading
   * "102" for a coin worth eight thousand dollars is not a smaller unit, it is
   * an unreadable one. Null leaves the figure in SOL, and the caller has to say
   * so rather than print a dollar sign over it.
   */
  solUsd?: number | null,
): number {
  if (unit !== 'market-cap') return solPerToken(scaledPrice, tokenDecimals);
  const sol = marketCapSol(scaledPrice, tokenDecimals, totalSupply);
  return solUsd && solUsd > 0 ? sol * solUsd : sol;
}

/**
 * How many decimal places the axis needs.
 *
 * A fixed precision is wrong in both directions here: two places turns an
 * entire memecoin chart into a flat line at zero, and twelve places makes a
 * graduated token unreadable. So it is chosen from the magnitude of what is
 * actually on screen.
 */
export function precisionFor(values: readonly number[]): number {
  const positive = values.filter((value) => value > 0);
  if (positive.length === 0) return 2;

  const smallest = Math.min(...positive);
  if (smallest >= 100) return 2;
  if (smallest >= 1) return 4;
  if (smallest >= 0.01) return 6;
  if (smallest >= 0.0001) return 8;
  return 12;
}

export function minMoveFor(precision: number): number {
  return 1 / 10 ** precision;
}

/** Compact SOL for a label. */
export function formatSol(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  if (value >= 1) return value.toFixed(2);
  if (value >= 0.001) return value.toFixed(5);
  return value.toExponential(3);
}
