import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Archivo, Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import { AmbientTerminal } from '@/components/ambient-terminal';
import { HeaderScroll } from '@/components/header-scroll';
import { PageTransition } from '@/components/page-transition';
import { SiteNav } from '@/components/site-nav';
import { TokenStrip } from '@/components/token-strip';
import { StatusBanner } from '@/components/status-banner';
import { WalletButton, WalletProvider } from '@/components/wallet';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });
/*
 * The display face, for the few places something is meant to be seen from
 * across a room rather than read. Geist is a fine interface face and a weak
 * headline one: at poster size its letterforms are so even that a headline set
 * in it reads as a large paragraph. Archivo is drawn for exactly this, holds
 * its shape tight at 900, and is a grotesque rather than one of the display
 * faces every generated landing page reaches for.
 */
const archivo = Archivo({
  variable: '--font-display',
  subsets: ['latin'],
  weight: ['600', '700', '800', '900'],
});

export const metadata: Metadata = {
  /*
   * Without this, the card image URL resolves against localhost and every
   * shared link points at a machine nobody else can reach — which breaks the
   * only free distribution channel there is, and only once deployed.
   *
   * Read from the same value the sign-in message is bound to, so there is one
   * answer to "what is this site's address" rather than two that can disagree.
   */
  metadataBase: new URL(process.env['APP_URI'] ?? 'http://localhost:3000'),
  title: { default: 'Probatio', template: '%s' },
  description:
    'Trade live Solana markets with practice money. Honest fills, and a record kept honestly.',
};

/**
 * The shell every page sits in.
 *
 * The footer links to the two pages that argue against the product — what you
 * still have to trust, and how to check a record without asking us. They are
 * in the furniture rather than buried, because a site that only surfaces its
 * claims and hides its caveats is making a different argument than it thinks.
 */
export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} ${archivo.variable}`}>
      <body>
        <div className="grain" aria-hidden="true" />
        <div className="glow" aria-hidden="true" />
        <AmbientTerminal />
        <div className="scan" aria-hidden="true" />
        <div className="rails" aria-hidden="true" />
        <span className="rail-pulse left" aria-hidden="true" />
        <span className="rail-pulse right" aria-hidden="true" />
        {/* First thing in the tab order, and the only way past the header
            without walking every link in it. */}
        <a href="#content" className="skip-link">
          Skip to content
        </a>

        {/* Above the header and outside the wallet context, which it does not
            need: it states which token belongs to this site, which is true
            whether or not anybody is connected. */}
        <TokenStrip />

        <WalletProvider>
        <HeaderScroll />
        <header className="site-header">
          <div className="shell">
            {/* A plain anchor, not next/link, and the same goes for every
                internal link on the site. PageTransition intercepts these
                clicks and routes them itself so the page can fade out first;
                next/link would navigate on its own and the two would race. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/" className="wordmark" aria-label="Probatio home">
              <span className="mark" aria-hidden="true" />
            </a>
            {/* A row where there is width for one, a button where there is
                not. Verify and Trust stay out of the row, since repeating the
                footer crowds a header that is mostly for the app's own pages,
                but they are in the panel: on a phone the footer is the whole
                page away. */}
            <SiteNav />
            <div className="site-right">
              {/* External, so PageTransition leaves them alone and they open
                  where a social link is expected to. */}
              <a
                className="icon-link"
                href="https://github.com/ProbatioHQ/probatio"
                target="_blank"
                rel="noreferrer noopener"
                aria-label="Probatio on GitHub"
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
                  <path d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.29-.01-1.05-.02-2.06-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.2.08 1.84 1.24 1.84 1.24 1.07 1.83 2.81 1.3 3.5.99.11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.62-5.49 5.92.43.37.81 1.1.81 2.22 0 1.6-.01 2.9-.01 3.29 0 .32.22.7.83.58A12.01 12.01 0 0 0 24 12.5C24 5.87 18.63.5 12 .5z" />
                </svg>
              </a>
              <a
                className="icon-link"
                href="https://x.com/ProbatioTrade"
                target="_blank"
                rel="noreferrer noopener"
                aria-label="Probatio on X"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77z" />
                </svg>
              </a>
              {/* The wallet lives in the furniture, so signing in is reachable
                  from every page rather than only from the front one. */}
              <WalletButton />
            </div>
          </div>
        </header>

        <StatusBanner />

        <PageTransition>
          <div className="shell" id="content">
            {children}
          </div>
        </PageTransition>

        </WalletProvider>

        <footer className="site-footer">
          <div className="shell">
            {/* The tagline is the front page's job. In a phone footer it is a
                line of marketing between somebody and the four links they
                actually came down here for. */}
            <span className="footer-say">Practice money. Real prices. Records kept honestly.</span>
            <span>
              <a href="/docs">How it works</a> · <a href="/roadmap">Roadmap</a> ·{' '}
              <a href="/verify">Verify a record</a> · <a href="/trust">What you have to trust</a>
            </span>
          </div>
        </footer>
      </body>
    </html>
  );
}
