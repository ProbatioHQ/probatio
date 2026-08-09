import { sha256 } from '@noble/hashes/sha2.js';

/**
 * The hash chain the on-chain program keeps.
 *
 * This must match `commit_root` in the Anchor program byte for byte:
 *
 * ```text
 * accumulator = sha256(accumulator || batch_root || leaves_le_u32 || engine_version_le_u32)
 * ```
 *
 * Duplicating the logic in two languages is a real risk — the two can drift
 * apart and nobody notices until a verification fails in front of a user. So
 * the shapes are pinned by tests that check known vectors, and the keeper
 * compares its predicted accumulator against what the chain actually stored
 * after every commit.
 *
 * The little-endian widths are not a choice. They are what `to_le_bytes()`
 * produces on a Rust `u32`, and getting either wrong yields a different chain
 * that would look correct until someone tried to check it.
 */

export const EMPTY_ACCUMULATOR: Uint8Array = new Uint8Array(32);

function u32LittleEndian(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error(`not a u32: ${value}`);
  }
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

/** Fold one batch into the chain. */
export function extendChain(
  accumulator: Uint8Array,
  batchRoot: Uint8Array,
  leaves: number,
  engineVersion: number,
): Uint8Array {
  if (accumulator.length !== 32) {
    throw new Error(`accumulator must be 32 bytes, got ${accumulator.length}`);
  }
  if (batchRoot.length !== 32) {
    throw new Error(`batch root must be 32 bytes, got ${batchRoot.length}`);
  }
  if (leaves <= 0) {
    throw new Error('a batch must contain at least one leaf');
  }

  const input = new Uint8Array(32 + 32 + 4 + 4);
  input.set(accumulator, 0);
  input.set(batchRoot, 32);
  input.set(u32LittleEndian(leaves), 64);
  input.set(u32LittleEndian(engineVersion), 68);

  return sha256(input);
}

export interface Batch {
  readonly root: Uint8Array;
  readonly leaves: number;
  readonly engineVersion: number;
}

/**
 * Replay a whole sequence of batches.
 *
 * What a verifier runs: given every batch a trader's record claims, this
 * arrives at the accumulator the chain should hold. If it does not match, the
 * claimed history is not the committed one.
 */
export function replayChain(batches: readonly Batch[]): Uint8Array {
  let accumulator: Uint8Array = EMPTY_ACCUMULATOR;
  for (const batch of batches) {
    accumulator = extendChain(accumulator, batch.root, batch.leaves, batch.engineVersion);
  }
  return accumulator;
}
