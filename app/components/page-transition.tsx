'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Fading between pages instead of cutting.
 *
 * A hard cut between two dark pages reads as a flicker, and a flicker reads as
 * a page that broke. Holding the old view for a fifth of a second while it
 * leaves, then bringing the new one in, is the difference between a site and a
 * stack of documents.
 *
 * Internal links are intercepted rather than animated after the fact, because
 * by the time the route has changed the old page is already gone and there is
 * nothing left to fade.
 */

/** Long enough to read as a fade, short enough that a click still feels instant. */
const EXIT_MS = 130;

export function PageTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  /*
   * Whether a page this component sent away is still on its way out.
   *
   * Set on the click and cleared only when the path has actually changed, which
   * is the whole of what went wrong before. Clearing it alongside the call to
   * navigate returned the outgoing page to full opacity while the new route was
   * still being fetched, so a click read as the page you were on, blank, the
   * page you were on again, and then the one you asked for. It is never set by
   * the back button, so returning to a page cannot leave it faded out either,
   * which is the other way this has been broken.
   */
  const [exiting, setExiting] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setExiting((current) => (current ? false : current));
  }, [pathname]);


  const onClick = useCallback(
    (event: MouseEvent) => {
      // Never swallow a modifier click: a reader opening in a new tab expects
      // a new tab, not a fade.
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const anchor = (event.target as HTMLElement | null)?.closest('a');
      if (!anchor) return;

      const href = anchor.getAttribute('href');
      if (!href || !href.startsWith('/')) return;
      if (anchor.target && anchor.target !== '_self') return;
      if (href === pathname) return;

      event.preventDefault();

      /*
       * Moving inside one section is not an arrival, so it does not get an
       * arrival's fade.
       *
       * Stepping through the documentation pages meant watching the article
       * fade out, the route change, and the whole thing fade back in, which on
       * pages that share their layout and their heading reads as a flicker
       * rather than a transition — the only part that actually changed was the
       * body. Same first segment, so straight there.
       */
      const section = (path: string): string => path.split('/')[1] ?? '';
      if (section(href) === section(pathname)) {
        router.push(href);
        return;
      }

      /*
       * Out, then across. The page holds for a moment on its way to nothing,
       * the route changes underneath it, and what arrives comes up from
       * nothing in its place.
       */
      setExiting(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => router.push(href), EXIT_MS);
    },
    [pathname, router],
  );

  useEffect(() => {
    document.addEventListener('click', onClick);
    return () => {
      document.removeEventListener('click', onClick);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [onClick]);

  // The outer wrapper mounts once, on arrival, and runs the slow settling fade.
  // The inner element is keyed by path, so it remounts on every navigation and
  // runs the quick one — a click lands almost at once, the site still fades in.
  return (
    <div className="page-root">
      <div key={pathname} className={exiting ? 'page leaving' : 'page'}>
        {children}
      </div>
    </div>
  );
}
