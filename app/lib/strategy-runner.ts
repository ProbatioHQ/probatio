import 'server-only';
import { marketCapLamports, priceFromReserves } from '@probatio/candles';
import {
  automatedTradesSince,
  creatorLaunchCounts,
  ensureAccount,
  getManyTokenMetadata,
  isSuspended,
  lastPrices,
  launchedAtMs,
  newLaunches,
  openPositions,
  recordStrategyEvent,
  currentRankedSeason,
  hasEntered,
  launchBundlesFor,
  recordLaunchBundle,
  socialReuseFor,
  runningStrategies,
  staleRunningStrategies,
  stopStrategy,
  type AccountRow,
  type Client,
  type PositionRow,
  type StrategyRow,
} from '@probatio/db';
import {
  PUMPFUN_TOKEN_TOTAL_SUPPLY,
  PoolReader,
  RpcClient,
  bondingCurveAddress,
  decodeTokenAccount,
  holderCount,
  launchBundle,
} from '@probatio/pools';
import {
  DAILY_TRADE_CAP,
  QuoteError,
  exitDecision,
  matchesEntry,
  needsBundle,
  needsCreatorHolding,
  needsHolders,
  quoteSell,
  readStoredRules,
  sizeFor,
  type Candidate,
  type StrategyRules,
} from '@probatio/sim';
import { db } from './db';
import { rpcEndpoint, hasDedicatedRpc } from './env';
import { executeTrade } from './execute-trade';
import { ranking } from './explore';
import { seasonTradingOpen, whyNotOpen } from './season-open';
import { noteViewed } from './watched';

/**
 * Strategies, run on our clock so a trader's laptop does not have to be open.
 *
 * A season lasts a fortnight. Anybody who has to keep a program running for that
 * long to compete will not compete, so the rules people write in the form are
 * evaluated here, on a server, and the orders they produce go through exactly
 * the path a click goes through: `executeTrade`, the season's latency, the pool
 * read twice, the same sealed record. There is no faster lane for a strategy and
 * no separate table its trades land in.
 *
 * WHAT KEEPS THIS AFFORDABLE
 *
 * Every fill reads the chain twice, and that is the only thing here that costs
 * anything. So the loop is built so that a strategy which is *not* trading costs
 * nothing at all:
 *
 *   Entry conditions are checked against a candidate list assembled from what
 *   the site already computes for its own pages — the launch table and the
 *   explore ranking, both cached, neither of them a chain read. A thousand idle
 *   strategies do a thousand comparisons in memory and read nothing.
 *
 *   Exits are screened against the last known price, which is free, and only
 *   confirmed against the chain when the screen says a level is plausibly
 *   crossed. The confirmation matters: a rule says "leave when a real exit
 *   returns this much", and the last known price is a mid, which is not a price
 *   anybody can get. Selling on the screen alone would fire the rule at a number
 *   nobody could have realised, which is the exact dishonesty the backtester
 *   exists to avoid. The screen decides when to look; the quote decides.
 *
 * WHAT BOUNDS THE DAMAGE
 *
 * A strategy that enters and leaves every few seconds does not merely trade
 * badly, it spends a month of the site's RPC allowance by itself in a day. So
 * there is a hard daily count, enforced by counting the trades rather than by
 * keeping a total that a restart could lose.
 */

/** Off without a dedicated endpoint, like every other background reader. */
const ENABLED = process.env['PROBATIO_DISABLE_STRATEGIES'] !== '1' && hasDedicatedRpc();

/**
 * How often to look.
 *
 * Fifteen seconds. Slower and a stop loss on a token that halves in a minute is
 * a stop loss in name only; faster buys very little, because the free price this
 * screens against is itself refreshed every six seconds and a check against a
 * number that has not changed is a check that cannot decide anything new.
 */
const TICK_MS = Number(process.env['PROBATIO_STRATEGY_INTERVAL_MS'] ?? '15000');

/**
 * How close to a level the free screen has to be before the chain is asked.
 *
 * The screen is a mid price and a real exit is always worse than mid, by the
 * fee and by this position's own impact. So screening exactly at the level would
 * ask too late on the way down and the stop would fire further under water than
 * it was set. Five hundred basis points of margin is comfortably more than a
 * fill's own cost on anything liquid enough to be worth trading, and the price
 * of being wrong about it is one extra chain read that answers "not yet".
 */
