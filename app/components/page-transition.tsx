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

const EXIT_MS = 110;

export function PageTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  /*
   * Which page is on its way out, rather than a boolean saying one is.
   *
   * The flag used to be reset by an effect watching the path, which meant every
   * navigation rendered twice: once with the new route still marked as leaving,
   * then again after the effect cleared it. Derived from the path instead, it
   * is simply false the moment the path changes — no effect, no second render,
   * and no window in which the arriving page is styled as though it were
   * departing.
   */
  const [leavingFrom, setLeavingFrom] = useState<string | null>(null);
  const leaving = leavingFrom !== null && leavingFrom === pathname;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

      setLeavingFrom(pathname);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        router.push(href);
        // Cleared as the navigation goes out, not left set.
        //
        // It used to stay behind, and because "is this page leaving" is derived
        // by comparing it to the current path, coming back to a page that had
        // once been left made that comparison true all over again: the arriving
        // page rendered mid-exit, at zero opacity, and stayed blank until the
        // whole site was reloaded. Which is what the browser's back button does
        // every time.
        setLeavingFrom(null);
      }, EXIT_MS);
    },
    [pathname, router],
  );

  /*
   * Belt and braces for arrivals this component never initiated: the back and
   * forward buttons, and anything that routes without going through the click
   * handler. Written through the updater so an already-null value re-renders
   * nothing.
   */
  useEffect(() => {
    setLeavingFrom((current) => (current === null ? current : null));
  }, [pathname]);

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
      <div key={pathname} className={leaving ? 'page leaving' : 'page'}>
        {children}
      </div>
    </div>
  );
}
