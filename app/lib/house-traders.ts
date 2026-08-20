import 'server-only';
import { createHash } from 'node:crypto';
import {
  ConcurrentTradeError,
  claimName,
  clearName,
  ensureAccount,
  ensureFreePlaySeason,
  bondingLaunches,
  isSpent,
  isSuspended,
  openPositions,
  startOver,
  upsertUser,
} from '@probatio/db';
import { PoolReader, RpcClient } from '@probatio/pools';
import { quoteBuy, quoteSell } from '@probatio/sim';
import { background } from './background-write';
import { db } from './db';
import { executeTrade } from './execute-trade';
import { rpcEndpoint } from './env';
import { hasDedicatedRpc } from './env';
import { movingMints, risingMints, topMints } from './explore';
/*
 * Deliberately not the shared client the trade route uses.
 *
 * These read the chain constantly and nobody is waiting on them, so sharing a
 * client with the request path means a person's trade queues behind a house
 * account's, and it means the house loses the race when the endpoint gets
 * busy: six of ninety-one fills were dying on getMultipleAccounts 429 while
 * the walker and the price marker, which have their own patient clients, had
 * none at all.
 *
 * Its own client, paced slowly and patient about refusals. A 429 becomes a
 * wait rather than a lost trade, and the reads a person is waiting on are
 * untouched by any of it.
 */
let houseRpc: RpcClient | null = null;
let houseReader: PoolReader | null = null;

function reader(): PoolReader {
  houseRpc ??= new RpcClient({
    endpoint: rpcEndpoint(),
    timeoutMs: 15_000,
    minIntervalMs: 150,
    maxRetries: 6,
    priority: 'background',
  });
  houseReader ??= new PoolReader(houseRpc);
  return houseReader;
}

/**
 * The two reads a fill needs, taken separately.
 *
 * Separate calls rather than one, because the whole engine rests on the second
 * read happening after the latency wait. Nothing here coalesces, so the fill
 * can never latch onto a read that began before the delay.
 */
function readMarket(mint: string): ReturnType<PoolReader['resolve']> {
  return reader().resolve(mint);
}

/**
 * House accounts, trading for real.
 *
 * A simulator with an empty leaderboard tells a visitor nothing about whether
 * it works, and there is no honest way to fill that board with records nobody
 * made. So these make them. Each one is an ordinary account that buys and sells
 * real pump.fun tokens through the same path a person's click takes: the pool
 * is read, the season's latency is waited out, the fill is quoted against the
 * pool as it stands afterwards, and the result is sealed into the same record
 * anyone can verify.
 *
 * Nothing here is written straight into the tables. Every number on their rows
 * was produced by the engine against a market that really moved, which is the
 * only reason showing them is defensible: the board is not claiming these are
 * strangers who got rich, it is showing the simulator running.
 *
 * FREE PLAY ONLY, AND THAT IS NOT A SETTING
 *
 * They are pinned to the free-play season by construction, never entered into a
 * ranked one. A ranked season charges an entry fee and pays a prize, and house
 * accounts competing in that would be taking money off people who thought they
 * were playing against peers. The board marks the two apart, and this file has
 * no way of reaching the ranked side even by accident.
 */

/** How many accounts to run. Off unless a dedicated endpoint is configured. */
const COUNT = Number(process.env['PROBATIO_HOUSE_TRADERS'] ?? (hasDedicatedRpc() ? '14' : '0'));

/** Below this there is nothing worth opening, in lamports. */
const MIN_TRADE = 15_000_000n;

/**
 * A remainder worth less than this is closed rather than trimmed.
 *
 * Left alone, it was worse than the 0.000 SOL rows it was meant to prevent: a
 * position that is never finished is never a round trip, so the accounts holding
 * them showed no win rate and nothing realized however much they traded.
 */
const DUST = 5_000_000n;