const SCREEN_MARGIN_BPS = 500;

/** How many tokens to consider per strategy per tick. */
const CANDIDATES = 40;

/** Nothing older than this is a usable screening price, in seconds. */
const PRICE_MAX_AGE_SECONDS = 300;

/**
 * How often a position with no screening price may be quoted against the chain.
 *
 * The screen is what makes this loop cheap, and a position nothing has priced in
 * five minutes has no screen. The honest response to that is to pay for the
 * answer rather than to guess — but paying for it on every tick is four reads a
 * minute for every unpriced position, which on a handful of them is the entire
 * saving handed back. So an unpriced position is quoted on a slower clock, and
 * the cost of that is a stop that may fire a minute late on a token nothing else
 * on the site is watching.
 */
const BLIND_QUOTE_MS = 90_000;

/**
 * How long a holder count is worth keeping.
 *
 * Half a minute. Unlike a launch slot, whose answer is fixed for ever, this
 * changes every few seconds on anything worth buying. Held only long enough
 * that several strategies screening the same token in the same pass share one
 * scan rather than each paying for their own.
 */
const HOLDERS_TTL_MS = 30_000;

const DAY_MS = 24 * 60 * 60 * 1_000;
const BPS = 10_000n;

/**
 * When each position was last quoted blind, keyed by account and mint.
 *
 * In memory rather than a table: it bounds a cost, and a restart forgetting it
 * costs one extra read per position. Trimmed with the strategies that own the
 * positions, so it cannot outgrow the set of things being held.
 */
const blindQuotes = new Map<string, number>();

/** Holder counts, briefly. See HOLDERS_TTL_MS. */
const holderCounts = new Map<string, { holders: number | null; at: number }>();

function mayQuoteBlind(accountId: number, mint: string, now: number): boolean {
  const key = `${accountId}:${mint}`;
  const last = blindQuotes.get(key) ?? 0;
  if (now - last < BLIND_QUOTE_MS) return false;
  blindQuotes.set(key, now);
  // Bounded by what is actually held, so it cannot leak across a long uptime.
  if (blindQuotes.size > 4_000) {
    for (const [held, at] of blindQuotes) {
      if (now - at > BLIND_QUOTE_MS * 4) blindQuotes.delete(held);
    }
  }
  return true;
}

interface RunnerState {
  timer: ReturnType<typeof setInterval> | null;
  busy: boolean;
  ticks: number;
  entered: number;
  exited: number;
  failures: number;
  lastError: string | null;
}

const KEY = Symbol.for('probatio.strategy-runner');

function state(): RunnerState {
  const store = globalThis as unknown as Record<symbol, RunnerState | undefined>;
  const existing = store[KEY];
  if (existing) return existing;
  const fresh: RunnerState = {
    timer: null,
    busy: false,
    ticks: 0,
    entered: 0,
    exited: 0,
    failures: 0,
    lastError: null,
  };
  store[KEY] = fresh;
  return fresh;
}

export function strategyRunnerStatus(): Omit<RunnerState, 'timer'> {
  const { timer: _timer, ...rest } = state();
  return rest;
}

/*
 * Its own patient client, for the reason written out in house-traders.ts: these
 * reads have nobody waiting on them, and sharing a client with the request path
 * means a person's trade queues behind a strategy's.
 */
let runnerRpc: RpcClient | null = null;
let runnerReader: PoolReader | null = null;

/** The same patient client the reader is built on, for the calls it does not make. */
function rpc(): RpcClient {
  reader();
  return runnerRpc!;
}

function reader(): PoolReader {
  runnerRpc ??= new RpcClient({
    endpoint: rpcEndpoint(),
    timeoutMs: 15_000,
    minIntervalMs: 150,
    maxRetries: 6,
    priority: 'background',
  });
  runnerReader ??= new PoolReader(runnerRpc);
  return runnerReader;
}

function market(mint: string): ReturnType<PoolReader['resolve']> {
  return reader().resolve(mint);
}

