import { RpcClient } from '@probatio/pools';
import { claimData, markEntryClaimed, markEntryRefunded, seasonByOrdinal } from '@probatio/db';
import { PROGRAM_ID, decodeEntry, entryAddress } from '@probatio/vault';
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { rpcEndpoint } from '@/lib/env';
import { currentUser } from '@/lib/session';

/**
 * Confirm a claim or refund by reading the on-chain entry.
 *
 * The program marks an entry claimed once its prize or refund has been paid, so
 * reading that flag is the proof the money left the vault. Only then is the
 * entry recorded as settled here, which also guards it from being marked twice.
 */

const SIGNATURE_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

export async function POST(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'money');
  if (throttled.response) return throttled.response;

  const user = await currentUser();
  if (!user) return Response.json({ error: 'sign in to confirm' }, { status: 401 });

  let body: { season?: unknown; signature?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: 'expected a JSON body' }, { status: 400 });
  }
  const ordinal = typeof body.season === 'number' ? body.season : NaN;
  const signature = typeof body.signature === 'string' ? body.signature : '';
  if (!Number.isInteger(ordinal)) {
    return Response.json({ error: 'which season?' }, { status: 400 });
  }
  if (!SIGNATURE_PATTERN.test(signature)) {
    return Response.json({ error: 'that is not a transaction signature' }, { status: 400 });
  }

  const client = await db();
  const season = await seasonByOrdinal(client, ordinal);
  if (!season) return Response.json({ error: `no season with ordinal ${ordinal}` }, { status: 404 });

  const data = await claimData(client, { seasonId: season.id, trader: user.pubkey });
  if (!data || !data.seasonOnchainPubkey) {
    return Response.json({ error: 'you have no entry in that season' }, { status: 404 });
  }

  const entry = entryAddress(data.seasonOnchainPubkey, user.pubkey).address;
  let account;
  try {
    const rpc = new RpcClient({ endpoint: rpcEndpoint(), timeoutMs: 20_000 });
    account = await rpc.getAccount(entry);
  } catch {
    return Response.json({ error: 'could not reach the network. Try again.' }, { status: 502 });
  }

  if (!account || account.owner !== PROGRAM_ID) {
    return Response.json({ error: 'no entry account on chain' }, { status: 404 });
  }

  let decoded;
  try {
    decoded = decodeEntry(account.data);
  } catch {
    return Response.json({ error: 'that account is not an entry' }, { status: 400 });
  }

  if (!decoded.claimed) {
    // Not settled on chain yet. 202, because a claimer who just signed should
    // not be told it failed while it is still finalizing.
    return Response.json({ settled: false, failure: 'not_paid_yet' }, { status: 202 });
  }

  const now = Date.now();
  if (data.voided) {
    await markEntryRefunded(client, { seasonId: season.id, trader: user.pubkey, txSignature: signature, now });
    return Response.json({ settled: true, refunded: true, season: ordinal, signature });
  }
  await markEntryClaimed(client, { seasonId: season.id, trader: user.pubkey, txSignature: signature, now });
  return Response.json({ settled: true, claimed: true, season: ordinal, signature });
}
