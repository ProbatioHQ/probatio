import { commitHistory, ensureFreePlaySeason, seasonByOrdinal } from '@probatio/db';
import { leavesFor, loadTrades } from '@probatio/keeper';
import { db } from '@/lib/db';
import { rateLimit } from '@/lib/rate-limit';

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

/**
 * The trader's most recent season that actually has commitments, if any.
 *
 * Read straight from the commits table rather than guessed from the season
 * list: a trader may have traded in three seasons and be committed in one.
 */
async function seasonWithCommitsFor(
  client: Awaited<ReturnType<typeof db>>,
  trader: string,
): Promise<{ id: number; ordinal: number } | null> {
  const result = await client.execute({
    sql: `SELECT c.season_id AS id, s.ordinal AS ordinal
          FROM commits c
          JOIN seasons s ON s.id = c.season_id
          WHERE c.user_pubkey = ? AND c.confirmed_at IS NOT NULL
          ORDER BY s.ordinal DESC, c.id DESC
          LIMIT 1`,
    args: [trader],
  });
  const row = result.rows[0];
  return row ? { id: Number(row['id']), ordinal: Number(row['ordinal']) } : null;
}

export async function GET(request: Request): Promise<Response> {
  const throttled = await rateLimit(request, 'chainRead');
  if (throttled.response) return throttled.response;

  const url = new URL(request.url);
  const trader = url.searchParams.get('trader');
  const ordinal = url.searchParams.get('season');

  if (!trader || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trader)) {
    return Response.json({ error: 'trader must be a base58 address' }, { status: 400 });
  }

  const client = await db();
  const now = Date.now();

  /*
   * Which season to prove.
   *
   * Asked for explicitly when a season is named. Otherwise the one this trader
   * actually has commitments in, most recent first — because defaulting to
   * free play meant the verify page could only ever check unranked records.
   * Every ranked season is the one that pays money, and there was no way to
   * reach one from the interface at all: the form has a wallet and an endpoint
   * and nowhere to say which season.
   *
   * A parsed ordinal is required to be a number. `Number('abc')` is NaN, which
   * matched nothing and fell through to free play, quietly answering a
   * different question than the one asked.
   */
  const parsed = ordinal === null ? null : Number(ordinal);
  if (parsed !== null && !Number.isInteger(parsed)) {
    return Response.json({ error: 'season must be an integer ordinal' }, { status: 400 });
  }

  const season = parsed === null ? null : await seasonByOrdinal(client, parsed);
  if (parsed !== null && !season) {
    return Response.json({ error: `no season with ordinal ${parsed}` }, { status: 404 });
  }

  const withCommits = season ? null : await seasonWithCommitsFor(client, trader);
  const seasonId = season?.id ?? withCommits?.id ?? (await ensureFreePlaySeason(client, now));

  /*
   * The ordinal of the season actually used, not of the one that was asked for.
   *
   * These are two different things whenever the season is chosen rather than
   * named, and reporting the wrong one is not cosmetic: the verifier derives
   * the on-chain record address from this number. Sending -1 while proving
   * season 0 pointed the reader's browser at an account that does not exist
   * and reported the record as missing — a failed verification for a record
   * that was committed correctly.
   */
  const usedOrdinal = season?.ordinal ?? withCommits?.ordinal ?? -1;

  const commits = await commitHistory(client, seasonId, trader);
  if (commits.length === 0) {
    return Response.json({
      trader,
      seasonId,
      seasonOrdinal: usedOrdinal,
      batches: [],
      note: 'Nothing has been committed on chain for this trader in this season yet.',
    });
  }

  // Every batch, with the leaves that built it, in committed order. Order is
  // part of the claim: a merkle root is not a set, and the same leaves in a
  // different order produce a different root.
  //
  // Wrapped so a rebuild problem returns a JSON error rather than an unhandled
  // non-JSON 500 the verifier cannot read. A leaf that will not rebuild
  // (LeafMismatchError) or a count that disagrees with what was committed is a
  // data problem worth naming, not a crash.
  let batches;
  try {
    batches = await Promise.all(
      commits.map(async (commit, index) => {
        const trades = await loadTrades(
          client,
          seasonId,
          trader,
          commit.fromTradeId,
          commit.toTradeId,
        );
        const leaves = leavesFor(trades);
        // The stored range can, in a non-contiguous history, load more trades
        // than the batch committed; a proof over a superset would fold a leaf
        // count that disagrees with the root and fail a genuine record. Refuse
        // rather than serve a proof that cannot verify.
        if (leaves.length !== commit.leafCount) {
          throw new Error(
            `batch ${index} rebuilt ${leaves.length} leaves but ${commit.leafCount} were committed`,
          );
        }
        return {
          batchIndex: index,
          root: commit.merkleRoot,
          leaves: commit.leafCount,
          engineVersion: commit.engineVersion,
          previousAccumulator: commit.previousAccumulator,
          predictedAccumulator: commit.predictedAccumulator,
          txSignature: commit.txSignature,
          slot: commit.slot,
          trades: leaves.map((leaf) => ({
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
  } catch (error) {
    console.error('[proof] could not rebuild proof for', trader, error);
    return Response.json(
      {
        error:
          'This record could not be rebuilt from storage. Its stored trades disagree ' +
          'with what was committed, so no honest proof can be served for it.',
      },
      { status: 500 },
    );
  }

  return Response.json({
    trader,
    seasonId,
    seasonOrdinal: usedOrdinal,
    batches,
    // Read this from the chain yourself. Ours is not the copy that counts.
    howToVerify:
      'Rebuild each leaf, recompute each batch root, fold the roots into the ' +
      'accumulator chain, and compare the result against the trader record on ' +
      'chain. The /verify page does this in your browser against an RPC you choose.',
  });
}
