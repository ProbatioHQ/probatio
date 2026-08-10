import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROGRAM_ID } from '../src/solana';

/**
 * The TypeScript program id and the Rust one must be the same string.
 *
 * These are two hand-written copies of one address in two languages, and every
 * instruction this project sends is built against the TypeScript one while
 * every account the program owns is derived from the Rust one. When they
 * disagree, nothing fails locally: the tests pass, the build passes, and every
 * transaction is rejected the moment it reaches a real cluster.
 *
 * That has already happened once here — the source said one address, the
 * program keypair another, and only a deployment revealed it. It happened a
 * second time in a script that kept its own copy of the id and was still using
 * the discarded one. Two occurrences of the same mistake is the point at which
 * it is worth a test rather than more care.
 *
 * Reads the Rust source rather than any build artefact, so it is checking what
 * a reader of the repository would see.
 */

const LIB_RS = new URL('../../../program/programs/probatio/src/lib.rs', import.meta.url);

describe('the program id', () => {
  it('matches declare_id! in the Rust source', () => {
    const source = readFileSync(LIB_RS, 'utf8');
    const declared = /declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\)/.exec(source);

    expect(declared, 'declare_id! not found in program/src/lib.rs').not.toBeNull();
    expect(PROGRAM_ID).toBe(declared![1]);
  });

  it('is a plausible base58 address', () => {
    // A truncated or mistyped constant is still a string, and would otherwise
    // only be caught by a cluster refusing it.
    expect(PROGRAM_ID).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });
});
