'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { WalletButton } from '@/components/wallet';

/**
 * The site's own links, laid out for the width there is.
 *
 * Five of them sat in a row at every size. On a phone that row is most of the
 * header, so it wrapped onto a second line and pushed everything down, and what
 * it pushed down was the balance, which is the one thing in the header somebody
 * is checking. Wide enough, they stay in a row; narrower, they fold behind a
 * button and take no width at all until asked for.
 *
 * The narrow layout is Axon's, matched deliberately: a 36px bordered button
 * with three hairline bars, and a drawer that drops the full width of the
 * screen under the header behind a scrim, rather than a menu hanging off the
 * top right corner. Two sites by the same person should not have two different
 * answers to the same question, and Axon's answer is the better one: full width
 * gives every row a thumb's worth of target, and a scrim makes it obvious that
 * the page behind is waiting rather than gone.
 */

/**
 * `narrow` is what the phone calls it, where the two differ.
 *
 * One page, two names. "Explore" is what a desk audience calls a board of
 * what is worth a look; "Movers" is the word every mobile client uses for the
 * same screen. Neither is a translation of the other, they are the words each
 * audience already has, so the label follows the width rather than picking one
 * and hoping.
 */
const LINKS: readonly { href: string; label: string; narrow?: string }[] = [
  { href: '/explore', label: 'Explore', narrow: 'Movers' },
  { href: '/feed', label: 'Terminal' },
  { href: '/watching', label: 'Watching' },
  { href: '/traders', label: 'Traders' },
  { href: '/season', label: 'Season' },
  { href: '/duels', label: 'Duels' },
  { href: '/store', label: 'Store' },
  { href: '/telegram', label: 'Telegram' },
  { href: '/roadmap', label: 'Roadmap' },
  { href: '/docs', label: 'How it works' },
];

export function SiteNav() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const box = useRef<HTMLDivElement>(null);

  // Arriving somewhere closes it. Without this the panel is still standing over
  // the page it just navigated to.
  useEffect(() => {
    setOpen((was) => (was ? false : was));
  }, [pathname]);

  /*
   * The page behind does not scroll while the drawer is over it.
   *
   * A full-width drawer covers most of the screen, so a thumb that misses a
   * row lands on the page underneath and scrolls it, and closing the menu
   * leaves you somewhere you did not choose to be. Axon locks the body for the
   * same reason.
   */
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const isHere = useCallback(
    (href: string): boolean => pathname === href || pathname.startsWith(`${href}/`),
    [pathname],
  );

  return (
    <div className="site-nav-wrap" ref={box}>
      {/* The row, at widths that have room for it. */}
      <nav className="site-nav" aria-label="Main">
        {LINKS.map((link) => (
          <a key={link.href} href={link.href} aria-current={isHere(link.href) ? 'page' : undefined}>
            {link.label}
          </a>
        ))}
      </nav>

      {/* The button, at widths that do not. Drawn in CSS rather than as a
          glyph, so it takes the header's own colour and cannot fail to load. */}
      <button
        type="button"
        className={open ? 'nav-toggle open' : 'nav-toggle'}
        aria-expanded={open}
        aria-label={open ? 'Close menu' : 'Open menu'}
        onClick={() => setOpen((was) => !was)}
      >
        <span className="nav-bars" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      </button>

      {open && (
        // Tapping anywhere off the drawer closes it, which is what the scrim is
        // for. It replaces the document-level mousedown listener this used to
        // carry: a listener that never fired on a phone, because a tap is a
        // pointer event and mousedown only follows one if nothing calls
        // preventDefault first.
        <div className="nav-scrim" onClick={() => setOpen(false)} role="presentation">
          <div className="nav-drawer" onClick={(event) => event.stopPropagation()}>
            {LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                aria-current={isHere(link.href) ? 'page' : undefined}
                className={isHere(link.href) ? 'here' : undefined}
              >
                {link.narrow ?? link.label}
                {/* A dot rather than a colour change alone, so where you are
                    survives being read by somebody who cannot separate the two
                    greens. */}
                {isHere(link.href) && <span className="dot" aria-hidden="true" />}
              </a>
            ))}

            {/*
              Verify and Trust are not in here any more.
              
              They were put in the drawer because a phone reaches the footer
              only after the whole page. They are still in the footer, still one
              tap from the bottom of any page, and having them in a menu of six
              destinations made the two arguments against the product compete
              with the six places somebody actually wants to go.
            */}

            {/*
              The action and the two outside links, on one row at the foot.

              Axon's shape: the thing you came to do takes the width it needs
              and the links that leave the site are square icon buttons beside
              it. Connecting is the only thing worth doing on a page you are not
              signed in to, so it gets the room; GitHub and X are marks, because
              set as words they read as two more destinations in a list of
              destinations when they are the only two that leave.
            */}
            <div className="nav-drawer-foot">
              <div className="nav-drawer-wallet">
                <WalletButton />
              </div>
              <a
                className="nav-icon-button"
                href="https://github.com/ProbatioHQ/probatio"
                target="_blank"
                rel="noreferrer noopener"
                aria-label="Probatio on GitHub"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
                  <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2Z" />
                </svg>
              </a>
              <a
                className="nav-icon-button"
                href="https://x.com/ProbatioTrade"
                target="_blank"
                rel="noreferrer noopener"
                aria-label="Probatio on X"
              >
                <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77z" />
                </svg>
              </a>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
