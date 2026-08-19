import { sha256 } from '@noble/hashes/sha2.js';
import { NODE_PREFIX } from './leaf';

/**
 * Merkle trees over trade leaves.
 *
 * Two details here are not cosmetic.
 *
 * Leaves and internal nodes carry different domain prefixes, so an internal
 * node can never be presented as a leaf. Without that separation a proof could
 * pass off a pair of hashes as a single trade.
 *
 * An odd node is promoted to the next level unchanged rather than duplicated.
 * Duplicating it, the well-known Bitcoin approach, lets two different trees
 * produce the same root, which would mean a record could be swapped for a
 * different one with the same commitment.
 */

export class MerkleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MerkleError';
  }
}

export function hashNode(left: Uint8Array, right: Uint8Array): Uint8Array {
  const combined = new Uint8Array(1 + left.length + right.length);
  combined[0] = NODE_PREFIX;
  combined.set(left, 1);
  combined.set(right, 1 + left.length);
  return sha256(combined);
}

export interface ProofStep {
  readonly sibling: Uint8Array;
  /** True when the sibling sits on the left. Order matters to the hash. */
  readonly siblingOnLeft: boolean;
}

export interface MerkleTree {
  readonly root: Uint8Array;
  readonly leafCount: number;
  /** Every level, leaves first. Kept so proofs cost nothing to produce. */
  readonly levels: readonly (readonly Uint8Array[])[];
}

export function buildTree(leafHashes: readonly Uint8Array[]): MerkleTree {
  if (leafHashes.length === 0) {
    throw new MerkleError('cannot build a tree with no leaves');
  }

  const levels: Uint8Array[][] = [[...leafHashes]];

  while (levels[levels.length - 1]!.length > 1) {
    const current = levels[levels.length - 1]!;
    const next: Uint8Array[] = [];

    for (let i = 0; i < current.length; i += 2) {
      const left = current[i]!;
      const right = current[i + 1];
      // Promoted, not duplicated. Duplicating would let two different trees
      // share a root.
      next.push(right ? hashNode(left, right) : left);
    }

    levels.push(next);
  }

  return {
    root: levels[levels.length - 1]![0]!,
    leafCount: leafHashes.length,
    levels,
  };
}

export function merkleRoot(leafHashes: readonly Uint8Array[]): Uint8Array {
  return buildTree(leafHashes).root;
}

/** The path proving a leaf belongs to the tree. */
export function buildProof(tree: MerkleTree, index: number): ProofStep[] {
  if (!Number.isInteger(index) || index < 0 || index >= tree.leafCount) {
    throw new MerkleError(`leaf index ${index} is outside a tree of ${tree.leafCount}`);
  }

  const proof: ProofStep[] = [];
  let position = index;

  for (let level = 0; level < tree.levels.length - 1; level += 1) {
    const nodes = tree.levels[level]!;
    const isRight = position % 2 === 1;
    const siblingIndex = isRight ? position - 1 : position + 1;
    const sibling = nodes[siblingIndex];

    // No sibling means this node was promoted unchanged, so the level adds
    // nothing to the path.
    if (sibling) {
      proof.push({ sibling, siblingOnLeft: isRight });
    }

    position = Math.floor(position / 2);
  }

  return proof;
}

/**
 * Recompute a root from a leaf and its path.
 *
 * This is the whole point of the exercise: anyone holding one trade and a
 * short path can arrive at the root that was committed on chain, without our
 * database and without our cooperation.
 */
export function computeRoot(leafHash: Uint8Array, proof: readonly ProofStep[]): Uint8Array {
  let current = leafHash;
  for (const step of proof) {
    current = step.siblingOnLeft
      ? hashNode(step.sibling, current)
      : hashNode(current, step.sibling);
  }
  return current;
}

export function equalHashes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function verifyProof(
  leafHash: Uint8Array,
  proof: readonly ProofStep[],
  root: Uint8Array,
): boolean {
  return equalHashes(computeRoot(leafHash, proof), root);
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new MerkleError(`not valid hex: ${hex}`);
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
