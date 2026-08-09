import { LayoutError, discriminatorMatches, readPubkey, readU64, readU8 } from './layout';

/**
 * The pump.fun TradeEvent.
 *
 * Every trade against a bonding curve emits one, and it carries the reserves
 * *after* the trade. That is what makes historical price reconstruction exact
 * rather than approximate: the same virtual reserves the fill engine quotes
 * against are recorded at every point in the token's history, so a chart drawn
 * from these events and a fill computed by the engine cannot disagree.
 *
 * Layout, confirmed against live mainnet transactions:
 *
 *   0    discriminator            8
 *   8    mint                     Pubkey
 *   40   sol_amount               u64
 *   48   token_amount             u64
 *   56   is_buy                   bool
 *   57   user                     Pubkey
 *   89   timestamp                i64
 *   97   virtual_sol_reserves     u64
 *   105  virtual_token_reserves   u64
 *   113  real_sol_reserves        u64
 *   121  real_token_reserves      u64
 *
 * More fields follow — fee recipients, fee amounts, the creator — and the
 * event has grown over time, so only the prefix above is read and the rest is
 * ignored on purpose.
 */
export const TRADE_EVENT_DISCRIMINATOR = Uint8Array.from([
  0xbd, 0xdb, 0x7f, 0xd3, 0x4e, 0xe6, 0x61, 0xee,
]);

export const TRADE_EVENT_OFFSETS = {
  mint: 8,
  solAmount: 40,
  tokenAmount: 48,
  isBuy: 56,
  user: 57,
  timestamp: 89,
  virtualSolReserves: 97,
  virtualTokenReserves: 105,
  realSolReserves: 113,
  realTokenReserves: 121,
} as const;

export const TRADE_EVENT_MIN_BYTES = TRADE_EVENT_OFFSETS.realTokenReserves + 8;

/** The prefix `Program data:` lines carry before their base64 payload. */
const PROGRAM_DATA_PREFIX = 'Program data: ';

export interface TradeEvent {
  readonly mint: string;
  readonly solAmount: bigint;
  readonly tokenAmount: bigint;
  readonly isBuy: boolean;
  readonly user: string;
  /** Unix seconds, as recorded by the program. Matches the block time. */
  readonly timestamp: number;
  readonly virtualSolReserves: bigint;
  readonly virtualTokenReserves: bigint;
  readonly realSolReserves: bigint;
  readonly realTokenReserves: bigint;
}

function readI64(data: Uint8Array, offset: number): bigint {
  const unsigned = readU64(data, offset);
  // Two's complement. Timestamps are never negative in practice, but a wrong
  // offset would show up as an absurd date rather than a silently plausible one.
  return unsigned >= 1n << 63n ? unsigned - (1n << 64n) : unsigned;
}

export function decodeTradeEvent(data: Uint8Array): TradeEvent {
  if (data.length < TRADE_EVENT_MIN_BYTES) {
    throw new LayoutError(
      `trade event is ${data.length} bytes, expected at least ${TRADE_EVENT_MIN_BYTES}`,
    );
  }
  if (!discriminatorMatches(data, TRADE_EVENT_DISCRIMINATOR)) {
    throw new LayoutError('event discriminator is not TradeEvent');
  }

  const o = TRADE_EVENT_OFFSETS;
  const isBuyByte = readU8(data, o.isBuy);
  if (isBuyByte > 1) {
    throw new LayoutError(`is_buy is ${isBuyByte}, not a bool — the layout is probably wrong`);
  }

  const event: TradeEvent = {
    mint: readPubkey(data, o.mint),
    solAmount: readU64(data, o.solAmount),
    tokenAmount: readU64(data, o.tokenAmount),
    isBuy: isBuyByte === 1,
    user: readPubkey(data, o.user),
    timestamp: Number(readI64(data, o.timestamp)),
    virtualSolReserves: readU64(data, o.virtualSolReserves),
    virtualTokenReserves: readU64(data, o.virtualTokenReserves),
    realSolReserves: readU64(data, o.realSolReserves),
    realTokenReserves: readU64(data, o.realTokenReserves),
  };

  if (event.virtualSolReserves === 0n || event.virtualTokenReserves === 0n) {
    throw new LayoutError('trade event has a zero virtual reserve — the layout is probably wrong');
  }
  // The virtual reserves always exceed the real ones by the curve's seeded
  // offset. If an offset drifted these would cross.
  if (event.realSolReserves > event.virtualSolReserves) {
    throw new LayoutError('real SOL exceeds virtual SOL — the layout is probably wrong');
  }
  if (event.realTokenReserves > event.virtualTokenReserves) {
    throw new LayoutError('real tokens exceed virtual tokens — the layout is probably wrong');
  }

  return event;
}

/**
 * Pull every TradeEvent out of a transaction's logs.
 *
 * A single transaction can hold more than one — an aggregator routing through
 * pump.fun emits one per hop — and lines belonging to other programs are
 * skipped rather than treated as corrupt.
 */
