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
import { findProgramAddress } from '@probatio/pools';
import bs58 from 'bs58';

/**
 * The program, and how to find a trader's record inside it.
 *
 * Derived here rather than asked for. If this page took the account address
 * from the server it was checking, that server could hand back an address it
 * controls holding whatever accumulator it liked, and the comparison would pass
 * while proving nothing. The seeds and the program id are in the repository;
 * the derivation is the reader's.
 */
const PROGRAM_ID = 'HRGEAiqX4qw7B1fgNsR64oRAKF4QwkjkZFx9YXDFxaXA';
const SEASON_SEED = new TextEncoder().encode('season');
const RECORD_SEED = new TextEncoder().encode('record');
/** Anchor's discriminator for TraderRecord. */
const TRADER_RECORD_DISCRIMINATOR = 'f9159451b5a2ad97';

function seasonPda(ordinal: number): string {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setInt16(0, ordinal, true);
  return findProgramAddress([SEASON_SEED, bytes], PROGRAM_ID).address;
}

function recordPda(season: string, trader: string): string {
  return findProgramAddress(
    [RECORD_SEED, bs58.decode(season), bs58.decode(trader)],
    PROGRAM_ID,
  ).address;
}

/** The accumulator out of a TraderRecord account, or null if it is not one. */
function accumulatorFrom(base64: string): string | null {
  const binary = atob(base64);
  const data = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  // 8 discriminator, 32 season, 32 trader, then the accumulator.
  if (data.length < 104) return null;

  const hex = (from: number, to: number): string =>
    [...data.subarray(from, to)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

  if (hex(0, 8) !== TRADER_RECORD_DISCRIMINATOR) return null;
  return hex(72, 104);
}

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
              ? // Says what this step did, not what a later one will. It asked
                // the endpoint whether it was healthy; it did not read an
                // account, because there is not one to read until the program
                // is deployed. Claiming otherwise would be the site telling a
                // reader a check happened that did not.
                'reachable from your browser, and answering'
              : 'reachable but not healthy',
        });
      } catch {
        results.push({
          label: 'Your RPC endpoint',
          passed: false,
          detail: 'could not be reached from your browser',
        });
      }

      /*
       * 5. The comparison the whole page exists for.
       *
       * This used to be a hardcoded failure saying the program was not
       * deployed. True when it was written, and it would have stayed on the
       * screen unchanged on the day of deployment — the one check that matters
       * reporting "not deployed" forever while every local check above it
       * passed and the page looked like it was working.
       *
       * It reads the chain now. The address is derived here from the seeds in
       * the repository, the account is fetched from the reader's own endpoint,
       * and the accumulator inside it is compared against the one folded from
       * the batches above. Nothing in this step comes from the server being
       * checked.
       */
      try {
        const account = recordPda(seasonPda(bundle.seasonOrdinal), bundle.trader);
        const response = await fetch(rpc.trim(), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getAccountInfo',
            params: [account, { encoding: 'base64', commitment: 'confirmed' }],
          }),
        });
        const body = (await response.json()) as {
          result?: { value?: { data?: [string, string]; owner?: string } | null };
        };
        const value = body.result?.value ?? null;

        if (!value) {
          results.push({
            label: 'On-chain comparison',
            passed: false,
            detail:
              `no account at ${account.slice(0, 8)}… on this endpoint — either nothing has been ` +
              'committed for this trader yet, or the program is not deployed on the cluster you chose',
          });
        } else if (value.owner !== PROGRAM_ID) {
          // An account at the right address owned by somebody else is not this
          // program's record, whatever it contains.
          results.push({
            label: 'On-chain comparison',
            passed: false,
            detail: `that account is owned by ${value.owner?.slice(0, 8)}…, not the program`,
          });
        } else {
          const onChain = accumulatorFrom(value.data?.[0] ?? '');
          results.push({
            label: 'On-chain comparison',
            passed: onChain === expected,
            detail:
              onChain === null
                ? 'the account exists but is not a trader record'
                : onChain === expected
                  ? `the chain holds ${onChain.slice(0, 16)}…, which is what these trades produce`
                  : `the chain holds ${onChain.slice(0, 16)}…, these trades produce ${expected.slice(0, 16)}…`,
          });
        }
      } catch {
        results.push({
          label: 'On-chain comparison',
          passed: false,
          detail: 'the record could not be read from your endpoint',
        });
      }

      setChecks(results);
    } catch (error) {
      setNote(error instanceof Error ? error.message : 'Verification could not run.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Verifier" className="panel">
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
        <ol className="bare">
          {checks.map((check) => (
            <li key={check.label}>
              <span className={check.passed ? 'gain' : 'dim'}>
                {check.passed ? 'Pass' : 'Not verified'}
              </span>{' '}
             , {check.label}: <span className="dim">{check.detail}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
