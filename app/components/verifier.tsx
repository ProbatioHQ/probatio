'use client';

import { useEffect, useRef, useState } from 'react';
import { buildProof, buildTree, computeRoot, hashLeaf, toHex, type TradeLeaf } from '@probatio/commit';

/**
 * Check a trader's record without taking our word for it.
 *
 * Every fill is sealed with a hash the moment it lands, computed over the exact
 * inputs it was priced from: the reserves, the amounts, the fee, the slot it
 * was clicked at and the slot it filled at. This page asks the server for those
 * inputs and the seals, then recomputes every hash in your browser and compares.
 *
 * The value of it is what it catches. Nothing here trusts the server's opinion
 * of its own data: if a single field of a stored fill were edited afterwards,
 * to improve a price or move a fee, the recomputed hash would stop matching the
 * seal recorded beside it and this page would name the trade. The server cannot
 * make that comparison come out right without also forging the seal, and it
 * cannot forge the seal without the inputs producing it, which are the inputs
 * shown to you here.
 *
 * The arithmetic runs on your machine, from the same open-source hashing the
 * engine uses. You can run it against a record you did not create.
 */

interface RawLeaf
  extends Omit<
    TradeLeaf,
    'solAmount' | 'tokenAmount' | 'feeLamports' | 'solReserve' | 'tokenReserve' | 'deliverableTokens'
  > {
  solAmount: string;
  tokenAmount: string;
  feeLamports: string;
  solReserve: string;
  tokenReserve: string;
  deliverableTokens: string;
  /** The seal written when this fill landed. */
  recordedHash: string;
}

interface Bundle {
  trader: string;
  seasonId: number;
  record: RawLeaf[];
  error?: string;
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

export function Verifier() {
  const [trader, setTrader] = useState('');
  /** So a link that says "check this record" only ever checks it once. */
  const autoRan = useRef(false);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [root, setRoot] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /*
   * A wallet in the link fills the form and runs the check.
   *
   * Every profile page links here as "Check this record yourself" with the
   * trader in the query string, and nothing read it, so the one path built for
   * a sceptic dropped them on an empty form and asked them to copy the address
   * back out of the page they had just left.
   *
   * Read from `window.location` rather than `useSearchParams`, which would make
   * this page dynamic and require a Suspense boundary for a value that only
   * matters in the browser.
   */
  useEffect(() => {
    if (autoRan.current) return;
    const params = new URLSearchParams(window.location.search);
    const linked = params.get('trader');
    if (!linked) return;

    autoRan.current = true;
    setTrader(linked);
    void run(linked);
    // Once, on arrival. Re-running on every keystroke is the opposite of what a
    // prefilled link should do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run(overrideTrader?: string): Promise<void> {
    setBusy(true);
    setChecks(null);
    setRoot(null);
    setNote(null);

    try {
      // The override matters: when a link triggers this, the state set a line
      // earlier has not been committed yet, so reading `trader` here would send
      // an empty address.
      const who = (overrideTrader ?? trader).trim();

      const response = await fetch(`/api/proof?trader=${encodeURIComponent(who)}`);
      const bundle = (await response.json()) as Bundle;

      if (!response.ok) {
        setNote(bundle.error ?? 'Could not load that record.');
        return;
      }
      if (!bundle.record || bundle.record.length === 0) {
        setNote('This wallet has no fills on record yet, so there is nothing to check.');
        return;
      }

      const results: Check[] = [];

      /*
       * 1. Every seal, recomputed.
       *
       * The whole point. Each fill is hashed again here from the inputs shown
       * with it, and compared to the seal stored beside it. A mismatch names
       * the trade rather than failing the page, because which one disagrees is
       * the only useful thing to know.
       */
      const rehashed = bundle.record.map((raw) => ({
        raw,
        hash: toHex(hashLeaf(toLeaf(raw))),
      }));
      const broken = rehashed.filter((entry) => entry.hash !== entry.raw.recordedHash);

      if (broken.length === 0) {
        results.push({
          label: 'Seals',
          passed: true,
          detail: `all ${rehashed.length} fills rehash to exactly the seal recorded with them`,
        });
      } else {
        for (const entry of broken) {
          results.push({
            label: `Fill ${entry.raw.sequence}`,
            passed: false,
            detail:
              `its inputs hash to ${entry.hash.slice(0, 16)}…, but ${entry.raw.recordedHash.slice(0, 16)}… ` +
              'was recorded. The stored trade has been changed since it was sealed.',
          });
        }
      }

      /*
       * 2. The root over the whole record.
       *
       * One hash standing for every fill in order. Two people holding the same
       * record get the same root, and a record with one field altered anywhere
       * inside it gets a different one, so it is the short string worth
       * comparing when somebody shares a result.
       */
      const hashes = rehashed.map((entry) => hashLeaf(toLeaf(entry.raw)));
      const tree = buildTree(hashes);
      setRoot(toHex(tree.root));

      /*
       * 3. Each fill proves it belongs to that root.
       *
       * Recomputing the root from a leaf and its proof is what makes the root
       * mean anything: without it the root is just a number the page printed.
       */
      const membershipOk = hashes.every(
        (hash, index) => toHex(computeRoot(hash, buildProof(tree, index))) === toHex(tree.root),
      );
      results.push({
        label: 'Membership',
        passed: membershipOk,
        detail: membershipOk
          ? 'every fill proves it belongs to the record, in the order it was made'
          : 'a fill does not belong to the record claiming it',
      });

      setChecks(results);
      setNote(
        broken.length === 0
          ? 'Checked in your browser. Nothing on this page was taken from us on trust.'
          : `${broken.length} of ${rehashed.length} fills do not match their seal.`,
      );
    } catch (error) {
      console.error('[verify] check failed', error);
      setNote('Something went wrong running the check. The console has the detail.');
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

      <button type="button" onClick={() => void run()} disabled={busy || trader.trim() === ''}>
        {busy ? 'Checking…' : 'Check'}
      </button>

      {note && <p role="status">{note}</p>}

      {checks && (
        <ol className="bare">
          {checks.map((check) => (
            <li key={check.label}>
              <strong className={check.passed ? 'gain' : 'loss'}>
                {check.passed ? 'pass' : 'fail'}
              </strong>
              , {check.label}: <span className="dim">{check.detail}</span>
            </li>
          ))}
        </ol>
      )}

      {root && (
        <>
          <p>
            <small>
              The record&apos;s root. Every fill, in order, folded into one hash. Two people
              checking the same record get this same string, and a record with one figure changed
              anywhere inside it does not.
            </small>
          </p>
          <pre>
            <code>{root}</code>
          </pre>
        </>
      )}
    </section>
  );
}
