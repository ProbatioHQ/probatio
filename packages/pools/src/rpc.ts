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

export class RpcClient {
  readonly #options: RpcOptions;
  #nextId = 1;

  constructor(options: RpcOptions) {
    if (!options.endpoint) {
      throw new RpcError('an RPC endpoint is required');
    }
    this.#options = options;
  }

  private get commitment(): string {
    return this.#options.commitment ?? 'confirmed';
  }

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    const doFetch = this.#options.fetchImpl ?? fetch;
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
      throw new RpcError(`${method} could not reach the RPC endpoint: ${reason}`);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new RpcError(`${method} returned HTTP ${response.status}`, response.status);
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

  async getSlot(): Promise<number> {
    return this.call<number>('getSlot', [{ commitment: this.commitment }]);
  }

  async getAccount(address: string): Promise<AccountData | null> {
    const result = await this.call<WithContext<AccountValue | null>>('getAccountInfo', [
      address,
      { encoding: 'base64', commitment: this.commitment },
    ]);
    return result.value ? toAccountData(result.value, result.context.slot) : null;
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
