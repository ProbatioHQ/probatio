import { RpcClient } from '@probatio/pools';
import { PRACTICE_TIERS, creditFor, explainFailure, verifyPayment } from '@probatio/payments';
import {
  getPaymentIntent,
  intentEvidence,
  recordOnChainEntry,
  seasonOnchainPubkey,
  settlePayment,
  type PaymentIntentRow,
} from '@probatio/db';
import { PROGRAM_ID, decodeEntry, entryAddress } from '@probatio/vault';
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { rpcEndpoint } from '@/lib/env';
import { currentUser } from '@/lib/session';

/**
 * Read what actually happened.
 *
 * The client sends a signature. That is a claim, not evidence. For an entry the
 * server reads the on-chain entry the transaction was supposed to create and
 * checks it names this trader, this season, and the amount asked for — the
 * entry exists only if `record_entry` succeeded, so its presence is the proof.
 * For a store purchase the transfer itself is fetched and checked. Only then is
 * anybody credited.
 */

const SIGNATURE_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
type Client = Awaited<ReturnType<typeof db>>;

export async function POST(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'money');
  if (throttled.response) return throttled.response;

  const user = await currentUser();
  if (!user) return Response.json({ error: 'sign in to confirm a payment' }, { status: 401 });

  let body: { reference?: unknown; signature?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: 'expected a JSON body' }, { status: 400 });
  }

  const reference = typeof body.reference === 'string' ? body.reference : '';
  const signature = typeof body.signature === 'string' ? body.signature : '';

  if (!SIGNATURE_PATTERN.test(signature)) {
    return Response.json({ error: 'that is not a transaction signature' }, { status: 400 });
  }

  const client = await db();
  const intent = await getPaymentIntent(client, reference);
  if (!intent) {
    return Response.json({ error: 'no payment was requested with that reference' }, { status: 404 });
  }

  // The intent belongs to whoever it was issued to. Without this, one user
  // could settle another's intent with a transaction they happened to see.
  if (intent.userPubkey !== user.pubkey) {
    return Response.json({ error: 'that payment was requested by a different wallet' }, { status: 403 });
  }

  if (intent.purpose === 'season_entry') {
    return confirmEntry(client, intent, signature);
  }
  return confirmTransfer(client, intent, user.pubkey, signature);
}

/**
 * Confirm a season entry by reading the on-chain entry it created.
 *
 * The entry account is derived from the season and the trader, so it cannot be
 * pointed elsewhere; it exists only if the fee was paid into the vault. Reading
 * it, and checking the season, trader and amount, is the whole verification.
 */
async function confirmEntry(
  client: Client,
  intent: PaymentIntentRow,
  signature: string,
): Promise<Response> {
  if (intent.seasonId === null) {
    return Response.json({ error: 'that entry intent is malformed' }, { status: 400 });
  }
  const seasonPubkey = await seasonOnchainPubkey(client, intent.seasonId);
  if (!seasonPubkey) {
    return Response.json({ error: 'that season is not on chain' }, { status: 409 });
  }

  const entry = entryAddress(seasonPubkey, intent.userPubkey).address;

  let account;
  try {
    const rpc = new RpcClient({ endpoint: rpcEndpoint(), timeoutMs: 20_000 });
    account = await rpc.getAccount(entry);
  } catch {
    return Response.json({ error: 'could not reach the network. Try again.' }, { status: 502 });
  }

  if (!account) {
    // Not an error: the entry has not finalized yet. 202 so a trader who just
    // paid is not told their payment failed.
    return Response.json({ settled: false, failure: 'not_found' }, { status: 202 });
  }
  if (account.owner !== PROGRAM_ID) {
    return Response.json({ error: 'that account is not owned by the program' }, { status: 400 });
  }

  let decoded;
  try {
    decoded = decodeEntry(account.data);
  } catch {
    return Response.json({ error: 'that account is not an entry' }, { status: 400 });
  }

  const expected = BigInt(intent.amount);
  if (decoded.season !== seasonPubkey || decoded.trader !== intent.userPubkey || decoded.paid !== expected) {
    return Response.json({ error: 'that entry does not match what was asked for' }, { status: 400 });
  }

  const evidence = (await intentEvidence(client, intent.reference)) ?? {
    funder: null,
    walletFirstSeenAt: null,
    walletSignatureCount: null,
    flags: [],
  };

  await recordOnChainEntry(client, {
    seasonId: intent.seasonId,
    userPubkey: intent.userPubkey,
    onchainEntryPubkey: entry,
    entryTxSignature: signature,
    paid: expected,
    evidence,
    now: Date.now(),
  });

  return Response.json({ settled: true, entered: true, seasonId: intent.seasonId, signature });
}

/** Confirm a treasury transfer (a store purchase), the way it always worked. */
async function confirmTransfer(
  client: Client,
  intent: PaymentIntentRow,
  userPubkey: string,
  signature: string,
): Promise<Response> {
  let transaction;
  try {
    const rpc = new RpcClient({ endpoint: rpcEndpoint(), timeoutMs: 20_000 });
    transaction = await rpc.getTransaction(signature, 'finalized');
  } catch {
    return Response.json({ error: 'could not reach the network. Try again.' }, { status: 502 });
  }

  const verification = verifyPayment(transaction, {
    payer: intent.userPubkey,
    recipient: intent.recipient,
    lamports: BigInt(intent.amount),
    reference: intent.reference,
  });

  if (!verification.ok) {
    const notYet = verification.failure === 'not_found';
    return Response.json(
      { error: explainFailure(verification.failure!), failure: verification.failure, settled: false },
      { status: notYet ? 202 : 400 },
    );
  }

  const tier =
    intent.purpose === 'practice_sol'
      ? PRACTICE_TIERS.find((entry) => entry.priceLamports === BigInt(intent.amount))
      : undefined;

  if (intent.purpose === 'practice_sol' && !tier) {
    return Response.json(
      { error: 'that purchase is no longer available at the price it was quoted.' },
      { status: 409 },
    );
  }

  const settlement = await settlePayment(client, {
    reference: intent.reference,
    txSignature: signature,
    userPubkey,
    seasonId: intent.seasonId,
    purpose: intent.purpose,
    amount: intent.amount,
    ...(tier ? { amountCredited: creditFor(tier).toString() } : {}),
    now: Date.now(),
  });

  return Response.json({
    settled: true,
    ...(tier ? { credited: creditFor(tier).toString(), sol: tier.sol } : {}),
    fresh: settlement.fresh,
    entered: settlement.entryId !== null,
    seasonId: intent.seasonId,
    signature,
  });
}
