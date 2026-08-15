import bs58 from 'bs58';
import { sha256 } from '@noble/hashes/sha2.js';
import { findProgramAddress, type DerivedAddress } from '@probatio/pools';
import { compileMessage, encodeMessage, type AccountMeta, type Instruction } from '@probatio/payments';

/**
 * The season-vault instructions, encoded by hand.
 *
 * These are how entry money reaches a season's vault and how a prize leaves it:
 * `record_entry` pays the fee in, `finalize_season` publishes the results,
 * `claim_prize` pays a winner out against a merkle proof, and `void_season` +
 * `refund_entry` give a cancelled season back. The keeper's `commit_root` is
 * elsewhere on purpose; that key may only append records, and none of these.
 *
 * Every discriminator and account order is pinned by a test that reads the
 * program's own IDL. Anchor matches accounts by position and args by a byte
 * layout, so an encoding that drifts from the program does not fail loudly — it
 * fails as a rejected transaction with an opaque error, or worse, a valid one
 * that moves money the wrong way. That is why this is checked rather than
 * trusted, and why nothing here is typed from memory.
 */

export class VaultError extends Error {}

export {
  AuthorityGateway,
  type AuthorityReceipt,
  type AuthorityGatewayOptions,
} from './gateway';

/** The program that holds the seasons, vaults and entries. */
export const PROGRAM_ID = 'HRGEAiqX4qw7B1fgNsR64oRAKF4QwkjkZFx9YXDFxaXA';
export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';

const SEASON_SEED = new TextEncoder().encode('season');
const VAULT_SEED = new TextEncoder().encode('vault');
const ENTRY_SEED = new TextEncoder().encode('entry');

/** Anchor names an instruction by the first eight bytes of `sha256("global:<name>")`. */
export function anchorDiscriminator(name: string): Uint8Array {
  return sha256(new TextEncoder().encode(`global:${name}`)).subarray(0, 8);
}

/** Anchor names an account type by the first eight bytes of `sha256("account:<Name>")`. */
export function accountDiscriminator(name: string): Uint8Array {
  return sha256(new TextEncoder().encode(`account:${name}`)).subarray(0, 8);
}

function hex8(bytes: Uint8Array): string {
  return [...bytes.subarray(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// --------------------------------------------------------------------------
// Little-endian byte helpers. The range checks are the point: setBigUint64 and
// friends throw on overflow, so an amount that does not fit is caught here
// rather than silently wrapping into a different number of lamports.

function u16(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new VaultError(`u16 out of range: ${n}`);
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, true);
  return b;
}

function i16(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < -0x8000 || n > 0x7fff) throw new VaultError(`i16 out of range: ${n}`);
  const b = new Uint8Array(2);
  new DataView(b.buffer).setInt16(0, n, true);
  return b;
}

function u32(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new VaultError(`u32 out of range: ${n}`);
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function i32(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < -0x80000000 || n > 0x7fffffff) throw new VaultError(`i32 out of range: ${n}`);
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, n, true);
  return b;
}

function u64(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true); // throws on overflow or negative
  return b;
}

function i64(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, n, true);
  return b;
}

function u128(n: bigint): Uint8Array {
  if (n < 0n || n > (1n << 128n) - 1n) throw new VaultError(`u128 out of range: ${n}`);
  const b = new Uint8Array(16);
  const view = new DataView(b.buffer);
  view.setBigUint64(0, n & 0xffffffffffffffffn, true);
  view.setBigUint64(8, n >> 64n, true);
  return b;
}

function boolean(value: boolean): Uint8Array {
  return new Uint8Array([value ? 1 : 0]);
}

function pubkeyBytes(address: string): Uint8Array {
  const bytes = bs58.decode(address);
  if (bytes.length !== 32) throw new VaultError(`not a 32-byte pubkey: ${address}`);
  return bytes;
}

