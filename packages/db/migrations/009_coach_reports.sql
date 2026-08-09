-- What the coach was given, and what it did with it.
--
-- The `reports` table already existed with the right idea: keep the metrics
-- beside the wording, so a report can be audited against its own inputs. These
-- columns finish it.
--
-- `trips_at_report` is the important one. It is what makes "nothing has changed
-- since your last report" answerable, and paired with the unique index below it
-- turns that rule into a constraint rather than a check that happened moments
-- before the write. Two requests arriving together both pass an in-process
-- check; only one can pass this.

ALTER TABLE reports ADD COLUMN trips_at_report INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reports ADD COLUMN headline TEXT NOT NULL DEFAULT '';
ALTER TABLE reports ADD COLUMN focus TEXT NOT NULL DEFAULT '';

-- Cost, kept per report. One paid call per session across a season is the whole
-- budget for this feature, and it cannot be watched if it is not recorded.
ALTER TABLE reports ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reports ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;

-- How much of the model's reply failed checking. Zero in normal operation.
-- Anything else means it is inventing figures, which is worth knowing before a
-- trader tells us rather than after.
ALTER TABLE reports ADD COLUMN dropped INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX reports_account_kind_trips_idx
  ON reports (account_id, kind, trips_at_report)
  WHERE account_id IS NOT NULL;
