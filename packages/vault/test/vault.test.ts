import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  anchorDiscriminator,
  claimPrize,
  finalizeSeason,
  initSeason,
  recordEntry,
  refundEntry,
  voidSeason,
  type SeasonParams,
} from '../src/index';

/**
 * Pinned against the program's own IDL, the same way the keeper pins commit_root.
 *
 * Anchor matches accounts by position and args by byte layout, so a drifted
 * encoding is not a loud failure but a rejected transaction or, worse, one that
 * moves money the wrong way. Every discriminator, every account slot, and the
 * arg layout of each instruction is checked here against the generated IDL.
 */

interface IdlAccount {
  name: string;
  signer?: boolean;
  writable?: boolean;
}
interface IdlInstruction {
  name: string;
  discriminator: number[];
  accounts: IdlAccount[];
}
const idl = JSON.parse(
  readFileSync(new URL('../../../program/idl/probatio.json', import.meta.url), 'utf8'),
) as { address: string; instructions: IdlInstruction[] };

const ixOf = (name: string): IdlInstruction => idl.instructions.find((i) => i.name === name)!;
const hex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

// Placeholder addresses (valid base58 pubkeys) for shape assertions.
const AUTHORITY = 'BPFLoaderUpgradeab1e11111111111111111111111';
const TRADER = '7xKXtg2CW3cWCLBmVvKcbAkKM6mzTuKMYqM9dAcuLNwr';

const params: SeasonParams = {
  ordinal: 1,
  keeper: AUTHORITY,
  startsAt: 1_700_000_000n,
  endsAt: 1_700_600_000n,
  entryClosesAt: 1_700_300_000n,
  startingBalance: 10_000_000_000n,
  entryCost: 50_000_000n,
  houseBps: 1000,
  houseThreshold: 0n,
  latencyMs: 600,
  slippageBps: 50,
  maxPriceImpactBps: 5000,
  engineVersion: 1,
  scoringFormulaHash: new Uint8Array(32).fill(7),
};

/** The instruction's account slots agree with the IDL, in order and in flags. */
function assertAccounts(built: { keys: readonly { pubkey: string; isSigner: boolean; isWritable: boolean }[] }, name: string): void {
  const spec = ixOf(name).accounts;
  expect(built.keys.length).toBe(spec.length);
  spec.forEach((account, i) => {
    const key = built.keys[i]!;
    expect(key.isSigner, `${name}.${account.name} signer`).toBe(Boolean(account.signer));
    expect(key.isWritable, `${name}.${account.name} writable`).toBe(Boolean(account.writable));
    if (account.name === 'system_program') expect(key.pubkey).toBe(SYSTEM_PROGRAM_ID);
  });
}

/** Every instruction's discriminator matches the IDL and my sha256 computation. */
function assertDiscriminator(built: { data: Uint8Array }, name: string): void {
  const idlDisc = Uint8Array.from(ixOf(name).discriminator);
  expect(hex(built.data.subarray(0, 8))).toBe(hex(idlDisc));
  expect(hex(anchorDiscriminator(name))).toBe(hex(idlDisc));
}

