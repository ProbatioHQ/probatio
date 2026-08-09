/**
 * The keeper's view of the chain.
 *
 * Narrow on purpose. The keeper's key can append trade commitments and do
 * nothing else — it cannot change a season's rules, take an entry, or publish
 * results. That restriction is enforced by the program, but expressing it in
 * the interface too means no amount of later code can quietly widen what the
 * hot key is used for.
 *
 * The concrete Solana implementation arrives with deployment. Until the program
 * is on a cluster, an adapter would be written against nothing.
 */

export interface CommitReceipt {
  readonly signature: string;
  readonly slot: number;
}

export interface OnChainRecord {
  /** 32 bytes, hex-encoded. */
  readonly accumulator: string;
  readonly commitCount: number;
  readonly leafCount: number;
}

export class GatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayError';
  }
}

export interface ChainGateway {
  /**
   * Append a batch to a trader's record.
   *
   * Resolving means the transaction was confirmed. Rejecting means it may or
   * may not have landed — which is exactly why the keeper never treats a
   * rejection as proof of anything and reconciles by reading the chain
   * instead.
   */
  commitRoot(input: {
    readonly seasonOrdinal: number;
    readonly trader: string;
    readonly merkleRoot: string;
    readonly leaves: number;
    readonly engineVersion: number;
  }): Promise<CommitReceipt>;

  /** The record as the chain currently holds it, or null if none exists yet. */
  readRecord(seasonOrdinal: number, trader: string): Promise<OnChainRecord | null>;
}
