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

const EXIT_MS = 190;

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
      setLeavingFrom(pathname);

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

  return (
    <div key={pathname} className={leaving ? 'page leaving' : 'page'}>
      {children}
    </div>
  );
}
