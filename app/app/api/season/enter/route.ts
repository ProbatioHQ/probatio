import { RpcClient } from '@probatio/pools';
import {
  enterFreeSeason,
  entriesFromFunder,
  hasEntered,
  openRankedSeason,
} from '@probatio/db';
import { DEFAULT_RULES, assess, explainRefusal, gatherEvidence } from '@probatio/sybil';
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';
import { rpcEndpoint } from '@/lib/env';
import { currentUser } from '@/lib/session';

/**
 * Enter a season that costs nothing.
 *
 * A free season has no payment to build, sign or verify — but there is still a
 * wallet to look at, and with no entry fee the funding-source limit is the only
 * thing standing between one person and fifty entries. That is why the sybil
 * check below is heavier here than on the paid path, not lighter.
 *
 * Free seasons are now a choice rather than the only safe option. They used to
 * be forced, because the void policy promises full refunds and the program had
 * no instruction that could pay one; `refund_entry` closed that, and the
 * running season charges. This route is for the ones that do not.
 *
 * Refuses outright on a paid season. A route that quietly let somebody in
 * without paying would be a far worse bug than one that refuses.
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

  if (BigInt(season.entryCost) > 0n) {
    return Response.json(
      { error: 'this season has an entry fee', paid: true, entryCost: season.entryCost },
      { status: 409 },
    );
  }

  if (await hasEntered(client, season.id, user.pubkey)) {
    return Response.json({ entered: true, alreadyEntered: true, seasonId: season.id });
  }

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

  const result = await enterFreeSeason(client, {
    seasonId: season.id,
    userPubkey: user.pubkey,
    evidence: {
      funder: evidence.funder,
      walletFirstSeenAt: evidence.firstSeenAt,
      walletSignatureCount: evidence.signatureCount,
      flags: verdict.flags,
    },
    now,
  });

  return Response.json({
    entered: result.entryId !== null,
    alreadyEntered: result.alreadyEntered,
    seasonId: season.id,
    seasonName: season.name,
  });
}
