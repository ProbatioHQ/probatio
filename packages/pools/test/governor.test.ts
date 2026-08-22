import { beforeEach, describe, expect, it } from 'vitest';
import { RpcClient, RpcGovernor, creditsFor, governorFor, resetGovernors } from '../src/index';

/**
 * One budget for the whole process.
 *
 * Every worker in the app paces itself and every one of them has an honest
 * reason for the number it chose. What the endpoint saw was the sum: about
 * ninety-six requests a second, against a plan that allows three point eight
 * six credits a second. That is not a spike to be smoothed out, it is
 * twenty-five times the budget, and it emptied a month of credits in under a
 * week. The provider halted the account, and the site truthfully reported that
 * it could not read the chain while nothing was wrong with the chain.
 *
 * So the pace comes from the allowance, and a call that costs ten credits waits
 * ten times as long as one that costs one.
 */

/** A clock a test drives, so none of this waits in real time. */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void>; slept: number[] } {
  let time = 1_000_000;
  const slept: number[] = [];
  return {
    now: () => time,
    sleep: async (ms: number) => {
      slept.push(ms);
      time += ms;
    },
    slept,
  };
}

/** A round base, so the arithmetic below is about the rules and not the plan. */
const BASE = 100;

beforeEach(() => resetGovernors());

describe('spending at the rate the plan affords', () => {
  /*
   * The number that was missing from the whole system. Ten million credits a
   * month is three point eight six a second, and nothing in the code knew it.
   */
  it('derives its pace from the allowance rather than a constant', () => {
    const perSecond = (10_000_000 / (30 * 86_400)) * 0.6;
    expect(new RpcGovernor().stats().baseMs).toBe(Math.round(1_000 / perSecond));
  });

  it('makes concurrent callers queue rather than fire together', async () => {
    const clock = fakeClock();
    const governor = new RpcGovernor(clock.now, BASE);

    // Three callers arriving in the same instant. The first goes straight out
    // and the others take the next slots: a burst becomes a queue.
    await governor.admit('getSlot', clock.sleep);
    await governor.admit('getSlot', clock.sleep);
    await governor.admit('getSlot', clock.sleep);

    expect(clock.slept).toEqual([BASE, BASE]);
  });

  /*
   * Not every request is one credit. A budget that counted requests would be
   * wrong by exactly the amount that matters: the calls that walk a wallet's
   * history and scan a program's accounts are what emptied the plan.
   */
  it('charges an expensive call what it costs', async () => {
    const clock = fakeClock();
    const governor = new RpcGovernor(clock.now, BASE);

    expect(creditsFor('getProgramAccounts')).toBe(20);
    expect(creditsFor('getSignaturesForAddress')).toBe(10);
    expect(creditsFor('getAccountInfo')).toBe(1);

    await governor.admit('getProgramAccounts', clock.sleep);
    await governor.admit('getSlot', clock.sleep);
    expect(clock.slept).toEqual([BASE * 20]);
    expect(governor.stats().credits).toBe(21);
  });

  it('does not delay a caller that arrives after the gap has passed', async () => {
    const clock = fakeClock();
    const governor = new RpcGovernor(clock.now, BASE);

    await governor.admit('getSlot', clock.sleep);
    await clock.sleep(5_000);
    clock.slept.length = 0;
    await governor.admit('getSlot', clock.sleep);

    expect(clock.slept).toEqual([]);
  });
});

