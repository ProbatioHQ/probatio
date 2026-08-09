import { extractCreateEvents, type CreateEvent } from '@probatio/pools';

/**
 * Turning a stream of program logs into a launch feed.
 *
 * pump.fun has no official API, and the community endpoints are undocumented
 * and can change without notice — so launches are read from the chain's own
 * CreateEvent, the same source everything else in this project uses.
 *
 * The transport is a `logsSubscribe` websocket rather than polling. A complete
 * launch feed means watching every pump.fun transaction, which as repeated
 * requests would cost more than the rest of the system put together. A
 * subscription is pushed instead of pulled, so it does not compete with the
 * request budget the poller lives inside.
 *
 * Everything here is pure: log lines in, launches out. The socket itself is
 * the caller's problem, which keeps reconnection logic away from parsing.
 */

export interface ObservedLaunch {
  readonly mint: string;
  readonly bondingCurve: string;
  readonly creator: string;
  readonly name: string;
  readonly symbol: string;
  readonly uri: string;
  readonly launchedAt: number;
  readonly slot: number | null;
}

export interface LogNotification {
  readonly signature: string;
  readonly slot: number | null;
  readonly err: unknown;
  readonly logs: readonly string[];
}

function toLaunch(event: CreateEvent, slot: number | null): ObservedLaunch {
  return {
    mint: event.mint,
    bondingCurve: event.bondingCurve,
    creator: event.creator,
    name: event.name,
    symbol: event.symbol,
    uri: event.uri,
    launchedAt: event.timestamp,
    slot,
  };
}

/**
 * Deduplicating launches across reconnections.
 *
 * A websocket that drops and resubscribes replays recent history, so the same
 * launch arrives more than once. The database ignores a repeat anyway, but
 * filtering here keeps a reconnect from turning into a burst of pointless
 * writes.
 *
 * The window is bounded so a long-running process does not accumulate every
 * mint it has ever seen. Anything evicted that turns out to be a repeat is
 * caught by the database instead — the two defences are deliberately
 * overlapping, because the cheap one is allowed to be imperfect.
 */
export class LaunchFeed {
  readonly #seen = new Set<string>();
  readonly #order: string[] = [];
  readonly #capacity: number;

  constructor(capacity = 5_000) {
    if (capacity < 1) throw new Error('capacity must be at least one');
    this.#capacity = capacity;
  }

  get size(): number {
    return this.#seen.size;
  }

  /**
   * Process one notification, returning any launches not seen before.
   *
   * A failed transaction never created anything, so it is skipped — otherwise
   * the feed would advertise tokens that do not exist.
   */
  ingest(notification: LogNotification): ObservedLaunch[] {
    if (notification.err !== null && notification.err !== undefined) return [];

    const fresh: ObservedLaunch[] = [];

    for (const event of extractCreateEvents(notification.logs)) {
      if (this.#seen.has(event.mint)) continue;
      this.#remember(event.mint);
      fresh.push(toLaunch(event, notification.slot));
    }

    return fresh;
  }

  /** Process a batch, preserving order and dropping repeats within it. */
  ingestMany(notifications: readonly LogNotification[]): ObservedLaunch[] {
    return notifications.flatMap((notification) => this.ingest(notification));
  }

  #remember(mint: string): void {
    this.#seen.add(mint);
    this.#order.push(mint);

    while (this.#order.length > this.#capacity) {
      const evicted = this.#order.shift()!;
      this.#seen.delete(evicted);
    }
  }
}
