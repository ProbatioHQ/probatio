import type { Dependency } from './outage';

/**
 * What the site can still do.
 *
 * There is exactly one thing that must never degrade: trading against stale
 * prices. A fill quoted from a cached pool is a fabricated fill, and a
 * simulator that fabricates fills has no reason to exist. So when the chain
 * cannot be read, trading stops — it does not fall back, it does not estimate,
 * and it does not quietly serve the last price it saw.
 *
 * Everything else degrades. Charts go stale and say so, the launch feed stops
 * growing and says how old it is, the coach becomes unavailable. Those are
 * inconveniences. A wrong fill is a lie.
 */

export type Capability =
  | 'trading'
  | 'charts'
  | 'launches'
  | 'leaderboard'
  | 'entering'
  | 'coach'
  | 'signIn';

export type Level = 'ok' | 'degraded' | 'unavailable';

export interface CapabilityState {
  readonly capability: Capability;
  readonly level: Level;
  readonly note: string;
}

/**
 * What each capability needs, and what happens without it.
 *
 * `stops` means the capability refuses rather than degrades. Only trading and
 * entering are on that list, and for the same reason: both produce a record
 * that cannot be taken back.
 */
const REQUIREMENTS: {
  capability: Capability;
  needs: Dependency[];
  stops: boolean;
  degradedNote: string;
  stoppedNote: string;
}[] = [
  {
    capability: 'trading',
    needs: ['rpc', 'database'],
    stops: true,
    degradedNote: '',
    stoppedNote:
      'Trading is off while live prices cannot be read. A fill quoted against a stale price is not a fill.',
  },
  {
    capability: 'entering',
    needs: ['rpc', 'database'],
    stops: true,
    degradedNote: '',
    stoppedNote: 'Season entry is off while payments cannot be verified on chain.',
  },
  {
    capability: 'charts',
    needs: ['rpc'],
    stops: false,
    degradedNote: 'Charts show the last data received and are not updating.',
    stoppedNote: '',
  },
  {
    capability: 'launches',
    needs: ['feed'],
    stops: false,
    degradedNote: 'New launches are not arriving. The list shows what was seen before the feed dropped.',
    stoppedNote: '',
  },
  {
    capability: 'leaderboard',
    needs: ['rpc'],
    stops: false,
    degradedNote: 'Open positions are valued at cost rather than at market, so standings may shift when prices return.',
    stoppedNote: '',
  },
  { capability: 'coach', needs: ['coach'], stops: false, degradedNote: 'The coach is unavailable.', stoppedNote: '' },
  { capability: 'signIn', needs: ['database'], stops: true, degradedNote: '', stoppedNote: 'Signing in is unavailable.' },
];

export function capabilities(down: readonly Dependency[]): CapabilityState[] {
  const offline = new Set(down);

  return REQUIREMENTS.map((requirement) => {
    const missing = requirement.needs.filter((need) => offline.has(need));
    if (missing.length === 0) {
      return { capability: requirement.capability, level: 'ok' as const, note: '' };
    }
    // The database is not optional for anything. A capability that could
    // "degrade" without it would be serving something it did not read.
    const stopped = requirement.stops || missing.includes('database');
    return {
      capability: requirement.capability,
      level: stopped ? ('unavailable' as const) : ('degraded' as const),
      note: stopped ? requirement.stoppedNote || 'Unavailable.' : requirement.degradedNote,
    };
  });
}

export function overall(states: readonly CapabilityState[]): Level {
  if (states.some((state) => state.level === 'unavailable')) return 'unavailable';
  if (states.some((state) => state.level === 'degraded')) return 'degraded';
  return 'ok';
}