/**
 * The most an account may move the market it is trading, in basis points.
 *
 * A hundred and fifty. This is the number that made the fills nonsense: buys
 * landing at 38.63% impact and sells at 21.80%, so a position bought and sold
 * inside four minutes came back down fifty per cent while the token itself had
 * barely moved. The loss was not the market, it was the account walking up its
 * own order book on the way in and back down it on the way out.
 *
 * A depth cap was already there and did not catch it, because on a bonding
 * curve the reserve it measured is the virtual one. Virtual reserves are far
 * larger than what the curve will actually deliver, so a fortieth of them is
 * still most of the real liquidity. The fix cannot be a fraction of anything
 * that has to be interpreted; it has to be the impact itself, which the engine
 * already computes and which means the same thing on either venue.
 */
const MAX_IMPACT_BPS = 150;

/**
 * Shrink a size until the market can take it.
 *
 * Halving rather than solving, because the engine's quote is the authority on
 * impact and asking it eight times costs nothing: these are pure arithmetic
 * against a pool already in hand, with no read behind them.
 */
function sized(
  pool: Parameters<typeof quoteBuy>[0],
  wanted: bigint,
  side: 'buy' | 'sell',
  floor: bigint,
): bigint {
  let size = wanted;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (size < floor) return 0n;
    try {
      const quote = side === 'buy' ? quoteBuy(pool, size) : quoteSell(pool, size);
      if (quote.priceImpactBps <= MAX_IMPACT_BPS) return size;
    } catch {
      // Refused outright, which is the loudest possible way of saying too big.
    }
    size /= 2n;
  }
  return 0n;
}

/** How often a trade is attempted. One account per tick, in rotation. */
const TICK_MS = Number(process.env['PROBATIO_HOUSE_INTERVAL_MS'] ?? '9000');

/**
 * Deterministic randomness.
 *
 * These have to look like people rather than like a loop, and the first version
 * looked exactly like a loop: every account bought the same token for the same
 * size, sold forty per cent of it, and finished the day on the balance it
 * started with. Four rows of 0.601 SOL and 0.01% impact, one after another, is
 * worse than an empty board because it says out loud that nothing here is real.
 *
 * Seeded rather than random so a restart continues the same characters instead
 * of inventing new ones, and so anything odd on the board can be reproduced.
 */
function rand(...parts: number[]): number {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    hash = Math.imul(hash ^ (part >>> 0), 0x01000193) >>> 0;
    hash ^= hash >>> 13;
    hash = Math.imul(hash, 0x5bd1e995) >>> 0;
    hash ^= hash >>> 15;
  }
  /*
   * A full avalanche at the end, and it is not optional.
   *
   * A single multiply-and-xor per input barely moves for inputs that differ by
   * one, and these are indexed 0 to 13. Checked rather than assumed, and the
   * check was worth running: two accounts came out byte-identical and four more
   * agreed to within a per cent, so fourteen traders were really about five,
   * twice over. Fixing the loop upstairs and leaving this would have produced
   * the same complaint in a different shape.
   */
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
  hash ^= hash >>> 16;
  return (hash >>> 0) / 4294967296;
}

/**
 * Who each account is.
 *
 * Everything that makes two traders look different comes from here: how much
 * they bet, how long they sit on it, how many things they hold at once, and
 * whether they scale out or slam the exit. Derived from the index, so account
 * four is the same character tomorrow as it was today.
 */
