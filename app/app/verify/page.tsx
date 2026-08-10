import { Verifier } from '@/components/verifier';

export const metadata = { title: 'Verify a record — Probatio' };

export default function VerifyPage() {
  return (
    <main className="prose">
      <h1>Check a record</h1>
      <p>
        This page does not ask us whether a record is valid. It rebuilds every trade from its
        own recorded inputs, recomputes the hashes, and compares the result against what is on
        the Solana chain — in your browser, against an RPC endpoint you choose.
      </p>
      <p>
        If our server were lying, this page would say so. That is the only reason it exists.
      </p>
      <Verifier />
    </main>
  );
}
