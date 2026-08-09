import bs58 from 'bs58';

/**
 * Legacy Solana transaction messages, encoded by hand.
 *
 * There is no web3.js here. Every other Solana structure in this project is
 * encoded and decoded directly, and a wallet-signed transfer is not the place
 * to change that — the format is small, fully specified, and the alternative is
 * a large dependency in the one code path that moves real money.
 *
 * The encoder is checked against transactions taken off mainnet: decode a real
 * transfer, re-encode it, and require the bytes back. Anything short of that is
 * a guess about a format the network is the only authority on.
 */

export class MessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MessageError';
  }
}

export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
export const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
/** The System instruction index for a transfer. */
const SYSTEM_TRANSFER = 2;

export interface AccountMeta {
  readonly pubkey: string;
  readonly isSigner: boolean;
  readonly isWritable: boolean;
}

export interface Instruction {
  readonly programId: string;
  readonly keys: readonly AccountMeta[];
  readonly data: Uint8Array;
}

export interface Message {
  readonly numRequiredSignatures: number;
  readonly numReadonlySignedAccounts: number;
  readonly numReadonlyUnsignedAccounts: number;
  readonly accountKeys: readonly string[];
  readonly recentBlockhash: string;
  readonly instructions: readonly CompiledInstruction[];
}

export interface CompiledInstruction {
  readonly programIdIndex: number;
  readonly accountIndexes: readonly number[];
  readonly data: Uint8Array;
}

/**
 * Compact-u16, Solana's short vector length prefix.
 *
 * Seven bits per byte, low group first, high bit meaning "another byte
 * follows". Not the same as an LEB128 varint in the general case, and getting
 * it wrong shifts every field after it.
 */
export function encodeCompactU16(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new MessageError(`compact-u16 out of range: ${value}`);
  }

  const bytes: number[] = [];
  let remaining = value;
  for (;;) {
    const group = remaining & 0x7f;
    remaining >>= 7;
    if (remaining === 0) {
      bytes.push(group);
      break;
    }
    bytes.push(group | 0x80);
  }
  return Uint8Array.from(bytes);
}

export function decodeCompactU16(bytes: Uint8Array, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let cursor = offset;

  for (let read = 0; read < 3; read += 1) {
    const byte = bytes[cursor];
    if (byte === undefined) throw new MessageError('compact-u16 ran off the end');
    cursor += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, next: cursor };
    shift += 7;
  }
  throw new MessageError('compact-u16 longer than three bytes');
}

/**
 * Put accounts in the order a message requires.
 *
 * Writable signers, then readonly signers, then writable non-signers, then
 * readonly non-signers. The fee payer is first regardless. This ordering is not
 * cosmetic: the header describes the account list purely by counts, so a key in
 * the wrong group is silently granted or denied a permission.
 */
export function orderAccounts(
  feePayer: string,
  instructions: readonly Instruction[],
): { keys: string[]; numRequiredSignatures: number; numReadonlySigned: number; numReadonlyUnsigned: number } {
  const merged = new Map<string, { isSigner: boolean; isWritable: boolean }>();

  const note = (pubkey: string, isSigner: boolean, isWritable: boolean): void => {
    const existing = merged.get(pubkey);
    // Permissions accumulate. An account that is writable in one instruction
    // and readonly in another is writable, and demoting it would fail the
    // transaction at execution rather than here.
    merged.set(pubkey, {
      isSigner: (existing?.isSigner ?? false) || isSigner,
      isWritable: (existing?.isWritable ?? false) || isWritable,
    });
  };

  note(feePayer, true, true);
  for (const instruction of instructions) {
    for (const key of instruction.keys) note(key.pubkey, key.isSigner, key.isWritable);
    // A program is never a signer and never writable.
    if (!merged.has(instruction.programId)) note(instruction.programId, false, false);
  }

  const others = [...merged.entries()].filter(([pubkey]) => pubkey !== feePayer);
  const pick = (isSigner: boolean, isWritable: boolean): string[] =>
    others
      .filter(([, meta]) => meta.isSigner === isSigner && meta.isWritable === isWritable)
      .map(([pubkey]) => pubkey);

  const writableSigners = pick(true, true);
  const readonlySigners = pick(true, false);
  const writableNonSigners = pick(false, true);
  const readonlyNonSigners = pick(false, false);

  return {
    keys: [feePayer, ...writableSigners, ...readonlySigners, ...writableNonSigners, ...readonlyNonSigners],
    numRequiredSignatures: 1 + writableSigners.length + readonlySigners.length,
    numReadonlySigned: readonlySigners.length,
    numReadonlyUnsigned: readonlyNonSigners.length,
  };
}

export function compileMessage(
  feePayer: string,
  recentBlockhash: string,
  instructions: readonly Instruction[],
): Message {
  const ordered = orderAccounts(feePayer, instructions);
  const indexOf = (pubkey: string): number => {
    const index = ordered.keys.indexOf(pubkey);
    if (index === -1) throw new MessageError(`account missing from the message: ${pubkey}`);
    return index;
  };

  return {
    numRequiredSignatures: ordered.numRequiredSignatures,
    numReadonlySignedAccounts: ordered.numReadonlySigned,
    numReadonlyUnsignedAccounts: ordered.numReadonlyUnsigned,
    accountKeys: ordered.keys,
    recentBlockhash,
    instructions: instructions.map((instruction) => ({
      programIdIndex: indexOf(instruction.programId),
      accountIndexes: instruction.keys.map((key) => indexOf(key.pubkey)),
      data: instruction.data,
    })),
  };
}