// ---------------------------------------------------------------------------
// what there is to buy
// ---------------------------------------------------------------------------

/**
 * Tokens a strategy could enter, with enough about each to check a condition.
 *
 * Assembled entirely from cached reads. The launch table carries a curve's
 * reserves, which are its liquidity and its market cap; the explore ranking
 * carries what has moved, which is where a graduated token's numbers come from.
 * Neither costs a credit, which is what makes a waiting strategy free.
 */
/** A candidate, plus the creator this side needs to go and ask about them. */
type Scanned = Candidate & { readonly creator: string | null };

async function candidates(client: Client, now: number): Promise<Scanned[]> {
  const out = new Map<string, Scanned>();

  const fresh = await newLaunches(client, CANDIDATES);

  /*
   * Socials and creator history, in two batched reads for the whole list.
   *
   * Per-token lookups here would turn a free pass into forty queries a tick per
   * strategy, which is the shape of thing that makes an idle strategy expensive
   * and is exactly what this loop is built to avoid.
   */
  const [socials, launchCounts, reuse] = await Promise.all([
    getManyTokenMetadata(client, fresh.map((launch) => launch.mint)),
    creatorLaunchCounts(client, fresh.map((launch) => launch.creator)),
    socialReuseFor(client, fresh.map((launch) => launch.mint)),
  ]);

  for (const launch of fresh) {
    const curve = launch.curve;
    if (!curve || curve.virtualSolReserves === null || curve.virtualTokenReserves === null) continue;

    const ageSeconds = Math.max(0, Math.floor((now - launchedAtMs(launch.launchedAt)) / 1_000));
    /*
     * A curve prices against virtual reserves and can only hand over the real
     * ones, so its depth is the real SOL it holds. Reporting the virtual figure
     * as liquidity would tell a strategy a curve holds thirty SOL when it holds
     * two, and every impact cap in the system exists because that difference is
     * the whole trade.
     */
    out.set(launch.mint, {
      mint: launch.mint,
      ageSeconds,
      liquidityLamports: curve.realSolReserves,
      // Through the one function allowed to turn reserves into a price, so a
      // strategy's idea of a market cap and the chart's cannot differ.
      marketCapLamports: marketCapLamports(
        priceFromReserves(curve.virtualSolReserves, curve.virtualTokenReserves),
        PUMPFUN_TOKEN_TOTAL_SUPPLY,
      ),
      changeBps: null,
      graduated: false,
      ...socialsOf(socials.get(launch.mint)),
      // Absent means this site has not indexed any launch from them, which
      // cannot be true while looking at one of theirs, so it counts as one.
      creatorLaunches: launchCounts.get(launch.creator) ?? 1,
      // Filled in later, and only for what survives everything free.
      creatorHoldingBps: null,
      bundledBps: null,
      holders: null,
      // Absent means the token names no account, which is a different fact from
      // an account nobody else has used.
      socialReuse: reuse.get(launch.mint) ?? null,
      creator: launch.creator,
    });
  }

  try {
    for (const row of await ranking()) {
      if (row.mint === '' || out.has(row.mint)) continue;
      out.set(row.mint, {
        mint: row.mint,
        ageSeconds: Math.max(0, Math.floor((now - launchedAtMs(row.createdAt)) / 1_000)),
        // The board reports these in dollars and this side has no honest rate to
        // convert them with. Null rather than nought: reported as nought they
        // would sail through every ceiling while failing every floor, so a
        // strategy asking for a small market cap would buy every graduated token
        // on the feed.
        liquidityLamports: null,
        marketCapLamports: null,
        changeBps: row.changeH1 === null ? null : Math.round(row.changeH1 * 100),
        graduated: true,
        /*
         * The board carries a token's socials and creator, but not in a form
         * this reads, and a second batched lookup per tick for the whole board
         * is a cost this loop exists to avoid. Unknown rather than assumed, so
         * a strategy asking for an X account simply does not match a board
         * token instead of matching one on a guess.
         */
        hasTwitter: null,
        hasWebsite: null,
        creatorLaunches: null,
        creatorHoldingBps: null,
        bundledBps: null,
        holders: null,
        socialReuse: null,
        creator: null,
      });
    }
  } catch {
    // The board is somebody else's service. Without it there are still launches.
  }

  return [...out.values()];
}