function fixed32(bytes: Uint8Array, what: string): Uint8Array {
  if (bytes.length !== 32) throw new VaultError(`${what} must be 32 bytes, got ${bytes.length}`);
  return bytes;
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const system: AccountMeta = { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false };

// --------------------------------------------------------------------------
// Addresses. All three are program-derived, so the caller never chooses them.

/** The Season account for an ordinal. Seeds `["season", i16le(ordinal)]`. */
export function seasonAddress(ordinal: number, programId = PROGRAM_ID): DerivedAddress {
  return findProgramAddress([SEASON_SEED, i16(ordinal)], programId);
}

/** The vault holding a season's pot. Seeds `["vault", season]`. */
export function vaultAddress(season: string, programId = PROGRAM_ID): DerivedAddress {
  return findProgramAddress([VAULT_SEED, pubkeyBytes(season)], programId);
}

/** A trader's entry in a season. Seeds `["entry", season, trader]`, one per trader. */
export function entryAddress(season: string, trader: string, programId = PROGRAM_ID): DerivedAddress {
  return findProgramAddress([ENTRY_SEED, pubkeyBytes(season), pubkeyBytes(trader)], programId);
}

// --------------------------------------------------------------------------
// Instructions.

/** The ruleset a season is created with. Mirrors the program's `SeasonParams`. */
export interface SeasonParams {
  readonly ordinal: number;
  readonly keeper: string;
  readonly startsAt: bigint;
  readonly endsAt: bigint;
  readonly entryClosesAt: bigint;
  readonly startingBalance: bigint;
  readonly entryCost: bigint;
  readonly houseBps: number;
  readonly houseThreshold: bigint;
  readonly latencyMs: number;
  readonly slippageBps: number;
  readonly maxPriceImpactBps: number;
  readonly engineVersion: number;
  readonly scoringFormulaHash: Uint8Array;
}

function hexToBytes32(hex: string, what: string): Uint8Array {
  if (hex.length !== 64 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new VaultError(`${what} must be 32 bytes of hex, got "${hex}"`);
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/**
 * Seconds since the epoch, which is the unit the program's clock speaks.
 *
 * The database keeps milliseconds; the program compares against
 * `Clock::unix_timestamp`, which is seconds. Sending milliseconds would put
 * entry deadlines and the season end thousands of years out — this is the seam
 * where that is caught.
 */
export function secondsFromMs(ms: number): bigint {
  if (!Number.isFinite(ms)) throw new VaultError(`not a timestamp: ${ms}`);
  return BigInt(Math.floor(ms / 1000));
}

/**
 * Assemble `SeasonParams` from the season's stored values and its ruleset.
 *
 * Timestamps arrive as milliseconds and leave as seconds. The scoring hash is
 * the one the season already published, so the on-chain season matches what
 * verifiers and finalization expect rather than whatever today's rules hash to.
 */
export function seasonParamsFrom(input: {
  readonly ordinal: number;
  readonly keeper: string;
  readonly startsAtMs: number;
  readonly endsAtMs: number;
  readonly entryClosesAtMs: number;
  readonly startingBalance: bigint;
  readonly entryCost: bigint;
  readonly houseBps: number;
  readonly houseThreshold: bigint;
  readonly latencyMs: number;
  readonly slippageBps: number;
  readonly maxPriceImpactBps: number;
  readonly engineVersion: number;
  readonly scoringFormulaHashHex: string;
}): SeasonParams {
  return {
    ordinal: input.ordinal,
    keeper: input.keeper,
    startsAt: secondsFromMs(input.startsAtMs),
    endsAt: secondsFromMs(input.endsAtMs),
    entryClosesAt: secondsFromMs(input.entryClosesAtMs),
    startingBalance: input.startingBalance,
    entryCost: input.entryCost,
    houseBps: input.houseBps,
    houseThreshold: input.houseThreshold,
    latencyMs: input.latencyMs,
    slippageBps: input.slippageBps,
    maxPriceImpactBps: input.maxPriceImpactBps,
    engineVersion: input.engineVersion,
    scoringFormulaHash: hexToBytes32(input.scoringFormulaHashHex, 'scoring formula hash'),
  };
}

/** The next on-chain transition a season is due, or none. */
export type SeasonTransition = 'init' | 'open_entries' | 'start_trading' | 'finalize' | 'none';

/**
 * Which lifecycle step a season needs next, from its state and the clock.
 *
 * Off chain -> init. Pending past its entry-open time -> open entries. Entry
 * open past its close time -> start trading. Running or closed past its end ->
 * finalize. Everything else waits. One step is taken per tick, so a season that
 * is far behind catches up over a few ticks rather than all at once.
 */
export function nextSeasonTransition(input: {
  readonly onChain: boolean;
  readonly status: string;
  readonly entryOpensAtMs: number | null;
  readonly entryClosesAtMs: number | null;
  readonly endsAtMs: number | null;
  readonly nowMs: number;
}): SeasonTransition {
  if (!input.onChain) return 'init';
  const ended = input.endsAtMs !== null && input.nowMs >= input.endsAtMs;
  if (input.status === 'pending') {
    return input.entryOpensAtMs !== null && input.nowMs >= input.entryOpensAtMs
      ? 'open_entries'
      : 'none';
  }
  if (input.status === 'entry_open') {
    return input.entryClosesAtMs !== null && input.nowMs >= input.entryClosesAtMs
      ? 'start_trading'
      : 'none';
  }
  if (input.status === 'running' || input.status === 'closed') {
    return ended ? 'finalize' : 'none';
  }
  return 'none';
}

/** `init_season`: creates the Season and its vault. Signed and paid by the authority. */
export function initSeason(input: { readonly authority: string; readonly params: SeasonParams; readonly programId?: string }): Instruction {
  const programId = input.programId ?? PROGRAM_ID;
  const p = input.params;
  const season = seasonAddress(p.ordinal, programId).address;
  const vault = vaultAddress(season, programId).address;
  const data = concat(
    anchorDiscriminator('init_season'),
    i16(p.ordinal),
    pubkeyBytes(p.keeper),
    i64(p.startsAt),
    i64(p.endsAt),
    i64(p.entryClosesAt),
    u64(p.startingBalance),
    u64(p.entryCost),
    u16(p.houseBps),
    u64(p.houseThreshold),
    u32(p.latencyMs),
    u16(p.slippageBps),
    u16(p.maxPriceImpactBps),
    u32(p.engineVersion),
    fixed32(p.scoringFormulaHash, 'scoring formula hash'),
  );
  return {
    programId,
    keys: [
      { pubkey: input.authority, isSigner: true, isWritable: true },
      { pubkey: season, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      system,
    ],
    data,
  };
}

/** `record_entry`: the trader pays the entry fee into the vault. Signed by the trader. */
export function recordEntry(input: { readonly trader: string; readonly ordinal: number; readonly programId?: string }): Instruction {
  const programId = input.programId ?? PROGRAM_ID;
  const season = seasonAddress(input.ordinal, programId).address;
  const entry = entryAddress(season, input.trader, programId).address;
  const vault = vaultAddress(season, programId).address;
  return {
    programId,
    keys: [
      { pubkey: input.trader, isSigner: true, isWritable: true },
      { pubkey: season, isSigner: false, isWritable: true },
      { pubkey: entry, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      system,
    ],
    data: anchorDiscriminator('record_entry'),
  };
}

/** An authority-signed status transition that carries no data. */
function authorityTransition(name: string, authority: string, ordinal: number, programId: string): Instruction {
  const season = seasonAddress(ordinal, programId).address;
  return {
    programId,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: season, isSigner: false, isWritable: true },
    ],
    data: anchorDiscriminator(name),
  };
}

/** `open_entries`: moves a season from Pending to accepting entries. Signed by the authority. */
export function openEntries(input: { readonly authority: string; readonly ordinal: number; readonly programId?: string }): Instruction {
  return authorityTransition('open_entries', input.authority, input.ordinal, input.programId ?? PROGRAM_ID);
}

/** `start_trading`: closes entries and starts the season running. Signed by the authority. */
export function startTrading(input: { readonly authority: string; readonly ordinal: number; readonly programId?: string }): Instruction {
  return authorityTransition('start_trading', input.authority, input.ordinal, input.programId ?? PROGRAM_ID);
}

/** `finalize_season`: writes the results root. Signed by the authority. */
export function finalizeSeason(input: {
  readonly authority: string;
  readonly ordinal: number;
  readonly resultsRoot: Uint8Array;
  readonly programId?: string;
}): Instruction {
  const programId = input.programId ?? PROGRAM_ID;
  const season = seasonAddress(input.ordinal, programId).address;
  return {
    programId,
    keys: [
      { pubkey: input.authority, isSigner: true, isWritable: false },
      { pubkey: season, isSigner: false, isWritable: true },
    ],
    data: concat(anchorDiscriminator('finalize_season'), fixed32(input.resultsRoot, 'results root')),
  };
}

/** A winner's claimed result. Mirrors the program's `ResultClaim`. */
export interface ResultClaim {
  readonly rank: number;
  readonly startingBalance: bigint;
  readonly finalEquity: bigint;
  readonly returnBps: number;
  readonly tradeCount: number;
  readonly payoutLamports: bigint;
}

/** One step of a merkle proof. `siblingOnLeft` because the hash order matters. */
export interface ProofStep {
  readonly sibling: Uint8Array;
  readonly siblingOnLeft: boolean;
}

/** `claim_prize`: pays the winner from the vault against a proof. Signed by the payer. */
export function claimPrize(input: {
  readonly payer: string;
  readonly trader: string;
  readonly ordinal: number;
  readonly claim: ResultClaim;
  readonly proof: readonly ProofStep[];
  readonly programId?: string;
}): Instruction {
  const programId = input.programId ?? PROGRAM_ID;
  const season = seasonAddress(input.ordinal, programId).address;
  const entry = entryAddress(season, input.trader, programId).address;
  const vault = vaultAddress(season, programId).address;
  const c = input.claim;
  const proofBytes = concat(
    u32(input.proof.length),
    ...input.proof.map((step) => concat(fixed32(step.sibling, 'proof sibling'), boolean(step.siblingOnLeft))),
  );
  const data = concat(
    anchorDiscriminator('claim_prize'),
    u32(c.rank),
    u128(c.startingBalance),
    u128(c.finalEquity),
    i32(c.returnBps),
    u32(c.tradeCount),
    u128(c.payoutLamports),
    proofBytes,
  );
  return {
    programId,
    keys: [
      { pubkey: input.payer, isSigner: true, isWritable: true },
      { pubkey: season, isSigner: false, isWritable: true },
      { pubkey: entry, isSigner: false, isWritable: true },
      { pubkey: input.trader, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      system,
    ],
    data,
  };
}

/** `void_season`: marks a season Voided so its entries can be refunded. Signed by the authority. */
export function voidSeason(input: { readonly authority: string; readonly ordinal: number; readonly programId?: string }): Instruction {
  return authorityTransition('void_season', input.authority, input.ordinal, input.programId ?? PROGRAM_ID);
}

/** `refund_entry`: pays a voided season's entry back from the vault. Signed by the payer. */
export function refundEntry(input: { readonly payer: string; readonly trader: string; readonly ordinal: number; readonly programId?: string }): Instruction {
  const programId = input.programId ?? PROGRAM_ID;
  const season = seasonAddress(input.ordinal, programId).address;
  const entry = entryAddress(season, input.trader, programId).address;
  const vault = vaultAddress(season, programId).address;
  return {
    programId,
    keys: [
      { pubkey: input.payer, isSigner: true, isWritable: true },
      { pubkey: season, isSigner: false, isWritable: true },
      { pubkey: entry, isSigner: false, isWritable: true },
      { pubkey: input.trader, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      system,
    ],
    data: anchorDiscriminator('refund_entry'),
  };
}

/**
 * The record_entry transaction, compiled for a trader's wallet to sign, base58.
 *
 * The trader is the fee payer and the only signer; the instruction pays the
 * fee into the vault and creates their entry. The wallet decodes this, signs
 * it, submits it, and reports the signature, which the server then checks
 * against the entry the chain now holds.
 */
export function recordEntryMessage(input: {
  readonly trader: string;
  readonly ordinal: number;
  readonly blockhash: string;
  readonly programId?: string;
}): string {
  const instruction = recordEntry({
    trader: input.trader,
    ordinal: input.ordinal,
    ...(input.programId !== undefined ? { programId: input.programId } : {}),
  });
  return bs58.encode(encodeMessage(compileMessage(input.trader, input.blockhash, [instruction])));
}

/**
 * The claim_prize transaction, compiled for a winner's wallet to sign, base58.
 *
 * The payer is the winner and the only signer; the program pays them from the
 * vault against the proof. The result and proof come from the finalization the
 * season already published, so nothing here is recomputed under them.
 */
export function claimPrizeMessage(input: {
  readonly payer: string;
  readonly trader: string;
  readonly ordinal: number;
  readonly claim: ResultClaim;
  readonly proof: readonly ProofStep[];
  readonly blockhash: string;
  readonly programId?: string;
}): string {
  const instruction = claimPrize({
    payer: input.payer,
    trader: input.trader,
    ordinal: input.ordinal,
    claim: input.claim,
    proof: input.proof,
    ...(input.programId !== undefined ? { programId: input.programId } : {}),
  });
  return bs58.encode(encodeMessage(compileMessage(input.payer, input.blockhash, [instruction])));
}

/** The refund_entry transaction, compiled for a voided season's entrant to sign, base58. */
export function refundEntryMessage(input: {
  readonly payer: string;
  readonly trader: string;
  readonly ordinal: number;
  readonly blockhash: string;
  readonly programId?: string;
}): string {
  const instruction = refundEntry({
    payer: input.payer,
    trader: input.trader,
    ordinal: input.ordinal,
    ...(input.programId !== undefined ? { programId: input.programId } : {}),
  });
  return bs58.encode(encodeMessage(compileMessage(input.payer, input.blockhash, [instruction])));
}

/** A decoded on-chain Entry, the proof a trader paid into a season's vault. */
export interface OnChainEntry {
  readonly season: string;
  readonly trader: string;
  readonly paid: bigint;
  readonly claimed: boolean;
}

/**
 * Decode an Entry account, so a confirmed entry can be checked against what was
 * asked for.
 *
 * The discriminator is checked first: without it a different account at the
 * same address decodes into plausible numbers rather than failing, and an entry
 * would be credited that was never made.
 */
export function decodeEntry(data: Uint8Array): OnChainEntry {
  // 8 discriminator, 32 season, 32 trader, 8 paid, 8 entered_at, 1 claimed, ...
  if (data.length < 89) throw new VaultError(`entry account too short: ${data.length} bytes`);
  if (hex8(data) !== hex8(accountDiscriminator('Entry'))) {
    throw new VaultError('not an entry account');
  }
  const view = new DataView(data.buffer, data.byteOffset);
  return {
    season: bs58.encode(data.subarray(8, 40)),
    trader: bs58.encode(data.subarray(40, 72)),
    paid: view.getBigUint64(72, true),
    claimed: data[88] !== 0,
  };
}
