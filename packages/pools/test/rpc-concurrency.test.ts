import { describe, expect, it } from 'vitest';
import { RpcClient } from '../src/rpc';

/**
 * The in-flight cap is what keeps a launch spike from opening sockets without
 * bound against one endpoint. These pin that it actually bounds concurrency and
 * still lets every call through eventually.
 */

/** A fetch that parks until released, so concurrency can be observed. */
function controllableFetch() {
  let inFlight = 0;
  let peak = 0;
  const releases: Array<() => void> = [];

  const impl = (async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise<void>((resolve) => releases.push(resolve));
    inFlight -= 1;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ jsonrpc: '2.0', id: 1, result: 1 }),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  return {
    impl,
    peak: () => peak,
    parked: () => releases.length,
    releaseAll: () => {
      while (releases.length) releases.shift()!();
    },
  };
}

describe('RpcClient maxConcurrent', () => {
  it('never runs more calls in flight than the cap', async () => {
    const fetch = controllableFetch();
    const client = new RpcClient({ endpoint: 'http://x', maxConcurrent: 2, fetchImpl: fetch.impl });

    const calls = Promise.all(Array.from({ length: 6 }, () => client.getSlot()));

    // Let the first wave reach fetch, then confirm only the cap got through.
    await new Promise((r) => setTimeout(r, 10));
    expect(fetch.parked()).toBe(2);

    fetch.releaseAll();
    // Drain the rest in waves as slots free up.
    for (let i = 0; i < 4; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
      fetch.releaseAll();
    }

    await calls;
    expect(fetch.peak()).toBe(2);
  });

  it('lets every call through when no cap is set', async () => {
    const fetch = controllableFetch();
    const client = new RpcClient({ endpoint: 'http://x', fetchImpl: fetch.impl });

    const calls = Promise.all(Array.from({ length: 5 }, () => client.getSlot()));
    await new Promise((r) => setTimeout(r, 10));
    expect(fetch.parked()).toBe(5);

    fetch.releaseAll();
    await calls;
    expect(fetch.peak()).toBe(5);
  });
});
