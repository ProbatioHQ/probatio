import { describe, expect, it } from 'vitest';
import { AccountSubscription } from '../src/accounts';
import type { AccountUpdate } from '../src/accounts';
import type { WebSocketLike } from '../src/subscription';

/**
 * The push side of the price feed.
 *
 * Two things here fail quietly rather than loudly, so both are tested directly:
 * a notification attributed to the wrong account, which shows a trader another
 * token's price, and a reconnect that comes back with no subscriptions, which
 * looks connected and delivers nothing forever.
 */

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

  /** What the node was asked, as objects. */
  calls(): { id?: number; method?: string; params?: unknown[] }[] {
    return this.sent.map((raw) => JSON.parse(raw));
  }

  open(): void {
    this.onopen?.({});
  }
  reply(id: number, subscription: number): void {
    this.onmessage?.({ data: JSON.stringify({ jsonrpc: '2.0', id, result: subscription }) });
  }
  notify(subscription: number, base64: string, slot = 42): void {
    this.onmessage?.({
      data: JSON.stringify({
        jsonrpc: '2.0',
        method: 'accountNotification',
        params: { subscription, result: { value: { data: [base64, 'base64'] }, context: { slot } } },
      }),
    });
  }
}

function harness() {
  const sockets: FakeSocket[] = [];
  const updates: AccountUpdate[] = [];
  const subscription = new AccountSubscription({
    endpoint: 'https://example.invalid',
    onUpdate: (update) => updates.push(update),
    socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    reconnectBaseMs: 1,
  });
  return { subscription, sockets, updates };
}

const ALICE = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const BOB = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

describe('watching accounts over a socket', () => {
  it('subscribes to what was asked for once the socket opens', () => {
    const { subscription, sockets } = harness();
    subscription.start();
    subscription.watch(ALICE);
    sockets[0]!.open();

    const calls = sockets[0]!.calls();
    expect(calls.some((c) => c.method === 'accountSubscribe' && c.params?.[0] === ALICE)).toBe(true);
  });

  it('delivers an account to the address it belongs to', () => {
    const { subscription, sockets, updates } = harness();
    subscription.start();
    subscription.watch(ALICE);
    subscription.watch(BOB);
    const socket = sockets[0]!;
    socket.open();

    const calls = socket.calls().filter((c) => c.method === 'accountSubscribe');
    const aliceId = calls.find((c) => c.params?.[0] === ALICE)!.id!;
    const bobId = calls.find((c) => c.params?.[0] === BOB)!.id!;
    socket.reply(aliceId, 11);
    socket.reply(bobId, 22);

    socket.notify(22, Buffer.from('bob').toString('base64'));

    // The whole point: a price must never be shown against another token.
    expect(updates).toHaveLength(1);
    expect(updates[0]!.address).toBe(BOB);
    expect(Buffer.from(updates[0]!.data).toString()).toBe('bob');
    expect(updates[0]!.slot).toBe(42);
  });

  it('ignores a notification for a subscription it does not know', () => {
    const { subscription, sockets, updates } = harness();
    subscription.start();
    subscription.watch(ALICE);
    sockets[0]!.open();
    sockets[0]!.notify(999, Buffer.from('stray').toString('base64'));
    expect(updates).toHaveLength(0);
  });

  it('re-subscribes everything after a reconnect', async () => {
    // A socket that comes back with none of its subscriptions looks healthy and
    // delivers nothing, which is the worst of both.
    const { subscription, sockets } = harness();
    subscription.start();
    subscription.watch(ALICE);
    subscription.watch(BOB);
    sockets[0]!.open();
    sockets[0]!.onclose?.({});

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sockets.length).toBeGreaterThan(1);

    const fresh = sockets[sockets.length - 1]!;
    fresh.open();
    const addresses = fresh
      .calls()
      .filter((c) => c.method === 'accountSubscribe')
      .map((c) => c.params?.[0]);
    expect(addresses).toContain(ALICE);
    expect(addresses).toContain(BOB);
  });

  it('does not deliver an account after it is unwatched', () => {
    const { subscription, sockets, updates } = harness();
    subscription.start();
    subscription.watch(ALICE);
    const socket = sockets[0]!;
    socket.open();
    const id = socket.calls().find((c) => c.method === 'accountSubscribe')!.id!;
    socket.reply(id, 7);

    subscription.unwatch(ALICE);
    socket.notify(7, Buffer.from('late').toString('base64'));
    expect(updates).toHaveLength(0);
  });

  it('tells the node to stop sending when a token is closed', () => {
    const { subscription, sockets } = harness();
    subscription.start();
    subscription.watch(ALICE);
    const socket = sockets[0]!;
    socket.open();
    socket.reply(socket.calls().find((c) => c.method === 'accountSubscribe')!.id!, 7);

    subscription.unwatch(ALICE);
    expect(socket.calls().some((c) => c.method === 'accountUnsubscribe')).toBe(true);
  });

  it('watches the same account only once', () => {
    const { subscription, sockets } = harness();
    subscription.start();
    subscription.watch(ALICE);
    subscription.watch(ALICE);
    sockets[0]!.open();
    const count = sockets[0]!.calls().filter((c) => c.method === 'accountSubscribe').length;
    expect(count).toBe(1);
  });

  it('remembers what to watch when asked before the socket opens', () => {
    const { subscription, sockets } = harness();
    subscription.watch(ALICE);
    subscription.start();
    sockets[0]!.open();
    expect(sockets[0]!.calls().some((c) => c.params?.[0] === ALICE)).toBe(true);
  });

  it('counts only what the node has confirmed', () => {
    const { subscription, sockets } = harness();
    subscription.start();
    subscription.watch(ALICE);
    const socket = sockets[0]!;
    socket.open();
    expect(subscription.active).toBe(0);
    socket.reply(socket.calls().find((c) => c.method === 'accountSubscribe')!.id!, 5);
    expect(subscription.active).toBe(1);
  });
});