// ---------------------------------------------------------------------------
// leaving a position
// ---------------------------------------------------------------------------

/**
 * Whether a token's metadata names an X account or a site.
 *
 * A blank string is not a link. Launchers write empty fields as often as they
 * omit them, and treating one as a social would pass every token that filled
 * the form in badly.
 */
function socialsOf(
  token: { twitterUrl: string | null; websiteUrl: string | null } | undefined,
): { hasTwitter: boolean | null; hasWebsite: boolean | null } {
  if (!token) return { hasTwitter: null, hasWebsite: null };
  return {
    hasTwitter: (token.twitterUrl ?? '').trim().length > 0,
    hasWebsite: (token.websiteUrl ?? '').trim().length > 0,
  };
}

/**
 * What share of the supply a launcher still holds, in basis points.
 *
 * Every token account they hold for the mint, not just the associated one.
 * Checked against mainnet: of two live holders of the same token, one used the
 * derived associated address and the other held it in a plain account that
 * derivation never names. Reading only the associated account would report zero
 * for the second, and zero is the answer that lets a token through a "dev holds
 * under five percent" rule. A condition that fails open is worse than none.
 *
 * Null when it cannot be read, which the rule then treats as unmet rather than
 * as clean.
 */
async function creatorHoldingBps(creator: string, mint: string): Promise<number | null> {
  try {
    const accounts = await rpc().getTokenAccountsByOwner(creator, mint);
    let held = 0n;
    for (const entry of accounts) {
      try {
        held += decodeTokenAccount(entry.account.data).amount;
      } catch {
        // Another account type under the same owner. Not evidence of anything.
      }
    }
    return Number((held * 10_000n) / PUMPFUN_TOKEN_TOTAL_SUPPLY);
  } catch {
    return null;
  }
}

/**
 * What went in a token's launch slot, from the store or from the chain.
 *
 * Read once per mint, ever. A token's launch slot is over, so the answer cannot
 * change, and a row here — including a row recording that the walk gave up — is
 * the difference between paying for that answer once and paying for it on every
 * pass of every strategy that asks.
 */
async function bundledBpsFor(
  client: Client,
  mint: string,
  known: Map<string, { bundledBps: number | null }>,
  now: number,
): Promise<number | null> {
  const stored = known.get(mint);
  if (stored) return stored.bundledBps;

  let found: Awaited<ReturnType<typeof launchBundle>> = null;
  try {
    found = await launchBundle(rpc(), bondingCurveAddress(mint));
  } catch {
    // Recorded as unreadable below rather than retried on the next pass.
  }

  await recordLaunchBundle(client, {
    mint,
    slot: found?.slot ?? null,
    bought: found?.boughtTokens.toString() ?? null,
    bundledBps: found?.bundledBps ?? null,
    buys: found?.buys ?? null,
    now,
  });
  known.set(mint, { bundledBps: found?.bundledBps ?? null });
  return found?.bundledBps ?? null;
}

/**
 * How many wallets hold a token, from the last half minute or from the chain.
 *
 * The most expensive question a strategy can ask, so it is asked last and its
 * answer is shared. Null on a failed scan, which the rule treats as unmet: a
 * scan that did not finish is not a token nobody holds.
 */
async function holdersFor(mint: string, now: number): Promise<number | null> {
  const held = holderCounts.get(mint);
  if (held && now - held.at < HOLDERS_TTL_MS) return held.holders;

  const found = await holderCount(rpc(), mint);
  holderCounts.set(mint, { holders: found?.holders ?? null, at: now });

  // Bounded, so a long uptime cannot accumulate every mint ever screened.
  if (holderCounts.size > 2_000) {
    for (const [key, entry] of holderCounts) {
      if (now - entry.at > HOLDERS_TTL_MS * 4) holderCounts.delete(key);
    }
  }
  return found?.holders ?? null;
}

function bpsAgainst(value: bigint, cost: bigint): number {
  if (cost <= 0n) return 0;
  return Number(((value - cost) * BPS) / cost);
}

