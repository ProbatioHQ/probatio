import { quoteBuy, quoteSell, type PoolState } from '@probatio/sim';
import {
  PUMPSWAP_DEFAULT_FEES,
  WSOL_MINT,
  type ConfirmedTransaction,
  type PumpSwapPool,
  type RpcClient,
} from '@probatio/pools';
import type { Sample, SkipReason, ValidationReport } from './replay';

/**
 * The same gate, pointed at the other venue.
 *
 * The curve harness has always been the thing that makes this project's central
 * claim checkable, and it walks a token's bonding curve — so it stopped at
 * graduation and never saw a PumpSwap swap. That gap is how a fee schedule
 * copied from the curve sat wrong by four times for as long as it did: the
 * measurement that would have caught it did not reach the code that was wrong.
 *
 * An AMM has to be read differently. A curve carries its reserves inside the
 * account and emits them in a log, so a trade event states the market before
 * and after. A pool's reserves are balances in two ordinary token accounts,
 * which means the reserves have to be recovered from the transaction's token
 * balance changes, and a "swap" has to be told apart from everything else that
 * moves those balances.
 */

/** One swap on one pool, with the market as it stood either side of it. */
export interface PoolSwap {
  readonly signature: string;
  /**
   * Who made the trade: the fee payer, which on a swap is the trader.
   *
   * Was discarded until now, and it was the one field standing between a walk
   * this code already does and knowing which real wallets are any good. It
   * costs nothing to keep: the account keys are already decoded to read the
   * balances, and the payer is the first of them by definition.
   */
  readonly trader: string | null;
  readonly slot: number;
  /** Unix seconds, from the block. Null when the node did not carry it. */
  readonly blockTime: number | null;
  readonly isBuy: boolean;
  /** Reserves before, in the order the engine wants them. */
  readonly solBefore: bigint;
  readonly tokenBefore: bigint;
  readonly solAfter: bigint;
  readonly tokenAfter: bigint;
  /** What the trader put in on a buy: everything that left them, fees included. */
  readonly grossIn: bigint;
  /** What the trader got out on a sell, after every fee. */
  readonly netOut: bigint;
  /** Tokens delivered on a buy, surrendered on a sell. */
  readonly tokens: bigint;
}

export interface CollectPoolOptions {
  readonly maxTransactions?: number;
  readonly concurrency?: number;
  readonly onProgress?: (scanned: number, swaps: number) => void;
  /**
   * Called with each page's swaps as the walk goes, newest first. Lets a caller
   * turn history into a chart as it arrives rather than waiting for the whole
   * walk, so the recent past draws in seconds and the deeper past fills in
   * behind it. Awaited, so a slow consumer paces the walk rather than racing it.
   */
  readonly onBatch?: (pageSwaps: readonly PoolSwap[]) => void | Promise<void>;
}

const SIGNATURE_PAGE = 100;
const DEFAULT_MAX_TRANSACTIONS = 300;
const DEFAULT_CONCURRENCY = 3;

/**
 * A fee is a small fraction of a trade. Anything larger moving through the same
 * transaction is a router hop or a liquidity operation, not a cost of this swap,
 * and counting it would measure the aggregator rather than the engine.
 */
const MAX_FEE_FRACTION = 20n; // a twentieth

/**
 * PumpSwap's own swap instructions, as they appear in a transaction's logs.
 *
 * Used to count how many swaps a transaction performed, which is the difference
 * between reading one and averaging several. Aggregator instructions like
 * `Route`, `RouteV2` and `Swap` belong to other programs and wrap these, so
 * they are deliberately not in the list.
 */
const SWAP_INSTRUCTIONS = new Set([
  'Buy',
  'BuyExactSolIn',
  'BuyExactQuoteIn',
  'Sell',
  'SellExactBaseIn',
  'SellExactTokensIn',
]);

const INSTRUCTION_LOG = 'Program log: Instruction: ';

/** How many swaps a transaction performed. */
export function swapCount(logMessages: readonly string[]): number {
  let count = 0;
  for (const line of logMessages) {
    if (!line.startsWith(INSTRUCTION_LOG)) continue;
    if (SWAP_INSTRUCTIONS.has(line.slice(INSTRUCTION_LOG.length).trim())) count += 1;
  }
  return count;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        results[index] = await worker(items[index]!);
      }
    }),
  );
  return results;
}

/**
 * Read one transaction as a swap on this pool, or decide it is not one.
 *
 * Exported because every rejection here is a judgement about what counts as
 * evidence, and those are worth testing directly rather than only through a
 * network run.
 */
