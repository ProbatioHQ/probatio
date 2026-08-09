/**
 * Can the fee wallet finish the season it is in.
 *
 * The question that matters, rather than what has been spent. If the keeper
 * runs out mid-season the trades after that point are never committed, and
 * uncommitted trades void the season under the published policy — so this has
 * to be answered while topping up still helps.
 *
 *   DATABASE_URL=file:./app/probatio.db KEEPER_ADDRESS=<pubkey> npx tsx scripts/treasury.mts
 */
import { RpcClient } from '@probatio/pools';
import { currentRankedSeason, migrate, openDatabase } from '@probatio/db';
import {
  RECORD_RENT_LAMPORTS,
  SIGNATURE_FEE_LAMPORTS,
  checkTreasury,
  coversItsCosts,
  estimateSeasonCost,
} from '@probatio/keeper';

const url = process.env['DATABASE_URL'] ?? 'file:./app/probatio.db';
const keeperAddress = process.env['KEEPER_ADDRESS'] ?? null;
const batchSize = Number(process.env['BATCH_SIZE'] ?? '256');

const db = openDatabase({ url });
await migrate(db);

const now = Date.now();
const season = await currentRankedSeason(db, now);

const sol = (lamports: bigint): string => `${(Number(lamports) / 1e9).toFixed(4)} SOL`;

console.log('Cost of recording, measured against mainnet\n');
console.log(`  trader record rent   ${RECORD_RENT_LAMPORTS} lamports  (${sol(RECORD_RENT_LAMPORTS)})`);
console.log(`  signature fee        ${SIGNATURE_FEE_LAMPORTS} lamports`);
console.log('\n  Rent dominates. A trader who makes one trade costs almost exactly as');
console.log('  much to record as one who makes a thousand.\n');

// What the season has actually done so far, and what is plausibly left.
const traders = season
  ? Number(
      (
        await db.execute({
          sql: 'SELECT COUNT(DISTINCT user_pubkey) AS n FROM accounts WHERE season_id = ?',
          args: [season.id],
        })
      ).rows[0]?.['n'] ?? 0,
    )
  : 0;

const trades = season
  ? Number(
      (
        await db.execute({
          sql: 'SELECT COUNT(*) AS n FROM trades WHERE season_id = ?',
          args: [season.id],
        })
      ).rows[0]?.['n'] ?? 0,
    )
  : 0;

const committed = season
  ? Number(
      (
        await db.execute({
          sql: `SELECT COALESCE(SUM(leaf_count), 0) AS n FROM commits
                WHERE season_id = ? AND confirmed_at IS NOT NULL`,
          args: [season.id],
        })
      ).rows[0]?.['n'] ?? 0,
    )
  : 0;

if (!season) {
  console.log('No ranked season. Free play costs nothing to record — it is never committed.');
  process.exit(0);
}

const tradesEach = traders === 0 ? 0 : Math.ceil(trades / traders);
console.log(`Season ${season.ordinal}: ${traders} trader(s), ${trades} trade(s), ${committed} committed`);

const whole = estimateSeasonCost({ traders, tradesEach, batchSize });
console.log(`\nRecording it all costs about ${sol(whole.totalLamports)}`);
console.log(`  ${whole.records} record(s)  ${sol(whole.rentLamports)}`);
console.log(`  ${whole.commits} commit(s)  ${sol(whole.feeLamports)}`);

// Everything not yet committed is still to pay for, plus whoever has not
// traded yet. Projected forward rather than measured, and said so.
const projectedTraders = Number(process.env['PROJECTED_TRADERS'] ?? String(traders));
const remaining = {
  traders: Math.max(0, projectedTraders),
  tradesEach,
  batchSize,
};

if (keeperAddress) {
  const rpc = new RpcClient({
    endpoint: process.env['RPC_URL'] ?? 'https://api.mainnet-beta.solana.com',
    timeoutMs: 20_000,
  });
  const account = await rpc.getAccount(keeperAddress).catch(() => null);
  const balance = BigInt(account?.lamports ?? 0);

  const check = checkTreasury({ balanceLamports: balance, remaining });
  console.log(`\nKeeper ${keeperAddress}`);
  console.log(`  balance   ${sol(check.balanceLamports)}`);
  console.log(`  needs     ${sol(check.requiredLamports)} to finish with the margin held`);
  console.log(`  verdict   ${check.verdict.toUpperCase()} — ${check.detail}`);
  console.log(`  affords   ${check.tradersAffordable} more trader record(s)`);

  if (check.verdict === 'insufficient') process.exit(2);
  if (check.verdict === 'low') process.exit(1);
} else {
  console.log('\nSet KEEPER_ADDRESS to check a real balance against this.');
}

const pot = BigInt(season.entryCost) * BigInt(traders);
const economics = coversItsCosts(pot, 1_000, 1_000_000_000n, whole);
console.log(`\nPot ${sol(pot)}, house cut ${sol(economics.revenueLamports)}`);

if (traders === 0) {
  // Zero covers zero, which is arithmetic rather than good news.
  console.log('  nothing to record and nothing to pay for it with');
} else {
  console.log(
    economics.covered
      ? '  the season pays for recording itself'
      : '  recorded at a loss — no cut is taken below a one SOL pot, by design',
  );
}

// What it looks like at a size worth planning for.
for (const size of [20, 100, 500]) {
  const shape = { traders: size, tradesEach: Math.max(1, tradesEach) || 50, batchSize };
  const cost = estimateSeasonCost(shape);
  const scale = coversItsCosts(BigInt(season.entryCost) * BigInt(size), 1_000, 1_000_000_000n, cost);
  console.log(
    `  at ${String(size).padStart(4)} traders: costs ${sol(cost.totalLamports)}, ` +
      `cut ${sol(scale.revenueLamports)}  ${scale.covered ? 'covered' : 'at a loss'}`,
  );
}
