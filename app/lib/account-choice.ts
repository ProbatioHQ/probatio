import 'server-only';
import { cookies } from 'next/headers';

/**
 * Which account a trader is trading, when they have two.
 *
 * Entering a ranked season used to move every trade onto it with no way back,
 * because the account was decided by circumstance rather than chosen. That is
 * right almost always, and wrong the moment somebody wants to try something on
 * free play without spending a season entry on finding out.
 *
 * The choice is a cookie rather than a column, because it belongs to the
 * browser somebody is sitting at rather than to the account: the same wallet on
 * a phone and a laptop can reasonably be doing different things, and nothing
 * about it needs to survive being wrong.
 *
 * Free is the default and the fallback. A choice of ranked is honoured only
 * when there is a ranked season to trade, so an expired one cannot strand
 * somebody on an account that no longer accepts trades.
 */

export type AccountMode = 'free' | 'ranked';

export const ACCOUNT_COOKIE = 'probatio.account';

/** What this browser last chose, or null if it never has. */
export async function accountChoice(): Promise<AccountMode | null> {
  const value = (await cookies()).get(ACCOUNT_COOKIE)?.value;
  return value === 'free' || value === 'ranked' ? value : null;
}
