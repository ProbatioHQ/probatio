import {
  DUEL_WINDOWS,
  DuelError,
  acceptDuel,
  accountFor,
  closeOffer,
  currentRankedSeason,
  duelById,
  duelRecord,
  duelsFor,
  ensureAccount,
  hasEntered,
  liveDuelFor,
  namesFor,
  pubkeyForName,
  recentDuels,
  returnBps,
  type DuelRow,
} from '@probatio/db';
import { checkName, DEFAULT_NAME_RULES, displayName } from '@probatio/profile';
import { decodePubkey } from '@probatio/auth';
import { db } from '@/lib/db';
import { equityOf } from '@/lib/duel-equity';
import { rateLimit } from '@/lib/rate-limit';
import { seasonTradingOpen, whyNotOpen } from '@/lib/season-open';
import { currentUser } from '@/lib/session';

/**
 * Offering, accepting and reading duels.
 *
 * A duel is scored off the account its two traders already entered the season
 * with, so nothing here creates an account, moves a balance or places an order.
 * What it writes is an agreement: who, against whom, over what window. The
 * trading is the ordinary trading both were doing anyway.
 */

/** Live returns are read every few seconds by an open page, so they are cheap. */
export const dynamic = 'force-dynamic';

interface Side {
  readonly pubkey: string;
  readonly name: string;
  readonly bps: number | null;
}

/**
 * A duel as the page needs it, with the caller's own side named.
 *
 * `you` and `them` rather than challenger and opponent, because every screen
 * that shows a duel shows it to one of the two people in it, and making each
 * of them work out which column is theirs is how a board gets misread.
 */
function shape(
  duel: DuelRow,
  viewer: string | null,
  names: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const side = (pubkey: string, bps: number | null): Side => ({
    pubkey,
    name: displayName(pubkey, names.get(pubkey) ?? null),
    bps,
  });
  const challenger = side(duel.challenger, duel.challengerBps);
  const opponent = side(duel.opponent, duel.opponentBps);
  const mine = viewer === duel.challenger;

  return {
    id: duel.id,
    status: duel.status,
    windowSeconds: duel.windowSeconds,
    createdAt: duel.createdAt,
    offerExpiresAt: duel.offerExpiresAt,
    startedAt: duel.startedAt,
    endsAt: duel.endsAt,
    settledAt: duel.settledAt,
    challenger,
    opponent,
    // Null when the viewer is not in this duel, which is the case on the public
    // board. The two sides above are still there and still named.
    you: viewer === null ? null : mine ? challenger : opponent,
    them: viewer === null ? null : mine ? opponent : challenger,
    iChallenged: viewer === null ? null : mine,
    winner: duel.winner,
    /*
     * Said out loud rather than left for somebody to infer from two counts.
     * A result that leaned on a position nobody could price is a weaker claim
     * than one measured throughout, and the difference belongs on the screen.
     */
    fullyPriced: duel.unpricedOpen === 0 && duel.unpricedClose === 0,
    seal: duel.seal,
  };
}

async function nameMap(
  client: Awaited<ReturnType<typeof db>>,
  duels: readonly DuelRow[],
): Promise<Map<string, string>> {
  const pubkeys = [...new Set(duels.flatMap((duel) => [duel.challenger, duel.opponent]))];
  return namesFor(client, pubkeys);
}

/**
 * The running score of a live duel, cached for a few seconds.
 *
 * Both traders sit on this page with it polling, and every read prices every
 * position either of them holds against the chain. Uncached, a single duel with
 * three open positions between two watching browsers is twelve pool reads a
 * minute, for a number that is a scoreboard rather than a fill: nobody is
 * trading off it, and it does not need to be accurate to the second.
 *
 * Keyed by duel, not by viewer, because the two of them are looking at the same
 * two numbers from opposite sides. One read serves both.
 */
const RUNNING_TTL_MS = 15_000;
const runningCache = new Map<number, { at: number; challenger: number; opponent: number }>();

