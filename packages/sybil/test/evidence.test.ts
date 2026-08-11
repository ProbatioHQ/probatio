import { describe, expect, it } from 'vitest';
import type { RpcClient } from '@probatio/pools';
import { SHARED_FUNDER_SIGNATURES, gatherEvidence } from '../src/evidence';

/**
 * Reading a wallet off the chain.
 *
 * The part that matters most here is the one that decides whether a funder
 * identifies anybody. Getting it wrong in the strict direction refuses people
 * who did nothing but buy SOL on an exchange, so the failure cases are tested
 * as carefully as the working one.
 */

const NOW = 1_700_000_000_000;
const WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const FUNDER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

interface Stub {
  /** Signature counts to answer with, per address. */
  readonly counts: Record<string, number>;
  readonly payer?: string;
  /** Addresses whose signature lookup throws. */
  readonly unreadable?: readonly string[];
}

function rpc(stub: Stub): RpcClient {
  let calls = 0;
  return {
    async getSignatures(address: string, options: { limit?: number } = {}) {
      calls += 1;
      if (stub.unreadable?.includes(address)) throw new Error('rpc down');
      const total = stub.counts[address] ?? 0;
      const limit = options.limit ?? 100;
      // One page at a time, oldest last, as the real client returns them.
      const page = Math.min(total, limit);
      return Array.from({ length: page }, (_, index) => ({
        signature: `${address}-${calls}-${index}`,
        slot: 1_000 - index,
        blockTime: (NOW - 90 * 86_400_000) / 1_000,
        err: null,
      }));
    },
    async getTransaction() {
      return { accountKeys: [stub.payer ?? FUNDER], preBalances: [], postBalances: [], err: null };
    },
  } as unknown as RpcClient;
}

describe('reading who funded a wallet', () => {
  it('finds the funder of an ordinary wallet', async () => {
    const evidence = await gatherEvidence(rpc({ counts: { [WALLET]: 40, [FUNDER]: 60 } }), WALLET, NOW);
    expect(evidence.funder).toBe(FUNDER);
    expect(evidence.funderIsShared).toBe(false);
  });

  it('calls a funder with a full page of history shared', async () => {
    // An exchange fills the page in minutes. Somebody hand-funding wallets
    // never gets near it.
    const evidence = await gatherEvidence(
      rpc({ counts: { [WALLET]: 3, [FUNDER]: SHARED_FUNDER_SIGNATURES } }),
      WALLET,
      NOW,
    );
    expect(evidence.funder).toBe(FUNDER);
    expect(evidence.funderIsShared).toBe(true);
  });

  it('does not call a busy-but-ordinary funder shared', async () => {
    const evidence = await gatherEvidence(
      rpc({ counts: { [WALLET]: 3, [FUNDER]: SHARED_FUNDER_SIGNATURES - 1 } }),
      WALLET,
      NOW,
    );
    expect(evidence.funderIsShared).toBe(false);
  });

  it('treats an unreadable funder as shared, not as a person', async () => {
    // This is the direction that matters. A refusal is the only thing the
    // funder can cause, so an RPC failure resolving toward "identifies a
    // person" would refuse an entry because a network call flaked.
    const evidence = await gatherEvidence(
      rpc({ counts: { [WALLET]: 3, [FUNDER]: 10 }, unreadable: [FUNDER] }),
      WALLET,
      NOW,
    );
    expect(evidence.funder).toBe(FUNDER);
    expect(evidence.funderIsShared).toBe(true);
  });

  it('reports a self-funded wallet as having no funder', async () => {
    const evidence = await gatherEvidence(
      rpc({ counts: { [WALLET]: 5 }, payer: WALLET }),
      WALLET,
      NOW,
    );
    expect(evidence.funder).toBeNull();
    expect(evidence.funderIsShared).toBe(false);
  });

  it('reports an empty wallet without inventing a funder', async () => {
    const evidence = await gatherEvidence(rpc({ counts: {} }), WALLET, NOW);
    expect(evidence.signatureCount).toBe(0);
    expect(evidence.funder).toBeNull();
    expect(evidence.funderIsShared).toBe(false);
  });
});
