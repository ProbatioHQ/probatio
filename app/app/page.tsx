import { Hero } from '@/components/hero';

/**
 * Re-rendered on a short window rather than pinned for a year.
 *
 * As a fully static route this was prerendered at build time and served with a
 * year of edge caching, and the cache is keyed on the address rather than the
 * build. So a deploy shipped a new front page that nobody was given: the edge
 * went on answering with the copy it already had, and every change to this page
 * looked like it had failed to deploy. The page holds no data and costs nothing
 * to rebuild, so it is worth far more kept current than kept cached.
 */
export const revalidate = 30;

/**
 * The front page.
 *
 * One screen, and nothing under it. Everything this page used to stack up
 * vertically already has a home of its own in the header: the terminal, the
 * season, the store, the roadmap, and how it works. Repeating all of it here
 * turned the front page into a table of contents nobody scrolled, and buried
 * the one thing it is for, which is saying what this is and offering the way
 * in.
 */
export default function Home() {
  return (
    <main className="wide home">
      <Hero />
    </main>
  );
}
