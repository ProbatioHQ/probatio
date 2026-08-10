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
  const [leaving, setLeaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A new path means the new page has arrived, so stop leaving.
  useEffect(() => {
    setLeaving(false);
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
      setLeaving(true);

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