interface Character {
  /** Typical buy, in lamports. */
  readonly floor: bigint;
  readonly ceiling: bigint;
  /** Ticks a position is usually held before it is a candidate to sell. */
  readonly patience: number;
  /**
   * How often this one trades at all, relative to the others.
   *
   * Turns went round in strict rotation, so all fourteen made the same number
   * of trades and the board's trade column read 4, 4, 3, 4, 2 all the way down.
   * Nobody trades on a metronome. Some of these barely show up.
   */
  readonly tempo: number;
  /** How many tokens this one is willing to hold at once. */
  readonly width: number;
  /** How much of a position leaves on a sell, in basis points. */
  readonly exit: number;
  /**
   * Which part of the market this one trades, as a fraction of the ranking.
   *
   * The single biggest reason they looked identical. Every account drew from
   * the same list sorted by market cap, so whatever sat near the top got bought
   * by all of them and the feed read as one token repeated. Real traders do not
   * share a watchlist: some only touch the largest names, some live three
   * hundred places down where nobody has heard of anything.
   */
  readonly band: number;
  readonly reach: number;
  /**
   * How much of what it has goes into one entry, in basis points.
   *
   * The board came back flat: fourteen accounts between 9.99 and 10.05 after
   * hours of real fills. Sizes were a few per cent of the balance, so a token
   * would have to double for a row to move a whole point, and none of them ever
   * bet enough to be visibly right or wrong.
   */
  readonly bet: number;
  /**
   * Where this one shops, and it is the reason the board was a row of ties.
   *
   * Everything traded the market cap ranking or the hour's movers, and both of
   * those are established tokens that move a per cent or two. A thirty per cent
   * position in something that moves two per cent moves the account by six
   * tenths of one, so fourteen accounts sat between 9.99 and 10.06 whatever
   * they did. Nothing was ever going to separate them.
   *
   * The third lane is tokens still on the curve, minutes old, which move in
   * multiples rather than in per cents. That is where a paper account actually
   * finds out whether it is any good, and where a row ends the day somewhere
   * other than where it started.
   */
  readonly hunts: 'curve' | 'movers' | 'large';
  /**
   * Whether this one looks at direction before buying.
   *
   * Not a cheat and not a guarantee: it buys tokens that are up on the hour
   * instead of buying across a band regardless. That is what separates a trader
   * from somebody pressing buttons, and without it every account here was doing
   * the latter. Thirteen of fourteen finished down, two of them halved, because
   * buying into falls and paying fees both ways is a losing strategy however
   * honestly it is executed.
   *
   * Roughly half of them read the tape. The other half do not, and that is the
   * point: a board where everybody wins is exactly as fake as one where nobody
   * does.
   */
  readonly reads: boolean;
  /** Where inside that band it starts looking. */
  readonly taste: number;
}

function characterOf(index: number): Character {
  const a = rand(index, 1);
  const b = rand(index, 2);
  const c = rand(index, 3);
  // Its own draw. Sharing one with `width` tied the two together and put eight
  // of fourteen accounts on exactly half a position, which is a tell.
  const d = rand(index, 5);

  /*
   * A heavy tail on purpose. Most accounts trade tenths of a SOL and one or two
   * of them swing whole ones, which is what a real board looks like.
   *
   * Capped well under a third of the starting balance, which is the ceiling a
   * single entry is allowed. Left uncapped the largest characters wanted eight
   * SOL of a ten SOL account, hit that limit on every single buy, and printed
   * the same number over and over: the uniformity this whole thing exists to
   * get rid of, arriving through the back door.
   */
  const scale = a < 0.58 ? 0.05 + a * 0.42 : a < 0.88 ? 0.26 + a * 0.7 : 0.75 + a * 1.1;
  let floor = BigInt(Math.round(scale * 0.42 * 1e9));
  let ceiling = BigInt(Math.round(scale * 1.55 * 1e9));
  if (ceiling > 2_100_000_000n) ceiling = 2_100_000_000n;
  if (floor > ceiling / 2n) floor = ceiling / 2n;

  return {
    floor: floor < 15_000_000n ? 15_000_000n : floor,
    ceiling: ceiling < 45_000_000n ? 45_000_000n : ceiling,
    /*
     * Skewed short, with a long tail.
     *
     * Most are out inside a few minutes and a couple sit on a position for half
     * an hour. The first spread topped out under four minutes, which on a large
     * token is not enough time for the price to do anything, so every account
     * finished on the balance it started with and the whole board read +0.0%.
     * Letting the slow ones actually wait is what makes the market, rather than
     * the schedule, decide who is winning.
     */
    /*
     * Floored at twenty ticks, three minutes, because the fastest characters
     * were turning positions over in nine seconds. Nothing can happen to a
     * price in nine seconds except the cost of trading it, so those accounts
     * were not trading, they were paying fees in a loop.
     */
    patience: Math.round(20 + Math.pow(b, 2.2) * 260),
    tempo: 0.14 + rand(index, 6) * 0.86,
    width: 1 + Math.floor(c * 4),
    // A fifth of them take the whole thing off; the rest scale out by anything
    // from a quarter to most of it, on a continuous spread rather than three
    // settings everybody shares.
    exit: d < 0.2 ? 10_000 : 2_200 + Math.floor(d * 6_400),
    // Where the band starts, and how wide it is. A narrow band is a specialist
    // who keeps turning up in the same dozen names; a wide one trades anything.
    // Skewed toward the top, or nobody trades the liquid names at all: a flat
    // draw put every band past rank eighty, which is its own kind of wrong.
    // From a careful eighth of the account to a third of it, which is the cap.
    bet: 1_200 + Math.floor(rand(index, 9) * 2_100),
    reads: rand(index, 11) < 0.5,
    hunts: (() => {
      const draw = rand(index, 10);
      // Weighted to the curve, because that is the only lane with enough range
      // in it to tell one trader from another inside a day.
      return draw < 0.5 ? 'curve' : draw < 0.8 ? 'movers' : 'large';
    })(),
    band: Math.pow(rand(index, 7), 1.7) * 0.8,
    reach: 0.06 + rand(index, 8) * 0.3,
    taste: Math.floor(rand(index, 4) * 997),
  };
}