describe('finding the ceiling', () => {
  /*
   * The allowance is what is paid for; the endpoint decides what it will serve
   * at any given moment, and only it knows that.
   */
  it('widens the gap every time the endpoint refuses', () => {
    const governor = new RpcGovernor(Date.now, BASE);

    expect(governor.stats().floorMs).toBe(BASE);
    governor.refused();
    expect(governor.stats().floorMs).toBe(BASE * 2);
    governor.refused();
    expect(governor.stats().floorMs).toBe(BASE * 4);
  });

  it('never widens past a ceiling of its own', () => {
    const governor = new RpcGovernor(Date.now, BASE);
    for (let index = 0; index < 40; index += 1) governor.refused();
    expect(governor.stats().floorMs).toBe(10_000);
  });

  /*
   * Fast to retreat, slow to advance. The other way round oscillates between
   * hammering and sulking, and never settles anywhere useful.
   */
  it('gives the gap back only after a long run of successes', () => {
    const governor = new RpcGovernor(Date.now, BASE);
    governor.refused();
    governor.refused();
    expect(governor.stats().floorMs).toBe(400);

    for (let index = 0; index < 39; index += 1) governor.served();
    expect(governor.stats().floorMs).toBe(400);

    governor.served();
    expect(governor.stats().floorMs).toBe(320);
  });

  /*
   * The floor is allowed to widen when the endpoint pushes back, and never to
   * narrow past what the plan affords. Recovering below that is how the month
   * gets spent in a week.
   */
  it('never goes faster than the plan, however well things are going', () => {
    const governor = new RpcGovernor(Date.now, BASE);
    for (let index = 0; index < 500; index += 1) governor.served();
    expect(governor.stats().floorMs).toBe(BASE);
  });

  it('forgets a run of successes as soon as it is refused again', () => {
    const governor = new RpcGovernor(Date.now, BASE);
    governor.refused();
    for (let index = 0; index < 39; index += 1) governor.served();
    governor.refused();
    for (let index = 0; index < 39; index += 1) governor.served();
    // Two refusals and never forty successes in a row, so nothing is given back.
    expect(governor.stats().floorMs).toBe(BASE * 4);
  });
});

describe('retreating together', () => {
  /*
   * The failure this exists to prevent. Before it, a refusal taught one client
   * to back off while eleven others carried straight on into the same wall,
   * which is how a limit becomes an outage.
   */
  it('pauses every background caller, not just the one that was refused', async () => {
    const clock = fakeClock();
    const governor = new RpcGovernor(clock.now, BASE);

    governor.refused();
    expect(governor.stats().cooling).toBe(true);

    await governor.admit('getSlot', clock.sleep);
    expect(clock.slept[0]).toBe(1_000);
  });

  it('waits as long as the server asked, not as long as it guessed', async () => {
    const clock = fakeClock();
    const governor = new RpcGovernor(clock.now, BASE);

    governor.refused(9_000);
    await governor.admit('getSlot', clock.sleep);
    expect(clock.slept[0]).toBe(9_000);
  });

  it('will not be held for ever by an absurd Retry-After', async () => {
    const clock = fakeClock();
    const governor = new RpcGovernor(clock.now, BASE);

    governor.refused(600_000);
    await governor.admit('getSlot', clock.sleep);
    expect(clock.slept[0]).toBe(60_000);
  });

  /*
   * A refusal arriving while somebody is already waiting extends the cooldown,
   * and a single sleep would let that caller through into the wall everybody
   * else had just backed away from.
   */
  it('keeps waiting when the cooldown is extended underneath it', async () => {
    const clock = fakeClock();
    const governor = new RpcGovernor(clock.now, BASE);
    let extended = false;

    governor.refused(1_000);
    const sleep = async (ms: number): Promise<void> => {
      await clock.sleep(ms);
      if (!extended) {
        extended = true;
        governor.refused(1_000);
      }
    };

    await governor.admit('getSlot', sleep);
    expect(clock.slept).toEqual([1_000, 1_000]);
  });
});

