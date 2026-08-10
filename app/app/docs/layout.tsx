/**
 * The documentation shell.
 *
 * These pages are the argument for the product, not a reference for an API.
 * Anybody deciding whether a leaderboard is worth their time is deciding
 * whether the fills are honest and whether the record can be checked, and both
 * of those are explained here rather than asserted on the front page.
 */
export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="prose">
      <nav className="site-nav" aria-label="Documentation" style={{ marginBottom: 8 }}>
        <a href="/docs">Overview</a>
        <a href="/docs/fills">Fills</a>
        <a href="/docs/records">Records</a>
        <a href="/docs/scoring">Scoring</a>
      </nav>
      {children}
    </main>
  );
}
