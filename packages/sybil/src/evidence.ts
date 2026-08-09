import type { RpcClient, SignatureInfo } from '@probatio/pools';

/**
 * What the chain says about a wallet.
 *
 * Gathered once, when somebody enters, and then kept. Kept is the important
 * part: the pot is not really what a sybil is after.
 *
 * Farming the prize does not pay. An attacker holding k of N entries expects
 * k/N of the pot whatever the payout shape, which after the house cut is a
 * small guaranteed loss. What does pay is farming a *record*: run twenty
 * wallets across three seasons, throw away the nineteen that failed, and
 * present the survivor as skill. That attack does not need to win any money,
 * only to produce one clean history — and the place it is cashed in is capital
 * allocation, years later, by somebody who cannot see the nineteen.
 *
 * So the evidence is recorded at entry, when it is cheap and truthful, rather
 * than reconstructed later when the nineteen are long gone.
 */

export interface WalletEvidence {
  readonly pubkey: string;
  /** Unix ms of the oldest transaction found, or null if the wallet is empty. */
  readonly firstSeenAt: number | null;
  /** Transactions found, up to the search limit. */
  readonly signatureCount: number;
  /** True when the count hit the limit and the wallet is older than it looks. */
  readonly truncated: boolean;
  /**
   * Who paid for this wallet's first transaction, if it could be read. The
   * single most useful signal there is: twenty wallets funded from one place
   * are one person however carefully they trade.
   */
  readonly funder: string | null;
  readonly gatheredAt: number;
}

/** How far back to look. Enough to date a wallet without paging forever. */
const MAX_PAGES = 5;
const PAGE = 1_000;

export async function gatherEvidence(
  rpc: RpcClient,
  pubkey: string,
  now: number,
): Promise<WalletEvidence> {
  let signatures: SignatureInfo[] = [];
  let before: string | undefined;
  let truncated = false;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const batch = await rpc.getSignatures(pubkey, {
      limit: PAGE,
      ...(before ? { before } : {}),
    });
    signatures = signatures.concat(batch);
    if (batch.length < PAGE) break;
    before = batch[batch.length - 1]!.signature;
    if (page === MAX_PAGES - 1) truncated = true;
  }

  if (signatures.length === 0) {
    return {
      pubkey,
      firstSeenAt: null,
      signatureCount: 0,
      truncated: false,
      funder: null,
      gatheredAt: now,
    };
  }

  // Returned newest first, so the oldest is last.
  const oldest = signatures[signatures.length - 1]!;
  const firstSeenAt = oldest.blockTime === null ? null : oldest.blockTime * 1_000;

  return {
    pubkey,
    firstSeenAt,
    signatureCount: signatures.length,
    truncated,
    funder: await findFunder(rpc, pubkey, oldest.signature),
    gatheredAt: now,
  };
}

/**
 * Who paid for this wallet's first transaction.
 *
 * The fee payer of the oldest transaction the wallet appears in. For a freshly
 * created wallet that is whoever funded it, which is exactly the link worth
 * having. For a wallet whose own first act was signing, it is the wallet
 * itself, and that is reported honestly rather than dressed up as an unknown.
 */
async function findFunder(
  rpc: RpcClient,
  pubkey: string,
  signature: string,
): Promise<string | null> {
  try {
    const transaction = await rpc.getTransaction(signature, 'confirmed');
    const payer = transaction?.accountKeys[0] ?? null;
    return payer === pubkey ? null : payer;
  } catch {
    // A funder that cannot be read is unknown, never assumed.
    return null;
  }
}
