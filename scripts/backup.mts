/**
 * Back the database up.
 *
 * Plain JSON Lines with a manifest, not a vendor dump. A backup that can only
 * be restored by the tool that made it is a bet that the tool still exists and
 * still works on the day it is needed, and that day is chosen by the failure.
 *
 * The manifest carries a row count and a content hash per table. Without them a
 * truncated backup restores quietly and looks fine — every table present, some
 * rows missing — which is worse than a backup that visibly fails.
 *
 *   DATABASE_URL=file:./app/probatio.db npx tsx scripts/backup.mts [outDir]
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDatabase } from '@probatio/db';

const url = process.env['DATABASE_URL'] ?? 'file:./app/probatio.db';
const outDir = process.argv[2] ?? './backups';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = join(outDir, stamp);

const db = openDatabase({ url });

const tables = (
  await db.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )
).rows.map((row) => String(row['name']));

mkdirSync(target, { recursive: true });

interface TableManifest {
  rows: number;
  sha256: string;
  file: string;
}

const manifest: Record<string, TableManifest> = {};

for (const table of tables) {
  const result = await db.execute(`SELECT * FROM "${table}"`);

  // Column order comes from the schema, not from object key order, so a
  // restore does not depend on how a JSON parser happens to iterate.
  const columns = result.columns;
  const lines = result.rows.map((row) =>
    JSON.stringify(columns.map((column) => (row as Record<string, unknown>)[column] ?? null)),
  );

  const body = lines.join('\n');
  const file = `${table}.jsonl`;
  writeFileSync(join(target, file), body === '' ? '' : `${body}\n`);

  manifest[table] = {
    rows: result.rows.length,
    sha256: createHash('sha256').update(body).digest('hex'),
    file,
  };
  console.log(`  ${table.padEnd(20)} ${String(result.rows.length).padStart(7)} rows`);
}

// Tables before everything else. Ordering by name puts an index on
// suspended_tokens ahead of the table it indexes, and the restore fails on a
// backup that is otherwise perfect — found by running the drill rather than by
// reading the script.
const schemaStatements = (
  await db.execute(
    `SELECT sql FROM sqlite_master
     WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
     ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'view' THEN 1 ELSE 2 END, name`,
  )
).rows.map((row) => String(row['sql']));

// Stored as an array, not as one file to be split on semicolons later. The
// append-only triggers contain semicolons inside their bodies, so any text
// split reassembles them wrongly and the restore dies on "incomplete input" —
// found by running the drill, not by reading the script.
writeFileSync(join(target, 'schema.json'), `${JSON.stringify(schemaStatements, null, 2)}\n`);
// Kept alongside for reading. Never parsed.
writeFileSync(join(target, 'schema.sql'), `${schemaStatements.join(';\n\n')};\n`);

const columnsByTable: Record<string, string[]> = {};
for (const table of tables) {
  const info = await db.execute(`PRAGMA table_info("${table}")`);
  columnsByTable[table] = info.rows.map((row) => String(row['name']));
}

writeFileSync(
  join(target, 'manifest.json'),
  `${JSON.stringify(
    {
      takenAt: Date.now(),
      source: url,
      tables: manifest,
      columns: columnsByTable,
      // What is NOT in here. Stated because a backup that quietly excludes the
      // thing you cannot rebuild is worse than no backup at all.
      excludes: [
        'program/target/deploy/probatio-keypair.json — the only key that can deploy to the program address',
        'SESSION_SECRET — losing it signs everyone out, nothing worse',
        'TREASURY_ADDRESS private key — held in a wallet, never on this server',
        'ANTHROPIC_API_KEY',
      ],
    },
    null,
    2,
  )}\n`,
);

const total = Object.values(manifest).reduce((sum, entry) => sum + entry.rows, 0);
console.log(`\n${tables.length} tables, ${total} rows -> ${target}`);
