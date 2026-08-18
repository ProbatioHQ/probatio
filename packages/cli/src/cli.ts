import { Probatio, ProbatioError, type VerifiedRecord } from '@probatio/sdk';

/**
 * The Probatio command line.
 *
 * Checking a record from a terminal, against an RPC you name, is the plainest
 * form of "do not trust us, check". `run` is written to be testable: it takes
 * its output sinks and an optional fetch, and returns an exit code rather than
 * calling `process.exit`, so the binary in `bin.ts` is the only part that
 * touches the process.
 */

export interface CliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

const stdoutIo: CliIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

const HELP = `probatio, the open prop firm

Usage
  probatio verify <wallet> [--season <n>] [--api <url>] [--json]
  probatio record <wallet> [--api <url>] [--json]
  probatio standings [--limit <n>] [--api <url>] [--json]
  probatio season [--api <url>] [--json]
  probatio proof <wallet> [--season <n>] [--api <url>]

Options
  --season <n>    a specific season ordinal, default the latest committed
  --limit <n>     how many standings to return
  --api <url>     a Probatio instance, default https://probatiotrade.com
  --json          print the raw JSON result instead of a summary

verify exits 0 when every fill rehashes to the seal recorded with it, 1 when one does not.`;

interface Flags {
  api?: string | undefined;
  season?: number | undefined;
  limit?: number | undefined;
  json: boolean;
  positional: string[];
}

/** A bad command line. `run` turns it into a clear message and exit code 2. */
class UsageError extends Error {}

const VALUE_FLAGS = new Set(['--api', '--season', '--limit']);

/** A value that is really the next option (a bare `--json`), not a negative number. */
function looksLikeFlag(value: string): boolean {
  return value.startsWith('-') && !/^-?\d+$/.test(value);
}

function count(name: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new UsageError(`${name} must be a non-negative integer, got "${value}"`);
  }
  return n;
}

/**
 * Turn argv into flags, rejecting rather than guessing.
 *
 * Accepts both `--flag value` and `--flag=value`. A value-taking flag with no
 * value, or a following token that is itself an option, is an error, not a
 * silent misread. `--season` and `--limit` must be non-negative integers, so a
 * typo like `--limit foo` fails here instead of sending `?limit=NaN` onward.
 */
function parseFlags(args: readonly string[]): Flags {
  const flags: Flags = { json: false, positional: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!arg.startsWith('-')) {
      flags.positional.push(arg);
      continue;
    }

    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);

    if (name === '--json') {
      flags.json = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) {
      throw new UsageError(`unknown option: ${name}`);
    }

    const value = inline ?? args[(i += 1)];
    if (value === undefined || (inline === undefined && looksLikeFlag(value))) {
      throw new UsageError(`${name} needs a value`);
    }
    else if (name === '--api') flags.api = value;
    else if (name === '--season') flags.season = count(name, value);
    else flags.limit = count(name, value);
  }
  return flags;
}

function client(flags: Flags, fetchImpl?: typeof fetch): Probatio {
  return new Probatio({ apiBase: flags.api, fetchImpl });
}

