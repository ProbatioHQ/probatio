# Backups, and the drill

A backup nobody has restored is a belief, not a backup. This describes the
procedure and the result of actually running it.

## Taking one

    DATABASE_URL=<url> npx tsx scripts/backup.mts ./backups

Writes one JSON Lines file per table, the schema as an array of statements, and
a manifest holding a row count and content hash for every table.

Plain JSON rather than a vendor dump on purpose: a backup that can only be read
by the tool that wrote it is a bet that the tool still works on the day it is
needed, and that day is chosen by the failure.

## Restoring one

    npx tsx scripts/restore.mts <backupDir> <targetUrl>

The schema is restored from the backup, not by re-running migrations. Replaying
migrations rebuilds *today's* schema, which is not necessarily the one the data
was written under, and the difference only surfaces on the day it matters.

Every table's hash and row count is checked against the manifest, and the
database's own `foreign_key_check` runs at the end. A restore that satisfies the
manifest but violates a foreign key has restored a shape, not a record.

## Proving it is complete

    npx tsx scripts/verify-restore.mts <targetUrl>

This is the step that distinguishes a restore from a hope. Every trade was
hashed into a merkle leaf, batched into a root, and folded into an accumulator
chain published on chain. So a restored database can be checked against records
kept somewhere the backup could not influence: rebuild every leaf from the
restored rows, recompute every root, re-fold every chain, and require the
results to match what was committed.

A restore missing one trade, or holding one altered field, cannot produce the
same hashes.

## The drill, actually run

12 traders, 108 trades, 36 commits, 350 rows across 21 tables.

| Step | Result |
|---|---|
| Backup | 21 tables, 350 rows |
| Restore into an empty database | 350 rows, manifest and foreign keys satisfied |
| Verify against commitments | 36 commits, 108 trades rebuilt, 36 roots matched, 12 chains re-folded |

**Two real bugs were found by running it**, neither of which a reading of the
scripts would have caught:

1. The schema was dumped ordered by name, so an index was created before the
   table it indexes and every restore failed on a perfectly good backup.
2. The schema was reassembled by splitting text on semicolons, which cuts the
   append-only triggers in half — their bodies contain semicolons. The restore
   died on `incomplete input`. Statements are now stored as an array and never
   re-parsed.

## Detection, tested against a forged backup

A backup file was edited to change one trade's amount, and its manifest hash was
repaired so the integrity check would pass — the case a manifest cannot catch by
construction, since whoever changed the data can change its hash.

    restore:  350 rows restored, manifest and foreign keys both satisfied
    verify:   commit 2: trade 5 rebuilds to 5a602ff3… but 6ecdac19… was committed
              commit 3: chain is at 8a72c33d… but the commit follows 81302cec…

The restore was clean. The commitments caught it, and caught the break it caused
in every commit after it.

## What a backup does not contain

Listed in every manifest, because a backup that quietly omits the thing you
cannot rebuild is worse than no backup.

- `program/target/deploy/probatio-keypair.json` — **the only key that can deploy
  to the program address.** Losing it cannot be recovered from any database
  backup. Back it up separately and offline.
- `SESSION_SECRET` — losing it signs everyone out. Nothing worse.
- The treasury wallet key — held in a wallet, never on the server.
- `ANTHROPIC_API_KEY`.

## Not yet done

No schedule and no offsite copy: this runs by hand today. Automating it belongs
with deployment, and claiming it here before it exists would be the sort of
belief this document is written against.
