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

  for (const line of lines) {
    const values = JSON.parse(line) as unknown[];
    await db.execute({
      sql: `INSERT INTO "${table}" (${quoted}) VALUES (${placeholders})`,
      args: values as never,
    });
  }
  restored += lines.length;
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
