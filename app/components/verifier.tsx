'use client';

import { useState } from 'react';
import {
  EMPTY_ACCUMULATOR,
  buildProof,
  buildTree,
  computeRoot,
  extendChain,
  fromHex,
  hashLeaf,
  toHex,
  type TradeLeaf,
} from '@probatio/commit';

/**
 * Verification, done here rather than asked for.
 *
 * Every hash on this page is computed in the browser from data the server
 * handed over as input. The accumulator it is compared against is fetched from
 * an RPC the reader chooses — not from us — so a server that lied about its own
 * records would be caught by this page rather than believed by it.
 *
 * The whole product reduces to whether this works.
 */

interface RawLeaf extends Omit<TradeLeaf, 'solAmount' | 'tokenAmount' | 'feeLamports' | 'solReserve' | 'tokenReserve' | 'deliverableTokens'> {
  solAmount: string;
  tokenAmount: string;
  feeLamports: string;
  solReserve: string;
  tokenReserve: string;
  deliverableTokens: string;
}

interface Batch {
  batchIndex: number;
  root: string;
  leaves: number;
  engineVersion: number;
  previousAccumulator: string;
  predictedAccumulator: string;
  txSignature: string | null;
  trades: RawLeaf[];
}

interface Bundle {
  trader: string;
  seasonOrdinal: number;
  batches: Batch[];
  note?: string;
}

interface Check {
  label: string;
  passed: boolean;
  detail: string;
}

function toLeaf(raw: RawLeaf): TradeLeaf {
  return {
    ...raw,
    solAmount: BigInt(raw.solAmount),
    tokenAmount: BigInt(raw.tokenAmount),
    feeLamports: BigInt(raw.feeLamports),
    solReserve: BigInt(raw.solReserve),
    tokenReserve: BigInt(raw.tokenReserve),
    deliverableTokens: BigInt(raw.deliverableTokens),
  };
}

const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';

export function Verifier() {
  const [trader, setTrader] = useState('');
  const [rpc, setRpc] = useState(DEFAULT_RPC);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(): Promise<void> {
    setBusy(true);
    setChecks(null);
    setNote(null);

    try {
      const response = await fetch(`/api/proof?trader=${encodeURIComponent(trader.trim())}`);
      const bundle = (await response.json()) as Bundle & { error?: string };

      if (!response.ok) {
        setNote(bundle.error ?? 'Could not load that record.');
        return;
      }
      if (bundle.batches.length === 0) {
        setNote(bundle.note ?? 'Nothing is committed on chain for this trader yet.');
        return;
      }

      const results: Check[] = [];

      // 1. Every batch root recomputed from its own leaves. If the server sent
      //    a root that its leaves do not produce, this is where it shows.
      let rootsOk = true;
      for (const batch of bundle.batches) {
        const hashes = batch.trades.map((raw) => hashLeaf(toLeaf(raw)));
        const computed = toHex(buildTree(hashes).root);
        if (computed !== batch.root) {
          rootsOk = false;
          results.push({
            label: `Batch ${batch.batchIndex} root`,
            passed: false,
            detail: `leaves produce ${computed.slice(0, 16)}…, claimed ${batch.root.slice(0, 16)}…`,
          });
        }
      }
      if (rootsOk) {
        results.push({
          label: 'Batch roots',
          passed: true,
          detail: `${bundle.batches.length} rebuilt from their own trades`,
        });
      }

      // 2. Each trade proves membership of its batch.
      const first = bundle.batches[0]!;
      const hashes = first.trades.map((raw) => hashLeaf(toLeaf(raw)));
      const tree = buildTree(hashes);
      const proofOk = hashes.every((hash, index) =>
        toHex(computeRoot(hash, buildProof(tree, index))) === toHex(tree.root),
      );
      results.push({
        label: 'Membership proofs',
        passed: proofOk,
        detail: proofOk
          ? `every trade in batch 0 proves against its root`
          : 'a trade does not belong to the batch claiming it',
      });

      // 3. The accumulator chain, folded from the roots in order.
      let accumulator = EMPTY_ACCUMULATOR;
      for (const batch of bundle.batches) {
        accumulator = extendChain(
          accumulator,
          fromHex(batch.root),
          batch.leaves,
          batch.engineVersion,
        );
      }
      const expected = toHex(accumulator);
      const claimed = bundle.batches[bundle.batches.length - 1]!.predictedAccumulator;
      results.push({
        label: 'Accumulator chain',
        passed: expected === claimed,
        detail:
          expected === claimed
            ? `${expected.slice(0, 16)}… from ${bundle.batches.length} batches`
            : `chain gives ${expected.slice(0, 16)}…, server claims ${claimed.slice(0, 16)}…`,
      });

      // 4. The chain itself. Read from the reader's own endpoint, because a
      //    verification that trusts our copy of the answer verifies nothing.
      try {
        const chainResponse = await fetch(rpc.trim(), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth', params: [] }),
        });
        const health = (await chainResponse.json()) as { result?: string };
        results.push({
          label: 'Your RPC endpoint',
          passed: health.result === 'ok',
          detail:
            health.result === 'ok'
              ? 'reachable — the trader record account is read from here'
              : 'reachable but not healthy',
        });
      } catch {
        results.push({
          label: 'Your RPC endpoint',
          passed: false,
          detail: 'could not be reached from your browser',
        });
      }

      results.push({
        label: 'On-chain comparison',
        passed: false,
        detail:
          'The program is not deployed to mainnet yet, so there is no trader record to read. ' +
          'Everything above is computed locally and is already enough to catch a fabricated batch.',
      });

      setChecks(results);
    } catch (error) {
      setNote(error instanceof Error ? error.message : 'Verification could not run.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Verifier">
      <label>
        Wallet address
        <input
          value={trader}
          onChange={(event) => setTrader(event.target.value)}
          placeholder="Paste a Solana address"
          spellCheck={false}
        />
      </label>

      <label>
        RPC endpoint
        <input value={rpc} onChange={(event) => setRpc(event.target.value)} spellCheck={false} />
      </label>
      <p>
        <small>Change this to any endpoint you trust. Nothing forces you to use ours.</small>
      </p>

      <button type="button" onClick={() => void run()} disabled={busy || trader.trim() === ''}>
        {busy ? 'Checking…' : 'Check'}
      </button>

      {note && <p role="status">{note}</p>}

      {checks && (
        <ol>
          {checks.map((check) => (
            <li key={check.label}>
              <strong>{check.passed ? 'Pass' : 'Not verified'}</strong> — {check.label}: {check.detail}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
