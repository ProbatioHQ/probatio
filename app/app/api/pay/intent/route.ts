import { RpcClient } from '@probatio/pools';
import {
  buildPaymentMessageBase58,
  createIntent,
  DEFAULT_TTL_MS,
} from '@probatio/payments';
import {
  createPaymentIntent,
  entriesFromFunder,
  hasEntered,
  openRankedSeason,
  recordIntentEvidence,
} from '@probatio/db';
import { DEFAULT_RULES, assess, explainRefusal, gatherEvidence } from '@probatio/sybil';
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { rpcEndpoint, treasuryAddress } from '@/lib/env';
import { currentUser } from '@/lib/session';

/**
 * Ask the user to pay.
 *
 * Builds the transaction the wallet will sign. Nothing here credits anything
 * and nothing here is trusted later — the returned message is a request, and
 * only the chain can answer it.
 *
 * The amount comes from the season row rather than from configuration or from
 * the client. The price of entry is part of the season's recorded ruleset, and
 * a season whose entry cost could be changed by a request is not a season with
 * a ruleset.
 */

export async function POST(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'money');
  if (throttled.response) return throttled.response;

  const user = await currentUser();
  if (!user) return Response.json({ error: 'sign in to enter' }, { status: 401 });

  const treasury = treasuryAddress();
  if (!treasury) {
    return Response.json({ error: 'entry is not open on this server' }, { status: 503 });
  }

  const client = await db();
  const now = Date.now();

  const season = await openRankedSeason(client, now);
  if (!season) {
    return Response.json(
      { error: 'no season is accepting entries right now.' },
      { status: 409 },
    );
  }

  if (await hasEntered(client, season.id, user.pubkey)) {
    // Cheaper to refuse here than to let them pay and then discover it.
    return Response.json(
      { error: 'you are already entered in this season.', seasonId: season.id },
      { status: 409 },
    );
  }

  // Read the wallet before asking for money. An entry that would be refused
  // should be refused before it is paid for, not after — and the evidence is
  // kept either way, because the attack worth defending against is not winning
  // this pot, it is presenting a survivor wallet as a track record later.
  let evidence;
  try {
    const rpc = new RpcClient({ endpoint: rpcEndpoint(), timeoutMs: 20_000, minIntervalMs: 60 });
    evidence = await gatherEvidence(rpc, user.pubkey, now);
  } catch {
    return Response.json({ error: 'could not reach the network. Try again.' }, { status: 502 });
  }

  const siblings =
    evidence.funder === null
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
    recipient: treasury,
    lamports: BigInt(season.entryCost),
    purpose: 'season_entry',
    seasonOrdinal: season.ordinal,
    now,
  });

  // A blockhash expires in around a minute. Fetched last so the user has as
  // much of that window as possible to approve the prompt.
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
      recipient: treasury,
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
    recipient: treasury,
    season: { id: season.id, ordinal: season.ordinal, name: season.name },
    expiresAt: intent.expiresAt,
    ttlMs: DEFAULT_TTL_MS,
  });
}
