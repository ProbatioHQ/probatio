import { Verifier } from '@/components/verifier';

export const metadata = { title: 'Verify a record, Probatio' };

export default function VerifyPage() {
  return (
    <main className="prose page-prose">
      <h1>Check a record</h1>
      <p>
        Every fill is sealed with a hash the moment it lands, computed over the exact figures it
        was priced from. This page asks for those figures, recomputes every hash in your browser,
        and compares. Nothing here is us telling you the answer.
      </p>
      <p>
        If a single number in a stored trade had been changed afterwards, its hash would no
        longer match the seal recorded beside it, and this page would name the trade. That is the
        only reason it exists.
      </p>
      <Verifier />
    </main>
  );
}