/**
 * The pubkeys these accounts hold.
 *
 * Derived from a fixed seed rather than stored, so the same run of accounts
 * comes back after a restart and keeps its history instead of a new set
 * appearing every deploy. They are addresses, not wallets: nothing here signs,
 * and no key for them exists anywhere.
 */
const SEED = process.env['PROBATIO_HOUSE_SEED'] ?? 'probatio-house-v1';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let out = '';
  while (value > 0n) {
    out = BASE58[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}

function pubkeyFor(index: number): string {
  return base58(createHash('sha256').update(`${SEED}:${index}`).digest());
}

/*
 * Names, so the board reads as people rather than as thirty-two bytes.
 *
 * Claimed through the same uniqueness check every trader's name goes through,
 * so one of these cannot quietly hold a handle somebody else could have had.
 *
 * Invented, and deliberately not modelled on anybody. There are wallets on
 * pump.fun whose handles people would recognise, and borrowing one of those for
 * an account the site itself runs would be impersonation whatever the fills
 * underneath it were doing.
 *
 * Not everybody gets one. A real board is part handles and part addresses,
 * because plenty of people never set a name, and fourteen tidy lowercase words
 * in a column is its own kind of tell.
 */
const NAMES = [
  'exitliquidity',
  'sizeonly',
  null,
  'thesis',
  'redcandle_',
  null,
  'nokia3310',
  'slowhand',
  null,
  '0xflatline',
  'downbad',
  null,
  'wickhunter',
  'nofloor',
  'clipped',
  'gm_only',
  null,
  'topblaster',
  'dustdealer',
  'riskoff',
];

interface HouseState {
  timer: NodeJS.Timeout | null;
  busy: boolean;
  ready: boolean;
  turn: number;
  filled: number;
  rejected: number;
  failures: number;
  /**
   * Which tokens have actually been traded.
   *
   * Kept because "they are all buying the same thing" is a claim that should be
   * settled with a number rather than by scrolling the feed and guessing.
   */
  mints: Set<string>;
  /** What the last failure said, since a counter alone explains nothing. */
  lastError: string | null;
}

const STATE_KEY = Symbol.for('probatio.house-traders');

function state(): HouseState {
  const global = globalThis as typeof globalThis & Record<symbol, unknown>;
  global[STATE_KEY] ??= {
    timer: null,
    busy: false,
    ready: false,
    turn: 0,
    filled: 0,
    rejected: 0,
    failures: 0,
    mints: new Set<string>(),
    lastError: null,
  } satisfies HouseState;
  return global[STATE_KEY] as HouseState;
}

export function houseTraderStats(): {
  running: boolean;
  accounts: number;
  filled: number;
  rejected: number;
  failures: number;
  tokens: number;
  lastError: string | null;
} {
  const current = state();
  return {
    running: current.timer !== null,
    accounts: COUNT,
    filled: current.filled,
    rejected: current.rejected,
    failures: current.failures,
    tokens: current.mints.size,
    lastError: current.lastError,
  };
}

/** Create the accounts and claim their names. Safe to run again. */
async function ensureAccounts(now: number): Promise<void> {
  const client = await db();
  const seasonId = await ensureFreePlaySeason(client, now);

  for (let index = 0; index < COUNT; index += 1) {
    const pubkey = pubkeyFor(index);
    await background(() => upsertUser(client, pubkey, now));
    await background(() => ensureAccount(client, seasonId, pubkey, now));

    const name = NAMES[index % NAMES.length];
    /*
     * Null on purpose: this one shows as an address, like most people do.
     *
     * Cleared rather than skipped. Names are claimed into the database, so
     * deciding later that an account should not have one does nothing on its
     * own: the board went on showing all fourteen with handles because the
     * handles were already sitting in `display_names` from the run before.
     */
    if (name === undefined || name === null) {
      await background(() => clearName(client, pubkey, 'house account, no handle', now));
      continue;
    }
    // Taken means a real trader already has it, and they keep it.
    await background(() => claimName(client, pubkey, name, name.toLowerCase(), now));
  }
}

/**
 * One trade, taken exactly as the trade route takes it.
 *
 * The order of operations here is the point, not an implementation detail: read
 * the pool at the click, wait out the account's latency, read it again, and
 * quote against the second reading. Shortening that would produce fills nobody
 * could have got, on a board whose entire claim is the opposite.
 */
async function trade(index: number, turn: number): Promise<void> {
  const client = await db();
  const now = Date.now();
  const pubkey = pubkeyFor(index);

  const seasonId = await ensureFreePlaySeason(client, now);
  let account = await ensureAccount(client, seasonId, pubkey, now);

  /*
   * Start again when there is nothing left to trade with.
   *
   * Every round trip pays a fee both ways, nothing here ever tops up, and a
   * balance below the minimum entry with no position left to sell is an account
   * that stops for good. Fourteen of them grinding down means a board that
   * looks fine today and is quieter every day until it is still.
   *
   * The old account is not touched. Its trades and its sealed record stay
   * exactly where they are, and the new generation appears beside it.
   */
  if (await isSpent(client, account.id, MIN_TRADE)) {
    account = await background(() => startOver(client, seasonId, pubkey, now));
    console.log(`[house] ${pubkey} started over`);
  }

  const who = characterOf(index);
  const holdings = await openPositions(client, account.id);
  let mint: string;
  let side: 'buy' | 'sell';
  let size: bigint;

  /*
   * Sell what has been held long enough, rather than on a fixed rhythm.
   *
   * The version this replaces sold two ticks in every three regardless, which
   * is why nobody ever finished up or down: a position bought and closed inside
   * five minutes on a large token cannot move, and fourteen accounts doing it
   * in lockstep produced fourteen rows of exactly ten SOL. Holding until the
   * position is a few minutes old at least gives the market a chance to be the
   * thing that decides who is winning.
   */
  const ripe = holdings.filter((row) => now - row.openedAt > who.patience * TICK_MS);
  const roll = rand(index, turn, 5);
  const closing = ripe.length > 0 && (roll < 0.62 || holdings.length >= who.width);

  if (closing) {
    const open = ripe[Math.floor(rand(index, turn, 6) * ripe.length)] ?? ripe[0]!;
    mint = open.mint;
    side = 'sell';
    const held = BigInt(open.tokenAmount);
    // Around their usual exit, not exactly it, and a full one whenever what is
    // left would be dust.
    const spread = 1 + Math.floor(rand(index, turn, 7) * 2_000) - 1_000;
    const bps = BigInt(Math.min(10_000, Math.max(1_500, who.exit + spread)));
    size = (held * bps) / 10_000n;

    /*
     * Finish the position rather than halving it forever.
     *
     * Scaling out by a third of what is left never reaches zero, so a position
     * was never closed: two accounts had twenty-one and forty-one fills each
     * with no completed round trip between them, no win rate, and nothing
     * realized. The profile pages were right and the trading was wrong.
     *
     * Anything under a fifth left, or worth less than dust, goes in one go.
     * That is also what a person does with a tail: they do not keep selling a
     * quarter of a quarter, they close it.
     */
    if (size <= 0n || held - size < held / 5n || BigInt(open.costBasis) < DUST) size = held;

    /*
     * And out in pieces if the whole lot would move the price.
     *
     * Somebody holding more than the market can absorb does not get to leave in
     * one go, and pretending otherwise is what produced a twenty-two per cent
     * sell impact. They sell what the pool will take and keep the rest for the
     * next turn, which is what a person with a large position actually does.
     */
    const exitPool = (await readMarket(mint)).pool;
    if (!exitPool) return;

    /*
     * The impact cap shapes an exit; it must never prevent one.
     *
     * Halving until the market can take it is right for trimming a position and
     * wrong for finishing one: a holding too big for the pool would be halved
     * eight times, sell a scrap, and be left open for ever. When the whole lot
     * is meant to go, what the market will take goes now and the rest goes on
     * the following turns, which is a trader working out of a position rather
     * than an account stuck in one.
     */
    const closingOut = size === held;
    const shaped = sized(exitPool, size, 'sell', 1n);
    if (shaped <= 0n) return;
    if (!closingOut && shaped < size / 8n) return;
    size = shaped;
  } else {
    /*
     * Different accounts look at different parts of the list, and keep looking.
     *
     * This is the fix that mattered. Picking one token and giving up if it was
     * unusable meant the only tokens ever bought were the handful that happened
     * to be usable on the first try, so fourteen accounts with fourteen
     * different starting points still funnelled into the same three names and
     * the fills feed read as one token over and over. A pick is not a decision,
     * it is the first of several.
     *
     * Each account walks the list on its own stride from its own offset, so two
     * of them rejecting the same token do not then converge on the same
     * replacement.
     */
    /*
     * Four hundred deep, and each account only shops inside its own slice.
     *
     * A hundred and twenty by market cap is a pond small enough that fourteen
     * accounts kept landing on the same names however they were offset into it.
     * Widening the list is half the fix and the bands are the other half:
     * without them, a longer list just means everybody has more chances to
     * collide near the top, where the liquidity is.
     */
    /*
     * Two different lists, because they answer different questions.
     *
     * The market cap ranking is where the liquidity is and where nothing
     * happens; the movers list is where a position can actually go somewhere.
     * A board built only on the first one is a board of ties.
     */
    /*
     * Three lists, because they answer three different questions.
     *
     * The curve is where the range is: a token minutes old can double or halve
     * inside the hold. The movers list is the middle ground. The market cap
     * ranking is where the liquidity is and where almost nothing happens, and a
     * board built only on that one is a board of ties.
     */
    /*
     * Where they shop, and whether they look at direction while they are there.
     *
     * A reader on the curve wants the ones actually filling up rather than the
     * whole lane, so the progress floor rises: a token at eighty per cent has
     * buyers, one at three per cent has a deployer. A reader on the movers list
     * takes the ones going up rather than the ones merely moving.
     */
    const mints =
      who.hunts === 'curve'
        ? (await bondingLaunches(client, who.reads ? 6_000 : 300, 200)).map((l) => l.mint)
        : who.hunts === 'movers'
          ? who.reads
            ? await risingMints(200)
            : await movingMints(200)
          : await topMints(400);
    if (mints.length === 0) return;

    /*
     * A reader shops the front of its list, where the sorting has put the
     * strongest, rather than a slice somewhere down it.
     */
    const from = who.reads ? 0 : Math.floor(who.band * mints.length);
    const width = who.reads
      ? Math.max(10, Math.floor(mints.length / 4))
      : Math.max(12, Math.floor(who.reach * mints.length));
    const stride = 7 + (index % 11);
    const start = who.taste + turn * 3 + Math.floor(rand(index, turn, 8) * 11);
    let picked: string | undefined;

    for (let attempt = 0; attempt < 12 && picked === undefined; attempt += 1) {
      const candidate = mints[(from + ((start + attempt * stride) % width)) % mints.length];
      if (candidate === undefined) continue;
      // Never two positions in the same token: it reads as a bot, and it makes
      // the average cost of an exit meaningless.
      if (holdings.some((row) => row.mint === candidate)) continue;
      if (await isSuspended(client, candidate)) continue;
      picked = candidate;
    }
    if (picked === undefined) return;

    mint = picked;
    side = 'buy';
    /*
     * Sized against the account, not against a fixed table.
     *
     * The absolute range still varies the trade, but what decides whether a row
     * moves is the fraction of the balance behind it. Somebody who puts a
     * quarter of their account into something that halves is down twelve per
     * cent, and that is what a leaderboard is for.
     */
    const balance = BigInt(account.solBalance);
    const wobble = 0.6 + rand(index, turn, 9) * 0.9;
    size = (balance * BigInt(Math.round(who.bet * wobble))) / 10_000n;

    const cap = balance / 3n;
    if (size > cap) size = cap;
    if (size < MIN_TRADE) return;

    /*
     * And never more than the pool can take.
     *
     * A third of the balance into a thin curve is a trade the engine refuses on
     * price impact, and it was refusing one in three: twenty-one filled against
     * eleven rejected. The rejections were right, the sizes were wrong. Capped
     * against the market's own depth, an account trading a small token simply
     * trades smaller, which is what a person does.
     */
    /*
     * Sized against the impact it would cause, not against a fraction of a
     * reserve. See MAX_IMPACT_BPS: the fraction was measuring the wrong number
     * on a curve and let an account move a market forty per cent by itself.
     */
    const entry = (await readMarket(mint)).pool;
    if (!entry) return;
    size = sized(entry, size, 'buy', MIN_TRADE);
    if (size <= 0n) return;
  }

  /*
   * The same fill everybody else gets, through the same code.
   *
   * This used to be a second copy of the sequence in the trade route, which is
   * how two implementations of something whose every step matters quietly stop
   * agreeing. It reads the pool, waits out the latency, reads again and quotes
   * against the second reading, exactly as a person's click does, because these
   * accounts are only worth anything if their records are the same kind of
   * record as everybody else's.
   */
  const outcome = await executeTrade({
    client,
    account,
    seasonId,
    userPubkey: pubkey,
    mint,
    side,
    size,
    market: { atClick: readMarket, atFill: readMarket },
    now,
  });

  const current = state();
  if (outcome.status === 'filled') {
    current.filled += 1;
    current.mints.add(mint);
    return;
  }
  /*
   * Everything else is counted and dropped.
   *
   * A rejection is a real outcome and these accounts exist partly to show that,
   * so it is not retried and not logged as a fault. A suspended token, an
   * unreadable chain and a market that vanished mid-trade are all simply
   * reasons this turn did nothing.
   */
  if (outcome.status === 'rejected') current.rejected += 1;
}

/**
 * Whose turn it is, weighted by how much each one trades.
 *
 * Rotation gave every account the same number of trades, which is the one thing
 * no real leaderboard has ever shown. Drawn against the tempos instead, so the
 * busy ones appear several times an hour and the quiet ones go long stretches
 * without doing anything.
 */
function pickAccount(turn: number): number {
  let total = 0;
  for (let index = 0; index < COUNT; index += 1) total += characterOf(index).tempo;

  let dart = rand(turn, 11) * total;
  for (let index = 0; index < COUNT; index += 1) {
    dart -= characterOf(index).tempo;
    if (dart <= 0) return index;
  }
  return COUNT - 1;
}

async function tick(): Promise<void> {
  const current = state();
  if (current.busy) return;
  current.busy = true;

  try {
    const now = Date.now();
    if (!current.ready) {
      await ensureAccounts(now);
      current.ready = true;
      console.log(`[house] ${COUNT} accounts trading free play`);
    }

    current.turn += 1;
    await trade(pickAccount(current.turn), current.turn);
  } catch (error) {
    current.failures += 1;
    current.lastError = String(error).slice(0, 300);
    /*
     * A busy endpoint is not a fault, it is a queue.
     *
     * These share an RPC with the wallet walker and the chart warmer, and both
     * of those are meant to have priority: nobody is waiting on a house trade.
     * A 429 here means the pacing worked. Logging a stack trace for it buries
     * the failures that do matter.
     */
    const code = (error as { code?: unknown } | null)?.code;
    if (code !== 429) console.warn('[house] trade failed', error);
  } finally {
    state().busy = false;
  }
}

export function startHouseTraders(): void {
  if (COUNT <= 0) {
    console.log('[house] disabled');
    return;
  }
  const current = state();
  if (current.timer !== null) return;

  void tick();
  current.timer = setInterval(() => {
    void tick();
  }, TICK_MS);
  current.timer.unref?.();
}
