/**
 * Restore a backup into a fresh database, and check that it arrived whole.
 *
 * The checking is the point. A restore that runs without error proves the file
 * was readable, not that the data is all there — a truncated backup restores
 * quietly, with every table present and rows missing, and nobody finds out
 * until somebody's record is short.
 *
 *   npx tsx scripts/restore.mts <backupDir> <targetUrl>
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '@probatio/db';

const source = process.argv[2];
const targetUrl = process.argv[3];

if (!source || !targetUrl) {
  console.error('usage: restore.mts <backupDir> <targetUrl>');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8')) as {
  takenAt: number;
  tables: Record<string, { rows: number; sha256: string; file: string }>;
  columns: Record<string, string[]>;
};

const db = openDatabase({ url: targetUrl });

// Schema first, straight from the backup rather than by re-running migrations.
// A restore that replays migrations restores today's schema, not the one the
// data was written under, and the difference only shows up on the day it
// matters.
//
// Read as an array. The append-only triggers contain semicolons in their
// bodies, so splitting a text dump on them reassembles the statements wrongly.
const statements = JSON.parse(readFileSync(join(source, 'schema.json'), 'utf8')) as string[];
for (const statement of statements) {
  await db.execute(statement);
}

await db.execute('PRAGMA foreign_keys = OFF');

let restored = 0;
const problems: string[] = [];

// Ordered so a table's referenced rows land first where possible; foreign keys
// are off regardless, and checked again at the end.
const order = Object.keys(manifest.tables).sort((a, b) => {
  const rank = (name: string): number =>
    name === 'users' ? 0 : name === 'seasons' ? 1 : name === 'accounts' ? 2 : 3;
  return rank(a) - rank(b) || a.localeCompare(b);
});

for (const table of order) {
  const entry = manifest.tables[table]!;
  const body = readFileSync(join(source, entry.file), 'utf8');
  const trimmed = body.endsWith('\n') ? body.slice(0, -1) : body;

  const digest = createHash('sha256').update(trimmed).digest('hex');
  if (digest !== entry.sha256) {
    problems.push(`${table}: file hash does not match the manifest`);
    continue;
  }

  const lines = trimmed === '' ? [] : trimmed.split('\n');
  if (lines.length !== entry.rows) {
    problems.push(`${table}: manifest says ${entry.rows} rows, file has ${lines.length}`);
    continue;
  }
  if (lines.length === 0) continue;

  const columns = manifest.columns[table]!;
  const placeholders = columns.map(() => '?').join(', ');
  const quoted = columns.map((column) => `"${column}"`).join(', ');
  const sql = `INSERT INTO "${table}" (${quoted}) VALUES (${placeholders})`;

  /*
   * Batched, and that is not a micro-optimisation.
   *
   * This was one awaited round trip per row. A real database here is four
   * hundred thousand rows, almost all of them candles, and a restore of it did
   * not finish inside ten minutes — with no output at all while it ground
   * through the largest table, because progress was only printed once a table
   * was done. An operator restoring during an incident would have watched a
   * silent terminal and concluded the tool was broken.
   *
   * A backup that cannot be restored in the time an incident allows is not a
   * backup, so the drill is the thing that found this rather than the thing
   * that confirmed it was fine.
   */
  const CHUNK = 500;
  for (let offset = 0; offset < lines.length; offset += CHUNK) {
    const chunk = lines.slice(offset, offset + CHUNK);
    await db.batch(
      chunk.map((line) => ({ sql, args: JSON.parse(line) as never })),
      'write',
    );

    // Progress inside a table as well as between them. The largest table is
    // most of the wait, and silence during it is what looks like a hang.
    //
    // Carriage returns only when a person is watching. A restore is usually
    // run with its output redirected to a file, and rewriting the same line
    // into a log turns the record of the incident into one long smear.
    if (lines.length > CHUNK * 4 && (offset / CHUNK) % 20 === 0) {
      const done = Math.min(offset + CHUNK, lines.length);
      const line = `  ${table.padEnd(20)} ${String(done).padStart(7)} / ${lines.length} rows`;
      if (process.stdout.isTTY) process.stdout.write(`\r${line}`);
      else console.log(line);
    }
  }

  restored += lines.length;
  if (lines.length > CHUNK * 4 && process.stdout.isTTY) process.stdout.write('\r');
  console.log(`  ${table.padEnd(20)} ${String(lines.length).padStart(7)} rows`);
}

await db.execute('PRAGMA foreign_keys = ON');

// The database's own opinion, after everything is in. A restore that satisfies
// the manifest but violates a foreign key has restored a shape, not a record.
const violations = await db.execute('PRAGMA foreign_key_check');
if (violations.rows.length > 0) {
  problems.push(`${violations.rows.length} foreign key violations after restore`);
}

console.log(`\n${restored} rows restored from a backup taken ${new Date(manifest.takenAt).toISOString()}`);

if (problems.length > 0) {
  console.log('\nPROBLEMS:');
  for (const problem of problems) console.log(`  ${problem}`);
  process.exit(1);
}

console.log('manifest and foreign keys both satisfied');
