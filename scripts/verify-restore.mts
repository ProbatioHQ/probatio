/**
 * Prove a restore is complete, not just readable.
 *
 * A manifest check says the file arrived whole. It cannot say the data inside
 * it is the data that was committed — for that you need a record kept somewhere
 * the backup could not have influenced, and this product has one.
 *
 * Every trade was hashed into a merkle leaf, batched into a root, and folded
 * into an accumulator chain that was published on chain. So a restored database
 * can be checked against its own commitments: rebuild every leaf from the
 * restored rows, recompute every root, re-fold the chain, and require the
 * result to match what was committed. A restore missing one trade, or holding
 * one altered field, cannot produce the same hashes.
 *
 *   npx tsx scripts/verify-restore.mts <targetUrl>
 */
import { EMPTY_ACCUMULATOR, extendChain, hashLeaf, merkleRoot, toHex } from '@probatio/commit';
import { leavesFor, loadTrades } from '@probatio/keeper';
import { openDatabase } from '@probatio/db';

const url = process.argv[2];
if (!url) {
  console.error('usage: verify-restore.mts <targetUrl>');
  process.exit(1);
}

const db = openDatabase({ url });

const commits = (
  await db.execute(
    `SELECT id, season_id, user_pubkey, merkle_root, leaf_count, from_trade_id, to_trade_id,
            engine_version, previous_accumulator, predicted_accumulator
     FROM commits WHERE confirmed_at IS NOT NULL
     ORDER BY season_id, user_pubkey, id`,
  )
).rows.map((row) => ({
  id: Number(row['id']),
  seasonId: Number(row['season_id']),
  trader: String(row['user_pubkey']),
  root: String(row['merkle_root']),
  leafCount: Number(row['leaf_count']),
  from: Number(row['from_trade_id']),
  to: Number(row['to_trade_id']),
  engineVersion: Number(row['engine_version']),
  previous: String(row['previous_accumulator']),
  predicted: String(row['predicted_accumulator']),
}));

if (commits.length === 0) {
  console.log('no confirmed commits to verify against');
  process.exit(0);
}

const problems: string[] = [];
let leavesChecked = 0;
let rootsChecked = 0;

// Grouped by trader: the accumulator chain is per trader per season, so folding
// across traders would produce a number that matches nothing.
const chains = new Map<string, string>();

for (const commit of commits) {
  const key = `${commit.seasonId}:${commit.trader}`;
  const accumulator = chains.get(key) ?? toHex(EMPTY_ACCUMULATOR);

  const trades = await loadTrades(db, commit.seasonId, commit.trader, commit.from, commit.to);

  if (trades.length !== commit.leafCount) {
    problems.push(
      `commit ${commit.id}: committed ${commit.leafCount} trades, restored database has ${trades.length}`,
    );
    continue;
  }

  // Throws if a stored leaf hash disagrees with a rebuild, which is exactly the
  // signal a corrupted or partial restore produces.
  let leaves;
  try {
    leaves = leavesFor(trades);
  } catch (error) {
    problems.push(`commit ${commit.id}: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
  leavesChecked += leaves.length;

  const root = toHex(merkleRoot(leaves.map(hashLeaf)));
  if (root !== commit.root) {
    problems.push(`commit ${commit.id}: root rebuilt to ${root.slice(0, 16)}… but ${commit.root.slice(0, 16)}… was committed`);
    continue;
  }
  rootsChecked += 1;

  if (accumulator !== commit.previous) {
    problems.push(
      `commit ${commit.id}: chain is at ${accumulator.slice(0, 16)}… but the commit follows ${commit.previous.slice(0, 16)}…`,
    );
    continue;
  }

  const next = toHex(
    extendChain(
      Uint8Array.from(Buffer.from(accumulator, 'hex')),
      Uint8Array.from(Buffer.from(commit.root, 'hex')),
      commit.leafCount,
      commit.engineVersion,
    ),
  );
  if (next !== commit.predicted) {
    problems.push(`commit ${commit.id}: chain gives ${next.slice(0, 16)}… but ${commit.predicted.slice(0, 16)}… was committed`);
    continue;
  }

  chains.set(key, next);
}

console.log(`${commits.length} commits, ${leavesChecked} trades rebuilt, ${rootsChecked} roots matched`);
console.log(`${chains.size} accumulator chains re-folded`);

if (problems.length > 0) {
  console.log(`\n${problems.length} problems:`);
  for (const problem of problems.slice(0, 10)) console.log(`  ${problem}`);
  process.exit(1);
}

console.log('\nevery restored trade reproduces the hash that was committed for it');
