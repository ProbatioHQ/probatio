import { LayoutError, readPubkey, readU64, readU8 } from './layout';

/**
 * SPL token account layout — fixed at 165 bytes.
 *
 *   0   mint    Pubkey
 *   32  owner   Pubkey
 *   64  amount  u64
 *   72  delegate        COption<Pubkey>
 *   108 state           u8
 *   109 is_native       COption<u64>
 *   121 delegated_amount u64
 *   129 close_authority COption<Pubkey>
 *
 * AMM venues keep their reserves in ordinary token accounts rather than in the
 * pool account itself, so reading an AMM pool always takes two hops: decode the
 * pool to find its vaults, then read the vaults for the balances.
 */
export const TOKEN_ACCOUNT_BYTES = 165;

export const TOKEN_ACCOUNT_OFFSETS = {
  mint: 0,
  owner: 32,
  amount: 64,
  state: 108,
} as const;

/** 0 uninitialized, 1 initialized, 2 frozen. */
export type TokenAccountState = 'uninitialized' | 'initialized' | 'frozen';

export interface TokenAccount {
  readonly mint: string;
  readonly owner: string;
  readonly amount: bigint;
  readonly state: TokenAccountState;
}

const STATES: Record<number, TokenAccountState> = {
  0: 'uninitialized',
  1: 'initialized',
  2: 'frozen',
};

export function decodeTokenAccount(data: Uint8Array): TokenAccount {
  // Token-2022 accounts append extensions past the base layout, so this checks
  // for "at least" rather than "exactly".
  if (data.length < TOKEN_ACCOUNT_BYTES) {
    throw new LayoutError(
      `token account is ${data.length} bytes, expected at least ${TOKEN_ACCOUNT_BYTES}`,
    );
  }

  const stateByte = readU8(data, TOKEN_ACCOUNT_OFFSETS.state);
  const state = STATES[stateByte];
  if (!state) {
    throw new LayoutError(`unknown token account state ${stateByte} — the layout is probably wrong`);
  }

  return {
    mint: readPubkey(data, TOKEN_ACCOUNT_OFFSETS.mint),
    owner: readPubkey(data, TOKEN_ACCOUNT_OFFSETS.owner),
    amount: readU64(data, TOKEN_ACCOUNT_OFFSETS.amount),
    state,
  };
}

/**
 * Mint account layout — the only field needed here is `decimals`.
 *
 *   0  mint_authority COption<Pubkey>  36
 *   36 supply         u64
 *   44 decimals       u8
 *   45 is_initialized bool
 */
export const MINT_ACCOUNT_BYTES = 82;
export const MINT_DECIMALS_OFFSET = 44;

export function decodeMintDecimals(data: Uint8Array): number {
  if (data.length < MINT_ACCOUNT_BYTES) {
    throw new LayoutError(
      `mint account is ${data.length} bytes, expected at least ${MINT_ACCOUNT_BYTES}`,
    );
  }
  const decimals = readU8(data, MINT_DECIMALS_OFFSET);
  if (decimals > 18) {
    throw new LayoutError(`implausible decimals ${decimals} — the layout is probably wrong`);
  }
  return decimals;
}
