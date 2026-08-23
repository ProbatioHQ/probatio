import type { BucketRule } from './bucket';

/**
 * What each kind of request costs.
 *
 * Grouped by what the request actually does to us rather than by URL. A limit
 * chosen per route drifts the moment a route changes what it calls; a limit
 * chosen per cost stays honest.
 */

export type PolicyName =
  | 'read'
  | 'trade'
  | 'chainRead'
  | 'money'
  | 'paid'
  | 'auth'
  | 'write'
  | 'api-order'
  | 'api-read';

export const POLICIES: Record<PolicyName, BucketRule> = {
  // Cached or database-only. Generous: these are what a page load costs, and a
  // reader hitting a public leaderboard is not an attack.
  read: { capacity: 120, refillMs: 60_000 },

  // A trade reads pool state from chain and writes several rows. The engine
  // models a real delay, so a human cannot legitimately exceed this.
  trade: { capacity: 30, refillMs: 60_000 },

  // Reads that hit an RPC provider we pay for and can be banned from.
  chainRead: { capacity: 40, refillMs: 60_000 },

  // Anything that moves real money or asks somebody to sign. Deliberately
  // strict: an entry costs 0.05 SOL and nobody needs to start ten of them a
  // minute. Payment intents also gather wallet evidence, which is several RPC
  // calls before a single lamport has moved.
  money: { capacity: 6, refillMs: 60_000 },

  // Calls that cost money per request. The coach's own allowance already
  // governs how often a report can be produced; this governs how often somebody
  // can make us check.
  paid: { capacity: 10, refillMs: 60_000 },

  // Nonces and signature verification. Each one writes a row, so unbounded
  // requests are unbounded rows.
  auth: { capacity: 20, refillMs: 60_000 },

  // Cheap writes: claiming a name, and similar.
  write: { capacity: 20, refillMs: 60_000 },

  /*
   * Orders from a program, in their own bucket.
   *
   * Tighter than `trade`, and separate from it, which matters more than the
   * number. A person clicks a few times a minute; a loop can ask a thousand
   * times in the same minute without meaning any harm at all. Sharing the
   * website's bucket would mean one badly written program throttling the people
   * trading by hand, which is exactly backwards.
   *
   * Twenty a minute is far above any strategy worth running and far below what a
   * loop with no sleep in it produces, so it separates the two without ever being
   * reached by the first.
   */
  'api-order': { capacity: 20, refillMs: 60_000 },

  /*
   * Reads from a program. Generous, because they are database-only and because
   * the alternative is a bot polling blind: a program refused its own balance
   * places orders it cannot size, which is worse for everybody than the read.
   */
  'api-read': { capacity: 120, refillMs: 60_000 },
};
