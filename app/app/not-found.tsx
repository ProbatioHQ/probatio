import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Not found, Probatio' };

/**
 * The page for an address that does not exist.
 *
 * There was none, so a mistyped URL — or a token page for a mint that was never
 * launched — got the framework's bare default: no header, no way back, and
 * nothing to say what happened. A dead end on a site whose whole argument is
 * that you can check things for yourself reads as a site that is broken.
 */
export default function NotFound() {
  return (
    <main>
      <section className="term">
        <div className="term-bar">
          <span className="prompt">~/404</span>
          <span>no such page</span>
          <span className="lights">
            <i />
            <i />
            <i />
          </span>
        </div>
        <div className="term-body">
          <h1>Nothing here</h1>
          <p className="dim" style={{ maxWidth: '54ch' }}>
            That address does not match a page on this site. If you followed a link to a token,
            the mint may never have launched on pump.fun. This only indexes tokens it watched
            being created.
          </p>
          <div className="cta-row">
            <a href="/feed" className="button-link">
              Open the terminal
            </a>
      {/* A plain anchor rather than next/link, matching every other internal
          link here: PageTransition intercepts these clicks and routes them
          itself so the page can fade, and next/link would navigate on its own
          and race it. */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/" className="ghost-link">
              Back to the front page
            </a>
          </div>
        </div>
      </section>
    </main>
  );
}