/**
 * What this position would really fetch, right now, from the chain.
 *
 * The number the rule is actually judged on. Null when the pool cannot take the
 * position at all, which is a position still held rather than a position worth
 * nothing, and the runner leaves it alone rather than dumping it into a market
 * that has no room for it.
 */
async function realExit(mint: string, tokens: bigint): Promise<bigint | null> {
  try {
    const resolution = await market(mint);
    if (!resolution.pool) return null;
    return quoteSell(resolution.pool, tokens).solAmount;
  } catch (error) {
    if (error instanceof QuoteError) return null;
    throw error;
  }
}

/**
 * Should this position be closed, and why?
 *
 * Two stages on purpose. The screen is free and decides whether the chain is
 * worth asking; the quote is what the rule is applied to. A timeout needs no
 * quote at all, because a clock is not a price.
 */
async function shouldExit(
  rules: StrategyRules,
  accountId: number,
  position: PositionRow,
  screenPrice: bigint | null,
  now: number,
): Promise<{ readonly leave: true; readonly why: string } | { readonly leave: false }> {
  const cost = BigInt(position.costBasis);
  const tokens = BigInt(position.tokenAmount);
  const heldSeconds = Math.max(0, Math.floor((now - position.openedAt) / 1_000));

  if (
    rules.exit.timeoutSeconds !== undefined &&
    heldSeconds >= rules.exit.timeoutSeconds
  ) {
    return { leave: true, why: `held ${heldSeconds}s, past the ${rules.exit.timeoutSeconds}s timeout` };
  }

  if (rules.exit.takeProfitBps === undefined && rules.exit.stopLossBps === undefined) {
    return { leave: false };
  }

  /*
   * No screening price means no free way to tell whether a level is near, so the
   * answer has to be bought. Rare — a token nothing has priced in five minutes —
   * and rate limited, because buying it every tick would hand back the whole
   * saving the screen exists to make.
   */
  if (screenPrice === null) {
    if (!mayQuoteBlind(accountId, position.mint, now)) return { leave: false };
  } else {
    const atMid = (screenPrice * tokens) / 10n ** 18n;
    const screened = bpsAgainst(atMid, cost);
    const nowhereNear =
      exitDecision(rules.exit, {
        // Widened in both directions, because a mid is optimistic on the way
        // down and a real exit lands below it on the way up.
        movedBps: screened + SCREEN_MARGIN_BPS,
        heldSeconds,
      }) === null &&
      exitDecision(rules.exit, {
        movedBps: screened - SCREEN_MARGIN_BPS,
        heldSeconds,
      }) === null;
    if (nowhereNear) return { leave: false };
  }

  const proceeds = await realExit(position.mint, tokens);
  if (proceeds === null) return { leave: false };

  const moved = bpsAgainst(proceeds, cost);
  const fired = exitDecision(rules.exit, { movedBps: moved, heldSeconds });
  if (fired === null) return { leave: false };

  return {
    leave: true,
    // The number the decision was actually made on, so the log is checkable.
    why: `${fired.replace('_', ' ')} at ${moved} bps on a real exit`,
  };
}

// ---------------------------------------------------------------------------
// one strategy, one tick
// ---------------------------------------------------------------------------

