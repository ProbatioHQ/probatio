import 'server-only';
import type { Launch } from '@probatio/db';

/**
 * New launches, handed to whoever is watching.
 *
 * The websocket already knows the moment a token is created, and the page has
 * to find out somehow. Polling would mean every open tab asking the database
 * the same question several times a second, and the answer is usually nothing.
 * This is the other direction: one socket in, fanned out in process.
 *
 * In process is the limit of it. Two servers means a tab connected to one never
 * hears what the other saw, so the feed still loads over HTTP first and the
 * stream is only the update path — a reader on the wrong instance gets a feed
 * that is merely slower, not one that is empty.
 */

export type LaunchListener = (launches: readonly Launch[]) => void;

const listeners = new Set<LaunchListener>();

export function subscribeToLaunches(listener: LaunchListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishLaunches(launches: readonly Launch[]): void {
  if (launches.length === 0 || listeners.size === 0) return;
  for (const listener of listeners) {
    try {
      listener(launches);
    } catch (error) {
      // One broken connection must not stop the others from being told.
      console.error('[stream] listener threw', error);
    }
  }
}

/** How many connections are open. Reported by health rather than guessed at. */
export function launchListenerCount(): number {
  return listeners.size;
}