/** Lamports (a decimal string) as SOL, without a float ever touching the amount. */
function formatSol(lamports: string): string {
  const n = BigInt(lamports);
  const whole = n / 1_000_000_000n;
  const frac = (n % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

function printVerify(result: VerifiedRecord, io: CliIo): void {
  io.out('');
  for (const check of result.checks) {
    io.out(`  ${check.passed ? 'PASS' : 'FAIL'}  ${check.label}: ${check.detail}`);
  }
  io.out('');
  io.out(
    result.verified
      ? `VERIFIED  ${result.trader}, ${result.tradeCount} fill(s) checked`
      : `NOT VERIFIED  ${result.trader}` +
        (result.broken.length > 0 ? `, fill(s) ${result.broken.join(', ')} do not match their seal` : ''),
  );
  if (result.root) io.out(`ROOT      ${result.root}`);
}

async function cmdVerify(flags: Flags, io: CliIo, fetchImpl?: typeof fetch): Promise<number> {
  const wallet = flags.positional[0];
  if (!wallet) {
    io.err('verify needs a wallet: probatio verify <wallet>');
    return 2;
  }
  const result = await client(flags, fetchImpl).verifyRecord(wallet, { season: flags.season });
  if (flags.json) io.out(JSON.stringify(result, null, 2));
  else printVerify(result, io);
  return result.verified ? 0 : 1;
}

async function cmdRecord(flags: Flags, io: CliIo, fetchImpl?: typeof fetch): Promise<number> {
  const wallet = flags.positional[0];
  if (!wallet) {
    io.err('record needs a wallet: probatio record <wallet>');
    return 2;
  }
  const record = await client(flags, fetchImpl).getRecord(wallet);
  if (flags.json) {
    io.out(JSON.stringify(record, null, 2));
    return 0;
  }
  io.out(`${record.display}${record.name ? '' : ' (unnamed)'}`);
  if (!record.exists) {
    io.out('  no record yet');
    return 0;
  }
  io.out(`  ${record.seasons.length} season(s) traded`);
  for (const season of record.seasons) {
    const kind = season.ranked ? 'ranked' : season.freePlay ? 'free play' : 'past';
    const win = `${(season.winRateBps / 100).toFixed(1)}% win`;
    io.out(
      `  season ${season.seasonId} (${kind}): ${season.trades} trade(s), ` +
        `${season.roundTrips} round trip(s), ${win}`,
    );
  }
  return 0;
}

async function cmdStandings(flags: Flags, io: CliIo, fetchImpl?: typeof fetch): Promise<number> {
  const board = await client(flags, fetchImpl).getStandings({ limit: flags.limit });
  if (flags.json) {
    io.out(JSON.stringify(board, null, 2));
    return 0;
  }
  if (!board.season) {
    io.out('no season is running');
    return 0;
  }
  io.out(`${board.season.name}${board.final ? ' (final)' : ''}`);
  for (const row of board.standings) {
    io.out(`  ${String(row.rank).padStart(3)}  ${row.name ?? row.trader}  ${(row.returnBps / 100).toFixed(2)}%`);
  }
  return 0;
}

async function cmdSeason(flags: Flags, io: CliIo, fetchImpl?: typeof fetch): Promise<number> {
  const info = await client(flags, fetchImpl).getSeason();
  if (flags.json) {
    io.out(JSON.stringify(info, null, 2));
    return 0;
  }
  const season = info.ranked;
  if (!season) {
    io.out('no ranked season is running (free play is open)');
    return 0;
  }
  io.out(`${season.name} (season ${season.ordinal}) ${season.status}`);
  io.out(`  ${season.entrants} entrant(s), pot ${formatSol(season.potLamports)} SOL`);
  io.out(
    season.rulesetHash === season.rulesetHashNow
      ? '  ruleset: matches the hash recorded for this season'
      : '  ruleset: CHANGED since the season opened, does not match the recorded hash',
  );
  for (const payout of season.payouts) {
    io.out(`  place ${payout.place}: ${formatSol(payout.lamports)} SOL`);
  }
  return 0;
}

async function cmdProof(flags: Flags, io: CliIo, fetchImpl?: typeof fetch): Promise<number> {
  const wallet = flags.positional[0];
  if (!wallet) {
    io.err('proof needs a wallet: probatio proof <wallet>');
    return 2;
  }
  // The raw inputs a verifier recomputes from. Always JSON, so it pipes.
  const bundle = await client(flags, fetchImpl).getProof(wallet, { season: flags.season });
  io.out(JSON.stringify(bundle, null, 2));
  return 0;
}

export async function run(
  argv: readonly string[],
  io: CliIo = stdoutIo,
  fetchImpl?: typeof fetch,
): Promise<number> {
  const [command, ...rest] = argv;
  let flags: Flags;
  try {
    flags = parseFlags(rest);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 2;
  }
  try {
    switch (command) {
      case 'verify':
        return await cmdVerify(flags, io, fetchImpl);
      case 'record':
        return await cmdRecord(flags, io, fetchImpl);
      case 'standings':
        return await cmdStandings(flags, io, fetchImpl);
      case 'season':
        return await cmdSeason(flags, io, fetchImpl);
      case 'proof':
        return await cmdProof(flags, io, fetchImpl);
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        io.out(HELP);
        return 0;
      default:
        io.err(`unknown command: ${command}`);
        io.out(HELP);
        return 2;
    }
  } catch (error) {
    if (error instanceof ProbatioError) io.err(error.message);
    else io.err(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
}
