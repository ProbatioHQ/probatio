import { describe, expect, it } from 'vitest';
import {
  MEMO_PROGRAM_ID,
  MessageError,
  SYSTEM_PROGRAM_ID,
  compileMessage,
  decodeCompactU16,
  decodeMessage,
  encodeCompactU16,
  encodeMessage,
  memoInstruction,
  orderAccounts,
  serializeUnsigned,
  transferInstruction,
} from '../src/message';

const PAYER = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const TREASURY = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const REFERENCE = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BLOCKHASH = 'So11111111111111111111111111111111111111112';

describe('compact-u16', () => {
  it('encodes a single byte below 128', () => {
    expect([...encodeCompactU16(0)]).toEqual([0]);
    expect([...encodeCompactU16(5)]).toEqual([5]);
    expect([...encodeCompactU16(127)]).toEqual([127]);
  });

  it('spills into a second byte at 128', () => {
    expect([...encodeCompactU16(128)]).toEqual([0x80, 0x01]);
    expect([...encodeCompactU16(16_383)]).toEqual([0xff, 0x7f]);
  });

  it('uses three bytes at the top of the range', () => {
    expect([...encodeCompactU16(16_384)]).toEqual([0x80, 0x80, 0x01]);
    expect([...encodeCompactU16(65_535)]).toEqual([0xff, 0xff, 0x03]);
  });

  it('round trips every boundary', () => {
    for (const value of [0, 1, 127, 128, 255, 16_383, 16_384, 65_535]) {
      const { value: decoded, next } = decodeCompactU16(encodeCompactU16(value), 0);
      expect(decoded).toBe(value);
      expect(next).toBe(encodeCompactU16(value).length);
    }
  });

  it('refuses a value that does not fit', () => {
    expect(() => encodeCompactU16(65_536)).toThrow(MessageError);
    expect(() => encodeCompactU16(-1)).toThrow(MessageError);
  });

  it('refuses to read past the end', () => {
    expect(() => decodeCompactU16(Uint8Array.from([0x80]), 0)).toThrow(MessageError);
  });
});

describe('ordering accounts', () => {
  it('puts the fee payer first and signing', () => {
    const ordered = orderAccounts(PAYER, [transferInstruction(PAYER, TREASURY, 1n)]);

    expect(ordered.keys[0]).toBe(PAYER);
    expect(ordered.numRequiredSignatures).toBe(1);
  });

  it('groups writable before readonly among non-signers', () => {
    const ordered = orderAccounts(PAYER, [
      transferInstruction(PAYER, TREASURY, 1n, REFERENCE),
    ]);

    // payer (signer, writable), treasury (writable), then the readonly ones.
    expect(ordered.keys[0]).toBe(PAYER);
    expect(ordered.keys[1]).toBe(TREASURY);
    expect(ordered.keys.slice(2)).toContain(REFERENCE);
    expect(ordered.keys.slice(2)).toContain(SYSTEM_PROGRAM_ID);
    expect(ordered.numReadonlyUnsigned).toBe(2);
  });

  it('accumulates permissions rather than taking the last one seen', () => {
    // Readonly in one instruction and writable in another means writable.
    // Demoting it would fail at execution rather than here.
    const ordered = orderAccounts(PAYER, [
      { programId: MEMO_PROGRAM_ID, keys: [{ pubkey: TREASURY, isSigner: false, isWritable: false }], data: new Uint8Array() },
      transferInstruction(PAYER, TREASURY, 1n),
    ]);

    expect(ordered.numReadonlyUnsigned).toBe(2);
    expect(ordered.keys[1]).toBe(TREASURY);
  });

  it('never lists a program as writable', () => {
    const ordered = orderAccounts(PAYER, [memoInstruction('hello')]);
    expect(ordered.keys).toEqual([PAYER, MEMO_PROGRAM_ID]);
    expect(ordered.numReadonlyUnsigned).toBe(1);
  });

  it('lists an account once however often it appears', () => {
    const ordered = orderAccounts(PAYER, [
      transferInstruction(PAYER, TREASURY, 1n),
      transferInstruction(PAYER, TREASURY, 2n),
    ]);
    expect(ordered.keys).toHaveLength(3);
  });
});

describe('compiling and encoding', () => {
  const instructions = [
    transferInstruction(PAYER, TREASURY, 50_000_000n, REFERENCE),
    memoInstruction('Probatio season 1 entry'),
  ];

  it('round trips through the encoder', () => {
    const message = compileMessage(PAYER, BLOCKHASH, instructions);
    const decoded = decodeMessage(encodeMessage(message));

    expect(decoded.accountKeys).toEqual(message.accountKeys);
    expect(decoded.recentBlockhash).toBe(BLOCKHASH);
    expect(decoded.numRequiredSignatures).toBe(1);
    expect(decoded.instructions).toHaveLength(2);
  });

  it('encodes a transfer the System program will recognise', () => {
    const instruction = transferInstruction(PAYER, TREASURY, 50_000_000n);
    const view = new DataView(instruction.data.buffer, instruction.data.byteOffset);

    expect(instruction.data).toHaveLength(12);
    expect(view.getUint32(0, true)).toBe(2);
    expect(view.getBigUint64(4, true)).toBe(50_000_000n);
  });

  it('refuses an amount that will not fit in a u64', () => {
    expect(() => transferInstruction(PAYER, TREASURY, 2n ** 64n)).toThrow(MessageError);
    expect(() => transferInstruction(PAYER, TREASURY, -1n)).toThrow(MessageError);
  });

  it('leaves room for the signature the wallet adds', () => {
    const message = compileMessage(PAYER, BLOCKHASH, instructions);
    const serialized = serializeUnsigned(message);
    const encoded = encodeMessage(message);

    // One length byte, one empty 64-byte slot, then the message.
    expect(serialized).toHaveLength(1 + 64 + encoded.length);
    expect(serialized[0]).toBe(1);
    expect([...serialized.subarray(1, 65)].every((byte) => byte === 0)).toBe(true);
  });

  it('refuses a key that is not 32 bytes', () => {
    expect(() => encodeMessage(compileMessage('abc', BLOCKHASH, instructions))).toThrow(MessageError);
  });
});

describe('decoding what it should not', () => {
  it('refuses a versioned message rather than misreading it', () => {
    // The high bit marks a v0 message. Reading one as legacy produces
    // plausible nonsense rather than an error, which is worse.
    const bytes = encodeMessage(compileMessage(PAYER, BLOCKHASH, [memoInstruction('x')]));
    bytes[0] = 0x80;
    expect(() => decodeMessage(bytes)).toThrow(/not a legacy message/);
  });

  it('refuses a message too short to hold a header', () => {
    expect(() => decodeMessage(Uint8Array.from([1, 0]))).toThrow(MessageError);
  });

  it('refuses a message that ends mid-key', () => {
    const bytes = encodeMessage(compileMessage(PAYER, BLOCKHASH, [memoInstruction('x')]));
    expect(() => decodeMessage(bytes.subarray(0, 40))).toThrow(MessageError);
  });
});
