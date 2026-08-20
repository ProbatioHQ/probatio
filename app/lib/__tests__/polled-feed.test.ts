import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * New launches, from pump.fun rather than from the chain.
 *
 * The socket this replaces subscribed to every transaction touching the
 * pump.fun program to pick out the handful that are launches. It was billed per
 * message, it ran whether anybody was on the site or not, and it emptied a
 * month of credits in six days. The list of coins by creation time is the same
 * data from the people who made it, and costs nothing.
 */

const recorded: unknown[][] = [];
const published: unknown[][] = [];

vi.mock('../db', () => ({ db: async () => ({}) }));
let writesFail = false;
vi.mock('@probatio/db', () => ({
  recordLaunches: async (_client: unknown, batch: unknown[]) => {
    if (writesFail) throw new Error('database is busy');
    recorded.push(batch);
    return batch.length;
  },
}));
vi.mock('../launch-stream', () => ({
  publishLaunches: (items: unknown[]) => void published.push(items),
}));
vi.mock('../token-images', () => ({ resolveLaunchImages: async () => undefined }));
vi.mock('../health', () => ({
  reportFeedRunning: () => undefined,
  reportFeedState: (connected: boolean) => void states.push(connected),
  reportFeedNotification: () => void notifications.push(1),
}));

const states: boolean[] = [];
const notifications: number[] = [];

const NOW = 1_787_000_000_000;

function coin(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mint: '9Hz3QeJfNaRZsiwGL3rT8edrLG73qV3rd2eCGM5opump',
    bonding_curve: '5zmxS1k21WkYj9shJbe5s4huHsGeprwoRiF1zD8ifb2m',
    creator: '9hY3VTjB1xab2rcA8kXGxdvWYquAak2sjA5GfMV6QWwn',
    name: 'globglogabgalab',
    symbol: 'glob',
    metadata_uri: 'https://example.test/metadata.json',
    created_timestamp: NOW - 1_000,
    ...over,
  };
}

function serving(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

beforeEach(async () => {
  recorded.length = 0;
  published.length = 0;
  states.length = 0;
  notifications.length = 0;
  writesFail = false;
  const { resetPolledFeed } = await import('../polled-feed');
  resetPolledFeed();
});

describe('reading launches off the list', () => {
  it('turns a coin into the launch row the feed already stores', async () => {
    const { pollLaunches } = await import('../polled-feed');
    expect(await pollLaunches(serving([coin()]), NOW)).toBe(1);

    expect(recorded[0]).toEqual([
      {
        mint: '9Hz3QeJfNaRZsiwGL3rT8edrLG73qV3rd2eCGM5opump',
        bondingCurve: '5zmxS1k21WkYj9shJbe5s4huHsGeprwoRiF1zD8ifb2m',
        creator: '9hY3VTjB1xab2rcA8kXGxdvWYquAak2sjA5GfMV6QWwn',
        name: 'globglogabgalab',
        symbol: 'glob',
        uri: 'https://example.test/metadata.json',
        launchedAt: NOW - 1_000,
        slot: null,
      },
    ]);
  });

  /*
   * The socket knew which slot a launch landed in because it was reading the
   * chain. This is reading a list. The column is nullable precisely so a source
   * that does not know can say so, rather than write a plausible number nobody
   * can check.
   */
  it('says it does not know the slot rather than inventing one', async () => {
    const { pollLaunches } = await import('../polled-feed');
    await pollLaunches(serving([coin()]), NOW);
    expect((recorded[0] as { slot: unknown }[])[0]?.slot).toBeNull();
  });

  /*
   * Every poll returns the same newest fifty, most of which were in the last
   * one. Without this the feed would republish the whole page every ten
   * seconds.
   */
  it('reports each launch once, however many times it is listed', async () => {
    const { pollLaunches } = await import('../polled-feed');
    const page = [coin({ mint: 'aaa' }), coin({ mint: 'bbb' })];

    expect(await pollLaunches(serving(page), NOW)).toBe(2);
    expect(await pollLaunches(serving(page), NOW)).toBe(0);
    expect(recorded).toHaveLength(1);

    expect(await pollLaunches(serving([coin({ mint: 'ccc' }), ...page]), NOW)).toBe(1);
    expect((recorded[1] as { mint: string }[]).map((one) => one.mint)).toEqual(['ccc']);
  });

  /*
   * The list arrives newest first, and a feed reads in the order things
   * actually happened.
   */
  it('writes them oldest first', async () => {
    const { pollLaunches } = await import('../polled-feed');
    await pollLaunches(
      serving([
        coin({ mint: 'new', created_timestamp: NOW - 1_000 }),
        coin({ mint: 'old', created_timestamp: NOW - 9_000 }),
      ]),
      NOW,
    );
    expect((recorded[0] as { mint: string }[]).map((one) => one.mint)).toEqual(['old', 'new']);
  });

  /*
   * A launch with no mint or no curve cannot be traded or priced, so it is
   * dropped rather than written as a row every later read has to special case.
   */
  it('drops a coin it could not trade', async () => {
    const { pollLaunches } = await import('../polled-feed');
    await pollLaunches(
      serving([coin({ mint: '' }), coin({ bonding_curve: null, mint: 'x' }), coin({ mint: 'ok' })]),
      NOW,
    );
    expect((recorded[0] as { mint: string }[]).map((one) => one.mint)).toEqual(['ok']);
  });

  it('calls a missing timestamp now, rather than 1970', async () => {
    const { pollLaunches } = await import('../polled-feed');
    await pollLaunches(serving([coin({ created_timestamp: null })]), NOW);
    expect((recorded[0] as { launchedAt: number }[])[0]?.launchedAt).toBe(NOW);
  });

  /*
   * Published only after the write, so a tab never shows a launch that failed
   * to persist and vanishes on the next reload.
   */
  it('does not announce a launch it failed to store', async () => {
    const { pollLaunches } = await import('../polled-feed');
    writesFail = true;
    try {
      expect(await pollLaunches(serving([coin()]), NOW)).toBe(0);
      expect(published).toEqual([]);
    } finally {
      writesFail = false;
    }
  });
});

describe('when pump.fun is unhappy', () => {
  it('records the outage rather than only logging it', async () => {
    const { pollLaunches } = await import('../polled-feed');
    expect(await pollLaunches(serving([], 502), NOW)).toBe(0);
    expect(states).toEqual([false]);
  });

  it('survives a refusal and reads the next answer', async () => {
    const { pollLaunches } = await import('../polled-feed');
    await pollLaunches((async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch, NOW);
    expect(states).toEqual([false]);

    expect(await pollLaunches(serving([coin()]), NOW)).toBe(1);
    expect(states).toEqual([false, true]);
  });

  /*
   * A poll that answered is proof the source is alive whether or not anything
   * was new. The silence watchdog exists to catch a feed that is connected and
   * delivering nothing, and a quiet minute on pump.fun is not that.
   */
  it('counts a quiet poll as the feed being alive', async () => {
    const { pollLaunches } = await import('../polled-feed');
    await pollLaunches(serving([]), NOW);
    expect(notifications).toHaveLength(1);
    expect(states).toEqual([true]);
  });

  it('ignores an answer that is not a list', async () => {
    const { pollLaunches } = await import('../polled-feed');
    expect(await pollLaunches(serving({ error: 'nope' }), NOW)).toBe(0);
    expect(recorded).toEqual([]);
  });
});
