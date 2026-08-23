import 'server-only';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Reading the audit the repository wrote about itself.
 *
 * The result is a file in the repository, not a row in a table, and this only
 * reads it. That is the entire point of the arrangement: a self-audit stored
 * somewhere I can quietly rewrite is worth exactly as much as a screenshot of a
 * green number, and this site's whole argument is that those are worth nothing.
 * Committed, the history belongs to git, and the commit is the evidence.
 *
 * So there is deliberately no writer here. Nothing the running site can do
 * changes what a past pass found.
 */

export interface AuditFinding {
  readonly severity: 'error' | 'warning';
  readonly file: string;
  readonly line: number | null;
  readonly detail: string;
}

export interface AuditCheck {
  readonly id: string;
  readonly title: string;
  readonly inspected: number;
  readonly findings: readonly AuditFinding[];
}

export interface AuditPass {
  readonly at: number;
  readonly checks: number;
  readonly inspected: number;
  readonly errors: number;
  readonly warnings: number;
  readonly results: readonly AuditCheck[];
}

export interface AuditSummary {
  readonly at: number;
  readonly checks: number;
  readonly inspected: number;
  readonly errors: number;
  readonly warnings: number;
}

export interface Autonomy {
  readonly latest: AuditPass | null;
  readonly history: readonly AuditSummary[];
}

const DIR = join(process.cwd(), '..', 'audit');
/** Also the app's own directory, since the server may run from either. */
const FALLBACK = join(process.cwd(), 'audit');

async function readJson<T>(name: string): Promise<T | null> {
  for (const dir of [DIR, FALLBACK]) {
    try {
      return JSON.parse(await readFile(join(dir, name), 'utf8')) as T;
    } catch {
      /* Try the other, then give up. */
    }
  }
  return null;
}

/**
 * The last pass and the strip of ones before it.
 *
 * Null rather than an invented empty pass when the file is missing, because
 * "no audit has run" and "an audit ran and found nothing" are opposite facts
 * and a page that renders the first as the second is lying by omission. The
 * board says which it is.
 */
export async function autonomy(): Promise<Autonomy> {
  const [latest, history] = await Promise.all([
    readJson<AuditPass>('latest.json'),
    readJson<AuditSummary[]>('history.json'),
  ]);

  return { latest, history: history ?? [] };
}
