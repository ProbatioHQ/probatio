'use client';

import { useEffect } from 'react';

/**
 * The page for when something throws.
 *
 * There was none, so an unhandled error anywhere in the tree fell through to
 * the framework's default, which in production is a bare "Application error"
 * on a blank page. That is the worst possible moment to lose the header, the
 * status banner and the way back.
 *
 * Deliberately does not print the error. A stack trace is of no use to a trader
 * and of some use to an attacker; the digest is enough to find it in the logs.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Logged rather than swallowed, so a crash is visible to whoever runs this
    // rather than only to the person who hit it.
    console.error('[app] unhandled error', error);
  }, [error]);

  return (
    <main>
      <section className="term">
        <div className="term-bar">
          <span className="prompt">~/error</span>
          <span>something broke</span>
          <span className="lights">
            <i />
            <i />
            <i />
          </span>
        </div>
        <div className="term-body">
          <h1>That did not work</h1>
          <p className="dim" style={{ maxWidth: '56ch' }}>
            Something failed while building this page. Nothing you were doing was saved, and no
            trade was placed. Writes here either complete or roll back, never half.
          </p>
          <div className="cta-row">
            <button type="button" className="button-link" onClick={reset}>
              Try again
            </button>
      {/* A plain anchor rather than next/link, matching every other internal
          link here: PageTransition intercepts these clicks and routes them
          itself so the page can fade, and next/link would navigate on its own
          and race it. */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/" className="ghost-link">
              Back to the front page
            </a>
          </div>
          {error.digest && (
            <p>
              <small className="mono">reference {error.digest}</small>
            </p>
          )}
        </div>
      </section>
    </main>
  );
}
