import { describe, expect, it } from 'vitest';
import type { ConfirmedTransaction } from '@probatio/pools';
import { deriveWalletSwap } from '../src/wallet';

/**
 * Reading a trade out of a transaction, without being told where it happened.
 *
 * The fixture below is not invented. It is mainnet transaction
 * 4BRG9jcHMvN6roPcbY5BBAZ7YzCAUERmVDHDbCSdt7GrGoxxcCBzfwKbFmLB599U95uV2uH3A7Wdy7tM6wyFrauQ
 * with its balances copied across unchanged, because a parser tested only
 * against transactions its own author invented tests the author's beliefs about
 * the chain rather than the chain.
 */

const WSOL = 'So11111111111111111111111111111111111111112';
const TRADER = 'FbiF97iwAUgfX8P4koxcSp7iZMbHxqmiCx19jCotdfmr';
const POOL = 'GStt6F1F8yQSzDDaHjrzgPwZZprBraHPZsoqo25cvzuP';
const MINT = 'Ka8TzMrjmPDFUJgtx5kqrF7Xgfw911JSPHbmzxppump';
/** A protocol fee account: moves the same way as the pool, on the wrong scale. */
const FEE = '3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR';

const REAL: ConfirmedTransaction = {
  signature: '4BRG9jcHMvN6roPcbY5BBAZ7YzCAUERmVDHDbCSdt7GrGoxxcCBzfwKbFmLB599U95uV2uH3A7Wdy7tM6wyFrauQ',
  slot: 440_443_062,
  blockTime: 1_787_216_484,
  err: null,
  fee: 5_000n,
  accountKeys: [TRADER, POOL, FEE, MINT],
  preBalances: [1_000_000_000n, 0n, 0n, 0n],
  postBalances: [999_394_609n, 0n, 0n, 0n],
  preTokenBalances: [
    { accountIndex: 1, mint: WSOL, owner: POOL, amount: 308_762_015_496n },
    { accountIndex: 2, mint: WSOL, owner: FEE, amount: 538_247_455n },
    { accountIndex: 4, mint: MINT, owner: TRADER, amount: 35_882_917n },
    { accountIndex: 6, mint: MINT, owner: POOL, amount: 53_982_520_997_134n },
  ],
  postTokenBalances: [
    { accountIndex: 1, mint: WSOL, owner: POOL, amount: 308_762_521_843n },
    { accountIndex: 2, mint: WSOL, owner: FEE, amount: 538_247_581n },
    { accountIndex: 4, mint: MINT, owner: TRADER, amount: 119_472_673n },
    { accountIndex: 6, mint: MINT, owner: POOL, amount: 53_982_437_407_378n },
  ],
  logMessages: ['Program log: Instruction: Buy'],
};

