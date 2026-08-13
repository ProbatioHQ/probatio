import { DEFAULT_API_BASE } from './constants';
import type { ProfileRecord, ProofBundle, Standings } from './types';

/**
 * Reading the public record.
 *
 * These endpoints hand over inputs, never verdicts. `getProof` in particular
 * returns the raw material a verifier recomputes from; it says nothing about
 * whether the record is valid, which is `verifyRecord`'s job and is done against
 * the chain, not against this server.
 */

export class ProbatioError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProbatioError';
  }
}

export interface ReadOptions {
  /** Base URL of a Probatio instance. Defaults to https://probatio.app. */
  readonly apiBase?: string | undefined;
  /** Injected fetch, for tests or a non-browser runtime. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch | undefined;
}

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function resolveFetch(options: ReadOptions): typeof fetch {
  const impl = options.fetchImpl ?? (globalThis.fetch as typeof fetch | undefined);
  if (!impl) throw new ProbatioError('no fetch available; pass fetchImpl');
  return impl;
}

async function getJson<T>(url: string, options: ReadOptions): Promise<T> {
  const doFetch = resolveFetch(options);
  let response: Response;
  try {
    response = await doFetch(url, { headers: { accept: 'application/json' } });
  } catch (error) {
    throw new ProbatioError(`could not reach ${url}: ${(error as Error).message}`);
  }
  const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok || body === null) {
    throw new ProbatioError(body?.error ?? `${url} returned HTTP ${response.status}`, response.status);
  }
  return body;
}

function base(options: ReadOptions): string {
  return (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '');
}

/** The raw inputs to check a trader's record. A specific season, or the latest committed. */
export async function getProof(
  trader: string,
  options: ReadOptions & { readonly season?: number | undefined } = {},
): Promise<ProofBundle> {
  if (!ADDRESS.test(trader)) throw new ProbatioError(`not a base58 address: ${trader}`);
  const season = options.season === undefined ? '' : `&season=${options.season}`;
  return getJson<ProofBundle>(`${base(options)}/api/proof?trader=${trader}${season}`, options);
}

/** A trader's public record: their name, the seasons they traded, and where to prove it. */
export async function getRecord(trader: string, options: ReadOptions = {}): Promise<ProfileRecord> {
  if (!ADDRESS.test(trader)) throw new ProbatioError(`not a base58 address: ${trader}`);
  return getJson<ProfileRecord>(`${base(options)}/api/profile?trader=${trader}`, options);
}

/** The standings of a season, or the current one when none is named. */
export async function getStandings(
  options: ReadOptions & { readonly season?: number | undefined; readonly limit?: number | undefined } = {},
): Promise<Standings> {
  const params = new URLSearchParams();
  if (options.season !== undefined) params.set('season', String(options.season));
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  const query = params.toString();
  return getJson<Standings>(`${base(options)}/api/leaderboard${query ? `?${query}` : ''}`, options);
}
