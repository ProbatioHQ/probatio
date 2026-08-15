import { RpcClient } from '@probatio/pools';
import { createIntent, DEFAULT_TTL_MS } from '@probatio/payments';
import {
  createPaymentIntent,
  entriesFromFunder,
  hasEntered,
  openRankedSeason,
  recordIntentEvidence,
  seasonOnchainPubkey,
} from '@probatio/db';
import { chargeRefusal, explainChargeRefusal } from '@probatio/seasons';
import { DEFAULT_RULES, assess, explainRefusal, gatherEvidence } from '@probatio/sybil';
import { recordEntryMessage, vaultAddress } from '@probatio/vault';
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { rpcEndpoint } from '@/lib/env';
import { currentUser } from '@/lib/session';

/**
 * Ask the trader to pay their entry into the season vault.
 *
 * The transaction the wallet is asked to sign is `record_entry`: it moves the
 * fee from the trader into the season's on-chain vault and creates their entry.
 * The money never passes through a treasury we hold, and it can be paid back or
 * paid out only by the program, against a signed entry. Nothing here is trusted
 * later — the returned message is a request, and only the chain can answer it.
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

  /*
   * The payout gate, asked where the money is taken. Until the whole path is
   * proven end to end, a paid season is refused here rather than taking a fee
   * it cannot yet return. A free season is never refused.
   */
  const refusal = chargeRefusal({ entryCost: BigInt(season.entryCost) });
  if (refusal) {
    return Response.json({ error: explainChargeRefusal(refusal), refusal }, { status: 503 });
  }

  // The season has to exist on chain: record_entry pays into its vault, and
  // there is no vault until the lifecycle worker has created it.
  const onchain = await seasonOnchainPubkey(client, season.id);
  if (!onchain) {
    return Response.json(
      { error: 'entry is not open yet: the season is not on chain.' },
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
  // should be refused before it is paid for, and the evidence is kept either
  // way: the attack worth defending against is presenting a survivor wallet as
  // a track record later, not winning this one pot.
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

  // A blockhash expires in about a minute, so it is fetched last: the trader
  // gets as much of that window as possible to approve the prompt.
  let blockhash: string;
  try {
    const rpc = new RpcClient({ endpoint: rpcEndpoint(), timeoutMs: 10_000 });
    blockhash = (await rpc.getLatestBlockhash()).blockhash;
  } catch {
    return Response.json({ error: 'could not reach the network. Try again.' }, { status: 502 });
  }

  // The vault is where the fee lands; it is the intent's recipient only as a
  // record. Confirmation reads the entry the chain holds, not this address.
  const vault = vaultAddress(onchain).address;
  const intent = createIntent({
    payer: user.pubkey,
    recipient: vault,
    lamports: BigInt(season.entryCost),
    purpose: 'season_entry',
    seasonOrdinal: season.ordinal,
    now,
  });
  const message = recordEntryMessage({ trader: user.pubkey, ordinal: season.ordinal, blockhash });

  await createPaymentIntent(
    client,
    {
      reference: intent.reference,
      userPubkey: user.pubkey,
      seasonId: season.id,
      purpose: 'season_entry',
      recipient: vault,
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
    message,
    lamports: season.entryCost,
    recipient: vault,
    season: { id: season.id, ordinal: season.ordinal, name: season.name },
    expiresAt: intent.expiresAt,
    ttlMs: DEFAULT_TTL_MS,
  });
}
