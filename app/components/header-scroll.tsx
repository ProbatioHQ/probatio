'use client';

import { useEffect } from 'react';

/**
 * Solidifies the header once you leave the top of the page.
 *
 * At rest it is transparent so the hero glow runs behind it and the page reads
 * as one surface. A permanently solid strip cut the hero off from its own
 * light, which is what made the top of the site look like a document header.
 */
export function HeaderScroll() {
  useEffect(() => {
    const header = document.querySelector('.site-header');
    if (!header) return;

    const update = (): void => {
      header.classList.toggle('stuck', window.scrollY > 24);
    };

    update();
    window.addEventListener('scroll', update, { passive: true });
    return () => window.removeEventListener('scroll', update);
  }, []);

  return null;
}
