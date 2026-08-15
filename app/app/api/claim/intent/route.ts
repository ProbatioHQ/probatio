import { RpcClient } from '@probatio/pools';
import { fromHex } from '@probatio/commit';
import { claimData, seasonByOrdinal } from '@probatio/db';
import { claimPrizeMessage, refundEntryMessage } from '@probatio/vault';
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { rpcEndpoint } from '@/lib/env';
import { currentUser } from '@/lib/session';

/**
 * Build the transaction that pays a winner, or refunds a voided season.
 *
 * The prize is paid by the program from the vault, against the proof the season
 * published — so the message here is a request the wallet signs, and the chain,
 * not this server, decides whether it is owed. A finalized season builds a
 * claim; a voided one builds a refund. Nothing is recomputed: the result and
 * proof are the ones frozen at finalization.
 */

export async function POST(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'money');
  if (throttled.response) return throttled.response;

  const user = await currentUser();
  if (!user) return Response.json({ error: 'sign in to claim' }, { status: 401 });

  let body: { season?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: 'expected a JSON body' }, { status: 400 });
  }
  const ordinal = typeof body.season === 'number' ? body.season : NaN;
  if (!Number.isInteger(ordinal)) {
    return Response.json({ error: 'which season are you claiming?' }, { status: 400 });
  }

  const client = await db();
  const season = await seasonByOrdinal(client, ordinal);
  if (!season) return Response.json({ error: `no season with ordinal ${ordinal}` }, { status: 404 });

  const data = await claimData(client, { seasonId: season.id, trader: user.pubkey });
  if (!data) return Response.json({ error: 'you have no entry in that season' }, { status: 404 });
  if (!data.seasonOnchainPubkey) {
    return Response.json({ error: 'that season is not on chain' }, { status: 409 });
  }

  let blockhash: string;
  try {
    const rpc = new RpcClient({ endpoint: rpcEndpoint(), timeoutMs: 10_000 });
    blockhash = (await rpc.getLatestBlockhash()).blockhash;
  } catch {
    return Response.json({ error: 'could not reach the network. Try again.' }, { status: 502 });
  }

  if (data.voided) {
    if (data.refundedAt) return Response.json({ error: 'you have already been refunded' }, { status: 409 });
    if (data.claimedAt) return Response.json({ error: 'that entry was already claimed' }, { status: 409 });
    const message = refundEntryMessage({ payer: user.pubkey, trader: user.pubkey, ordinal, blockhash });
    return Response.json({ mode: 'refund', message, season: ordinal });
  }

  if (!data.resultsRoot) {
    return Response.json({ error: 'that season is not finalized yet' }, { status: 409 });
  }
  if (data.claimedAt) return Response.json({ error: 'you have already claimed' }, { status: 409 });
  if (
    data.rank === null ||
    data.startingBalance === null ||
    data.finalEquity === null ||
    data.returnBps === null ||
    data.tradeCount === null ||
    data.payoutLamports === null ||
    data.proof === null
  ) {
    return Response.json({ error: 'that entry was not finalized correctly' }, { status: 500 });
  }
  if (data.payoutLamports <= 0n) {
    return Response.json({ error: 'your rank did not win a prize' }, { status: 409 });
  }

  const proof = data.proof.map((step) => ({
    sibling: fromHex(step.sibling),
    siblingOnLeft: step.siblingOnLeft,
  }));
  const message = claimPrizeMessage({
    payer: user.pubkey,
    trader: user.pubkey,
    ordinal,
    blockhash,
    claim: {
      rank: data.rank,
      startingBalance: data.startingBalance,
      finalEquity: data.finalEquity,
      returnBps: data.returnBps,
      tradeCount: data.tradeCount,
      payoutLamports: data.payoutLamports,
    },
    proof,
  });

  return Response.json({
    mode: 'claim',
    message,
    payoutLamports: data.payoutLamports.toString(),
    rank: data.rank,
    season: ordinal,
  });
}
