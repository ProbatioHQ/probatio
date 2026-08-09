import type { Client, StoredCommit } from '@probatio/db';
import {
  discardIntent,
  lastConfirmedCommit,
  markAttempted,
  markConfirmed,
  markFailed,
  pendingCommits,
  recordIntent,
} from '@probatio/db';
import { EMPTY_ACCUMULATOR, extendChain, fromHex, toHex } from '@probatio/commit';
import type { ChainGateway } from './gateway';

/**
 * The keeper.
 *
 * It has one job that is easy — batch trades and commit their root — wrapped
 * around one that is not: doing so across a database and a chain that cannot
 * be written together.
 *
 * A commit that lands on chain but is not recorded here would be committed
 * again on restart, folding the same batch into the accumulator twice. Nothing
 * later can unfold it. So the intent is always written first, carrying the
 * accumulator the keeper expects afterwards, and a restart reconciles by
 * reading the chain rather than by guessing.
 *
 * When the chain holds a value that is neither the expected one nor the
 * previous one, the keeper stops. That means something wrote to the record
 * that this keeper did not, and continuing would build on a history it cannot
 * account for.
 */

export type Health = 'ok' | 'halted';

export interface CommitRequest {
  readonly seasonId: number;
  readonly seasonOrdinal: number;
  readonly userPubkey: string;
  readonly merkleRoot: string;
  readonly leafCount: number;
  readonly fromTradeId: number;
  readonly toTradeId: number;
  readonly engineVersion: number;
}

export interface CycleResult {
  readonly committed: number;
  readonly reconciled: number;
  readonly discarded: number;
  readonly failed: number;
  readonly health: Health;
  readonly halt?: string;
}

export class KeeperHalt extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeeperHalt';
  }
}

/** Where a trader's chain currently stands according to our own records. */
async function localAccumulator(
  db: Client,
  seasonId: number,
  userPubkey: string,
): Promise<string> {
  const last = await lastConfirmedCommit(db, seasonId, userPubkey);
  return last ? last.predictedAccumulator : toHex(EMPTY_ACCUMULATOR);
}

export function predictAccumulator(
  previous: string,
  merkleRoot: string,
  leaves: number,
  engineVersion: number,
): string {
  return toHex(extendChain(fromHex(previous), fromHex(merkleRoot), leaves, engineVersion));
}

export class Keeper {
  readonly #db: Client;
  readonly #chain: ChainGateway;
  #halted: string | null = null;

  constructor(db: Client, chain: ChainGateway) {
    this.#db = db;
    this.#chain = chain;
  }

  get halted(): string | null {
    return this.#halted;
  }

  /**
   * Resolve every intent that was written but never confirmed.
   *
   * Runs before any new work. Committing on top of an unresolved intent would
   * mean guessing whether the earlier batch landed, and guessing wrong in
   * either direction corrupts the chain permanently.
   */
  async reconcile(seasonOrdinalFor: (seasonId: number) => number): Promise<{
    reconciled: number;
    discarded: number;
    halt?: string;
  }> {
    let reconciled = 0;
    let discarded = 0;

    for (const pending of await pendingCommits(this.#db)) {
      const record = await this.#chain.readRecord(
        seasonOrdinalFor(pending.seasonId),
        pending.userPubkey,
      );
      const onChain = record?.accumulator ?? toHex(EMPTY_ACCUMULATOR);

      if (onChain === pending.predictedAccumulator) {
        // It landed. The transaction signature is lost, but the chain agreeing
        // is the stronger evidence anyway.
        await markConfirmed(this.#db, pending.id, pending.txSignature ?? 'recovered', record?.commitCount ?? 0, Date.now());
        reconciled += 1;
        continue;
      }

      if (onChain === pending.previousAccumulator) {
        // It never landed, so the batch can be safely planned again.
        await discardIntent(this.#db, pending.id);
        discarded += 1;
        continue;
      }

      const halt =
        `commit ${pending.id} for ${pending.userPubkey}: the chain holds ${onChain}, ` +
        `which is neither the expected ${pending.predictedAccumulator} nor the previous ` +
        `${pending.previousAccumulator}. Something wrote to this record that the keeper did not.`;
      this.#halted = halt;
      return { reconciled, discarded, halt };
    }

    return { reconciled, discarded };
  }

  /**
   * Commit one batch, write-ahead.
   *
   * The order is the whole point: record the intent, send, verify the chain
   * agrees, then confirm. A crash at any step leaves something reconcilable.
   */
  async commit(request: CommitRequest): Promise<StoredCommit['id'] | null> {
    if (this.#halted) throw new KeeperHalt(this.#halted);

    const previous = await localAccumulator(this.#db, request.seasonId, request.userPubkey);
    const predicted = predictAccumulator(
      previous,
      request.merkleRoot,
      request.leafCount,
      request.engineVersion,
    );

    const id = await recordIntent(
      this.#db,
      {
        seasonId: request.seasonId,
        userPubkey: request.userPubkey,
        merkleRoot: request.merkleRoot,
        leafCount: request.leafCount,
        fromTradeId: request.fromTradeId,
        toTradeId: request.toTradeId,
        engineVersion: request.engineVersion,
        previousAccumulator: previous,
        predictedAccumulator: predicted,
      },
      Date.now(),
    );

    await markAttempted(this.#db, id);

    let receipt;
    try {
      receipt = await this.#chain.commitRoot({
        seasonOrdinal: request.seasonOrdinal,
        trader: request.userPubkey,
        merkleRoot: request.merkleRoot,
        leaves: request.leafCount,
        engineVersion: request.engineVersion,
      });
    } catch (error) {
      // A rejection is not proof the transaction failed — it may have landed
      // and the response been lost. The intent stays for reconcile to settle.
      await markFailed(this.#db, id, error instanceof Error ? error.message : String(error));
      return null;
    }

    // The chain is read back rather than trusted. If the accumulator is not
    // what was predicted, our idea of this trader's history is already wrong
    // and every later commit would compound it.
    const record = await this.#chain.readRecord(request.seasonOrdinal, request.userPubkey);
    const actual = record?.accumulator ?? '';

    if (actual !== predicted) {
      const halt =
        `after committing for ${request.userPubkey} the chain holds ${actual}, ` +
        `but ${predicted} was expected. The keeper's view of this record is wrong.`;
      await markFailed(this.#db, id, halt);
      this.#halted = halt;
      throw new KeeperHalt(halt);
    }

    await markConfirmed(this.#db, id, receipt.signature, receipt.slot, Date.now());
    return id;
  }

  /** Clear a halt. Deliberate, because a halt means something is unexplained. */
  resume(): void {
    this.#halted = null;
  }
}