export function extractTradeEvents(logMessages: readonly string[]): TradeEvent[] {
  const events: TradeEvent[] = [];

  for (const line of logMessages) {
    if (!line.startsWith(PROGRAM_DATA_PREFIX)) continue;

    let payload: Uint8Array;
    try {
      payload = Uint8Array.from(Buffer.from(line.slice(PROGRAM_DATA_PREFIX.length), 'base64'));
    } catch {
      continue;
    }

    if (!discriminatorMatches(payload, TRADE_EVENT_DISCRIMINATOR)) continue;

    try {
      events.push(decodeTradeEvent(payload));
    } catch {
      // A malformed event is skipped rather than failing the whole backfill.
      // One bad transaction must not cost a token its entire chart.
    }
  }

  return events;
}

/**
 * The pump.fun CreateEvent, emitted once when a token is launched.
 *
 * Unlike TradeEvent this is variable-length: the name, symbol and URI are
 * Borsh strings, so everything after them has to be walked rather than read at
 * a fixed offset.
 *
 *   0    discriminator   8
 *   8    name            String
 *        symbol          String
 *        uri             String
 *        mint            Pubkey
 *        bonding_curve   Pubkey
 *        user            Pubkey
 *        creator         Pubkey
 *        timestamp       i64
 *
 * Later fields exist and are ignored, since the event has grown over time and
 * a launch feed needs none of them.
 */
export const CREATE_EVENT_DISCRIMINATOR = Uint8Array.from([
  0x1b, 0x72, 0xa9, 0x4d, 0xde, 0xeb, 0x63, 0x76,
]);

/** Generous ceilings that still refuse to allocate against a corrupt length. */
const MAX_NAME_BYTES = 256;
const MAX_URI_BYTES = 1024;

export interface CreateEvent {
  readonly name: string;
  readonly symbol: string;
  readonly uri: string;
  readonly mint: string;
  readonly bondingCurve: string;
  readonly user: string;
  readonly creator: string;
  /** Unix seconds. */
  readonly timestamp: number;
}

function readU32LE(data: Uint8Array, offset: number): number {
  if (offset + 4 > data.length) {
    throw new LayoutError(`cannot read a string length at offset ${offset}`);
  }
  return (
    (data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16)) +
    data[offset + 3]! * 0x1000000
  );
}

function readBorshString(
  data: Uint8Array,
  offset: number,
  maxBytes: number,
  what: string,
): { value: string; next: number } {
  const length = readU32LE(data, offset);
  if (length > maxBytes) {
    throw new LayoutError(`${what} claims ${length} bytes — the layout is probably wrong`);
  }
  const start = offset + 4;
  if (start + length > data.length) {
    throw new LayoutError(`${what} runs past the end of the event`);
  }
  return {
    value: new TextDecoder('utf-8', { fatal: false })
      .decode(data.subarray(start, start + length))
      .replace(/\0+$/, '')
      .trim(),
    next: start + length,
  };
}

export function decodeCreateEvent(data: Uint8Array): CreateEvent {
  if (!discriminatorMatches(data, CREATE_EVENT_DISCRIMINATOR)) {
    throw new LayoutError('event discriminator is not CreateEvent');
  }

  const name = readBorshString(data, 8, MAX_NAME_BYTES, 'name');
  const symbol = readBorshString(data, name.next, MAX_NAME_BYTES, 'symbol');
  const uri = readBorshString(data, symbol.next, MAX_URI_BYTES, 'uri');

  let cursor = uri.next;
  const mint = readPubkey(data, cursor);
  cursor += 32;
  const bondingCurve = readPubkey(data, cursor);
  cursor += 32;
  const user = readPubkey(data, cursor);
  cursor += 32;
  const creator = readPubkey(data, cursor);
  cursor += 32;

  const timestamp = Number(readU64(data, cursor));

  // A launch is never dated before pump.fun existed, and never far ahead of
  // now. A wrong offset shows up here rather than as a plausible-looking
  // token.
  if (timestamp < 1_600_000_000 || timestamp > 4_000_000_000) {
    throw new LayoutError(`implausible launch timestamp ${timestamp} — the layout is wrong`);
  }

  return {
    name: name.value,
    symbol: symbol.value,
    uri: uri.value,
    mint,
    bondingCurve,
    user,
    creator,
    timestamp,
  };
}

/** Pull every CreateEvent out of a transaction's logs. */
export function extractCreateEvents(logMessages: readonly string[]): CreateEvent[] {
  const events: CreateEvent[] = [];

  for (const line of logMessages) {
    if (!line.startsWith(PROGRAM_DATA_PREFIX)) continue;

    let payload: Uint8Array;
    try {
      payload = Uint8Array.from(Buffer.from(line.slice(PROGRAM_DATA_PREFIX.length), 'base64'));
    } catch {
      continue;
    }
    if (!discriminatorMatches(payload, CREATE_EVENT_DISCRIMINATOR)) continue;

    try {
      events.push(decodeCreateEvent(payload));
    } catch {
      // One malformed event must not cost the feed everything else in the block.
    }
  }

  return events;
}
