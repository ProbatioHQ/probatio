import { Hero } from '@/components/hero';

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
