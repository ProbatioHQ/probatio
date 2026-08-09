import type { Client } from '@libsql/client';
import { EMPTY_ACCUMULATOR, toHex } from '@probatio/commit';
import type { ChainGateway } from './gateway';

/**
 * Checking that only the keeper has written.
 *
 * The keeper already halts when it finds a record it did not expect — but only
 * for a trader it happened to have work in flight for. A stolen key would be
 * used on the other traders, and nothing would notice.
 *
 * So this walks every trader the keeper has ever committed for and asks the
 * chain what it holds. The last confirmed commit recorded a predicted
 * accumulator; the chain must hold exactly that. Anything else means somebody
 * signed with the keeper's key.
 *
 * The check is cheap and the conclusion is certain. Because the accumulator is
 * a hash chain, a foreign commit changes the value permanently and cannot be
 * undone by anyone — including whoever holds the key. That is what makes this
 * detection rather than a guess, and it is also why detection has to be
 * standing rather than incidental.
 */

export type AuditVerdict = 'clean' | 'foreign_commit' | 'missing_record' | 'unreadable';

export interface AuditFinding {
  readonly seasonId: number;
  readonly seasonOrdinal: number;
  readonly trader: string;
  readonly verdict: AuditVerdict;
  readonly expected: string;
  readonly onChain: string | null;
  readonly detail: string;
}

export interface AuditResult {
  readonly checked: number;
  readonly findings: readonly AuditFinding[];
  /** True when anything was found that only the keeper's key could have done. */
  readonly compromised: boolean;
}

/**
 * @param seasonOrdinalFor Maps a season id to the ordinal the chain knows it by.
 */
export async function auditRecords(
  db: Client,
  chain: ChainGateway,
  seasonOrdinalFor: (seasonId: number) => number,
): Promise<AuditResult> {
  // The last confirmed commit per trader per season. That predicted
  // accumulator is what the chain should hold, exactly.
  const rows = await db.execute(
    `SELECT c.season_id, c.user_pubkey, c.predicted_accumulator, c.id
     FROM commits c
     JOIN (
       SELECT season_id, user_pubkey, MAX(id) AS last_id
       FROM commits WHERE confirmed_at IS NOT NULL
       GROUP BY season_id, user_pubkey
     ) latest
       ON latest.season_id = c.season_id
      AND latest.user_pubkey = c.user_pubkey
      AND latest.last_id = c.id`,
  );

  const findings: AuditFinding[] = [];

  for (const row of rows.rows) {
    const seasonId = Number(row['season_id']);
    const trader = String(row['user_pubkey']);
    const expected = String(row['predicted_accumulator']);
    const ordinal = seasonOrdinalFor(seasonId);

    let onChain: string | null;
    try {
      const record = await chain.readRecord(ordinal, trader);
      onChain = record?.accumulator ?? null;
    } catch (error) {
      findings.push({
        seasonId,
        seasonOrdinal: ordinal,
        trader,
        verdict: 'unreadable',
        expected,
        onChain: null,
        detail: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    if (onChain === expected) continue;

    if (onChain === null) {
      // A record we committed to that the chain does not have. Not a
      // compromise — more likely a commit that never landed and was marked
      // confirmed wrongly — but it means the local record is not on chain,
      // which is its own problem.
      findings.push({
        seasonId,
        seasonOrdinal: ordinal,
        trader,
        verdict: 'missing_record',
        expected,
        onChain: null,
        detail: 'the chain has no record for a trader we recorded a confirmed commit for',
      });
      continue;
    }

    findings.push({
      seasonId,
      seasonOrdinal: ordinal,
      trader,
      verdict: 'foreign_commit',
      expected,
      onChain,
      detail:
        'the chain holds an accumulator this keeper never predicted. Only the ' +
        'keeper key can write here, so the key has been used by somebody else.',
    });
  }

  return {
    checked: rows.rows.length,
    findings,
    compromised: findings.some((finding) => finding.verdict === 'foreign_commit'),
  };
}

/**
 * What an empty record should look like.
 *
 * Exported so a caller checking a trader with no commits at all can tell "never
 * written" from "written by somebody else" — for a trader we have never
 * committed for, any record on chain is a foreign one.
 */
export const NO_RECORD = toHex(EMPTY_ACCUMULATOR);
