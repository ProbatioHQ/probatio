/**
 * The fill engine version.
 *
 * This number goes into every merkle leaf committed on chain (step 14). It is
 * what lets anyone re-check a trade against the exact rules that were in force
 * when it happened, instead of whatever the engine does today.
 *
 * Bump this whenever a change would produce a different fill for the same
 * inputs — new curve math, a different fee model, a changed rounding
 * direction, an altered latency rule. Do not bump it for refactors that leave
 * every output identical.
 *
 * Never reuse a number. A version, once committed to chain, is permanent.
 */
export const ENGINE_VERSION = 1 as const;

/**
 * Human-readable log of what each version means. Append only — editing a past
 * entry rewrites history that other people can verify against.
 */
export const ENGINE_VERSION_LOG: Readonly<Record<number, string>> = Object.freeze({
  1: 'Initial engine. Constant-product curve math, fixed-point integer amounts.',
});
