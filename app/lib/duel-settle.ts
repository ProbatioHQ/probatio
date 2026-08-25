import 'server-only';
import { accountFor, dueDuels, expireOffers, settleDuel } from '@probatio/db';
import { db } from './db';
import { equityOf } from './duel-equity';
import { hasDedicatedRpc } from './env';

/**
 * Closing duels whose window has run out.
 *
 * A duel ends at a time, and a time is not an event anything watches. Without
 * this, a duel would stay live for ever after its window closed: both traders
 * still marked as duelling, neither able to start another, and no result written
 * for the one they finished. Nothing would break loudly, which is exactly why it
 * would go unnoticed.
 *
 * WHY IT IS NOT SETTLED WHEN SOMEBODY OPENS THE PAGE
 *
 * Because then a duel nobody looks at is never scored, and the result depends on
 * who visited and when. The two closing snapshots have to be taken at the end of
 * the window rather than whenever a browser next asks, or the loser gets to
 * choose the moment they are measured by staying away.
 *
 * It cannot be exact. A tick runs every thirty seconds, so a duel is scored
 * within thirty seconds of its window closing rather than at the instant. That
 * is stated here rather than hidden: `ends_at` is what the seal commits to, and
 * `settled_at` is when it was actually read, so the gap is on the record.
 */

const TICK_MS = 30_000;

/** Priced against the chain, so it is gated like every other background reader. */
const ENABLED = process.env['PROBATIO_DISABLE_DUELS'] !== '1' && hasDedicatedRpc();

interface State {
  timer: ReturnType<typeof setInterval> | null;
  busy: boolean;
  ticks: number;
  settled: number;
  expired: number;
  failures: number;
  lastError: string | null;
}

const KEY = Symbol.for('probatio.duel-settle');

function state(): State {
  const store = globalThis as unknown as Record<symbol, State | undefined>;
  const existing = store[KEY];
  if (existing) return existing;
  const fresh: State = {
    timer: null,
    busy: false,
    ticks: 0,
    settled: 0,
    expired: 0,
    failures: 0,
    lastError: null,
  };
  store[KEY] = fresh;
  return fresh;
}

export function duelSettlerStatus(): Omit<State, 'timer'> {
  const { timer: _timer, ...rest } = state();
  return rest;
}

async function tick(): Promise<void> {
  const current = state();
  if (current.busy) return;
  current.busy = true;

  try {
    const client = await db();
    const now = Date.now();

    current.expired += await expireOffers(client, now);

    const due = await dueDuels(client, now);
    if (due.length === 0) {
      current.ticks += 1;
      return;
    }

    for (const duel of due) {
      try {
        /*
         * Both accounts read together, then priced together.
         *
         * `equityOf` takes the pair in one call so the two closing snapshots
         * share a set of prices. Reading them one after the other would score
         * the second trader against a market that had moved since the first was
         * measured, which is a difference no trade caused.
         */
        const [challenger, opponent] = await Promise.all([
          accountFor(client, duel.seasonId, duel.challenger),
          accountFor(client, duel.seasonId, duel.opponent),
        ]);
        /*
         * Read, never created.
         *
         * `ensureAccount` would build one at the season's starting balance,
         * which in a background job means quietly handing somebody ten SOL in a
         * season they never entered and then scoring a duel against it. Both
         * accounts must exist by now, because an offer is refused unless both
         * traders have entered; if one is somehow missing, that is a fact worth
         * surfacing rather than papering over with a fresh account.
         */
        if (!challenger || !opponent) {
          throw new Error(`duel ${duel.id} has a trader with no account in season ${duel.seasonId}`);
        }
        const [a, b] = await equityOf(client, [challenger, opponent]);
        if (!a || !b) continue;

        const settled = await settleDuel(
          client,
          {
            id: duel.id,
            challengerClose: a.lamports,
            opponentClose: b.lamports,
            unpriced: a.unpriced + b.unpriced,
          },
          Date.now(),
        );
        if (settled) current.settled += 1;
      } catch (error) {
        // One duel that cannot be settled must not hold up the others, and it
        // stays live so the next tick tries again rather than being written off
        // with a result nobody measured.
        current.failures += 1;
        current.lastError = error instanceof Error ? error.message : String(error);
      }
    }

    current.ticks += 1;
  } finally {
    current.busy = false;
  }
}

export function startDuelSettler(): void {
  const current = state();
  if (current.timer || !ENABLED) return;

  const run = (): void => {
    void tick().catch((error) => {
      current.failures += 1;
      current.lastError = error instanceof Error ? error.message : String(error);
      console.error('[duels] tick failed', error);
    });
  };

  run();
  current.timer = setInterval(run, TICK_MS);
}
