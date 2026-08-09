/**
 * Display names.
 *
 * A name sits next to a leaderboard place and a payout, which makes it an
 * impersonation surface rather than a decoration. The rules are correspondingly
 * blunt.
 *
 * ASCII only. Not because other alphabets do not matter — they plainly do — but
 * because the alternative is defending against homoglyphs across the whole of
 * Unicode, where a Cyrillic а and a Latin a are different characters that
 * render identically, and losing that fight once means somebody is impersonated
 * beside a prize. A wallet address is the identity here; the name is a
 * convenience, and a convenience is the right thing to make narrow.
 *
 * Nothing here touches the record. Names are not committed on chain and are not
 * part of any hash — the chain commits to public keys. A name can be taken away
 * without altering a single result, which is exactly why moderating them is
 * safe to do at all.
 */

export class NameError extends Error {
  readonly reason: NameRejection;

  constructor(message: string, reason: NameRejection) {
    super(message);
    this.name = 'NameError';
    this.reason = reason;
  }
}

export type NameRejection =
  | 'too_short'
  | 'too_long'
  | 'bad_characters'
  | 'bad_start'
  | 'reserved'
  | 'blocked';

export const MIN_LENGTH = 3;
export const MAX_LENGTH = 20;

/** Letters, digits, underscore and hyphen. Nothing else, ever. */
const ALLOWED = /^[A-Za-z0-9_-]+$/;

/**
 * Names nobody may hold.
 *
 * Compared after confusable folding, so `Pr0batio` and `PROBAT1O` are caught
 * by the same entry.
 */
const RESERVED = [
  'probatio',
  'admin',
  'administrator',
  'official',
  'support',
  'team',
  'staff',
  'mod',
  'moderator',
  'system',
  'verified',
  'root',
  'owner',
  'treasury',
  'null',
  'undefined',
  'anonymous',
  'deleted',
];

/**
 * Fold characters that render alike.
 *
 * Used for uniqueness and for reserved-word matching, never for display. Two
 * names that a person cannot tell apart at a glance are the same name for the
 * purpose of impersonation, whatever a byte comparison says.
 */
export function foldConfusables(name: string): string {
  return (
    name
      .toLowerCase()
      // Whole families collapse to one member, not pairwise. Folding 1 to l
      // while leaving i alone leaves admin and admln distinct, which is how a
      // reserved name gets taken by something nobody can tell apart from it.
      .replace(/[1il!|]/g, 'i')
      .replace(/[0o]/g, 'o')
      .replace(/[3e]/g, 'e')
      .replace(/[4a]/g, 'a')
      .replace(/[5s]/g, 's')
      .replace(/[7t]/g, 't')
      .replace(/[8b]/g, 'b')
      .replace(/[2z]/g, 'z')
      .replace(/[6g]/g, 'g')
      .replace(/[9g]/g, 'g')
      .replace(/[_-]/g, '')
  );
}

/** The key a name is stored unique on. */
export function nameKey(name: string): string {
  return foldConfusables(name);
}

export interface NameRules {
  /** Substrings refused anywhere in a name, matched after folding. */
  readonly blocked: readonly string[];
}

export const DEFAULT_NAME_RULES: NameRules = { blocked: [] };

export function validateName(raw: string, rules: NameRules = DEFAULT_NAME_RULES): string {
  const name = raw.trim();

  if (name.length < MIN_LENGTH) {
    throw new NameError(`names are at least ${MIN_LENGTH} characters`, 'too_short');
  }
  if (name.length > MAX_LENGTH) {
    throw new NameError(`names are at most ${MAX_LENGTH} characters`, 'too_long');
  }
  if (!ALLOWED.test(name)) {
    throw new NameError('names use letters, digits, underscore and hyphen only', 'bad_characters');
  }
  // A leading separator lets a name sort to the top of a list it did not earn.
  if (/^[_-]|[_-]$/.test(name)) {
    throw new NameError('names start and end with a letter or digit', 'bad_start');
  }

  const folded = foldConfusables(name);
  // The reserved words are folded too. Comparing a folded name against raw
  // entries means `official` folds to something its own entry no longer
  // matches, and the list quietly stops protecting the words on it.
  if (RESERVED.some((reserved) => foldConfusables(reserved) === folded)) {
    throw new NameError('that name is reserved', 'reserved');
  }
  for (const blocked of rules.blocked) {
    if (folded.includes(foldConfusables(blocked))) {
      throw new NameError('that name is not available', 'blocked');
    }
  }

  return name;
}

/** Whether a name is usable, without throwing. */
export function checkName(
  raw: string,
  rules: NameRules = DEFAULT_NAME_RULES,
): { ok: true; name: string; key: string } | { ok: false; reason: NameRejection; detail: string } {
  try {
    const name = validateName(raw, rules);
    return { ok: true, name, key: nameKey(name) };
  } catch (error) {
    if (error instanceof NameError) {
      return { ok: false, reason: error.reason, detail: error.message };
    }
    throw error;
  }
}

/** How a trader is shown when they have no name. */
export function shortAddress(pubkey: string): string {
  return pubkey.length <= 9 ? pubkey : `${pubkey.slice(0, 4)}…${pubkey.slice(-4)}`;
}

/**
 * What to show for a trader.
 *
 * The address is always available and always correct; the name is decoration on
 * top of it. A cleared name falls back rather than leaving a blank row, because
 * a moderated name must not also erase the result it was attached to.
 */
export function displayName(pubkey: string, name: string | null): string {
  return name ?? shortAddress(pubkey);
}