describe('who it applies to', () => {
  const endpoint = 'https://rpc.example/key';

  function respond(status: number): typeof fetch {
    return (async () =>
      new Response(status === 200 ? JSON.stringify({ result: 1 }) : 'no', {
        status,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
  }

  it('holds a background caller and lets an interactive one straight through', async () => {
    const slept: number[] = [];
    const sleep = async (ms: number): Promise<void> => void slept.push(ms);

    const background = new RpcClient({
      endpoint,
      priority: 'background',
      fetchImpl: respond(200),
      sleepImpl: sleep,
    });
    await background.getSlot();
    await background.getSlot();
    // A real clock runs under this one, so the gap is up to the floor rather
    // than exactly it. That there is a gap at all is the claim.
    expect(slept).toHaveLength(1);
    expect(slept[0]).toBeGreaterThan(0);

    /*
     * Somebody clicking buy is waiting, their traffic is a rounding error next
     * to the sweeps, and the entire point of throttling background work is that
     * the request path keeps working while it happens.
     */
    slept.length = 0;
    const interactive = new RpcClient({ endpoint, fetchImpl: respond(200), sleepImpl: sleep });
    await interactive.getSlot();
    await interactive.getSlot();
    expect(slept).toEqual([]);
  });

  /*
   * A 429 on the request path is the strongest evidence there is that the
   * sweeps need to get out of the way, so it counts even though the caller that
   * provoked it is never slowed down itself.
   */
  it('learns from an interactive refusal even though it never throttles one', async () => {
    const client = new RpcClient({
      endpoint,
      maxRetries: 0,
      fetchImpl: respond(429),
      sleepImpl: async () => undefined,
    });

    const before = governorFor(endpoint).stats().floorMs;
    await expect(client.getSlot()).rejects.toThrow('HTTP 429');
    expect(governorFor(endpoint).stats().floorMs).toBe(before * 2);
  });

  it('keeps one endpoint’s opinion out of another’s', async () => {
    const client = new RpcClient({
      endpoint,
      maxRetries: 0,
      fetchImpl: respond(429),
      sleepImpl: async () => undefined,
    });
    const base = governorFor('https://other.example').stats().baseMs;
    await expect(client.getSlot()).rejects.toThrow();

    expect(governorFor(endpoint).stats().floorMs).toBe(base * 2);
    expect(governorFor('https://other.example').stats().floorMs).toBe(base);
  });

  it('does not treat a plain error as a reason to slow everything down', async () => {
    const client = new RpcClient({
      endpoint,
      maxRetries: 0,
      fetchImpl: respond(400),
      sleepImpl: async () => undefined,
    });

    const before = governorFor(endpoint).stats().floorMs;
    await expect(client.getSlot()).rejects.toThrow('HTTP 400');
    expect(governorFor(endpoint).stats().floorMs).toBe(before);
  });
});

describe('one budget, not one per bundle', () => {
  /*
   * A bundler compiles this module once per bundle that imports it, so the
   * chart warmer, the curve watcher and the health route can each end up
   * holding a private copy of what was meant to be one shared budget.
   *
   * It showed exactly as it would: the health endpoint reported nothing spent
   * while the provider's meter showed thousands of credits an hour going out.
   * Every worker was being governed and none of them together, which is the
   * same failure this module exists to fix, one level down.
   */
  it('hands the same governor to callers that never met', () => {
    const endpoint = 'https://shared.example';
    const first = governorFor(endpoint);
    first.refused();

    // A second importer, which in production is a different bundle entirely.
    expect(governorFor(endpoint)).toBe(first);
    expect(governorFor(endpoint).stats().refusals).toBe(1);
  });

  it('lives somewhere a second copy of this module would find it', () => {
    governorFor('https://global.example');
    const shared = (globalThis as Record<symbol, unknown>)[
      Symbol.for('probatio.rpc-governors')
    ] as Map<string, unknown>;

    expect(shared).toBeInstanceOf(Map);
    expect(shared.has('https://global.example')).toBe(true);
  });

  it('is still cleared between tests, wherever it lives', () => {
    governorFor('https://reset.example').refused();
    resetGovernors();
    expect(governorFor('https://reset.example').stats().refusals).toBe(0);
  });
});