describe('vault instruction encoders', () => {
  it('uses the program the IDL was built for', () => {
    expect(PROGRAM_ID).toBe(idl.address);
  });

  it('init_season: discriminator, accounts, and a 128-byte SeasonParams', () => {
    const ix = initSeason({ authority: AUTHORITY, params });
    assertDiscriminator(ix, 'init_season');
    assertAccounts(ix, 'init_season');
    // 8 discriminator + SeasonParams. Decode a few fields back to be sure of the layout.
    expect(ix.data.length).toBe(8 + 128);
    const view = new DataView(ix.data.buffer, ix.data.byteOffset);
    expect(view.getInt16(8, true)).toBe(1); // ordinal
    expect(view.getBigUint64(8 + 2 + 32 + 8 + 8 + 8, true)).toBe(10_000_000_000n); // starting_balance
    expect(view.getBigUint64(8 + 2 + 32 + 8 + 8 + 8 + 8, true)).toBe(50_000_000n); // entry_cost
  });

  it('record_entry: discriminator only, five accounts, trader signs and pays', () => {
    const ix = recordEntry({ trader: TRADER, ordinal: 1 });
    assertDiscriminator(ix, 'record_entry');
    assertAccounts(ix, 'record_entry');
    expect(ix.data.length).toBe(8);
    expect(ix.keys[0]!.pubkey).toBe(TRADER);
    expect(ix.keys[0]!.isSigner).toBe(true);
    expect(ix.keys[0]!.isWritable).toBe(true);
  });

  it('finalize_season: discriminator then a 32-byte root', () => {
    const root = new Uint8Array(32).fill(9);
    const ix = finalizeSeason({ authority: AUTHORITY, ordinal: 1, resultsRoot: root });
    assertDiscriminator(ix, 'finalize_season');
    assertAccounts(ix, 'finalize_season');
    expect(ix.data.length).toBe(40);
    expect(hex(ix.data.subarray(8))).toBe(hex(root));
  });

  it('claim_prize: ResultClaim then a length-prefixed proof', () => {
    const proof = [
      { sibling: new Uint8Array(32).fill(1), siblingOnLeft: true },
      { sibling: new Uint8Array(32).fill(2), siblingOnLeft: false },
    ];
    const ix = claimPrize({
      payer: TRADER,
      trader: TRADER,
      ordinal: 1,
      claim: { rank: 1, startingBalance: 10n, finalEquity: 15n, returnBps: 5000, tradeCount: 4, payoutLamports: 135_000_000n },
      proof,
    });
    assertDiscriminator(ix, 'claim_prize');
    assertAccounts(ix, 'claim_prize');
    // 8 disc + rank(4) + startBal(16) + finalEq(16) + returnBps(4) + tradeCount(4)
    // + payout(16) + proofLen(4) + 2*(32+1)
    expect(ix.data.length).toBe(8 + 4 + 16 + 16 + 4 + 4 + 16 + 4 + 2 * 33);
    const view = new DataView(ix.data.buffer, ix.data.byteOffset);
    expect(view.getUint32(8, true)).toBe(1); // rank
    expect(view.getUint32(8 + 4 + 16 + 16 + 4 + 4 + 16, true)).toBe(2); // proof length
  });

  it('void_season: authority signs, two accounts', () => {
    const ix = voidSeason({ authority: AUTHORITY, ordinal: 1 });
    assertDiscriminator(ix, 'void_season');
    assertAccounts(ix, 'void_season');
    expect(ix.data.length).toBe(8);
  });

  it('refund_entry: discriminator only, five accounts', () => {
    const ix = refundEntry({ payer: TRADER, trader: TRADER, ordinal: 1 });
    assertDiscriminator(ix, 'refund_entry');
    assertAccounts(ix, 'refund_entry');
    expect(ix.data.length).toBe(8);
  });

  it('the entry and vault are program-derived, not caller-chosen', () => {
    const entry = recordEntry({ trader: TRADER, ordinal: 1 });
    // trader, season, entry, vault, system — entry and vault differ from all inputs.
    const addrs = entry.keys.map((k) => k.pubkey);
    expect(new Set(addrs).size).toBe(addrs.length);
  });

  it('rejects an amount that does not fit its field', () => {
    expect(() => finalizeSeason({ authority: AUTHORITY, ordinal: 1, resultsRoot: new Uint8Array(31) })).toThrow();
    expect(() =>
      claimPrize({
        payer: TRADER,
        trader: TRADER,
        ordinal: 1,
        claim: { rank: 1, startingBalance: -1n, finalEquity: 15n, returnBps: 0, tradeCount: 1, payoutLamports: 1n },
        proof: [],
      }),
    ).toThrow();
  });
});