async function runOne(client: Client, strategy: StrategyRow, now: number): Promise<void> {
  let rules: StrategyRules;
  try {
    rules = readStoredRules(strategy.rules, strategy.rulesVersion);
  } catch (error) {
    /*
     * Rules this build cannot read are rules it must not act on. Stopping is
     * the only safe reading: guessing at them would place orders nobody wrote.
     */
    const detail = error instanceof Error ? error.message : String(error);
    await stopStrategy(client, strategy.id, detail, now);
    await recordStrategyEvent(client, strategy.id, {
      at: now, kind: 'stopped', mint: null, detail,
    });
    return;
  }

  /*
   * Entered, or this does not run.
   *
   * `ensureAccount` will happily build an account against any season it is given,
   * because its job is to make sure a row exists rather than to decide who is
   * allowed one. Every request path gets that decision from `activeSeason`, which
   * checks the entry first — but `activeSeason` reads a cookie and there is no
   * request here, so the check has to be made explicitly.
   *
   * Without it, saving a strategy and pressing run was a way into a paid season
   * without paying: the runner would have created a ranked account for somebody
   * who never bought an entry and traded them against people who had.
   */
  if (!(await hasEntered(client, strategy.seasonId, strategy.userPubkey))) {
    const detail = 'you are not entered in this season, so there is nothing for it to trade';
    await stopStrategy(client, strategy.id, detail, now);
    await recordStrategyEvent(client, strategy.id, {
      at: now, kind: 'stopped', mint: null, detail,
    });
    return;
  }

  /*
   * Re-read before every order, never carried across one.
   *
   * `recordTrade` writes the new balance conditionally on the balance the fill
   * was quoted against still being there, which is what stops one trader
   * spending the same SOL twice. Reusing an account row across two orders in one
   * pass therefore does not merely go stale, it guarantees the second order is
   * refused as a race against the first — a strategy would land exactly one
   * trade per tick and log a confusing failure for every other one it tried.
   */
  const freshAccount = (): Promise<AccountRow> =>
    ensureAccount(client, strategy.seasonId, strategy.userPubkey, Date.now());

  const account = await freshAccount();
  const positions = await openPositions(client, account.id);

  /*
   * Ask for these to be priced.
   *
   * A held token nobody is looking at is priced by nothing, and its screen would
   * go stale in minutes. Noting it enrols it in the free pump.fun poll, which is
   * where the screening price comes from and costs nothing.
   */
  for (const position of positions) noteViewed(position.mint, now);

  /*
   * What not to buy, taken before the exits and deliberately not updated by
   * them. A mint sold this pass stays in here, so a strategy cannot sell a
   * position on one rule and buy it straight back on another inside the same
   * fifteen seconds, paying four fees to end up where it started.
   */
  const held = new Set(positions.map((position) => position.mint));
  const prices =
    positions.length === 0
      ? new Map<string, string>()
      : await lastPrices(
          client,
          [...held],
          Math.floor(now / 1_000) - PRICE_MAX_AGE_SECONDS,
        );

  const spentToday = await automatedTradesSince(client, account.id, now - DAY_MS);
  let budget = DAILY_TRADE_CAP - spentToday;

  if (budget <= 0) {
    await recordStrategyEvent(client, strategy.id, {
      at: now,
      kind: 'capped',
      mint: null,
      detail: `${spentToday} automated orders in the last day, and the cap is ${DAILY_TRADE_CAP}. Entries and exits resume as the day rolls forward.`,
    });
    return;
  }

  // ---- exits first. A position that should be closed outranks a new one. ----

  for (const position of positions) {
    if (budget <= 0) break;

    const priced = prices.get(position.mint);
    const verdict = await shouldExit(
      rules,
      account.id,
      position,
      priced === undefined ? null : BigInt(priced),
      now,
    );
    if (!verdict.leave) continue;

    const outcome = await executeTrade({
      client,
      account: await freshAccount(),
      seasonId: strategy.seasonId,
      userPubkey: strategy.userPubkey,
      mint: position.mint,
      side: 'sell',
      size: BigInt(position.tokenAmount),
      market: { atClick: market, atFill: market },
      source: 'form',
      now: Date.now(),
    });

    budget -= 1;
    if (outcome.status === 'filled') {
      state().exited += 1;
      await recordStrategyEvent(client, strategy.id, {
        at: Date.now(), kind: 'exited', mint: position.mint, detail: verdict.why,
      });
    } else {
      await recordStrategyEvent(client, strategy.id, {
        at: Date.now(),
        kind: 'skipped',
        mint: position.mint,
        // A refusal is the most useful line this log can hold.
        detail: `tried to leave (${verdict.why}) and could not: ${describe(outcome)}`,
      });
    }
  }

  // ---- then entries -------------------------------------------------------

  if (budget <= 0) return;

  /*
   * Read again after the exits, because the exits are what changed them. Sizing
   * against the balance from before a sell landed would skip an entry the
   * account can afford, and counting positions from before would leave a slot
   * that has just opened up unused for a whole tick.
   */
  const afterExits = await freshAccount();
  const openNow = await openPositions(client, afterExits.id);
  if (openNow.length >= rules.size.maxOpenPositions) return;

  /*
   * Against the smallest a position can be, not the largest.
   *
   * With conviction sizing the stake is a range, and the balance only has to
   * cover the bottom of it. Checking the ceiling here would stand a strategy
   * down for the rest of the season the moment its balance dipped under the
   * largest bet it is allowed to make, while every bet it actually wanted to
   * place was affordable.
   */
  const balance = BigInt(afterExits.solBalance);
  const least = rules.size.minStakeLamports ?? rules.size.stakeLamports;
  if (balance < least) {
    await recordStrategyEvent(client, strategy.id, {
      at: now,
      kind: 'skipped',
      mint: null,
      detail: `balance is ${(Number(balance) / 1e9).toFixed(3)} SOL and a position is at least ${(Number(least) / 1e9).toFixed(3)} SOL`,
    });
    return;
  }

  const room = Math.min(rules.size.maxOpenPositions - openNow.length, budget);
  let opened = 0;

  const wantsHolding = needsCreatorHolding(rules.entry);
  const wantsBundle = needsBundle(rules.entry);
  const wantsHolders = needsHolders(rules.entry);

  const scanned = await candidates(client, now);
  /* Whatever is already known, in one read for the whole list. */
  const bundles = wantsBundle
    ? new Map(
        [...(await launchBundlesFor(client, scanned.map((entry) => entry.mint)))].map(
          ([mint, row]) => [mint, { bundledBps: row.bundledBps }],
        ),
      )
    : new Map<string, { bundledBps: number | null }>();

  for (const candidate of scanned) {
    if (opened >= room) break;
    if (held.has(candidate.mint)) continue;

    /*
     * Everything free first, then pay for what is left.
     *
     * Checking the launcher's holdings needs a chain read, and doing it for
     * every candidate on every pass is exactly the cost this loop is arranged
     * to avoid. The conditions above usually cut a list of forty to one or two,
     * and paying for those is nothing.
     */
    const free = matchesEntry(
      {
        ...rules.entry,
        maxCreatorHoldingBps: undefined,
        maxBundleBps: undefined,
        minHolders: undefined,
      },
      candidate,
    );
    if (!free.ok) continue;

    let checked = candidate;
    if (wantsBundle) {
      checked = { ...checked, bundledBps: await bundledBpsFor(client, candidate.mint, bundles, now) };
    }
    if (wantsHolding) {
      if (candidate.creator === null) continue;
      const bps = await creatorHoldingBps(candidate.creator, candidate.mint);
      checked = { ...checked, creatorHoldingBps: bps };
    }
    /*
     * Last, because it is the dearest. A token that already failed on its
     * bundle or its launcher never costs a program scan at all.
     */
    if (wantsHolders) {
      checked = { ...checked, holders: await holdersFor(candidate.mint, now) };
    }

    const verdict = matchesEntry(rules.entry, checked);
    if (!verdict.ok) continue;

    // Checked before the chain is read, so a refusal costs nothing.
    if (await isSuspended(client, candidate.mint)) continue;

    /*
     * Sized against the same candidate the conditions were judged on, so the
     * margins scored here are the ones that were actually cleared, including
     * the chain reads filled in above.
     */
    const sizing = sizeFor(rules.size, rules.entry, checked);

    /*
     * One read, used for both the affordability check and the order.
     *
     * Read here rather than once for the whole pass, because several entries in
     * one pass spend the balance down and `recordTrade` writes conditionally on
     * the exact balance it was quoted against. Reading twice in a row would be
     * two queries for one answer, so the row that answers "can it afford this"
     * is the same row the order is placed with.
     *
     * A position it can no longer afford ends the pass rather than being bought
     * smaller: a size nobody chose is not a rule anybody wrote.
     */
    const funds = await freshAccount();
    if (BigInt(funds.solBalance) < sizing.lamports) break;

    const outcome = await executeTrade({
      client,
      account: funds,
      seasonId: strategy.seasonId,
      userPubkey: strategy.userPubkey,
      mint: candidate.mint,
      side: 'buy',
      size: sizing.lamports,
      market: { atClick: market, atFill: market },
      source: 'form',
      now: Date.now(),
    });

    opened += 1;
    if (outcome.status === 'filled') {
      state().entered += 1;
      held.add(candidate.mint);
      await recordStrategyEvent(client, strategy.id, {
        at: Date.now(),
        kind: 'entered',
        mint: candidate.mint,
        detail:
          sizing.confidence === null
            ? `bought ${(Number(sizing.lamports) / 1e9).toFixed(3)} SOL at ${outcome.fill.filled.priceImpactBps} bps of impact`
            : `bought ${(Number(sizing.lamports) / 1e9).toFixed(3)} SOL at ${outcome.fill.filled.priceImpactBps} bps of impact, ${sizing.why}`,
      });
    } else {
      await recordStrategyEvent(client, strategy.id, {
        at: Date.now(), kind: 'skipped', mint: candidate.mint, detail: describe(outcome),
      });
    }
  }
}