async function runningScore(
  client: Awaited<ReturnType<typeof db>>,
  duel: DuelRow,
  now: number,
): Promise<{ challenger: number; opponent: number } | null> {
  const held = runningCache.get(duel.id);
  if (held && now - held.at < RUNNING_TTL_MS) {
    return { challenger: held.challenger, opponent: held.opponent };
  }
  if (duel.challengerOpen === null || duel.opponentOpen === null) return null;

  try {
    const [challenger, opponent] = await Promise.all([
      accountFor(client, duel.seasonId, duel.challenger),
      accountFor(client, duel.seasonId, duel.opponent),
    ]);
    if (!challenger || !opponent) return null;
    const [a, b] = await equityOf(client, [challenger, opponent]);
    if (!a || !b) return null;

    const scored = {
      challenger: returnBps(BigInt(duel.challengerOpen), a.lamports),
      opponent: returnBps(BigInt(duel.opponentOpen), b.lamports),
    };
    runningCache.set(duel.id, { at: now, ...scored });
    /*
     * Settled duels leave their entry behind, so the map is trimmed rather than
     * left to grow for the life of the process. Ten is generous: it only ever
     * holds duels somebody currently has a page open on.
     */
    if (runningCache.size > 64) {
      for (const [id, entry] of runningCache) {
        if (now - entry.at > RUNNING_TTL_MS * 4) runningCache.delete(id);
      }
    }
    return scored;
  } catch {
    // A figure that cannot be read is left absent rather than returned as
    // nought, which would read as level when it is in fact unknown.
    return null;
  }
}

export async function GET(): Promise<Response> {
  const client = await db();
  const now = Date.now();
  const user = await currentUser();
  const season = await currentRankedSeason(client, now);

  const recent = await recentDuels(client, 12);

  if (!user) {
    const names = await nameMap(client, recent);
    return Response.json({
      signedIn: false,
      canOffer: false,
      windows: DUEL_WINDOWS,
      mine: [],
      record: null,
      recent: recent.map((duel) => shape(duel, null, names)),
    });
  }

  const mine = await duelsFor(client, user.pubkey);
  const names = await nameMap(client, [...mine, ...recent]);
  const record = await duelRecord(client, user.pubkey);

  const entered = season ? await hasEntered(client, season.id, user.pubkey) : false;
  const open = season !== null && seasonTradingOpen(season, now);

  /*
   * The live duel's running numbers, priced now.
   *
   * Only for a duel the caller is actually in. Pricing every live duel on the
   * site for a page view would put the cost of somebody else's duel on whoever
   * happened to open this page.
   */
  const live = await liveDuelFor(client, user.pubkey);
  let running: { you: number; them: number } | null = null;
  if (live && live.challengerOpen !== null && live.opponentOpen !== null) {
    const scored = await runningScore(client, live, now);
    if (scored) {
      const mineIsChallenger = live.challenger === user.pubkey;
      running = {
        you: mineIsChallenger ? scored.challenger : scored.opponent,
        them: mineIsChallenger ? scored.opponent : scored.challenger,
      };
    }
  }

  return Response.json({
    signedIn: true,
    canOffer: entered && open,
    why: entered ? (open ? null : whyNotOpen(season, now)) : 'enter the season first',
    windows: DUEL_WINDOWS,
    mine: mine.map((duel) => shape(duel, user.pubkey, names)),
    running,
    record,
    recent: recent.map((duel) => shape(duel, null, names)),
  });
}

