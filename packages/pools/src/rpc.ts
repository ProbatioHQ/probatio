/**
 * A minimal Solana JSON-RPC client.
 *
 * Only the handful of read methods this project needs, over plain fetch. No
 * dependency on a wallet SDK, which keeps the package small and means the only
 * code here that touches the network is this file — everything else stays pure
 * and testable.
 *
 * Every response is fetched at a specific slot and returns it, because a fill
 * has to be quoted against a known point in time rather than against "now".
 */

export class RpcError extends Error {
  readonly code: number | undefined;

  constructor(message: string, code?: number) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
  }
}

export interface AccountData {
  /** Raw account bytes. */
  readonly data: Uint8Array;
  readonly owner: string;
  readonly lamports: bigint;
  /** The slot this read reflects. */
  readonly slot: number;
}

export interface RpcOptions {
  readonly endpoint: string;
  /** Solana commitment level. 'confirmed' is the right trade-off for quoting. */
  readonly commitment?: 'processed' | 'confirmed' | 'finalized';
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /**
   * Minimum gap between requests, in milliseconds.
   *
   * Retrying a rate limit is recovery; pacing is avoidance. A backfill or a
   * replay makes thousands of calls in a burst, and no amount of backoff makes
   * that pleasant for a shared endpoint — it just converts refusals into
   * waiting. Spacing the requests out in the first place is what makes a cheap
   * endpoint usable at all.
   */
  readonly minIntervalMs?: number;
  /** Retries for rate limits and transient server errors. */
  readonly maxRetries?: number;
  /** Base delay for backoff, doubled each attempt. */
  readonly retryBaseMs?: number;
  /**
   * Most requests allowed in flight at once. Zero or unset means no ceiling.
   *
   * Pacing spaces requests out in time; this bounds how many can be mid-flight
   * together. It matters when one shared client is fed by a crowd rather than a
   * handful of workers: without it, a spike of trades opens an unbounded number
   * of concurrent sockets against one endpoint, which exhausts file descriptors
   * and drags down every other outbound call, workers and health probe included.
   * With it the spike queues instead.
   */
  readonly maxConcurrent?: number;
  /** Injected in tests so backoff does not actually sleep. */
  readonly sleepImpl?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_RETRY_BASE_MS = 400;

/** Rate limiting, and the server-side errors that are worth another attempt. */
function isRetryable(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RpcResponse<T> {
  result?: T;
  error?: { code: number; message: string };
}

interface AccountValue {
  data: [string, string];
  owner: string;
  lamports: number;
}

interface WithContext<T> {
  context: { slot: number };
  value: T;
}

interface RawSignatureInfo {
  signature: string;
  slot: number;
  blockTime?: number | null;
  err?: unknown;
}

interface RawTransaction {
  slot: number;
  blockTime?: number | null;
  meta?: { err?: unknown; logMessages?: string[] } | null;
}

export interface SignatureInfo {
  readonly signature: string;
  readonly slot: number;
  /** Unix seconds, or null for very old transactions the cluster no longer stamps. */
  readonly blockTime: number | null;
  /** Non-null when the transaction failed. Failed trades never moved a price. */
  readonly err: unknown;
}

export interface TransactionLogs {
  readonly signature: string;
  readonly slot: number;
  readonly blockTime: number | null;
  readonly err: unknown;
  readonly logMessages: readonly string[];
}

export type ProgramAccountFilter =
  | { readonly kind: 'dataSize'; readonly bytes: number }
  | { readonly kind: 'memcmp'; readonly offset: number; readonly base58: string };

function toRpcFilter(filter: ProgramAccountFilter): unknown {
  return filter.kind === 'dataSize'
    ? { dataSize: filter.bytes }
    : { memcmp: { offset: filter.offset, bytes: filter.base58 } };
}

export class RpcClient {
  readonly #options: RpcOptions;
  #nextId = 1;
  /**
   * When the next request may go out. Shared across concurrent callers, so
   * pacing holds however many workers are running.
   */
  #nextSlotAt = 0;

  /** In-flight requests, and callers waiting for a slot, for `maxConcurrent`. */
  #inFlight = 0;
  #waiting: Array<() => void> = [];

  constructor(options: RpcOptions) {
    if (!options.endpoint) {
      throw new RpcError('an RPC endpoint is required');
    }
    this.#options = options;
  }

  /** Wait for an in-flight slot when a ceiling is set, then hold it. */
  async #acquire(): Promise<void> {
    const limit = this.#options.maxConcurrent ?? 0;
    if (limit <= 0) return;
    if (this.#inFlight < limit) {
      this.#inFlight += 1;
      return;
    }
    // No free slot: wait to be handed one. The slot is passed over on release
    // without the count changing, so nothing can slip in between.
    await new Promise<void>((resolve) => this.#waiting.push(resolve));
  }

  /** Release a slot, handing it straight to the next caller waiting for one. */
  #release(): void {
    if ((this.#options.maxConcurrent ?? 0) <= 0) return;
    const next = this.#waiting.shift();
    if (next) {
      next(); // Hand the held slot over; the count stays as it is.
      return;
    }
    this.#inFlight -= 1;
  }

  private get commitment(): string {
    return this.#options.commitment ?? 'confirmed';
  }

  /**
   * One JSON-RPC call, retrying rate limits and transient server errors.
   *
   * Every provider rate-limits, and a backfill walking a token's history will
   * hit that ceiling on any plan worth paying for. Retrying with backoff here
   * is what makes a cheap endpoint usable instead of forcing an expensive one.
   *
   * `Retry-After` is honoured when the server sends it — it is the server
   * telling us exactly how long to wait, and guessing shorter only makes things
   * worse for everyone.
   */
  private async call<T>(method: string, params: unknown[]): Promise<T> {
    await this.#acquire();
    try {
      return await this.#dispatch<T>(method, params);
    } finally {
      this.#release();
    }
  }

  async #dispatch<T>(method: string, params: unknown[]): Promise<T> {
    const doFetch = this.#options.fetchImpl ?? fetch;
    const sleep = this.#options.sleepImpl ?? defaultSleep;
    const maxRetries = this.#options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const baseMs = this.#options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;

    let lastError: RpcError | undefined;

    // Claim a slot in the outgoing queue before doing anything else, so
    // concurrent workers space out rather than all firing at once.
    const minInterval = this.#options.minIntervalMs ?? 0;
    if (minInterval > 0) {
      const now = Date.now();
      const readyAt = Math.max(now, this.#nextSlotAt);
      this.#nextSlotAt = readyAt + minInterval;
      if (readyAt > now) await sleep(readyAt - now);
    }

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (attempt > 0) {
        const backoff = baseMs * 2 ** (attempt - 1);
        // Jitter so concurrent workers do not all retry on the same tick and
        // reproduce the burst that got them limited.
        await sleep(backoff + Math.floor(Math.random() * baseMs));
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.#options.timeoutMs ?? 15_000);

      let response: Response;
      try {
        response = await doFetch(this.#options.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: this.#nextId++, method, params }),
          signal: controller.signal,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        lastError = new RpcError(`${method} could not reach the RPC endpoint: ${reason}`);
        continue;
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        lastError = new RpcError(`${method} returned HTTP ${response.status}`, response.status);
        if (!isRetryable(response.status) || attempt === maxRetries) throw lastError;

        const retryAfter = Number(response.headers.get('retry-after'));
        if (Number.isFinite(retryAfter) && retryAfter > 0) {
          await sleep(Math.min(retryAfter * 1000, 30_000));
        }
        continue;
      }

      const body = (await response.json()) as RpcResponse<T>;
      if (body.error) {
        throw new RpcError(`${method} failed: ${body.error.message}`, body.error.code);
      }
      if (body.result === undefined) {
        throw new RpcError(`${method} returned no result`);
      }
      return body.result;
    }

    throw lastError ?? new RpcError(`${method} failed after ${maxRetries} retries`);
  }

  async getSlot(): Promise<number> {
    return this.call<number>('getSlot', [{ commitment: this.commitment }]);
  }

  /**
   * Transaction signatures touching an address, newest first.
   *
   * `before` walks backwards through history a page at a time — the only way
   * to reach anything older than the most recent thousand.
   */
  async getSignatures(
    address: string,
    options: { limit?: number; before?: string; until?: string } = {},
  ): Promise<SignatureInfo[]> {
    const params: Record<string, unknown> = {
      limit: Math.min(options.limit ?? 100, 1000),
      commitment: this.commitment,
    };
    if (options.before) params['before'] = options.before;
    if (options.until) params['until'] = options.until;

    const result = await this.call<RawSignatureInfo[]>('getSignaturesForAddress', [
      address,
      params,
    ]);

    return result.map((entry) => ({
      signature: entry.signature,
      slot: entry.slot,
      blockTime: entry.blockTime ?? null,
      err: entry.err ?? null,
    }));
  }

  /** A transaction's log messages, or null when it is missing or unparseable. */
  async getTransactionLogs(signature: string): Promise<TransactionLogs | null> {
    const result = await this.call<RawTransaction | null>('getTransaction', [
      signature,
      { maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
    ]);
    if (!result) return null;

    return {
      signature,
      slot: result.slot,
      blockTime: result.blockTime ?? null,
      err: result.meta?.err ?? null,
      logMessages: result.meta?.logMessages ?? [],
    };
  }

  async getAccount(address: string): Promise<AccountData | null> {
    const result = await this.call<WithContext<AccountValue | null>>('getAccountInfo', [
      address,
      { encoding: 'base64', commitment: this.commitment },
    ]);
    return result.value ? toAccountData(result.value, result.context.slot) : null;
  }

  /**
   * Find program accounts matching fixed-size filters.
   *
   * This is how a pool is located from a mint: a PumpSwap pool's address is
   * derived from its creator, which is not known in advance, so the mint has to
   * be matched inside the account data instead.
   *
   * Many public endpoints disable this method for large programs because it is
   * expensive to serve. A provider that supports it is required.
   */
  async getProgramAccounts(
    programId: string,
    filters: readonly ProgramAccountFilter[],
  ): Promise<{ address: string; account: AccountData }[]> {
    const result = await this.call<{ pubkey: string; account: AccountValue }[]>(
      'getProgramAccounts',
      [
        programId,
        {
          encoding: 'base64',
          commitment: this.commitment,
          filters: filters.map(toRpcFilter),
        },
      ],
    );

    // getProgramAccounts returns no context slot, so the reads are stamped with
    // 0 and callers that need a slot re-read the specific accounts.
    return result.map((entry) => ({
      address: entry.pubkey,
      account: toAccountData(entry.account, 0),
    }));
  }

  /**
   * Read several accounts in one round trip, at one slot.
   *
   * Reading a pool and its vaults separately would let the two land on
   * different slots, producing reserves that never coexisted. Batching them
   * makes the reading internally consistent.
   */
  async getAccounts(addresses: readonly string[]): Promise<(AccountData | null)[]> {
    if (addresses.length === 0) return [];
    if (addresses.length > 100) {
      throw new RpcError(`getMultipleAccounts takes at most 100 addresses, got ${addresses.length}`);
    }

    const result = await this.call<WithContext<(AccountValue | null)[]>>('getMultipleAccounts', [
      addresses,
      { encoding: 'base64', commitment: this.commitment },
    ]);

    return result.value.map((value) =>
      value ? toAccountData(value, result.context.slot) : null,
    );
  }

  /**
   * Submit a signed transaction.
   *
   * Preflight is left on: the simulation catches a malformed instruction before
   * it costs a fee, and the keeper submits few enough transactions that the
   * extra round trip is worth more than the latency.
   *
   * Resolving means the cluster accepted it, not that it landed. Only reading
   * the chain proves that, which is what reconcile is for.
   */
  async sendTransaction(base64: string): Promise<string> {
    return this.call<string>('sendTransaction', [
      base64,
      { encoding: 'base64', preflightCommitment: this.commitment, maxRetries: 3 },
    ]);
  }

  /**
   * Wait for a signature to settle, or give up.
   *
   * Gives up rather than throwing: a transaction that has not confirmed yet may
   * still land, and treating "not yet" as "failed" is exactly how a batch gets
   * committed twice.
   */
  async confirmSignature(
    signature: string,
    options: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<{ confirmed: boolean; slot: number | null; err: unknown }> {
    const deadline = Date.now() + (options.timeoutMs ?? 60_000);
    const sleep = this.#options.sleepImpl ?? defaultSleep;

    for (;;) {
      const result = await this.call<
        WithContext<({ slot: number; err: unknown; confirmationStatus: string } | null)[]>
      >('getSignatureStatuses', [[signature], { searchTransactionHistory: true }]);

      const status = result.value[0];
      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
        return { confirmed: status.err === null, slot: status.slot, err: status.err };
      }

      if (Date.now() >= deadline) return { confirmed: false, slot: null, err: null };
      await sleep(options.pollMs ?? 1_000);
    }
  }

  /**
   * A blockhash to build a transaction against.
   *
   * `lastValidBlockHeight` is returned with it because a transaction built on a
   * stale blockhash is rejected, and a payment flow that cannot tell a user
   * "this expired, try again" from "this failed" is a payment flow that loses
   * money to confusion.
   */
  async getLatestBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    const result = await this.call<
      WithContext<{ blockhash: string; lastValidBlockHeight: number }>
    >('getLatestBlockhash', [{ commitment: this.commitment }]);
    return result.value;
  }

  /**
   * A transaction, with the balance changes it caused.
   *
   * The balances are the point. An instruction says what it intends to move;
   * the pre and post balances say what actually moved, after every other
   * instruction in the transaction had its turn. Crediting a payment on the
   * former is how you credit a transfer that a later instruction took back.
   */
  async getTransaction(
    signature: string,
    commitment: 'confirmed' | 'finalized' = 'finalized',
  ): Promise<ConfirmedTransaction | null> {
    const result = await this.call<RawFullTransaction | null>('getTransaction', [
      signature,
      { maxSupportedTransactionVersion: 0, commitment, encoding: 'json' },
    ]);
    if (!result) return null;

    return {
      signature,
      slot: result.slot,
      blockTime: result.blockTime ?? null,
      err: result.meta?.err ?? null,
      fee: BigInt(result.meta?.fee ?? 0),
      accountKeys: allAccountKeys(result),
      preBalances: (result.meta?.preBalances ?? []).map((value) => BigInt(value)),
      postBalances: (result.meta?.postBalances ?? []).map((value) => BigInt(value)),
      preTokenBalances: tokenBalances(result.meta?.preTokenBalances),
      postTokenBalances: tokenBalances(result.meta?.postTokenBalances),
      logMessages: result.meta?.logMessages ?? [],
    };
  }
}

/**
 * Every account a transaction touched, in the order its balance arrays index.
 *
 * A versioned transaction can load most of its accounts from an address lookup
 * table, and those do not appear in the message — they arrive separately in
 * `loadedAddresses`. The balance arrays are indexed over the whole set, so
 * reading `accountKeys[i]` without them silently resolves the wrong account or
 * none at all.
 *
 * The order is fixed by the runtime and is not a choice: static keys first,
 * then the writable loaded addresses, then the readonly ones. Getting it wrong
 * would be worse than omitting them, because every index would still resolve to
 * something.
 *
 * Found when a replay of a PumpSwap pool recognised one swap in a hundred and
 * fifty transactions: on that venue the pool's own vaults are routinely in the
 * lookup table, so almost every real trade looked like it never touched the
 * pool. The same gap could refuse a genuine entry payment, since a wallet is
 * free to send a versioned transaction and the treasury it paid would not be
 * found among the keys.
 */
function allAccountKeys(result: RawFullTransaction): string[] {
  const statics = result.transaction?.message?.accountKeys ?? [];
  const loaded = result.meta?.loadedAddresses;
  if (!loaded) return [...statics];
  return [...statics, ...(loaded.writable ?? []), ...(loaded.readonly ?? [])];
}

function tokenBalances(raw: RawTokenBalance[] | undefined): TokenBalanceChange[] {
  return (raw ?? []).map((entry) => ({
    accountIndex: entry.accountIndex,
    mint: entry.mint,
    amount: BigInt(entry.uiTokenAmount?.amount ?? '0'),
    owner: entry.owner ?? null,
  }));
}

/**
 * An SPL token balance, as it stood before or after a transaction.
 *
 * Separate from the lamport arrays because an AMM's reserves are not lamports:
 * a pool's SOL side is wrapped SOL sitting in an ordinary token account, so the
 * only way to see a swap move it is here. `accountIndex` points into
 * `accountKeys`, and the RPC omits accounts that hold no token at all, so this
 * array is shorter than that one and must never be indexed in parallel with it.
 */
export interface TokenBalanceChange {
  readonly accountIndex: number;
  readonly mint: string;
  readonly amount: bigint;
  /**
   * Whose token account this is.
   *
   * The wallet, for a trader's own account; the pool's authority, for a vault.
   * It is what lets a transaction be read from the outside without knowing
   * which venue it went through: the side that moved opposite to the trader is
   * the pool, and its two vaults share this owner.
   */
  readonly owner?: string | null;
}

export interface ConfirmedTransaction {
  readonly signature: string;
  readonly slot: number;
  readonly blockTime: number | null;
  readonly err: unknown;
  /**
   * What the network charged to run this, in lamports.
   *
   * Not part of any trade, and a wallet's lamport change includes it, so
   * reading a trade's size out of balances means taking this back off.
   */
  readonly fee: bigint;
  /** In the transaction's own order, which is what the balance arrays index. */
  readonly accountKeys: readonly string[];
  readonly preBalances: readonly bigint[];
  readonly postBalances: readonly bigint[];
  readonly preTokenBalances: readonly TokenBalanceChange[];
  readonly postTokenBalances: readonly TokenBalanceChange[];
  readonly logMessages: readonly string[];
}

interface RawTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount?: { amount?: string };
}

interface RawFullTransaction {
  slot: number;
  blockTime?: number | null;
  transaction?: { message?: { accountKeys?: string[] } };
  meta?: {
    err?: unknown;
    fee?: number;
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: RawTokenBalance[];
    postTokenBalances?: RawTokenBalance[];
    loadedAddresses?: { writable?: string[]; readonly?: string[] } | null;
    logMessages?: string[];
  } | null;
}

function toAccountData(value: AccountValue, slot: number): AccountData {
  const [encoded, encoding] = value.data;
  if (encoding !== 'base64') {
    throw new RpcError(`expected base64 account data, got ${encoding}`);
  }
  return {
    data: Uint8Array.from(Buffer.from(encoded, 'base64')),
    owner: value.owner,
    lamports: BigInt(value.lamports),
    slot,
  };
}