function describe(outcome: Awaited<ReturnType<typeof executeTrade>>): string {
  return outcome.status === 'filled' ? 'filled' : `${outcome.status}: ${outcome.detail}`;
}

// ---------------------------------------------------------------------------
// the loop
// ---------------------------------------------------------------------------

async function tick(): Promise<void> {
  const current = state();
  if (current.busy) return;
  current.busy = true;

  try {
    const client = await db();
    const now = Date.now();
    const season = await currentRankedSeason(client, now);

    /*
     * Open for trading, which is not the same as `status === 'running'`.
     *
     * The first two days of a season are `entry_open`, and trades placed in
     * them count: `tradingOpen` says so, and every human path in the site asks
     * it rather than the column. This asked the column, so a strategy started
     * on the opening day was stopped within seconds and told the season was no
     * longer running, about a season that had just begun.
     */
    if (!season || !seasonTradingOpen(season, now)) {
      /*
       * No season to trade. Every running strategy is stopped and told why,
       * rather than left marked running against a season that has ended.
       */
      const orphans = season ? await runningStrategies(client, season.id) : [];
      const detail = whyNotOpen(season, now);
      for (const strategy of orphans) {
        await stopStrategy(client, strategy.id, detail, now);
        await recordStrategyEvent(client, strategy.id, {
          at: now, kind: 'stopped', mint: null, detail,
        });
      }
      return;
    }

    current.ticks += 1;

    /*
     * Strategies left running against a season that has finished.
     *
     * A season ending is not an event anything here watches. When one closes and
     * the next opens, the loop below asks for the strategies of the season that
     * is running now and never looks at the previous one's again, so they stay
     * marked running for ever. Nothing breaks, which is precisely why it would
     * have gone unnoticed, and a row asserting something untrue is the one thing
     * this project is not allowed to leave lying around.
     */
    for (const stale of await staleRunningStrategies(client, season.id)) {
      const detail = 'that season has finished, so it stopped';
      await stopStrategy(client, stale.id, detail, now);
      await recordStrategyEvent(client, stale.id, {
        at: now, kind: 'stopped', mint: null, detail,
      });
    }

    for (const strategy of await runningStrategies(client, season.id)) {
      try {
        await runOne(client, strategy, now);
      } catch (error) {
        // One strategy's failure is not the others'. Recorded on the strategy
        // itself so its owner can see it, and counted here so health can.
        current.failures += 1;
        const detail = error instanceof Error ? error.message : String(error);
        current.lastError = detail;
        try {
          await recordStrategyEvent(client, strategy.id, {
            at: Date.now(), kind: 'failed', mint: null, detail,
          });
        } catch {
          // A log that cannot be written must not take the runner down.
        }
      }
    }
  } finally {
    current.busy = false;
  }
}

export function startStrategyRunner(): void {
  const current = state();
  if (current.timer || !ENABLED) return;

  const run = (): void => {
    void tick().catch((error) => {
      current.failures += 1;
      current.lastError = error instanceof Error ? error.message : String(error);
      console.error('[strategies] tick failed', error);
    });
  };

  run();
  current.timer = setInterval(run, TICK_MS);
  current.timer.unref?.();
  console.log('[strategies] running');
}