/** Offer a duel to somebody, by name or by address. */
export async function POST(request: Request): Promise<Response> {
  const user = await currentUser();
  if (!user) return Response.json({ error: 'sign in' }, { status: 401 });

  const throttled = await rateLimit(request, 'write', 1, user.pubkey);
  if (throttled.response) return throttled.response;

  let body: { opponent?: unknown; windowSeconds?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: 'expected a JSON body' }, { status: 400 });
  }

  const target = typeof body.opponent === 'string' ? body.opponent.trim() : '';
  if (target === '') return Response.json({ error: 'who do you want to duel?' }, { status: 400 });

  const windowSeconds = Number(body.windowSeconds);
  if (!DUEL_WINDOWS.includes(windowSeconds)) {
    return Response.json({ error: 'pick one of the offered windows' }, { status: 400 });
  }

  const client = await db();
  const now = Date.now();

  const season = await currentRankedSeason(client, now);
  if (!season) return Response.json({ error: 'there is no season to duel in' }, { status: 409 });
  if (!seasonTradingOpen(season, now)) {
    return Response.json({ error: `${whyNotOpen(season, now)}, so there is nothing to duel over` }, {
      status: 409,
    });
  }

  /*
   * A name first, an address second.
   *
   * Almost everybody will type a name, and a name is resolved through the same
   * folded key the claim used so that spelling it differently still finds the
   * person. An address is accepted too, because a trader without a name is
   * still a trader somebody may want to duel.
   */
  let opponent: string | null = null;
  const asName = checkName(target.replace(/^@/, ''), DEFAULT_NAME_RULES);
  if (asName.ok) opponent = await pubkeyForName(client, asName.key);
  if (opponent === null) {
    try {
      decodePubkey(target);
      opponent = target;
    } catch {
      return Response.json({ error: 'no trader by that name or address' }, { status: 404 });
    }
  }

  if (opponent === user.pubkey) {
    return Response.json({ error: 'you cannot duel yourself' }, { status: 400 });
  }

  /*
   * Both have to be in the season, and both are checked before the offer.
   *
   * Not politeness. A duel is scored off season accounts, and an opponent who
   * never entered has no account to score, so an offer to them could never be
   * accepted. Refusing here is the difference between a sentence and a dead row
   * in somebody's list.
   */
  if (!(await hasEntered(client, season.id, user.pubkey))) {
    return Response.json({ error: 'enter the season before offering a duel' }, { status: 409 });
  }
  if (!(await hasEntered(client, season.id, opponent))) {
    return Response.json({ error: 'they have not entered this season' }, { status: 409 });
  }

  try {
    const { offerDuel } = await import('@probatio/db');
    const duel = await offerDuel(
      client,
      { seasonId: season.id, challenger: user.pubkey, opponent, windowSeconds },
      now,
    );
    return Response.json({ id: duel.id, status: duel.status });
  } catch (error) {
    if (error instanceof DuelError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}

/** Accept, decline or withdraw an offer. */
export async function PATCH(request: Request): Promise<Response> {
  const user = await currentUser();
  if (!user) return Response.json({ error: 'sign in' }, { status: 401 });

  const throttled = await rateLimit(request, 'write', 1, user.pubkey);
  if (throttled.response) return throttled.response;

  let body: { id?: unknown; action?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: 'expected a JSON body' }, { status: 400 });
  }

  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json({ error: 'which duel?' }, { status: 400 });
  }
  const action = body.action;
  if (action !== 'accept' && action !== 'decline' && action !== 'withdraw') {
    return Response.json({ error: 'action must be accept, decline or withdraw' }, { status: 400 });
  }

  const client = await db();
  const now = Date.now();

  try {
    if (action !== 'accept') {
      const duel = await closeOffer(client, {
        id,
        by: user.pubkey,
        status: action === 'decline' ? 'declined' : 'withdrawn',
      });
      return Response.json({ id: duel.id, status: duel.status });
    }

    const duel = await duelById(client, id);
    if (!duel) return Response.json({ error: 'there is no such duel' }, { status: 404 });

    const season = await currentRankedSeason(client, now);
    if (!season || !seasonTradingOpen(season, now) || season.id !== duel.seasonId) {
      return Response.json(
        { error: 'that season is not open, so there is nothing to duel over' },
        { status: 409 },
      );
    }

    /*
     * The window has to fit inside what is left of the season.
     *
     * A twenty-four hour duel accepted an hour before the season ends would be
     * scored across a boundary where trading stops for both of them, so the
     * second half measures nothing and the winner is whoever was ahead when the
     * music stopped.
     */
    if (season.endsAt !== null && now + duel.windowSeconds * 1_000 > season.endsAt) {
      return Response.json(
        { error: 'that window runs past the end of the season' },
        { status: 409 },
      );
    }

    /*
     * The one place a duel may create an account, and deliberately so.
     *
     * Both of these traders have entered, which was checked before the offer
     * was written. Entering does not itself write an account row: that happens
     * on a request path, so somebody who paid and never opened a page has none
     * yet. Ensuring it here, once, is what lets everything afterwards read
     * rather than create — the settler in particular, where building an account
     * at the season's starting balance would mean a background job handing
     * somebody ten SOL and then scoring a duel against it.
     */
    const [challenger, opponent] = await Promise.all([
      ensureAccount(client, duel.seasonId, duel.challenger, now),
      ensureAccount(client, duel.seasonId, duel.opponent, now),
    ]);
    const [a, b] = await equityOf(client, [challenger, opponent]);
    if (!a || !b) {
      return Response.json({ error: 'could not read both accounts' }, { status: 503 });
    }

    const accepted = await acceptDuel(
      client,
      {
        id,
        opponent: user.pubkey,
        challengerOpen: a.lamports,
        opponentOpen: b.lamports,
        unpriced: a.unpriced + b.unpriced,
      },
      Date.now(),
    );
    return Response.json({ id: accepted.id, status: accepted.status, endsAt: accepted.endsAt });
  } catch (error) {
    if (error instanceof DuelError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}
