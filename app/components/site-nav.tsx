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
 * The panel is a plain disclosure rather than a dialog: the page behind it is
 * not inert, nothing is trapped, and the links inside are the same anchors the
 * row uses, so the page transition handles them exactly as it does anywhere.
 */

const LINKS: readonly { href: string; label: string }[] = [
  { href: '/feed', label: 'Terminal' },
  { href: '/season', label: 'Season' },
  { href: '/store', label: 'Store' },
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

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
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
        <div className="nav-panel">
          {/*
            The wallet, at the top, where there is no room for it beside the
            button.

            It sat loose in the header next to the menu, so a phone header was
            a mark, a menu button and a wallet all competing in one strip. In
            here it is the first thing the menu offers, which is right: on a
            page you are not signed in to, connecting is the only thing worth
            doing. It also brings the account switcher somewhere a thumb can
            reach it, instead of inside a dropdown hanging off a 100px pill.

            Only mounts when the panel is open, so the header pays nothing for
            it until somebody asks.
          */}
          <div className="nav-panel-wallet">
            <WalletButton />
          </div>
          <span className="nav-panel-rule" aria-hidden="true" />

          {LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              aria-current={isHere(link.href) ? 'page' : undefined}
              className={isHere(link.href) ? 'here' : undefined}
            >
              {link.label}
            </a>
          ))}
          <span className="nav-panel-rule" aria-hidden="true" />
          {/* The two the footer carries, which a phone reaches only after the
              whole page, and which are the ones arguing against the product. */}
          <a href="/verify">Verify a record</a>
          <a href="/trust">What you have to trust</a>

          {/*
            The outside links, as their own marks again.

            They were written out as words on the grounds that an icon needs a
            tooltip and a phone has no cursor to show one. Wrong twice: these
            two marks are about as widely known as marks get, and set as plain
            text they read as two more destinations in a list of destinations
            when they are the only two that leave the site. Side by side in a
            row at the foot of the panel, they are visibly a different kind of
            thing, and each still carries its name for a screen reader.
          */}
          <span className="nav-panel-rule" aria-hidden="true" />
          <div className="nav-panel-social">
            <a
              href="https://github.com/ProbatioHQ/probatio"
              target="_blank"
              rel="noreferrer noopener"
              aria-label="Probatio on GitHub"
            >
              <svg viewBox="0 0 24 24" width="19" height="19" fill="currentColor" aria-hidden="true">
                <path d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.29-.01-1.05-.02-2.06-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.2.08 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.5.99.11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.62-5.49 5.92.43.37.81 1.1.81 2.22 0 1.6-.01 2.9-.01 3.29 0 .32.22.7.83.58A12.01 12.01 0 0 0 24 12.5C24 5.87 18.63.5 12 .5z" />
              </svg>
              <span>GitHub</span>
            </a>
            <a
              href="https://x.com"
              target="_blank"
              rel="noreferrer noopener"
              aria-label="Probatio on X"
            >
              <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77z" />
              </svg>
              <span>X</span>
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
