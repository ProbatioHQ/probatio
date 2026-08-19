/**
 * @probatio/commit: canonical trade encoding, merkle trees and proofs.
 *
 * What turns "we say these trades happened" into something a stranger can
 * check without trusting us. A leaf carries everything needed to recompute the
 * trade, a merkle path proves it belongs to a batch, and the batch's root is
 * folded into a hash chain the program keeps on chain.
 */

export { LEAF_BYTES, LEAF_PREFIX, LeafError, NODE_PREFIX, encodeLeaf, hashLeaf } from './leaf';
export type { TradeLeaf } from './leaf';

export {
  MerkleError,
  buildProof,
  buildTree,
  computeRoot,
  equalHashes,
  fromHex,
  hashNode,
  merkleRoot,
  toHex,
  verifyProof,
} from './merkle';
export type { MerkleTree, ProofStep } from './merkle';

export { EMPTY_ACCUMULATOR, extendChain, replayChain } from './chain';
export type { Batch } from './chain';

export { explainVerification, verifyTrade } from './verify';
export type {
  CommittedBatch,
  VerificationInput,
  VerificationResult,
  VerificationStatus,
  VerificationStep,
} from './verify';
