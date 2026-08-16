import { toWebSocketUrl, type SubscriptionStatus, type WebSocketLike } from './subscription';

/**
 * An `accountSubscribe` connection to a Solana node.
 *
 * The launch feed watches logs because it wants every pump.fun transaction.
 * This wants the opposite: a handful of specific accounts, watched closely,
 * because somebody has that token's chart open and a price that arrives twelve
 * seconds late is a price that was wrong for twelve seconds.
 *
 * Polling has a floor and this does not have one. The node pushes the account
 * the moment it changes, which for a bonding curve or a pool vault is the
 * moment somebody trades. There is no interval to tune because there is no
 * interval.
 *
 * The watched set moves constantly — a token is opened, looked at, left — so
 * subscribing is a method rather than a constructor argument, and everything
 * currently watched is re-subscribed after a reconnect. A socket that comes
 * back with none of its subscriptions is worse than one that stayed down,
 * because it looks connected.
 */

export interface AccountUpdate {
  readonly address: string;
  readonly data: Uint8Array;
  readonly slot: number | null;
}

export interface AccountSubscriptionOptions {
  /** A `wss://` endpoint, or an http one that will be converted. */
  readonly endpoint: string;
  readonly onUpdate: (update: AccountUpdate) => void;
  readonly onStatus?: (status: SubscriptionStatus, detail?: string) => void;
  /** Injected in tests. */
  readonly socketFactory?: (url: string) => WebSocketLike;
  readonly reconnectBaseMs?: number;
  readonly maxReconnectMs?: number;
}

const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_MAX_RECONNECT_MS = 30_000;

export class AccountSubscription {
  readonly #options: AccountSubscriptionOptions;
  #socket: WebSocketLike | null = null;
  /**
   * Whether the socket is open, which is not the same as existing.
   *
   * A socket is assigned the moment it is constructed and cannot carry a
   * subscribe until it opens. Sending on the strength of the field being
   * non-null subscribed once on the way up and again in the open handler, so
   * the node held two subscriptions and the request ids from the first one were
   * discarded — leaving notifications arriving under an id nothing recognised,
   * and a feed that connects and delivers nothing.
   */
  #open = false;
  #attempt = 0;
  #stopped = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #nextId = 100;

  /** Everything that should be watched, whether or not the socket is up. */
  readonly #wanted = new Set<string>();
  /** Request id → address, until the node answers with a subscription id. */
  readonly #pending = new Map<number, string>();
  /** Subscription id → address, so a notification can be attributed. */
  readonly #live = new Map<number, string>();

  constructor(options: AccountSubscriptionOptions) {
    this.#options = options;
  }

  get connected(): boolean {
    return this.#socket !== null && this.#open;
  }

  /** Addresses currently confirmed by the node. */
  get active(): number {
    return this.#live.size;
  }

  start(): void {
    this.#stopped = false;
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#socket?.close();
    this.#socket = null;
    this.#open = false;
    this.#wanted.clear();
    this.#pending.clear();
    this.#live.clear();
    this.#options.onStatus?.('closed');
  }

  /** Watch an account. Idempotent, and safe before the socket is open. */
  watch(address: string): void {
    if (this.#wanted.has(address)) return;
    this.#wanted.add(address);
    this.#subscribe(address);
  }

  /** Stop watching. The node is told, so it stops sending. */
  unwatch(address: string): void {
    if (!this.#wanted.delete(address)) return;

    for (const [id, watched] of this.#live) {
      if (watched !== address) continue;
      this.#live.delete(id);
      this.#send({ jsonrpc: '2.0', id: this.#nextId++, method: 'accountUnsubscribe', params: [id] });
    }
    for (const [id, watched] of this.#pending) {
      if (watched === address) this.#pending.delete(id);
    }
  }

  #subscribe(address: string): void {
    if (!this.#socket || !this.#open) return;
    const id = this.#nextId++;
    this.#pending.set(id, address);
    this.#send({
      jsonrpc: '2.0',
      id,
      method: 'accountSubscribe',
      // Base64 because the payloads here are account layouts, not JSON the node
      // knows how to parse, and `confirmed` because a price a trader is looking
      // at should not wait for finality it will never visibly benefit from.
      params: [address, { encoding: 'base64', commitment: 'confirmed' }],
    });
  }

  #send(payload: unknown): void {
    try {
      this.#socket?.send(JSON.stringify(payload));
    } catch {
      // A send on a dying socket is not worth reporting; the close handler is
      // about to run and will reconnect.
    }
  }

  #connect(): void {
    if (this.#stopped) return;

    const url = toWebSocketUrl(this.#options.endpoint);
    this.#options.onStatus?.('connecting', url);

    const create =
      this.#options.socketFactory ??
      ((target: string) => new WebSocket(target) as unknown as WebSocketLike);

    let socket: WebSocketLike;
    try {
      socket = create(url);
    } catch (error) {
      this.#scheduleReconnect(error instanceof Error ? error.message : String(error));
      return;
    }

    this.#socket = socket;

    socket.onopen = () => {
      this.#attempt = 0;
      this.#open = true;
      this.#options.onStatus?.('open');
      // Whatever was wanted while the socket was down is wanted now. Ids from
      // the previous connection mean nothing to this one.
      this.#pending.clear();
      this.#live.clear();
      for (const address of this.#wanted) this.#subscribe(address);
    };

    socket.onmessage = (event) => {
      // A throw inside a websocket listener is an uncaught exception, which the
      // process guard turns into a hard exit — one bad account update would take
      // the whole server down and keep it down as it reconnects and replays.
      // Contained to a logged miss instead.
      try {
        this.#handle(event.data);
      } catch (error) {
        this.#options.onStatus?.('error');
        console.error('[accounts] dropped an update its handler could not take', error);
      }
    };

    socket.onerror = () => {
      this.#options.onStatus?.('error');
    };

    socket.onclose = () => {
      this.#socket = null;
      this.#open = false;
      this.#scheduleReconnect('socket closed');
    };
  }

  #handle(raw: unknown): void {
    if (typeof raw !== 'string') return;

    let message: {
      id?: number;
      result?: unknown;
      method?: string;
      params?: {
        subscription?: number;
        result?: { value?: { data?: unknown }; context?: { slot?: number } };
      };
    };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    // The reply to a subscribe call: match it back to what was asked for.
    if (typeof message.id === 'number' && typeof message.result === 'number') {
      const address = this.#pending.get(message.id);
      this.#pending.delete(message.id);
      if (address && this.#wanted.has(address)) {
        this.#live.set(message.result, address);
        this.#options.onStatus?.('subscribed', address);
      }
      return;
    }

    if (message.method !== 'accountNotification') return;

    const subscription = message.params?.subscription;
    if (typeof subscription !== 'number') return;
    const address = this.#live.get(subscription);
    if (!address) return;

    const encoded = message.params?.result?.value?.data;
    const base64 = Array.isArray(encoded) ? encoded[0] : null;
    if (typeof base64 !== 'string') return;

    this.#options.onUpdate({
      address,
      data: Uint8Array.from(Buffer.from(base64, 'base64')),
      slot: message.params?.result?.context?.slot ?? null,
    });
  }

  #scheduleReconnect(detail: string): void {
    if (this.#stopped) return;
    this.#options.onStatus?.('closed', detail);

    const base = this.#options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
    const ceiling = this.#options.maxReconnectMs ?? DEFAULT_MAX_RECONNECT_MS;
    const delay = Math.min(base * 2 ** this.#attempt, ceiling);
    this.#attempt += 1;

    this.#timer = setTimeout(() => this.#connect(), delay);
    this.#timer.unref?.();
  }
}
