/**
 * Formatting a season's clock, in one place so two pages cannot disagree.
 *
 * The front page and the season page both show how long until entry closes, and
 * they drifted: the front page froze a coarse snapshot the server sent once
 * ("3h") while the season page ticked a live countdown ("2h 45m 12s"). Same
 * season, two different numbers, which is exactly the thing a countdown must not
 * do. The rule lives here now, and both call it.
 */

/**
 * A duration as a countdown string.
 *
 * Returns "closed" at or below zero. Above it, the two largest units: days and
 * hours far out, hours and minutes within a day, minutes and seconds within an
 * hour, so the last minute actually ticks.
 */
export function countdown(ms: number): string {
  if (ms <= 0) return 'closed';
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1_000);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}
