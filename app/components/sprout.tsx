/**
 * The sprout that marks how old a launch is.
 *
 * Drawn rather than set as an emoji: an emoji is a different typeface on every
 * platform, cannot take the colour of the text beside it, and would be the one
 * thing on the page rendered by somebody else's font. Taking `currentColor`
 * matters here, because the mark turns green with the age it sits next to.
 *
 * Its own file so the token page can use it without pulling the entire launch
 * feed into that route's bundle.
 */
export function Sprout({ size = 11 }: { size?: number }) {
  return (
    <svg
      className="sprout"
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
    >
      {/* A stem, and a leaf either side of it. */}
      <path d="M7.4 14.6V8.2h1.2v6.4z" />
      <path d="M7.6 8.1C7.6 5.9 6 4.2 3.6 3.6c-.5-.1-.8.2-.7.7.5 2.3 2.2 3.9 4.4 3.9z" />
      <path d="M8.4 7.6c0-2.2 1.6-3.9 4-4.5.5-.1.8.2.7.7-.5 2.3-2.2 3.9-4.4 3.9z" />
    </svg>
  );
}

/**
 * How long ago something happened, in the shortest form that is still true.
 *
 * Shared with the feed so a token reads the same age in the list and on its own
 * page. Zero means the launch time is not known, which a token the feed never
 * indexed will have, and that shows nothing rather than counting from 1970.
 */
export function age(launchedAt: number, now: number): string {
  if (launchedAt <= 0) return '';
  /*
   * Both in milliseconds, then divided once.
   *
   * This subtracted a millisecond launch time from a seconds clock, which is
   * always a large negative and clamps to zero, so every token in the feed read
   * as nought seconds old however long it had existed.
   */
  const seconds = Math.max(0, Math.floor((now - launchedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

/** Under an hour reads green, older reads grey. */
export function freshAge(launchedAt: number, now: number): boolean {
  if (launchedAt <= 0) return false;
  // The same mixed units made this negative for everything, so every token in
  // the feed was painted as launched within the hour.
  return now - launchedAt < 3_600_000;
}
