import bs58 from 'bs58';
import { LayoutError } from './layout';

/**
 * Who can replace a program.
 *
 * The most important account in this system and the one nobody looks at. A
 * program with an upgrade authority can be swapped for a different program by
 * whoever holds that key — including one that rewrites the records the old one
 * promised were append-only. Every guarantee the on-chain half makes is a
 * guarantee about the code currently deployed, and nothing more.
 *
 * So the authority is read and reported rather than assumed. Decoding it here
 * means the claim can be checked by anyone with an RPC endpoint, which is the
 * only kind of claim worth making about this.
 */

export const BPF_UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';

/** The account variants the loader stores. Only the last two matter here. */
const UNINITIALIZED = 0;
const BUFFER = 1;
const PROGRAM = 2;
const PROGRAM_DATA = 3;

export interface ProgramDataAccount {
  /** Base58, or null when the authority has been burned. */
  readonly upgradeAuthority: string | null;
  /** The slot the current bytecode was written at. */
  readonly lastDeploySlot: bigint;
  /** The deployed bytecode, for hashing against a local build. */
  readonly bytecode: Uint8Array;
}

/**
 * Decode a ProgramData account.
 *
 * Layout: a four-byte little-endian variant, an eight-byte slot, a one-byte
 * option flag, then a thirty-two byte authority if the flag is set. The
 * bytecode follows.
 *
 * The option byte is the whole point. Zero means the authority was burned and
 * the program can never be replaced; one means somebody can still replace it.
 */
export function decodeProgramData(data: Uint8Array): ProgramDataAccount {
  if (data.length < 13) {
    throw new LayoutError(`program data account is too short: ${data.length} bytes`);
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const variant = view.getUint32(0, true);
  if (variant !== PROGRAM_DATA) {
    throw new LayoutError(
      `expected a ProgramData account (${PROGRAM_DATA}), got variant ${variant}`,
    );
  }

  const lastDeploySlot = view.getBigUint64(4, true);
  const hasAuthority = data[12] === 1;

  if (!hasAuthority) {
    return { upgradeAuthority: null, lastDeploySlot, bytecode: data.subarray(13) };
  }

  if (data.length < 45) {
    throw new LayoutError('program data claims an authority but is too short to hold one');
  }

  return {
    upgradeAuthority: bs58.encode(data.subarray(13, 45)),
    lastDeploySlot,
    bytecode: data.subarray(45),
  };
}

/** The address holding a program's bytecode and its upgrade authority. */
export function programDataAddress(
  programId: string,
  findAddress: (seeds: readonly Uint8Array[], programId: string) => { address: string },
): string {
  return findAddress([bs58.decode(programId)], BPF_UPGRADEABLE_LOADER).address;
}

export const LOADER_VARIANTS = { UNINITIALIZED, BUFFER, PROGRAM, PROGRAM_DATA } as const;
