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
            The outside links, in here at the width the icons came out of.
            
            They sat loose in the header beside the menu button, so a narrow
            header was a mark, a button, two icons and a wallet, which is four
            separate things competing in a strip meant to carry one. Written
            out, because an icon needs a tooltip to say what it is and a phone
            has no cursor to show one with.
          */}
          <span className="nav-panel-rule" aria-hidden="true" />
          <a href="https://github.com/ProbatioHQ/probatio" target="_blank" rel="noreferrer noopener">
            GitHub
          </a>
          <a href="https://x.com" target="_blank" rel="noreferrer noopener">
            X
          </a>
        </div>
      )}
    </div>
  );
}
