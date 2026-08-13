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
  probatio verify <wallet> [--rpc <url>] [--season <n>] [--api <url>] [--json]
  probatio record <wallet> [--api <url>] [--json]
  probatio standings [--limit <n>] [--api <url>] [--json]
  probatio proof <wallet> [--season <n>] [--api <url>]

Options
  --rpc <url>     Solana RPC endpoint to check the record against (verify)
  --season <n>    a specific season ordinal, default the latest committed
  --limit <n>     how many standings to return
  --api <url>     a Probatio instance, default https://probatio.app
  --json          print the raw JSON result instead of a summary

verify exits 0 when the record checks out against the chain, 1 when it does not.`;

interface Flags {
  rpc?: string | undefined;
  api?: string | undefined;
  season?: number | undefined;
  limit?: number | undefined;
  json: boolean;
  positional: string[];
}

function parseFlags(args: readonly string[]): Flags {
  const flags: Flags = { json: false, positional: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--json') flags.json = true;
    else if (arg === '--rpc') flags.rpc = args[(i += 1)];
    else if (arg === '--api') flags.api = args[(i += 1)];
    else if (arg === '--season') flags.season = Number(args[(i += 1)]);
    else if (arg === '--limit') flags.limit = Number(args[(i += 1)]);
    else if (!arg.startsWith('-')) flags.positional.push(arg);
  }
  return flags;
}

function client(flags: Flags, fetchImpl?: typeof fetch): Probatio {
  return new Probatio({ apiBase: flags.api, rpc: flags.rpc, fetchImpl });
}

function printVerify(result: VerifiedRecord, io: CliIo): void {
  io.out('');
  for (const check of result.checks) {
    io.out(`  ${check.passed ? 'PASS' : 'FAIL'}  ${check.label}: ${check.detail}`);
  }
  io.out('');
  io.out(
    result.verified
      ? `VERIFIED  ${result.trader} in season ${result.seasonOrdinal}, ${result.tradeCount} trade(s) checked`
      : `NOT VERIFIED  ${result.trader} in season ${result.seasonOrdinal}`,
  );
}

async function cmdVerify(flags: Flags, io: CliIo, fetchImpl?: typeof fetch): Promise<number> {
  const wallet = flags.positional[0];
  if (!wallet) {
    io.err('verify needs a wallet: probatio verify <wallet> --rpc <url>');
    return 2;
  }
  if (!flags.rpc) {
    io.err('verify needs an rpc endpoint to check against the chain: --rpc <url>');
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
        `${season.roundTrips} round trip(s), ${win}, ${season.committedTrades} committed`,
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
  const flags = parseFlags(rest);
  try {
    switch (command) {
      case 'verify':
        return await cmdVerify(flags, io, fetchImpl);
      case 'record':
        return await cmdRecord(flags, io, fetchImpl);
      case 'standings':
        return await cmdStandings(flags, io, fetchImpl);
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
    io.err(error instanceof ProbatioError ? error.message : `error: ${(error as Error).message}`);
    return 2;
  }
}
