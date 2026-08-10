import { DocsNav } from '@/components/docs-nav';

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
    <div className="docs-shell">
      <DocsNav />
      <article className="prose docs-body">{children}</article>
    </div>
  );
}
