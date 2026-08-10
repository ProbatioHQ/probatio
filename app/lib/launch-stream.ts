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
    existing = { launches: new Set(), curves: new Set() };
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
