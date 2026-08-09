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

  constructor(options: RpcOptions) {
    if (!options.endpoint) {
      throw new RpcError('an RPC endpoint is required');
    }
    this.#options = options;
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
