import { commitHistory, ensureFreePlaySeason, seasonByOrdinal } from '@probatio/db';
import { leavesFor, loadTrades } from '@probatio/keeper';
import { db } from '@/lib/db';

/**
 * Everything a stranger needs to check a trader's record without us.
 *
 * This endpoint hands over inputs, not conclusions. It says nothing about
 * whether the record is valid — that question is answered by recomputing the
 * hashes and comparing them to the chain, which is work the verifier does
 * themselves against an RPC they choose.
 *
 * If this returned a verdict it would be worthless. A server saying its own
 * records are correct is the thing the whole design exists to avoid needing.
 */

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const trader = url.searchParams.get('trader');
  const ordinal = url.searchParams.get('season');

  if (!trader || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trader)) {
    return Response.json({ error: 'trader must be a base58 address' }, { status: 400 });
  }

  const client = await db();
  const now = Date.now();

  const season =
    ordinal === null
      ? null
      : await seasonByOrdinal(client, Number(ordinal));
  const seasonId = season?.id ?? (await ensureFreePlaySeason(client, now));

  const commits = await commitHistory(client, seasonId, trader);
  if (commits.length === 0) {
    return Response.json({
      trader,
      seasonId,
      seasonOrdinal: season?.ordinal ?? -1,
      batches: [],
      note: 'Nothing has been committed on chain for this trader in this season yet.',
    });
  }

  // Every batch, with the leaves that built it, in committed order. Order is
  // part of the claim: a merkle root is not a set, and the same leaves in a
  // different order produce a different root.
  const batches = await Promise.all(
    commits.map(async (commit, index) => {
      const trades = await loadTrades(
        client,
        seasonId,
        trader,
        commit.fromTradeId,
        commit.toTradeId,
      );
      return {
        batchIndex: index,
        root: commit.merkleRoot,
        leaves: commit.leafCount,
        engineVersion: commit.engineVersion,
        previousAccumulator: commit.previousAccumulator,
        predictedAccumulator: commit.predictedAccumulator,
        txSignature: commit.txSignature,
        slot: commit.slot,
        trades: leavesFor(trades).map((leaf) => ({
          ...leaf,
          solAmount: leaf.solAmount.toString(),
          tokenAmount: leaf.tokenAmount.toString(),
          feeLamports: leaf.feeLamports.toString(),
          solReserve: leaf.solReserve.toString(),
          tokenReserve: leaf.tokenReserve.toString(),
          deliverableTokens: leaf.deliverableTokens.toString(),
        })),
      };
    }),
  );

  return Response.json({
    trader,
    seasonId,
    seasonOrdinal: season?.ordinal ?? -1,
    batches,
    // Read this from the chain yourself. Ours is not the copy that counts.
    howToVerify:
      'Rebuild each leaf, recompute each batch root, fold the roots into the ' +
      'accumulator chain, and compare the result against the trader record on ' +
      'chain. The /verify page does this in your browser against an RPC you choose.',
  });
}
