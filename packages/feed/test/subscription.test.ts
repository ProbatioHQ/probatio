import { describe, expect, it, vi } from 'vitest';
import {
  LogSubscription,
  toWebSocketUrl,
  type WebSocketLike,
} from '../src/subscription';
import type { LogNotification } from '../src/launches';

/** A socket a test can drive: open it, push frames, close it. */
class FakeSocket implements WebSocketLike {
  sent: string[] = [];
  closed = false;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.({});
  }

  push(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  pushRaw(data: unknown): void {
    this.onmessage?.({ data });
  }

  drop(): void {
    this.onclose?.({});
  }
}

function notification(overrides: Record<string, unknown> = {}) {
  return {
    jsonrpc: '2.0',
    method: 'logsNotification',
    params: {
      result: {
        context: { slot: 4_321 },
        value: { signature: 'sig1', err: null, logs: ['Program log: hello'], ...overrides },
      },
    },
  };
}

describe('toWebSocketUrl', () => {
  it('swaps the scheme', () => {
    expect(toWebSocketUrl('https://api.mainnet-beta.solana.com')).toBe(
      'wss://api.mainnet-beta.solana.com',
    );
    expect(toWebSocketUrl('http://localhost:8899')).toBe('ws://localhost:8899');
  });

  it('leaves a websocket url alone', () => {
    expect(toWebSocketUrl('wss://example.com')).toBe('wss://example.com');
  });
});

describe('subscribing', () => {
  function build(onNotification = vi.fn()) {
    const socket = new FakeSocket();
    const subscription = new LogSubscription({
      endpoint: 'wss://example.com',
      mentions: 'PUMP',
      onNotification,
      socketFactory: () => socket,
    });
    return { socket, subscription, onNotification };
  }

  it('subscribes to logs mentioning the program', () => {
    const { socket, subscription } = build();
    subscription.start();
    socket.open();

    const request = JSON.parse(socket.sent[0]!);
    expect(request.method).toBe('logsSubscribe');
    expect(request.params[0]).toEqual({ mentions: ['PUMP'] });
    subscription.stop();
  });

  it('reports when the subscription is confirmed', () => {
    const statuses: string[] = [];
    const socket = new FakeSocket();
    const subscription = new LogSubscription({
      endpoint: 'wss://example.com',
      mentions: 'PUMP',
      onNotification: vi.fn(),
      onStatus: (status) => statuses.push(status),
      socketFactory: () => socket,
    });

    subscription.start();
    socket.open();
    socket.push({ jsonrpc: '2.0', result: 7, id: 1 });

    expect(statuses).toContain('subscribed');
    subscription.stop();
  });

  it('delivers a notification', () => {
    const { socket, subscription, onNotification } = build();
    subscription.start();
    socket.open();
    socket.push(notification());

    expect(onNotification).toHaveBeenCalledWith({
      signature: 'sig1',
      slot: 4_321,
      err: null,
      logs: ['Program log: hello'],
    } satisfies LogNotification);
    subscription.stop();
  });

  it('passes a failed transaction through rather than dropping it', () => {
    // The feed decides what a failure means, not the transport. A socket that
    // silently swallowed them would hide the fact they ever arrived.
    const { socket, subscription, onNotification } = build();
    subscription.start();
    socket.open();
    socket.push(notification({ err: { InstructionError: [0, 'Custom'] } }));

    expect(onNotification).toHaveBeenCalled();
    expect(onNotification.mock.calls[0]![0].err).not.toBeNull();
    subscription.stop();
  });

  it('ignores anything that is not a log notification', () => {
    const { socket, subscription, onNotification } = build();
    subscription.start();
    socket.open();

    socket.push({ jsonrpc: '2.0', method: 'somethingElse', params: {} });
    socket.push({ jsonrpc: '2.0', method: 'logsNotification', params: {} });
    socket.pushRaw('not json at all');
    socket.pushRaw({ an: 'object' });

    expect(onNotification).not.toHaveBeenCalled();
    subscription.stop();
  });
});

describe('reconnecting', () => {
  it('comes back after a drop', () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];

    const subscription = new LogSubscription({
      endpoint: 'wss://example.com',
      mentions: 'PUMP',
      onNotification: vi.fn(),
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      reconnectBaseMs: 100,
    });

    subscription.start();
    sockets[0]!.open();
    sockets[0]!.drop();

    // A feed that needs somebody to notice it died is not a feed.
    vi.advanceTimersByTime(200);
    expect(sockets).toHaveLength(2);

    subscription.stop();
    vi.useRealTimers();
  });

  it('backs off further each time', () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];

    const subscription = new LogSubscription({
      endpoint: 'wss://example.com',
      mentions: 'PUMP',
      onNotification: vi.fn(),
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      reconnectBaseMs: 100,
    });

    subscription.start();
    sockets[0]!.drop();
    vi.advanceTimersByTime(100);
    expect(sockets).toHaveLength(2);

    sockets[1]!.drop();
    // Still waiting: the second delay is longer than the first, because a node
    // that is down stays down and hammering it helps nobody.
    vi.advanceTimersByTime(100);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(150);
    expect(sockets).toHaveLength(3);

    subscription.stop();
    vi.useRealTimers();
  });

  it('resets the backoff once a connection succeeds', () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];

    const subscription = new LogSubscription({
      endpoint: 'wss://example.com',
      mentions: 'PUMP',
      onNotification: vi.fn(),
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      reconnectBaseMs: 100,
    });

    subscription.start();
    sockets[0]!.drop();
    vi.advanceTimersByTime(100);
    sockets[1]!.open();
    sockets[1]!.drop();

    // Back to the shortest delay, because the last attempt worked.
    vi.advanceTimersByTime(100);
    expect(sockets).toHaveLength(3);

    subscription.stop();
    vi.useRealTimers();
  });

  it('stops trying once stopped', () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];

    const subscription = new LogSubscription({
      endpoint: 'wss://example.com',
      mentions: 'PUMP',
      onNotification: vi.fn(),
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      reconnectBaseMs: 100,
    });

    subscription.start();
    subscription.stop();
    sockets[0]!.drop();
    vi.advanceTimersByTime(10_000);

    expect(sockets).toHaveLength(1);
    vi.useRealTimers();
  });

  it('survives a socket that cannot be created at all', () => {
    vi.useFakeTimers();
    let attempts = 0;

    const subscription = new LogSubscription({
      endpoint: 'wss://example.com',
      mentions: 'PUMP',
      onNotification: vi.fn(),
      socketFactory: () => {
        attempts += 1;
        throw new Error('no network');
      },
      reconnectBaseMs: 100,
    });

    expect(() => subscription.start()).not.toThrow();
    vi.advanceTimersByTime(100);
    expect(attempts).toBe(2);

    subscription.stop();
    vi.useRealTimers();
  });
});
