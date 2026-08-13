'use client';

import { usePathname } from 'next/navigation';

/**
 * Which page you are on, and where else you can go.
 *
 * The written pages had a row of identical links and an empty right half. A
 * reader could not tell where they were, and the page looked like a draft
 * rather than documentation.
 */

const PAGES = [
  { href: '/docs', label: 'Overview', blurb: 'What to read and why' },
  { href: '/docs/fills', label: 'Fills', blurb: 'Slippage, delay, and the measured error' },
  { href: '/docs/records', label: 'Records', blurb: 'How a trade becomes unrevisable' },
  { href: '/docs/scoring', label: 'Scoring', blurb: 'How a season is won' },
  { href: '/docs/sdk', label: 'SDK', blurb: 'Verify a record in a few lines' },
];

export function DocsNav() {
  const pathname = usePathname();

  return (
    <nav className="docs-nav" aria-label="Documentation">
      <span className="eyebrow">How it works</span>
      <ul className="bare">
        {PAGES.map((page) => {
          const active = pathname === page.href;
          return (
            <li key={page.href}>
              <a href={page.href} aria-current={active ? 'page' : undefined}>
                <span className="label">{page.label}</span>
                <span className="blurb">{page.blurb}</span>
              </a>
            </li>
          );
        })}
      </ul>

      <div className="docs-nav-foot">
        <a href="/verify">Verify a record</a>
        <a href="/trust">What you have to trust</a>
      </div>
    </nav>
  );
}
