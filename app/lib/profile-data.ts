import 'server-only';
import { activeName as readName } from '@probatio/db';
import { shortAddress } from '@probatio/profile';
import { db } from './db';

/** The display name for a wallet, or null. Safe on an address that has none. */
export async function activeName(pubkey: string): Promise<string | null> {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(pubkey)) return null;
  try {
    return await readName(await db(), pubkey);
  } catch {
    // A profile page must render for an address that has never been seen.
    return null;
  }
}

export function shortAddressSafe(pubkey: string): string {
  return shortAddress(pubkey);
}
