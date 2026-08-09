import { hashLeaf, type TradeLeaf } from './leaf';
import { buildProof, buildTree, computeRoot, equalHashes, fromHex, toHex } from './merkle';
import { EMPTY_ACCUMULATOR, extendChain } from './chain';

/**
 * Checking that a trade is really committed.
 *
 * The whole point of the commitment machinery is that this can be run by
 * somebody who does not trust us. Everything needed is data they can be handed
 * or read themselves: the trade, the other trades in its batch, the list of
 * batches, and the accumulator the chain holds. Nothing here reaches for a
 * database.
 *
 * It reports which step failed rather than a bare yes or no. "Your trade does
 * not verify" tells nobody anything; "the leaf and the batch are fine but the
 * chain does not hold what these batches produce" says exactly who has the
 * problem.
 */

export type VerificationStatus =
  | 'verified'
  | 'leaf_not_in_batch'
  | 'batch_root_mismatch'
  | 'chain_mismatch'
  | 'batch_not_found';

export interface VerificationStep {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface CommittedBatch {
  /** Hex merkle root, as recorded when the batch was committed. */
  readonly root: string;
  readonly leaves: number;
  readonly engineVersion: number;
}

export interface VerificationInput {
  /** The trade being checked, as claimed. */
  readonly trade: TradeLeaf;
  /**
   * Every leaf in the batch that should contain it, in committed order.
   *
   * Order matters: a merkle root is not a set. Supplying the same leaves in a
   * different order produces a different root and the check fails, which is
   * correct rather than inconvenient.
   */
  readonly batchLeaves: readonly TradeLeaf[];
  /** Index of the batch within the trader's committed history, from 0. */
  readonly batchIndex: number;
  /** Every batch committed for this trader in this season, oldest first. */
  readonly history: readonly CommittedBatch[];
  /** Hex accumulator currently on chain, or null if the record does not exist. */
  readonly onChainAccumulator: string | null;
}

export interface VerificationResult {
  readonly status: VerificationStatus;
  readonly verified: boolean;
  readonly detail: string;
  readonly steps: readonly VerificationStep[];
  readonly leafHash: string;
  /** The root recomputed from the supplied leaves. */
  readonly computedRoot?: string;
  /** The accumulator the supplied history produces. */
  readonly expectedAccumulator?: string;
}

function step(name: string, ok: boolean, detail: string): VerificationStep {
  return { name, ok, detail };
}

export function verifyTrade(input: VerificationInput): VerificationResult {
  const steps: VerificationStep[] = [];
  const leafHash = hashLeaf(input.trade);
  const leafHex = toHex(leafHash);

  steps.push(
    step('hash the trade', true, `the trade hashes to ${leafHex.slice(0, 16)}…`),
  );

  const batch = input.history[input.batchIndex];
  if (!batch) {
    return {
      status: 'batch_not_found',
      verified: false,
      detail: `there is no batch ${input.batchIndex} in a history of ${input.history.length}`,
      steps: [...steps, step('locate the batch', false, 'no such batch')],
      leafHash: leafHex,
    };
  }

  // The trade has to be one of the leaves the batch was built from. Comparing
  // hashes rather than fields means any difference at all — a changed amount, a
  // changed slot — shows up here.
  const hashes = input.batchLeaves.map((leaf) => hashLeaf(leaf));
  const index = hashes.findIndex((hash) => equalHashes(hash, leafHash));

  if (index === -1) {
    return {
      status: 'leaf_not_in_batch',
      verified: false,
      detail:
        'this trade is not one of the leaves in that batch — either it was never committed, ' +
        'or the version being checked differs from the one that was',
      steps: [...steps, step('find the trade in its batch', false, 'not present')],
      leafHash: leafHex,
    };
  }

  steps.push(
    step('find the trade in its batch', true, `it is leaf ${index} of ${hashes.length}`),
  );

  const tree = buildTree(hashes);
  const proof = buildProof(tree, index);
  const computedRoot = toHex(computeRoot(leafHash, proof));

  if (computedRoot !== batch.root) {
    return {
      status: 'batch_root_mismatch',
      verified: false,
      detail:
        `these leaves produce root ${computedRoot.slice(0, 16)}… but the batch was committed ` +
        `as ${batch.root.slice(0, 16)}… — the batch contents do not match what was committed`,
      steps: [
        ...steps,
        step('rebuild the batch root', false, 'the leaves do not produce the committed root'),
      ],
      leafHash: leafHex,
      computedRoot,
    };
  }

  steps.push(
    step(
      'rebuild the batch root',
      true,
      `${proof.length} hashes prove the trade belongs to ${batch.root.slice(0, 16)}…`,
    ),
  );

  // Replaying the whole history is what makes this a commitment rather than a
  // claim. A batch could be perfectly well-formed and still never have been
  // committed, or have been committed and then followed by batches that are
  // not in the list being checked.
  let accumulator = EMPTY_ACCUMULATOR;
  for (const entry of input.history) {
    accumulator = extendChain(
      accumulator,
      fromHex(entry.root),
      entry.leaves,
      entry.engineVersion,
    );
  }
  const expected = toHex(accumulator);

  if (input.onChainAccumulator === null) {
    return {
      status: 'chain_mismatch',
      verified: false,
      detail: 'the chain holds no record for this trader and season at all',
      steps: [...steps, step('match the chain', false, 'no on-chain record')],
      leafHash: leafHex,
      computedRoot,
      expectedAccumulator: expected,
    };
  }

  if (expected !== input.onChainAccumulator) {
    return {
      status: 'chain_mismatch',
      verified: false,
      detail:
        `these ${input.history.length} batches produce ${expected.slice(0, 16)}… but the chain ` +
        `holds ${input.onChainAccumulator.slice(0, 16)}… — the history being checked is not the ` +
        'one that was committed',
      steps: [...steps, step('match the chain', false, 'the accumulator does not match')],
      leafHash: leafHex,
      computedRoot,
      expectedAccumulator: expected,
    };
  }

  return {
    status: 'verified',
    verified: true,
    detail:
      `this trade is leaf ${index} of batch ${input.batchIndex}, and the ${input.history.length} ` +
      'batches committed for this trader produce exactly the accumulator the chain holds',
    steps: [
      ...steps,
      step('match the chain', true, `the chain holds ${expected.slice(0, 16)}…`),
    ],
    leafHash: leafHex,
    computedRoot,
    expectedAccumulator: expected,
  };
}

/** A short human-readable summary, for a verification page. */
export function explainVerification(result: VerificationResult): string {
  const lines = [result.verified ? 'VERIFIED' : `NOT VERIFIED — ${result.status}`, ''];
  for (const entry of result.steps) {
    lines.push(`  ${entry.ok ? 'ok  ' : 'FAIL'} ${entry.name} — ${entry.detail}`);
  }
  lines.push('', result.detail);
  return lines.join('\n');
}