export function asPoolSwap(
  transaction: ConfirmedTransaction,
  pool: PumpSwapPool,
  protocolFeeRecipients: readonly string[] = [],
): PoolSwap | null {
  if (transaction.err !== null && transaction.err !== undefined) return null;

  const balance = (
    list: readonly { accountIndex: number; mint: string; amount: bigint }[],
    account: string,
  ): bigint | null => {
    for (const entry of list) {
      if (transaction.accountKeys[entry.accountIndex] === account) return entry.amount;
    }
    return null;
  };

  const solBefore = balance(transaction.preTokenBalances, pool.quoteVault);
  const solAfter = balance(transaction.postTokenBalances, pool.quoteVault);
  const tokenBefore = balance(transaction.preTokenBalances, pool.baseVault);
  const tokenAfter = balance(transaction.postTokenBalances, pool.baseVault);
  if (solBefore === null || solAfter === null || tokenBefore === null || tokenAfter === null) {
    return null;
  }

  /*
   * Exactly one swap, or this is not a reading.
   *
   * Balances are transaction-level. A transaction that buys and then sells —
   * an arbitrage or a sandwich, which is most of the traffic on a thin, botted
   * pool — leaves a net change that solves as one badly priced swap. Before
   * this check the harness reported a median error of 8,955 bps on such a pool
   * while reporting nothing at all on a liquid one, which is the signature of a
   * measurement failing rather than an engine failing.
   *
   * A transaction whose swap instruction this does not recognise counts zero
   * and is skipped. That costs samples and cannot invent them, which is the
   * right way round.
   */
  if (swapCount(transaction.logMessages) !== 1) return null;

  const solDelta = solAfter - solBefore;
  const tokenDelta = tokenAfter - tokenBefore;
  if (solDelta === 0n || tokenDelta === 0n) return null;

  // The definition of a swap, and the check that first mattered: a deposit
  // moves both vaults the same way, and solving one as a swap attributes the
  // whole deposit to fees. That read as a fee of ninety percent.
  if (solDelta > 0n === tokenDelta > 0n) return null;

  const isBuy = solDelta > 0n;

  /*
   * PumpSwap's own protocol fee, and only that.
   *
   * This first counted every wrapped-SOL account that gained, on the reasoning
   * that anything not the pool must be a fee. Most swaps reach the pool through
   * a front end or a bot which takes a percent of its own in the same
   * transaction, so that reasoning charged the aggregator's cut to the venue:
   * a trade's gross came out too large, the engine quoted the larger amount,
   * and it read as the engine being generous by about 124 bps — which is very
   * close to the one percent such a front end takes, and was the clue.
   *
   * The venue's recipients are named in its own config, so the two can be told
   * apart by asking rather than by guessing at sizes.
   */
  const recipients = new Set(protocolFeeRecipients);
  let outside = 0n;
  for (const post of transaction.postTokenBalances) {
    if (post.mint !== WSOL_MINT) continue;
    const account = transaction.accountKeys[post.accountIndex];
    if (account === undefined || !recipients.has(account)) continue;
    const before =
      transaction.preTokenBalances.find((entry) => entry.accountIndex === post.accountIndex)
        ?.amount ?? 0n;
    const gain = post.amount - before;
    if (gain > 0n) outside += gain;
  }

  const magnitude = solDelta < 0n ? -solDelta : solDelta;
  if (outside * MAX_FEE_FRACTION > magnitude) return null;

  return {
    signature: transaction.signature,
    // The fee payer is always the first account key. Null rather than a guess
    // if a node hands back a transaction without them.
    trader: transaction.accountKeys[0] ?? null,
    slot: transaction.slot,
    blockTime: transaction.blockTime,
    isBuy,
    solBefore,
    tokenBefore,
    solAfter,
    tokenAfter,
    // A buy costs what reached the pool plus what went to the fee accounts.
    grossIn: isBuy ? solDelta + outside : 0n,
    // A sell pays what left the pool less what the fee accounts took.
    netOut: isBuy ? 0n : magnitude - outside,
    tokens: tokenDelta < 0n ? -tokenDelta : tokenDelta,
  };
}

