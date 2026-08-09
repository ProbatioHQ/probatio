import { RpcClient } from '@probatio/pools';
import {
  buildPaymentMessageBase58,
  createIntent,
  DEFAULT_TTL_MS,
} from '@probatio/payments';
import { createPaymentIntent, hasEntered, openRankedSeason } from '@probatio/db';
import { db } from '@/lib/db';
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

export async function POST(): Promise<Response> {
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
