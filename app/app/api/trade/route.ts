import { PoolReader, RpcClient, PUMPFUN_TOKEN_DECIMALS } from '@probatio/pools';
import { DEFAULT_RULES, simulateFill, totalFeeBps } from '@probatio/sim';
import { applyFill, emptyPosition, TradingError, type AccountState } from '@probatio/trading';
import { hashLeaf, toHex } from '@probatio/commit';
import {
  openPosition,
  recordTrade,
} from '@probatio/db';
import { db } from '@/lib/db';
import { activeSeason } from '@/lib/season';
import { currentUser } from '@/lib/session';
import { rpcEndpoint } from '@/lib/env';

/**
 * Execute a trade.
 *
 * The latency is real. The pool is read when the click arrives, the request
 * then waits exactly as long as the season's rules say a transaction takes,
 * and the fill is computed against the pool as it stands *after* that wait.
 *
 * Simulating the delay by quoting twice against one reading would be cheaper
 * and would be a lie: the whole reason this product exists is that other paper
 * traders fill you at the price on screen. Here the price genuinely moves while
 * you wait, and sometimes the trade genuinely fails.
 */

const MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_SLIPPAGE_BPS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function POST(request: Request): Promise<Response> {
  const user = await currentUser();
  if (!user) {
    return Response.json({ error: 'sign in to trade' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'expected a JSON body' }, { status: 400 });
  }

  const { mint, size, slippageBps } = (body ?? {}) as Record<string, unknown>;
  const side = (body as { side?: unknown }).side as 'buy' | 'sell' | undefined;

  if (typeof mint !== 'string' || !MINT_PATTERN.test(mint)) {
    return Response.json({ error: 'a valid mint is required' }, { status: 400 });
  }
  if (side !== 'buy' && side !== 'sell') {
    return Response.json({ error: 'side must be buy or sell' }, { status: 400 });
  }
  const tradeSide: 'buy' | 'sell' = side;
  if (typeof size !== 'string' || !/^[1-9]\d*$/.test(size)) {
    // Sizes arrive as decimal strings of base units. A JSON number cannot hold
    // a lamport balance without rounding it.
    return Response.json({ error: 'size must be a positive integer string' }, { status: 400 });
  }

  const slippage =
    typeof slippageBps === 'number' && Number.isFinite(slippageBps)
      ? Math.min(Math.max(Math.trunc(slippageBps), 0), MAX_SLIPPAGE_BPS)
      : DEFAULT_RULES.slippageBps;

  const client = await db();
  const now = Date.now();
  const { account, seasonId } = await activeSeason(client, user.pubkey, now);

  const rpc = new RpcClient({ endpoint: rpcEndpoint(), timeoutMs: 15_000 });
  const reader = new PoolReader(rpc);

  const atClickResolution = await reader.resolve(mint);
  if (!atClickResolution.pool) {
    return Response.json(
      { error: 'this token has no live market — it may have graduated with no pool' },
      { status: 409 },
    );
  }

  // The wait that makes the fill honest.
  await sleep(account.latencyMs);

  const atFillResolution = await reader.resolve(mint);
  if (!atFillResolution.pool) {
    return Response.json(
      { status: 'rejected', reason: 'no_liquidity', detail: 'the market disappeared mid-trade' },
      { status: 200 },
    );
  }

  const position = await openPosition(client, account.id, mint);
  const state: AccountState = {
    solBalance: BigInt(account.solBalance),
    position: position
      ? {
          mint: position.mint,
          tokenAmount: BigInt(position.tokenAmount),
          costBasis: BigInt(position.costBasis),
          realizedPnl: BigInt(position.realizedPnl),
        }
      : null,
  };

  // Checked before simulating, so a trader is told they cannot afford it
  // rather than watching the engine reject a size it was never going to fill.
  const requested = BigInt(size);
  if (side === 'buy' && requested > state.solBalance) {
    return Response.json(
      { status: 'rejected', reason: 'insufficient_sol', detail: 'not enough SOL' },
      { status: 200 },
    );
  }
  if (side === 'sell' && requested > (state.position?.tokenAmount ?? 0n)) {
    return Response.json(
      { status: 'rejected', reason: 'insufficient_tokens', detail: 'you do not hold that many' },
      { status: 200 },
    );
  }

  const outcome = simulateFill({
    side,
    size: requested,
    atClick: atClickResolution.pool,
    atFill: atFillResolution.pool,
    rules: {
      latencyMs: account.latencyMs,
      slippageBps: slippage,
      maxPriceImpactBps: account.maxPriceImpactBps,
      allowPartialFills: true,
    },
  });

  if (outcome.status === 'rejected') {
    // A rejection is a real outcome, not an error. Real transactions revert.
    return Response.json({
      status: 'rejected',
      reason: outcome.reason,
      detail: outcome.detail,
      expected: outcome.expected
        ? {
            solAmount: outcome.expected.solAmount.toString(),
            tokenAmount: outcome.expected.tokenAmount.toString(),
          }
        : null,
    });
  }

  const pool = atFillResolution.pool;
  let applied;
  try {
    applied = applyFill(state, outcome.quote, mint);
  } catch (error) {
    if (error instanceof TradingError) {
      return Response.json({ status: 'rejected', reason: error.code, detail: error.message });
    }
    throw error;
  }

  const nextPosition = applied.account.position ?? emptyPosition(mint);

  // Everything about the leaf except its sequence, which is only settled
  // inside the write transaction.
  const leafBase = {
    seasonOrdinal: account.seasonOrdinal,
    trader: user.pubkey,
    mint,
    side: tradeSide,
    solAmount: outcome.quote.solAmount,
    tokenAmount: outcome.quote.tokenAmount,
    feeLamports: outcome.quote.feeLamports,
    solReserve: pool.solReserve,
    tokenReserve: pool.tokenReserve,
    deliverableTokens: pool.deliverableTokens,
    feeBps: totalFeeBps(pool.fees),
    poolSource: pool.source,
    priceImpactBps: outcome.quote.priceImpactBps,
    partial: outcome.quote.partial,
    clickedAtSlot: atClickResolution.slot,
    filledAtSlot: pool.slot,
    latencyMs: account.latencyMs,
    engineVersion: outcome.quote.engineVersion,
    createdAt: now,
  };

  const recorded = await recordTrade(client, {
    snapshot: {
      mint,
      solReserve: pool.solReserve.toString(),
      tokenReserve: pool.tokenReserve.toString(),
      tokenDecimals: pool.tokenDecimals || PUMPFUN_TOKEN_DECIMALS,
      feeBps: totalFeeBps(pool.fees),
      source: pool.source,
      slot: pool.slot,
    },
    trade: {
      accountId: account.id,
      seasonId,
      userPubkey: user.pubkey,
      mint,
      side,
      solAmount: outcome.quote.solAmount.toString(),
      tokenAmount: outcome.quote.tokenAmount.toString(),
      fee: outcome.quote.feeLamports.toString(),
      priceImpactBps: outcome.quote.priceImpactBps,
      partial: outcome.quote.partial,
      poolSource: pool.source,
      clickedAtSlot: atClickResolution.slot,
      filledAtSlot: pool.slot,
      latencyMs: account.latencyMs,
      engineVersion: outcome.quote.engineVersion,
    },
    position: {
      accountId: account.id,
      mint,
      tokenAmount: nextPosition.tokenAmount.toString(),
      costBasis: nextPosition.costBasis.toString(),
      realizedPnl: nextPosition.realizedPnl.toString(),
      closed: applied.closed,
    },
    newBalance: applied.account.solBalance.toString(),
    leafHashFor: (sequence) => toHex(hashLeaf({ ...leafBase, sequence })),
    now,
  });

  return Response.json({
    status: 'filled',
    tradeId: recorded.id,
    sequence: recorded.sequence,
    // Both figures are returned so the interface can show the haircut rather
    // than quietly presenting the fill as though it were the quote.
    expected: {
      solAmount: outcome.expected.solAmount.toString(),
      tokenAmount: outcome.expected.tokenAmount.toString(),
    },
    filled: {
      solAmount: outcome.quote.solAmount.toString(),
      tokenAmount: outcome.quote.tokenAmount.toString(),
      feeLamports: outcome.quote.feeLamports.toString(),
      priceImpactBps: outcome.quote.priceImpactBps,
      partial: outcome.quote.partial,
    },
    slippageBps: outcome.slippageBps,
    latencyMs: outcome.latencyMs,
    balance: applied.account.solBalance.toString(),
    position: {
      tokenAmount: nextPosition.tokenAmount.toString(),
      costBasis: nextPosition.costBasis.toString(),
      realizedPnl: nextPosition.realizedPnl.toString(),
    },
    realized: applied.realized.toString(),
  });
}
