export const metadata = { title: 'What you have to trust — Probatio' };

/**
 * The page that argues against the product.
 *
 * Every system like this has a list of things you still have to take on faith,
 * and most of them are written by the people asking for the faith. Putting it
 * on its own page, linked from the first sentence on the site, is the only
 * version of this worth publishing.
 */
export default function TrustPage() {
  return (
    <main>
      <h1>What you have to trust</h1>

      <p>
        The point of writing records to the chain is that you do not have to take our word for
        them. That is true of the records. It is not true of everything, and the gaps are here.
      </p>

      <h2>The program can still be replaced</h2>
      <p>
        The on-chain program treats records as append-only: nothing can rewrite a trade once it
        is committed, not the server, not the key that signs the commitments, not us. That is
        enforced by the code that is deployed.
      </p>
      <p>
        But a Solana program has an upgrade authority, and while one exists that key can replace
        the program with a different one — including a version that rewrites records the current
        version refuses to touch. So the honest claim is not that your record cannot be edited.
        It is that your record cannot be edited <strong>without replacing the program on chain,
        which is a public, permanent, timestamped act</strong> that anyone watching would see.
      </p>
      <p>
        Check the current state yourself rather than believing this page:
      </p>
      <pre>
        <code>npx tsx scripts/verify-deployment.mts</code>
      </pre>
      <p>
        It reports who holds the upgrade authority, or that it has been burned. Burned means the
        program can never be replaced by anybody, including us.
      </p>

      <h2>Why it has not been burned yet</h2>
      <p>
        Burning it is the strongest version of the promise, and it is permanent — no bug fix
        afterwards, ever. A review of the program found five issues, one of which meant entry
        fees would have been locked in the vault forever with no way to pay anybody. Burning a
        program with a bug like that in it would have made the bug permanent too.
      </p>
      <p>
        There is also a specific thing still missing. The published void policy promises every
        entrant a full refund if a season does not count, and the program has no instruction that
        can pay one. Burning the authority today would make that promise impossible to keep for
        good.
      </p>

      <h2>The commitment</h2>
      <p>
        The upgrade authority will be burned before any season takes money, and after the refund
        instruction exists. If those cannot both be true, the season runs free rather than
        ranked.
      </p>
      <p>
        That ordering is checkable. The burn is visible on chain, the refund instruction is
        visible in the program, and the season taking money is visible from its entry cost.
      </p>

      <h2>The rest of the list</h2>
      <ul>
        <li>
          The key that signs commitments is a hot key on a server. It cannot rewrite anything or
          move money, but a stolen copy could append records for trades that never happened. That
          is detectable — every commitment is compared against what we predicted — and it is not
          repairable, so a season it happened in would be void.
        </li>
        <li>
          Prices come from the chain, but reading them is done by us. The fills are reproducible
          from the pool reserves recorded with every trade, so a wrong fill can be caught after
          the fact rather than prevented in advance.
        </li>
        <li>
          The program has been reviewed by the person who wrote it and by nobody else. No outside
          audit, no fuzzing, no formal analysis.
        </li>
        <li>
          Display names are moderated by us. They are never committed to the chain and removing
          one changes no record, which is why moderating them is safe.
        </li>
      </ul>

      <p>
        <a href="/verify">Check a record yourself</a>
      </p>
    </main>
  );
}
