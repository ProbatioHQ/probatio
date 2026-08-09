/**
 * Free play is modelled as a season with ordinal -1: unranked, no entry cost,
 * no end date, resets by incrementing an account's generation rather than by
 * deleting anything.
 *
 * Treating it as a season rather than a special case keeps every query
 * downstream uniform — positions, trades, commits and reports all work the same
 * way whether or not anyone paid to be there.
 */
export const FREE_PLAY_ORDINAL = -1 as const;