describe('reading one wallet out of a real transaction', () => {
  it('reads the trade with no idea which venue it went through', () => {
    const swap = deriveWalletSwap(REAL, TRADER);

    expect(swap?.mint).toBe(MINT);
    expect(swap?.isBuy).toBe(true);
    expect(swap?.tokenAmount).toBe(83_589_756n);
    // What left the wallet, less the network's fee, which was not paid to a pool.
    expect(swap?.solAmount).toBe(600_391n);
  });

  /*
   * The reserves the trade left behind, which is the whole basis of the copy
   * backtest: the pool a copier arriving one transaction later would have met.
   * Found by looking for whoever moved opposite the wallet in the same token,
   * then taking the wrapped SOL belonging to that same owner.
   */
  it('finds the pool the trade left behind, and its two sides', () => {
    const swap = deriveWalletSwap(REAL, TRADER);

    expect(swap?.tokenAfter).toBe(53_982_437_407_378n);
    expect(swap?.solAfter).toBe(308_762_521_843n);
  });

  /*
   * A fee account moves opposite the trader too, on a scale that would price a
   * copy against dust. The pool is the side that moved by what the trader did.
   */
  it('does not mistake a fee account for the pool', () => {
    const decoy: ConfirmedTransaction = {
      ...REAL,
      postTokenBalances: [
        ...REAL.postTokenBalances,
        { accountIndex: 7, mint: MINT, owner: FEE, amount: 1n },
      ],
      preTokenBalances: [
        ...REAL.preTokenBalances,
        { accountIndex: 7, mint: MINT, owner: FEE, amount: 100n },
      ],
    };

    expect(deriveWalletSwap(decoy, TRADER)?.tokenAfter).toBe(53_982_437_407_378n);
  });

  /*
   * Balances alone do not say who traded. Read from the pool's side this same
   * transaction is a coherent sell, because that is what a pool does, so the
   * board would fill with pools. The account that paid is the one that signed.
   */
  it('reads nothing for the pool on the other side of it', () => {
    expect(deriveWalletSwap(REAL, POOL)).toBeNull();
  });

  it('reads nothing for a wallet that only appears in the transaction', () => {
    expect(deriveWalletSwap(REAL, FEE)).toBeNull();
  });

  it('refuses a failed transaction', () => {
    expect(deriveWalletSwap({ ...REAL, err: { InstructionError: [] } }, TRADER)).toBeNull();
  });

  /*
   * Tokens arriving for no SOL is an airdrop, and calling it a buy would put a
   * position on the board that cost nothing and so can only show a profit.
   */
  it('refuses tokens that arrived without SOL leaving', () => {
    const airdrop: ConfirmedTransaction = {
      ...REAL,
      preBalances: [1_000_000_000n, 0n, 0n, 0n],
      postBalances: [1_000_000_000n, 0n, 0n, 0n],
    };

    expect(deriveWalletSwap(airdrop, TRADER)).toBeNull();
  });

  /*
   * The venue's own account of the trade wins wherever it exists: a bonding
   * curve emits one carrying the exact reserves the fill engine quotes against,
   * which balances cannot be made to say.
   */
  it('prefers the program event, and takes its reserves', () => {
    const event = Buffer.alloc(129);
    Buffer.from([0xbd, 0xdb, 0x7f, 0xd3, 0x4e, 0xe6, 0x61, 0xee]).copy(event, 0);
    // A base58 key decodes to 32 bytes; these are written raw, which is what
    // the program does, so the decoder reads them back as the same keys.
    const bs58 = (key: string): Buffer => {
      const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
      let value = 0n;
      for (const character of key) value = value * 58n + BigInt(ALPHABET.indexOf(character));
      const bytes: number[] = [];
      while (value > 0n) {
        bytes.unshift(Number(value % 256n));
        value /= 256n;
      }
      for (const character of key) {
        if (character !== '1') break;
        bytes.unshift(0);
      }
      return Buffer.from(bytes);
    };
    bs58(MINT).copy(event, 8);
    event.writeBigUInt64LE(2_000_000_000n, 40);
    event.writeBigUInt64LE(777n, 48);
    event.writeUInt8(1, 56);
    bs58(TRADER).copy(event, 57);
    event.writeBigInt64LE(1_787_216_484n, 89);
    event.writeBigUInt64LE(40_000_000_000n, 97);
    event.writeBigUInt64LE(900_000_000_000n, 105);
    event.writeBigUInt64LE(9_000_000_000n, 113);
    event.writeBigUInt64LE(800_000_000_000n, 121);

    const curve: ConfirmedTransaction = {
      ...REAL,
      logMessages: [`Program data: ${event.toString('base64')}`],
    };

    const swap = deriveWalletSwap(curve, TRADER);
    expect(swap?.solAmount).toBe(2_000_000_000n);
    expect(swap?.tokenAmount).toBe(777n);
    expect(swap?.solAfter).toBe(40_000_000_000n);
    expect(swap?.tokenAfter).toBe(900_000_000_000n);
  });
});
