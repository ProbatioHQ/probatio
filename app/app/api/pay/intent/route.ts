import { RpcClient } from '@probatio/pools';
import { buildPaymentMessageBase58, createIntent, DEFAULT_TTL_MS } from '@probatio/payments';
import {
  createPaymentIntent,
  entriesFromFunder,
  hasEntered,
  openRankedSeason,
  recordIntentEvidence,
} from '@probatio/db';
import { chargeRefusal, explainChargeRefusal } from '@probatio/seasons';
import { DEFAULT_RULES, assess, explainRefusal, gatherEvidence } from '@probatio/sybil';
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { rpcEndpoint } from '@/lib/env';
import { prizeAddress } from '@/lib/prize';
import { currentUser } from '@/lib/session';

/**
 * Ask the trader to pay their entry into the prize pot.
 *
 * The transaction is a plain transfer to the prize wallet. When the season
 * ends, the winners are paid out of that wallet automatically, so the pot is
 * held and distributed by the operator rather than a program. Nothing here is
 * trusted later: the returned message is a request, and only the chain can
 * confirm the transfer landed.
 *
 * The amount is the season's recorded entry cost, not anything the client sends.
 */

export async function POST(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'money');
  if (throttled.response) return throttled.response;

  const user = await currentUser();
  if (!user) return Response.json({ error: 'sign in to enter' }, { status: 401 });

  const client = await db();
  const now = Date.now();

  const season = await openRankedSeason(client, now);
  if (!season) {
    return Response.json({ error: 'no season is accepting entries right now.' }, { status: 409 });
  }

  // A paid season only opens if a winner could actually be paid.
  const refusal = chargeRefusal({ entryCost: BigInt(season.entryCost) });
  if (refusal) {
    return Response.json({ error: explainChargeRefusal(refusal), refusal }, { status: 503 });
  }

  const prize = prizeAddress();
  if (!prize) {
    return Response.json(
      { error: 'entry is not open on this server: no prize wallet is configured.' },
      { status: 503 },
    );
  }

  if (await hasEntered(client, season.id, user.pubkey)) {
    return Response.json(
      { error: 'you are already entered in this season.', seasonId: season.id },
      { status: 409 },
    );
  }

  // Read the wallet before asking for money. An entry that would be refused is
  // refused before it is paid for, and the evidence is kept either way: the
  // attack worth defending against is presenting a survivor wallet as a track
  // record later, not winning this one pot.
  let evidence;
  try {
    const rpc = new RpcClient({ endpoint: rpcEndpoint(), timeoutMs: 20_000, minIntervalMs: 60 });
    evidence = await gatherEvidence(rpc, user.pubkey, now);
  } catch {
    return Response.json({ error: 'could not reach the network. Try again.' }, { status: 502 });
  }

  const siblings =
    evidence.funder === null || evidence.funderIsShared
      ? 0
      : await entriesFromFunder(client, season.id, evidence.funder, now);

  const verdict = assess({ evidence, siblingEntries: siblings, now });
  if (!verdict.allowed) {
    return Response.json(
      { error: explainRefusal(verdict.refusal!, DEFAULT_RULES), refusal: verdict.refusal },
      { status: 403 },
    );
  }

  const intent = createIntent({
    payer: user.pubkey,
    recipient: prize,
    lamports: BigInt(season.entryCost),
    purpose: 'season_entry',
    seasonOrdinal: season.ordinal,
    now,
  });

  // A blockhash expires in about a minute, so it is fetched last: the trader
  // gets as much of that window as possible to approve the prompt.
  let blockhash: string;
  try {
    const rpc = new RpcClient({ endpoint: rpcEndpoint(), timeoutMs: 10_000 });
    blockhash = (await rpc.getLatestBlockhash()).blockhash;
  } catch {
    return Response.json({ error: 'could not reach the network. Try again.' }, { status: 502 });
  }

  await createPaymentIntent(
    client,
    {
      reference: intent.reference,
      userPubkey: user.pubkey,
      seasonId: season.id,
      purpose: 'season_entry',
      recipient: prize,
      amount: season.entryCost,
      expiresAt: intent.expiresAt,
    },
    now,
  );

  await recordIntentEvidence(client, intent.reference, {
    funder: evidence.funder,
    walletFirstSeenAt: evidence.firstSeenAt,
    walletSignatureCount: evidence.signatureCount,
    flags: verdict.flags,
  });

  return Response.json({
    reference: intent.reference,
    message: buildPaymentMessageBase58(intent, blockhash),
    lamports: season.entryCost,
    recipient: prize,
    season: { id: season.id, ordinal: season.ordinal, name: season.name },
    expiresAt: intent.expiresAt,
    ttlMs: DEFAULT_TTL_MS,
  });
}
