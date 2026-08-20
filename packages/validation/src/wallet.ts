import { RpcClient, extractTradeEvents, type ConfirmedTransaction } from '@probatio/pools';

/**
 * Reading one wallet's trading, rather than one pool's.
 *
 * A pool walk answers "who traded this token lately" and it is the wrong shape
 * for a trader board. Six hundred recent swaps of a busy pool cover half an
 * hour and turn up hundreds of wallets seen once each: fifteen hundred wallets
 * were read here and five of them had ever bought and sold the same token
 * inside the slice. Nobody could be scored, because a wallet's two ends were
 * almost never both on the table.
 *
 * A wallet walk is the other axis and it is the one that matters. Every swap a
 * wallet made, in order, across every token it touched, from a single signature
 * listing. Round trips are then simply there.
 *
 * Deliberately venue-blind. The trade is derived from what the transaction did
 * to the balances, so it reads a bonding curve, a PumpSwap pool, and a swap
 * routed through an aggregator the same way, without a program id list that
 * would silently go stale the next time pump.fun ships something.
 */

/** Wrapped SOL. A pool's SOL side is an ordinary token account holding this. */
const WSOL = 'So11111111111111111111111111111111111111112';

const SIGNATURE_PAGE = 1_000;

export interface WalletSwap {
  readonly signature: string;
  readonly trader: string;
  readonly mint: string;
  readonly isBuy: boolean;
  /** Lamports the wallet parted with, or took home. Always positive. */
  readonly solAmount: bigint;
  readonly tokenAmount: bigint;
  readonly slot: number;
  readonly blockTime: number | null;
  /** The venue immediately after the trade, when the transaction shows it. */
  readonly solAfter: bigint | null;
  readonly tokenAfter: bigint | null;
}

function netByOwner(
  transaction: ConfirmedTransaction,
  owner: string,
  mint: string,
): { delta: bigint; after: bigint } {
  let before = 0n;
  let after = 0n;
  for (const entry of transaction.preTokenBalances) {
    if (entry.owner === owner && entry.mint === mint) before += entry.amount;
  }
  for (const entry of transaction.postTokenBalances) {
    if (entry.owner === owner && entry.mint === mint) after += entry.amount;
  }
  return { delta: after - before, after };
}

/** Every mint whose balance moved for this owner, largest movement first. */
function movedMints(transaction: ConfirmedTransaction, owner: string): string[] {
  const mints = new Set<string>();
  for (const entry of [...transaction.preTokenBalances, ...transaction.postTokenBalances]) {
    if (entry.owner === owner && entry.mint !== WSOL) mints.add(entry.mint);
  }
  return [...mints].sort((a, b) => {
    const left = netByOwner(transaction, owner, a).delta;
    const right = netByOwner(transaction, owner, b).delta;
    const size = (value: bigint) => (value < 0n ? -value : value);
    return size(right) > size(left) ? 1 : size(right) < size(left) ? -1 : 0;
  });
}

/** What the wallet's own SOL did, counting wrapped SOL as the SOL it is. */
function lamportsMoved(transaction: ConfirmedTransaction, wallet: string): bigint {
  const index = transaction.accountKeys.indexOf(wallet);
  let delta = 0n;
  if (index >= 0) {
    const before = transaction.preBalances[index];
    const after = transaction.postBalances[index];
    if (before !== undefined && after !== undefined) delta += after - before;
  }
  delta += netByOwner(transaction, wallet, WSOL).delta;
  return delta;
}

/**
 * The venue's side of the trade, when the transaction reveals it.
 *
 * Whoever moved opposite the wallet in the same token is the pool, and a
 * PumpSwap pool's two vaults share an owner, so its SOL side is the wrapped SOL
 * account belonging to that same owner. Both post balances together are the
 * reserves a copier arriving one transaction later would have met.
 *
 * A bonding curve holds native SOL rather than wrapped, so this finds nothing
 * there and the trade event above supplies the reserves instead.
 */
function venueAfter(
  transaction: ConfirmedTransaction,
  wallet: string,
  mint: string,
  walletDelta: bigint,
): { solAfter: bigint; tokenAfter: bigint } | null {
  const owners = new Set<string>();
  for (const entry of transaction.postTokenBalances) {
    if (entry.mint === mint && entry.owner && entry.owner !== wallet) owners.add(entry.owner);
  }

  for (const owner of owners) {
    const token = netByOwner(transaction, owner, mint);
    // Opposite sign, and comparable size: a fee account also moves opposite,
    // and crediting one as the pool would price a copy against dust.
    const opposed = walletDelta > 0n ? token.delta < 0n : token.delta > 0n;
    if (!opposed) continue;
    const magnitude = token.delta < 0n ? -token.delta : token.delta;
    const wallets = walletDelta < 0n ? -walletDelta : walletDelta;
    if (magnitude * 2n < wallets) continue;

    const sol = netByOwner(transaction, owner, WSOL);
    if (sol.after <= 0n || token.after <= 0n) continue;
    return { solAfter: sol.after, tokenAfter: token.after };
  }
  return null;
}

