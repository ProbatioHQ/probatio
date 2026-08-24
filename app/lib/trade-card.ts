import 'server-only';
import { reconstruct, type LoggedTrade } from '@probatio/analytics';
import { displayName, displaySymbol, getTokenMetadata, tradeHistory, type Client } from '@probatio/db';

/**
 * A closed trade, reduced to what can honestly go on a card somebody posts.
 *
 * The card is the one distribution channel this project has. There is no ad
 * budget and no mailing list, so it travels because a trader chose to post it,
 * which means it has to be worth posting and it has to survive a skeptic.
 *
 * WHAT MAKES IT WORTH POSTING IS NOT THE NUMBER
 *
 * Everyone in this market has seen a screenshot of a huge gain and nobody
 * believes any of them, because a screenshot costs nothing to fabricate. Two
 * things here cannot be faked into an image, and both of them are the product:
 *
 * The cost of getting out. Every other card shows the multiple and hides the
 * exit. This one carries the fee and the price impact both legs actually paid,
 * which is the number that decides whether a trade was real and the number a
 * paper trader that flatters you cannot produce.
 *
 * The seal. Every fill carries a leaf hash, so the card can name the record and
 * say where to check it. Somebody who saves the image still holds the means to
 * disprove it.
 *
 * NOTHING HERE IS RECOMPUTED
 *
 * The trip comes out of `reconstruct`, the same replay the profile and the
 * coach read, which itself runs through `applyFill` rather than a second copy
 * of the cost-basis arithmetic. A card disagreeing with the profile it links to
 * would be worse than having no card.
 */

export interface TradeCard {
  /** The closing sell's leaf hash: what a verifier is pointed at. */
  readonly leafHash: string;
  readonly mint: string;
  readonly name: string;
  readonly symbol: string;
  /** The token's own art, when the metadata has any. */
  readonly image: string | null;

  /** Lamports in, lamports out, and the difference. Signed. */
  readonly invested: string;
  readonly proceeds: string;
  readonly realized: string;
  /** Return on what was put in, in basis points. Signed. */
  readonly returnBps: number;

  readonly heldMs: number;
  readonly closedAt: number;

  /**
   * What the round trip cost to make, beyond being wrong or right.
   *
   * Fees across every leg, and the worst price impact any single leg paid.
   * Worst rather than summed: impact is not additive across fills, and adding
   * it would produce a number that means nothing while looking precise.
   */
  readonly feesPaid: string;
  readonly worstImpactBps: number;
  readonly fills: number;
}

/** How far back a card may be made from. Beyond this it is not news. */
const HISTORY = 400;

function toLogged(row: {
  mint: string;
  side: 'buy' | 'sell';
  solAmount: string;
  tokenAmount: string;
  fee: string;
  priceImpactBps: number;
  createdAt: number;
}): LoggedTrade {
  return {
    mint: row.mint,
    side: row.side,
    solAmount: BigInt(row.solAmount),
    tokenAmount: BigInt(row.tokenAmount),
    feeLamports: BigInt(row.fee),
    priceImpactBps: row.priceImpactBps,
    at: row.createdAt,
  };
}

/**
 * The closed round trips on this account, newest first.
 *
 * Losses included, and that is deliberate rather than an oversight. A feed of
 * nothing but winners is the thing nobody believes; the traders who post their
 * losses are the reason the winners read as real.
 */
export async function cardsFor(
  client: Client,
  accountId: number,
  limit = 20,
): Promise<TradeCard[]> {
  const rows = await tradeHistory(client, accountId, HISTORY);
  if (rows.length === 0) return [];

  // `reconstruct` replays forward, and the log arrives newest first.
  const ordered = [...rows].reverse();
  /*
   * Keyed on more than the moment, defensively rather than in response to
   * anything observed. Two fills on one token sharing a millisecond would make
   * a key of mint and time ambiguous, and the wrong answer would be the opening
   * buy's seal on a card describing the closing sell. Each fill waits out the
   * season's latency, so this is not reachable today; the wider key costs
   * nothing and removes the question.
   */
  const key = (row: { mint: string; side: string; createdAt: number; solAmount: string }): string =>
    `${row.mint}:${row.createdAt}:${row.side}:${row.solAmount}`;
  const byFill = new Map(ordered.map((row) => [key(row), row]));
  const { closed } = reconstruct(ordered.map(toLogged));

  /*
   * Only what the replay could follow all the way through, which it enforces
   * itself rather than needing to be filtered here.
   *
   * This reads a bounded slice of the log, so a trader active enough to push a
   * position's opening buys past that edge leaves a sell with less behind it
   * than it needs. That was worth checking rather than assuming, because the
   * failure it would cause is the bad kind: a smaller cost basis is a *larger*
   * return, and a flattering wrong number on a public card is exactly what this
   * project cannot ship. It does not happen. `applyFill` throws when a sell
   * exceeds the position it is against, so the replay reports that fill as
   * skipped and never opens a trip for it.
   *
   * Dropping every trip on a token that had *any* skipped fill was the first
   * attempt at this, and it was worse than doing nothing: a trader whose oldest
   * sell fell off the edge would have lost the perfectly complete round trips
   * they made in that token afterwards.
   */
  const newest = [...closed].sort((a, b) => b.closedAt - a.closedAt).slice(0, limit);
  const mints = [...new Set(newest.map((trip) => trip.mint))];
  const metadata = await Promise.all(mints.map((mint) => getTokenMetadata(client, mint)));
  const known = new Map(mints.map((mint, index) => [mint, metadata[index] ?? null]));

  return newest.map((trip) => {
    const last = trip.trades[trip.trades.length - 1];
    /*
     * The closing sell's own row, so the card names the leaf a verifier will
     * actually recompute. The replay does not carry the hash — it works on
     * arithmetic, not on rows — so it is looked back up rather than invented.
     */
    const closing = last
      ? byFill.get(
          `${last.mint}:${last.at}:${last.side}:${last.solAmount.toString()}`,
        )
      : undefined;
    const token = known.get(trip.mint) ?? null;

    const worstImpactBps = trip.trades.reduce(
      (worst, fill) => Math.max(worst, fill.priceImpactBps),
      0,
    );

    /*
     * Against what was put in, not against what came back. Return on cost is
     * the figure a trader means when they say a number out loud, and it is the
     * one the profile and the leaderboard already use.
     */
    const returnBps =
      trip.invested > 0n ? Number((trip.realized * 10_000n) / trip.invested) : 0;

    return {
      leafHash: closing?.leafHash ?? '',
      mint: trip.mint,
      // Falls back to the mint's own head when nothing has been read for it,
      // which is the same thing every other surface here shows.
      name: token ? displayName(token) : trip.mint.slice(0, 4),
      symbol: token ? displaySymbol(token) : '???',
      image: token?.imageUrl ?? null,
      invested: trip.invested.toString(),
      proceeds: trip.proceeds.toString(),
      realized: trip.realized.toString(),
      returnBps,
      heldMs: trip.heldMs,
      closedAt: trip.closedAt,
      feesPaid: trip.feesPaid.toString(),
      worstImpactBps,
      fills: trip.trades.length,
    };
  });
}
