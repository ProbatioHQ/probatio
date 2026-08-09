import { RpcClient } from '@probatio/pools';
import { explainFailure, verifyPayment } from '@probatio/payments';
import { getPaymentIntent, settlePayment } from '@probatio/db';
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { rpcEndpoint } from '@/lib/env';
import { currentUser } from '@/lib/session';

/**
 * Read what actually happened.
 *
 * The client sends a signature. That is a claim, not evidence — the
 * transaction is fetched from the chain and checked against the intent the
 * server recorded, and only then is anybody credited.
 *
 * Finalized, not confirmed. A confirmed transaction can still be rolled back,
 * and an entry granted against one that later vanishes is an entry that cannot
 * be taken away gracefully.
 */

const SIGNATURE_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

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
    // 202 for a transaction that simply has not finalized yet: nothing is
    // wrong, the answer is not in yet, and telling a user who just paid that
    // their payment failed would be both wrong and alarming.
    const notYet = verification.failure === 'not_found';
    return Response.json(
      { error: explainFailure(verification.failure!), failure: verification.failure, settled: false },
      { status: notYet ? 202 : 400 },
    );
  }

  const settlement = await settlePayment(client, {
    reference: intent.reference,
    txSignature: signature,
    userPubkey: user.pubkey,
    seasonId: intent.seasonId,
    purpose: intent.purpose,
    amount: intent.amount,
    now: Date.now(),
  });

  return Response.json({
    settled: true,
    // False means it was already credited, which is a success, not an error.
    fresh: settlement.fresh,
    entered: settlement.entryId !== null,
    seasonId: intent.seasonId,
    signature,
  });
}