export function encodeMessage(message: Message): Uint8Array {
  const parts: Uint8Array[] = [
    Uint8Array.from([
      message.numRequiredSignatures,
      message.numReadonlySignedAccounts,
      message.numReadonlyUnsignedAccounts,
    ]),
    encodeCompactU16(message.accountKeys.length),
  ];

  for (const key of message.accountKeys) parts.push(decodePubkey(key));
  parts.push(decodePubkey(message.recentBlockhash));
  parts.push(encodeCompactU16(message.instructions.length));

  for (const instruction of message.instructions) {
    parts.push(Uint8Array.from([instruction.programIdIndex]));
    parts.push(encodeCompactU16(instruction.accountIndexes.length));
    parts.push(Uint8Array.from(instruction.accountIndexes));
    parts.push(encodeCompactU16(instruction.data.length));
    parts.push(instruction.data);
  }

  return concat(parts);
}

export function decodeMessage(bytes: Uint8Array): Message {
  if (bytes.length < 3) throw new MessageError('message too short for a header');
  // The high bit of the first byte marks a versioned message. This decoder
  // reads legacy messages, and quietly misreading a v0 message as legacy would
  // produce plausible nonsense.
  if ((bytes[0]! & 0x80) !== 0) throw new MessageError('not a legacy message');

  const numRequiredSignatures = bytes[0]!;
  const numReadonlySignedAccounts = bytes[1]!;
  const numReadonlyUnsignedAccounts = bytes[2]!;

  let cursor = 3;
  const accountCount = decodeCompactU16(bytes, cursor);
  cursor = accountCount.next;

  const accountKeys: string[] = [];
  for (let i = 0; i < accountCount.value; i += 1) {
    accountKeys.push(encodePubkey(slice(bytes, cursor, 32)));
    cursor += 32;
  }

  const recentBlockhash = encodePubkey(slice(bytes, cursor, 32));
  cursor += 32;

  const instructionCount = decodeCompactU16(bytes, cursor);
  cursor = instructionCount.next;

  const instructions: CompiledInstruction[] = [];
  for (let i = 0; i < instructionCount.value; i += 1) {
    const programIdIndex = bytes[cursor];
    if (programIdIndex === undefined) throw new MessageError('instruction ran off the end');
    cursor += 1;

    const accounts = decodeCompactU16(bytes, cursor);
    cursor = accounts.next;
    const accountIndexes = [...slice(bytes, cursor, accounts.value)];
    cursor += accounts.value;

    const dataLength = decodeCompactU16(bytes, cursor);
    cursor = dataLength.next;
    const data = slice(bytes, cursor, dataLength.value);
    cursor += dataLength.value;

    instructions.push({ programIdIndex, accountIndexes, data });
  }

  return {
    numRequiredSignatures,
    numReadonlySignedAccounts,
    numReadonlyUnsignedAccounts,
    accountKeys,
    recentBlockhash,
    instructions,
  };
}

/**
 * A transfer of lamports, with a reference account attached.
 *
 * The reference is a read-only account the System program never looks at. It
 * exists so the payment can be found on chain from the intent alone — the case
 * that matters is a user who signs, pays, and closes the tab before the
 * confirmation reaches us.
 */
export function transferInstruction(
  from: string,
  to: string,
  lamports: bigint,
  reference?: string,
): Instruction {
  if (lamports < 0n || lamports > 0xffff_ffff_ffff_ffffn) {
    throw new MessageError(`transfer amount out of range: ${lamports}`);
  }

  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, SYSTEM_TRANSFER, true);
  view.setBigUint64(4, lamports, true);

  const keys: AccountMeta[] = [
    { pubkey: from, isSigner: true, isWritable: true },
    { pubkey: to, isSigner: false, isWritable: true },
  ];
  if (reference) keys.push({ pubkey: reference, isSigner: false, isWritable: false });

  return { programId: SYSTEM_PROGRAM_ID, keys, data };
}

export function memoInstruction(note: string): Instruction {
  return {
    programId: MEMO_PROGRAM_ID,
    keys: [],
    data: new TextEncoder().encode(note),
  };
}

/**
 * A transaction with its signature slots left empty.
 *
 * The wallet fills them. Sending a placeholder of the right size is what makes
 * the payload a transaction rather than a bare message, which is what Phantom
 * expects to be handed.
 */
export function serializeUnsigned(message: Message): Uint8Array {
  const encoded = encodeMessage(message);
  const signatures = new Uint8Array(message.numRequiredSignatures * 64);
  return concat([encodeCompactU16(message.numRequiredSignatures), signatures, encoded]);
}

export function decodePubkey(value: string): Uint8Array {
  const bytes = bs58.decode(value);
  if (bytes.length !== 32) {
    throw new MessageError(`expected a 32-byte key, got ${bytes.length} from ${value}`);
  }
  return bytes;
}

export function encodePubkey(bytes: Uint8Array): string {
  return bs58.encode(bytes);
}

function slice(bytes: Uint8Array, offset: number, length: number): Uint8Array {
  if (offset + length > bytes.length) throw new MessageError('read past the end of the message');
  return bytes.subarray(offset, offset + length);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
