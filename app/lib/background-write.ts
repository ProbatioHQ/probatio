import 'server-only';

/**
 * One background write at a time, and a retry if the file says no anyway.
 *
 * SQLite permits a single writer. The db client already serializes anything
 * that opens a transaction, but a bare `execute` that happens to be an INSERT
 * or a DELETE goes straight at the file on the shared connection, and so does
 * every batch. That was fine while one background job wrote at a time.
 *
 * It stopped being fine the moment the wallet walker went to eight lanes: eight
 * batched inserts, the house accounts recording fills, retention deleting, and
 * the chart warmer writing candles, all at once. The result was a wall of
 * SQLITE_BUSY and SQLITE_BUSY_SNAPSHOT, and the second one is the nastier
 * kind — a transaction that began by reading and then tried to write after
 * somebody else already had. `busy_timeout` does not retry that. It fails at
 * once, which is why retention lost whole passes and the health probe reported
 * the database unreachable while it was merely busy.
 *
 * Background work queues here. Requests do not: a person clicking trade must
 * never wait behind a wallet walk, and the queue is deliberately only as wide
 * as the jobs that can afford to wait.
 *
 * The retry is for the case the queue cannot cover, which is a request writing
 * at the same moment. Short, bounded, and it gives up rather than hammering.
 */

let tail: Promise<unknown> = Promise.resolve();

const RETRIES = 4;
const BACKOFF_MS = 120;

function isBusy(error: unknown): boolean {
  const code = (error as { code?: unknown; rawCode?: unknown } | null)?.code;
  return code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT';
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run a write with the background lock held, retrying only a busy file. */
export async function background<T>(write: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });

  const ahead = tail;
  tail = tail.then(
    () => mine,
    () => mine,
  );
  await ahead.catch(() => undefined);

  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await write();
      } catch (error) {
        if (attempt >= RETRIES || !isBusy(error)) throw error;
        // Growing, so a burst does not have every retry land together.
        await wait(BACKOFF_MS * (attempt + 1));
      }
    }
  } finally {
    release();
  }
}
