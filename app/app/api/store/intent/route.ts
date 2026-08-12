import { RpcClient } from '@probatio/pools';
import {
  DEFAULT_TTL_MS,
  PRACTICE_TIERS,
  buildPaymentMessageBase58,
  createIntent,
  creditFor,
  tierFor,
} from '@probatio/payments';
import { createPaymentIntent, ensureAccount, ensureFreePlaySeason } from '@probatio/db';
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { rpcEndpoint, treasuryAddress } from '@/lib/env';
import { currentUser } from '@/lib/session';

/**
 * Ask to buy practice balance.
 *
 * The same shape as an entry payment and deliberately a separate route: entry
 * has a season, a sybil check and a leaderboard behind it, and none of that
 * applies to buying play money. Sharing the route would mean one function
 * holding two sets of rules and the wrong ones being applied by accident.
 *
 * What is not here is any check on how many of these somebody buys, because
 * there is nothing to defend. It credits a free-play account, free play is not
 * ranked, and a hundred practice accounts win nobody anything.
 */

export async function POST(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'money');
  if (throttled.response) return throttled.response;

  const user = await currentUser();
  if (!user) return Response.json({ error: 'sign in to buy practice balance' }, { status: 401 });

  let body: { sol?: unknown };
  try {
    body = (await request.json()) as { sol?: unknown };
  } catch {
    return Response.json({ error: 'expected a JSON body' }, { status: 400 });
  }

  const tier = typeof body.sol === 'number' ? tierFor(body.sol) : null;
  if (!tier) {
    return Response.json(
      {
        error: 'that is not a size we sell',
        sizes: PRACTICE_TIERS.map((entry) => entry.sol),
      },
      { status: 400 },
    );
  }

  const treasury = treasuryAddress();
  if (!treasury) {
    return Response.json(
      { error: 'the store is closed on this server: no payment address is configured.' },
      { status: 503 },
    );
  }

  const client = await db();
  const now = Date.now();

  // The credit lands in the free-play account, so both the season AND the
  // account have to exist before the payment does. Ensuring only the season
  // left a first-time buyer, whose very first action was the store, with a
  // verified on-chain payment and a settle that threw "no account to credit":
  // a 500 that repeated forever because nothing in this path created the row.
  const freePlayId = await ensureFreePlaySeason(client, now);
  await ensureAccount(client, freePlayId, user.pubkey, now);

  const intent = createIntent({
    payer: user.pubkey,
    recipient: treasury,
    lamports: tier.priceLamports,
    purpose: 'practice_sol',
    now,
  });

  // A blockhash expires in about a minute, so it is fetched last: the buyer
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
      seasonId: null,
      purpose: 'practice_sol',
      recipient: treasury,
      amount: tier.priceLamports.toString(),
      expiresAt: intent.expiresAt,
    },
    now,
  );

  return Response.json({
    reference: intent.reference,
    message: buildPaymentMessageBase58(intent, blockhash),
    lamports: tier.priceLamports.toString(),
    credits: creditFor(tier).toString(),
    sol: tier.sol,
    recipient: treasury,
    expiresAt: intent.expiresAt,
    ttlMs: DEFAULT_TTL_MS,
  });
}
