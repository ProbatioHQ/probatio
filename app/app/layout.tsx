import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
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
        <header className="site-header">
          <div className="shell">
            <a href="/" className="wordmark">
              Probatio
            </a>
            <nav className="site-nav" aria-label="Main">
              <a href="/verify">Verify</a>
              <a href="/trust">Trust</a>
            </nav>
          </div>
        </header>

        <div className="shell">{children}</div>

        <footer className="site-footer">
          <div className="shell">
            <span>Practice money. Real prices. Records anyone can check.</span>
            <span>
              <a href="/verify">Verify a record</a> · <a href="/trust">What you have to trust</a>
            </span>
          </div>
        </footer>
      </body>
    </html>
  );
}
