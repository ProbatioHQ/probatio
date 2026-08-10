import 'server-only';
import type { CurveState, Launch } from '@probatio/db';

/**
 * New launches and curve progress, handed to whoever is watching.
 *
 * The websocket already knows the moment a token is created, and the curve
 * watcher already knows when one crosses into another lane. The page has to
 * find out somehow. Polling would mean every open tab asking the database the
 * same question several times a second, and the answer is usually nothing.
 * This is the other direction: one socket in, fanned out in process.
 *
 * In process is the limit of it. Two servers means a tab connected to one never
 * hears what the other saw, so the feed still loads over HTTP first and the
 * stream is only the update path — a reader on the wrong instance gets a feed
 * that is merely slower, not one that is empty.
 */

export type LaunchListener = (launches: readonly Launch[]) => void;
export type CurveListener = (curves: readonly CurveState[]) => void;

interface Registry {
  launches: Set<LaunchListener>;
  curves: Set<CurveListener>;
  /** Open stream count per caller. Global for the same reason the sets are. */
  streams: Map<string, number>;
}

/**
 * Held on `globalThis`, and that is not a shortcut.
 *
 * `instrumentation.ts` and a route handler are compiled into separate bundles,
 * so a module-level `Set` here exists once per bundle. The publisher runs in
 * one and the subscriber in the other, which means the two never meet: the
 * stream stayed open, sent its heartbeats, and delivered nothing, for as long
 * as anybody cared to watch it. Symptom-free unless you time how long a launch
 * takes to appear.
 *
 * A single global registry is what makes them the same set. It also survives
 * the module re-evaluation a dev-server hot reload causes, which would
 * otherwise silently orphan every open connection.
 */
const KEY = Symbol.for('probatio.launch-stream');

function registry(): Registry {
  const store = globalThis as typeof globalThis & { [KEY]?: Registry };
  let existing = store[KEY];
  if (!existing) {
    existing = { launches: new Set(), curves: new Set(), streams: new Map() };
    store[KEY] = existing;
  }
  return existing;
}

function fanOut<T>(listeners: Set<(value: T) => void>, value: T, what: string): void {
  for (const listener of listeners) {
    try {
      listener(value);
    } catch (error) {
      // One broken connection must not stop the others from being told.
      console.error(`[stream] ${what} listener threw`, error);
    }
  }
}

export function subscribeToLaunches(listener: LaunchListener): () => void {
  const { launches } = registry();
  launches.add(listener);
  return () => {
    launches.delete(listener);
  };
}

export function publishLaunches(items: readonly Launch[]): void {
  const { launches } = registry();
  if (items.length === 0 || launches.size === 0) return;
  fanOut(launches, items, 'launch');
}

/**
 * Curve progress, as it changes.
 *
 * A separate channel from launches because it means something different: a
 * launch is a new row, a curve update moves an existing one — possibly into a
 * different lane. A reader that conflated the two would show the same token
 * twice.
 */
export function subscribeToCurves(listener: CurveListener): () => void {
  const { curves } = registry();
  curves.add(listener);
  return () => {
    curves.delete(listener);
  };
}

export function publishCurves(items: readonly CurveState[]): void {
  const { curves } = registry();
  if (items.length === 0 || curves.size === 0) return;
  fanOut(curves, items, 'curve');
}

/** How many connections are open. Reported by health rather than guessed at. */
export function launchListenerCount(): number {
  return registry().launches.size;
}

/**
 * How many streams one caller may hold open, and how many exist in total.
 *
 * The rate limiter counts requests, not connections, so it does not constrain
 * this at all: a caller allowed 120 reads a minute could hold 120 streams open
 * indefinitely, each with a subscription and a heartbeat timer, and never make
 * another request. Long-lived connections need a concurrency limit rather than
 * a rate.
 */
const PER_CALLER = 3;
const TOTAL = 200;

export interface StreamSlot {
  readonly granted: boolean;
  release(): void;
}

export function takeStreamSlot(caller: string): StreamSlot {
  // On the shared registry, not a module-level Map. The same bundling that
  // once left the publisher and the subscriber holding different Sets would
  // leave two copies of this counter, and a limit nobody agrees on is not a
  // limit. It also survives the module re-evaluation a hot reload causes,
  // which would otherwise strand every slot held at that moment.
  const { streams: openStreams } = registry();
  const total = [...openStreams.values()].reduce((sum, n) => sum + n, 0);
  const mine = openStreams.get(caller) ?? 0;

  if (mine >= PER_CALLER || total >= TOTAL) {
    return { granted: false, release: () => undefined };
  }

  openStreams.set(caller, mine + 1);

  // Idempotent: close can fire from an abort and from the finally that follows
  // it, and decrementing twice would leak slots back into the pool.
  let released = false;
  return {
    granted: true,
    release: () => {
      if (released) return;
      released = true;
      const held = openStreams.get(caller) ?? 0;
      if (held <= 1) openStreams.delete(caller);
      else openStreams.set(caller, held - 1);
    },
  };
}

/** Open streams, for health to report rather than guess at. */
export function openStreamCount(): number {
  return [...registry().streams.values()].reduce((sum, n) => sum + n, 0);
}
