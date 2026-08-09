import type { LogNotification } from './launches';

/**
 * A `logsSubscribe` connection to a Solana node.
 *
 * The live launch feed's transport. Pushed rather than polled, because a
 * complete feed means seeing every pump.fun transaction and asking for those
 * as requests would cost more than the rest of the system together.
 *
 * Reconnection is assumed, not exceptional. Sockets drop, nodes restart, and a
 * feed that needs a person to notice is not a feed. What arrives after a
 * reconnect may overlap what arrived before it, which is why the launch
 * deduplication upstream is bounded rather than trusting the stream to behave.
 */

export interface SubscriptionOptions {
  /** A `wss://` endpoint. Usually the RPC URL with the scheme swapped. */
  readonly endpoint: string;
  /** Only logs mentioning this address are delivered. */
  readonly mentions: string;
  readonly onNotification: (notification: LogNotification) => void;
  readonly onStatus?: (status: SubscriptionStatus, detail?: string) => void;
  /** Injected in tests. */
  readonly socketFactory?: (url: string) => WebSocketLike;
  readonly reconnectBaseMs?: number;
  readonly maxReconnectMs?: number;
}

export type SubscriptionStatus = 'connecting' | 'open' | 'subscribed' | 'closed' | 'error';

/** The slice of WebSocket used here, so a test can supply its own. */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
}

const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_MAX_RECONNECT_MS = 30_000;

/** Turn an http RPC URL into its websocket equivalent. */
export function toWebSocketUrl(endpoint: string): string {
  return endpoint.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
}

export class LogSubscription {
  readonly #options: SubscriptionOptions;
  #socket: WebSocketLike | null = null;
  #attempt = 0;
  #stopped = false;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: SubscriptionOptions) {
    this.#options = options;
  }

  get connected(): boolean {
    return this.#socket !== null;
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
    this.#options.onStatus?.('closed');
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
      this.#options.onStatus?.('open');
      socket.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'logsSubscribe',
          params: [{ mentions: [this.#options.mentions] }, { commitment: 'confirmed' }],
        }),
      );
    };

    socket.onmessage = (event) => {
      this.#handle(event.data);
    };

    socket.onerror = () => {
      this.#options.onStatus?.('error');
    };

    socket.onclose = () => {
      this.#socket = null;
      this.#scheduleReconnect('socket closed');
    };
  }

  #handle(raw: unknown): void {
    if (typeof raw !== 'string') return;

    let message: {
      result?: unknown;
      method?: string;
      params?: { result?: { value?: unknown; context?: { slot?: number } } };
    };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    // The reply to the subscribe call carries a subscription id and nothing
    // else worth keeping.
    if (typeof message.result === 'number') {
      this.#options.onStatus?.('subscribed', String(message.result));
      return;
    }

    if (message.method !== 'logsNotification') return;

    const value = message.params?.result?.value as
      | { signature?: string; err?: unknown; logs?: string[] }
      | undefined;
    if (!value?.signature || !Array.isArray(value.logs)) return;

    this.#options.onNotification({
      signature: value.signature,
      slot: message.params?.result?.context?.slot ?? null,
      err: value.err ?? null,
      logs: value.logs,
    });
  }

  /**
   * Back off before trying again, with a ceiling.
   *
   * A node that is down stays down for a while, and retrying every second
   * against it helps nobody — least of all the shared endpoints this is likely
   * to be pointed at.
   */
  #scheduleReconnect(detail: string): void {
    if (this.#stopped) return;

    this.#options.onStatus?.('closed', detail);

    const base = this.#options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
    const ceiling = this.#options.maxReconnectMs ?? DEFAULT_MAX_RECONNECT_MS;
    const delay = Math.min(base * 2 ** this.#attempt, ceiling);
    this.#attempt += 1;

    this.#timer = setTimeout(() => this.#connect(), delay);
  }
}
