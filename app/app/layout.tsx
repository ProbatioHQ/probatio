import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import { AmbientTerminal } from '@/components/ambient-terminal';
import { HeaderScroll } from '@/components/header-scroll';
import { PageTransition } from '@/components/page-transition';
import { StatusBanner } from '@/components/status-banner';
import { WalletButton, WalletProvider } from '@/components/wallet';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

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
    'Trade live Solana markets with practice money. Honest fills, and a record anyone can check.',
};

/**
 * The shell every page sits in.
 *
 * The footer links to the two pages that argue against the product — what you
 * still have to trust, and how to check a record without asking us. They are
 * in the furniture rather than buried, because a site that only surfaces its
 * claims and hides its caveats is making a different argument than it thinks.
 */
export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
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

        <WalletProvider>
        <HeaderScroll />
        <header className="site-header">
          <div className="shell">
            {/* A plain anchor, not next/link, and the same goes for every
                internal link on the site. PageTransition intercepts these
                clicks and routes them itself so the page can fade out first;
                next/link would navigate on its own and the two would race. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/" className="wordmark">
              <span className="mark" aria-hidden="true" />
              Probatio
            </a>
            <nav className="site-nav" aria-label="Main">
              <a href="/feed">Terminal</a>
              <a href="/season">Season</a>
              <a href="/store">Store</a>
              <a href="/docs">How it works</a>
              <a href="/verify">Verify</a>
              <a href="/trust">Trust</a>
            </nav>
            {/* The wallet lives in the furniture, so signing in is reachable
                from every page rather than only from the front one. */}
            <WalletButton />
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
            <span>Practice money. Real prices. Records anyone can check.</span>
            <span>
              <a href="/docs">How it works</a> · <a href="/verify">Verify a record</a> ·{' '}
              <a href="/trust">What you have to trust</a>
            </span>
          </div>
        </footer>
      </body>
    </html>
  );
}
