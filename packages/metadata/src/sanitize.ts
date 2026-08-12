/**
 * Stripping characters that are invisible but not harmless.
 *
 * C0 and C1 control codes, the zero-width family, and the bidirectional
 * overrides. The last let a token render its name right-to-left so it displays
 * as something other than what it is. Token names appear on the leaderboard and
 * in the positions panel, next to money, so both the on-chain and the off-chain
 * name are cleaned at their source rather than escaped somewhere downstream and
 * hoped about.
 *
 * Expressed as code-point ranges rather than a regex literal so the source file
 * itself carries no invisible characters.
 */
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x001f], // C0 controls
  [0x007f, 0x009f], // DEL and C1 controls
  [0x200b, 0x200f], // zero-width space/joiner and LRM/RLM
  [0x2028, 0x2029], // line and paragraph separators
  [0x202a, 0x202e], // bidirectional embedding and overrides
  [0x2066, 0x2069], // bidirectional isolates
  [0xfeff, 0xfeff], // zero-width no-break space / BOM
];

function isInvisible(codePoint: number): boolean {
  return INVISIBLE_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high);
}

/** Remove the invisible characters and trim. Never throws. */
export function stripInvisible(value: string): string {
  let out = '';
  for (const char of value) {
    if (!isInvisible(char.codePointAt(0) ?? 0)) out += char;
  }
  return out.trim();
}