/** Walk a pool's history and keep the transactions that are plainly swaps. */
export async function collectPoolSwaps(
  rpc: RpcClient,
  poolAddress: string,
  pool: PumpSwapPool,
  options: CollectPoolOptions = {},
  protocolFeeRecipients: readonly string[] = [],
): Promise<PoolSwap[]> {
  const maxTransactions = options.maxTransactions ?? DEFAULT_MAX_TRANSACTIONS;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;

  const collected: PoolSwap[] = [];
  let before: string | undefined;
  let scanned = 0;

  while (scanned < maxTransactions) {
    const page = await rpc.getSignatures(poolAddress, {
      limit: Math.min(SIGNATURE_PAGE, maxTransactions - scanned),
      ...(before ? { before } : {}),
    });
    if (page.length === 0) break;

    before = page[page.length - 1]!.signature;
    scanned += page.length;

    const usable = page.filter((entry) => entry.err === null);
    const transactions = await mapWithConcurrency(usable, concurrency, (entry) =>
      rpc.getTransaction(entry.signature, 'confirmed'),
    );

    const pageSwaps: PoolSwap[] = [];
    for (const transaction of transactions) {
      if (!transaction) continue;
      const swap = asPoolSwap(transaction, pool, protocolFeeRecipients);
      if (swap) {
        collected.push(swap);
        pageSwaps.push(swap);
      }
    }

    options.onProgress?.(scanned, collected.length);
    if (pageSwaps.length > 0) await options.onBatch?.(pageSwaps);
    if (page.length < SIGNATURE_PAGE) break;
  }

  // Oldest first. Ordering within a slot is not recoverable from balances
  // alone, and it does not need to be: the consecutiveness check below throws
  // out any pair that does not join, so a wrong order costs samples rather than
  // producing wrong ones.
  return collected.sort((a, b) => a.slot - b.slot);
}

/**
 * Whether one swap genuinely follows another.
 *
 * Pure balance arithmetic, independent of the fill engine: the reserves the
 * later swap started from must be exactly the ones the earlier swap left. If
 * they are not, something moved the pool in between that this walk did not see,
 * and the pair says nothing about whether the engine is right.
 */
export function joins(previous: PoolSwap, current: PoolSwap): boolean {
  return previous.solAfter === current.solBefore && previous.tokenAfter === current.tokenBefore;
}

function signedErrorBps(mine: bigint, actual: bigint): number {
  if (actual === 0n) return mine === 0n ? 0 : 10_000;
  const difference = mine - actual;
  const magnitude = difference < 0n ? -difference : difference;
  const bps = Number((magnitude * 10_000n) / actual);
  return difference < 0n ? -bps : bps;
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!;
}

/**
 * Run the engine over a pool's history and measure how closely it reproduces it.
 *
 * `fees` is passed in rather than assumed, because what the engine should be
 * charging is exactly the thing under test.
 */
export function replayPool(
  mint: string,
  swaps: readonly PoolSwap[],
  tokenDecimals: number,
  engineVersion: number,
  fees = PUMPSWAP_DEFAULT_FEES,
  /** SOL the pool counts beyond its quote vault. See pumpSwapReserveOffset. */
  quoteReserveOffset = 0n,
): ValidationReport {
  const samples: Sample[] = [];
  const skipped: Record<SkipReason, number> = {
    not_consecutive: 0,
    unquotable: 0,
    first_event: swaps.length > 0 ? 1 : 0,
  };

  for (let i = 1; i < swaps.length; i += 1) {
    const previous = swaps[i - 1]!;
    const current = swaps[i]!;

    if (!joins(previous, current)) {
      skipped.not_consecutive += 1;
      continue;
    }

    const before: PoolState = {
      mint,
      solReserve: current.solBefore + quoteReserveOffset,
      tokenReserve: current.tokenBefore,
      // An AMM holds its reserves outright, so all of them are deliverable.
      deliverableTokens: current.tokenBefore,
      tokenDecimals,
      fees,
      source: 'pumpswap',
      slot: current.slot,
    };

    try {
      if (current.isBuy) {
        const quote = quoteBuy(before, current.grossIn);
        const signed = signedErrorBps(quote.tokenAmount, current.tokens);
        samples.push({
          side: 'buy',
          errorBps: Math.abs(signed),
          signedErrorBps: signed,
          expected: current.tokens,
          actual: quote.tokenAmount,
          slot: current.slot,
        });
      } else {
        const quote = quoteSell(before, current.tokens);
        const signed = signedErrorBps(quote.solAmount, current.netOut);
        samples.push({
          side: 'sell',
          errorBps: Math.abs(signed),
          signedErrorBps: signed,
          expected: current.netOut,
          actual: quote.solAmount,
          slot: current.slot,
        });
      }
    } catch {
      skipped.unquotable += 1;
    }
  }

  const sorted = samples.map((sample) => sample.errorBps).sort((a, b) => a - b);
  const exact = samples.filter((sample) => sample.errorBps === 0).length;

  return {
    mint,
    engineVersion,
    eventsSeen: swaps.length,
    samples: samples.length,
    buys: samples.filter((sample) => sample.side === 'buy').length,
    sells: samples.filter((sample) => sample.side === 'sell').length,
    skipped,
    medianErrorBps: percentile(sorted, 0.5),
    p95ErrorBps: percentile(sorted, 0.95),
    maxErrorBps: sorted.length === 0 ? 0 : sorted[sorted.length - 1]!,
    exactMatches: exact,
    exactRate: samples.length === 0 ? 0 : exact / samples.length,
    worst: [...samples].sort((a, b) => b.errorBps - a.errorBps).slice(0, 5),
    allSamples: samples,
  };
}