/**
 * What one transaction did for one wallet, or nothing if it was not a trade.
 *
 * Pure, so it can be tested against a transaction rather than against a node.
 */
export function deriveWalletSwap(
  transaction: ConfirmedTransaction,
  wallet: string,
): WalletSwap | null {
  if (transaction.err !== null && transaction.err !== undefined) return null;

  /*
   * The wallet has to have paid for this transaction to be counted as having
   * made the trade in it.
   *
   * Balances alone do not say who traded: read from the pool's side, the same
   * transaction is a perfectly coherent sell, because that is what a pool does.
   * The fee payer is the one account that signed, so it is the one that decided
   * anything, and it is exactly how a pool walk names a trader, so both ways in
   * agree on what a trader is. A wallet trading behind a separate fee payer is
   * missed rather than guessed at.
   */
  if (transaction.accountKeys[0] !== wallet) return null;

  /*
   * The program's own account of the trade, preferred wherever it exists.
   *
   * A bonding curve emits one per trade carrying the exact virtual reserves
   * the fill engine quotes against, which is better than anything balances can
   * be made to say, and it costs nothing to look.
   */
  for (const event of extractTradeEvents(transaction.logMessages)) {
    if (event.user !== wallet) continue;
    if (event.solAmount <= 0n || event.tokenAmount <= 0n) continue;
    return {
      signature: transaction.signature,
      trader: wallet,
      mint: event.mint,
      isBuy: event.isBuy,
      solAmount: event.solAmount,
      tokenAmount: event.tokenAmount,
      slot: transaction.slot,
      blockTime: transaction.blockTime,
      solAfter: event.virtualSolReserves,
      tokenAfter: event.virtualTokenReserves,
    };
  }

  const [mint] = movedMints(transaction, wallet);
  if (mint === undefined) return null;

  const { delta } = netByOwner(transaction, wallet, mint);
  if (delta === 0n) return null;

  const sol = lamportsMoved(transaction, wallet);
  const isBuy = delta > 0n;
  // A buy costs SOL and a sell pays it. Anything else is a transfer, an
  // airdrop, or a wallet paying rent, and calling it a trade would put a
  // position on the board that was never bought.
  if (isBuy ? sol >= 0n : sol <= 0n) return null;

  const tokens = delta < 0n ? -delta : delta;
  // The network's fee is in that balance change and was not paid to anybody
  // trading. Left in, it would show as part of what a position cost and part of
  // what it returned, charging every wallet twice for the same thing.
  const lamports = (sol < 0n ? -sol : sol) - transaction.fee;
  if (lamports <= 0n) return null;

  return {
    signature: transaction.signature,
    trader: wallet,
    mint,
    isBuy,
    solAmount: lamports,
    tokenAmount: tokens,
    slot: transaction.slot,
    blockTime: transaction.blockTime,
    ...(venueAfter(transaction, wallet, mint, delta) ?? { solAfter: null, tokenAfter: null }),
  };
}

export interface WalletWalkOptions {
  readonly maxTransactions?: number;
  readonly concurrency?: number;
  /** Stop once the wallet's history reaches back past this unix second. */
  readonly until?: number;
  readonly onBatch?: (swaps: readonly WalletSwap[]) => Promise<void> | void;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await work(item);
    }
  });
  await Promise.all(runners);
  return results;
}

/** Walk a wallet's recent history and return every trade in it, oldest first. */
export async function collectWalletSwaps(
  rpc: RpcClient,
  wallet: string,
  options: WalletWalkOptions = {},
): Promise<WalletSwap[]> {
  const maxTransactions = options.maxTransactions ?? 400;
  const concurrency = options.concurrency ?? 8;

  const collected: WalletSwap[] = [];
  let before: string | undefined;
  let scanned = 0;

  while (scanned < maxTransactions) {
    const page = await rpc.getSignatures(wallet, {
      limit: Math.min(SIGNATURE_PAGE, maxTransactions - scanned),
      ...(before ? { before } : {}),
    });
    if (page.length === 0) break;

    const last = page[page.length - 1]!;
    before = last.signature;
    scanned += page.length;

    const usable = page.filter((entry) => entry.err === null);
    const transactions = await mapWithConcurrency(usable, concurrency, (entry) =>
      rpc.getTransaction(entry.signature, 'confirmed'),
    );

    const batch: WalletSwap[] = [];
    for (const transaction of transactions) {
      if (!transaction) continue;
      const swap = deriveWalletSwap(transaction, wallet);
      if (swap) batch.push(swap);
    }
    collected.push(...batch);
    if (batch.length > 0) await options.onBatch?.(batch);

    if (page.length < SIGNATURE_PAGE) break;
    // Past the scoring window there is nothing left to learn about this wallet,
    // and its history can run back years.
    if (options.until !== undefined && last.blockTime !== null && last.blockTime < options.until) {
      break;
    }
  }

  return collected.sort((a, b) => a.slot - b.slot);
}
