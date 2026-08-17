'use client';

import { useEffect, useRef } from 'react';
import { HeroBackdrop } from '@/components/hero-backdrop';
import { SignIn } from '@/components/wallet';

/**
 * The front page, as one screen.
 *
 * Two things carry it beyond a headline on a background. The first is the
 * entrance: the mark settles, then each line of the headline is uncovered from
 * behind its own edge rather than faded in, then the rest arrives under it. A
 * fade says a page loaded; an uncovering says something was revealed.
 *
 * The second is depth. The pointer moves the layers by different amounts, so
 * the mark, the headline and the grid behind them sit at three distances
 * rather than flat against the glass. It is a few pixels at most, which is the
 * point: parallax that can be noticed is parallax that has been overdone.
 *
 * Both are motion for its own sake to anybody who has asked for less of it, so
 * both stop entirely under `prefers-reduced-motion`.
 */
export function Hero() {
  const root = useRef<HTMLElement>(null);

  useEffect(() => {
    const node = root.current;
    if (!node) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    // A coarse pointer has no hover position to track, and reading one from
    // touches would jump the layers on every tap.
    if (!window.matchMedia('(pointer: fine)').matches) return;

    let frame = 0;
    let targetX = 0;
    let targetY = 0;
    let currentX = 0;
    let currentY = 0;

    const settle = (): void => {
      // Eased toward the pointer rather than pinned to it, so the layers glide
      // and keep gliding for a moment after the pointer stops.
      currentX += (targetX - currentX) * 0.08;
      currentY += (targetY - currentY) * 0.08;
      node.style.setProperty('--px', currentX.toFixed(4));
      node.style.setProperty('--py', currentY.toFixed(4));
      if (Math.abs(targetX - currentX) > 0.0005 || Math.abs(targetY - currentY) > 0.0005) {
        frame = requestAnimationFrame(settle);
      } else {
        frame = 0;
      }
    };

    const onMove = (event: PointerEvent): void => {
      const box = node.getBoundingClientRect();
      targetX = (event.clientX - box.left) / box.width - 0.5;
      targetY = (event.clientY - box.top) / box.height - 0.5;
      if (!frame) frame = requestAnimationFrame(settle);
    };

    const onLeave = (): void => {
      targetX = 0;
      targetY = 0;
      if (!frame) frame = requestAnimationFrame(settle);
    };

    node.addEventListener('pointermove', onMove);
    node.addEventListener('pointerleave', onLeave);
    return () => {
      node.removeEventListener('pointermove', onMove);
      node.removeEventListener('pointerleave', onLeave);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <section className="hero hero-cinema" ref={root}>
      <HeroBackdrop />
      <div className="hero-inner">
        <span className="hero-mark" aria-hidden="true">
          <span className="hero-mark-float">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/probatio-logo.png" alt="" width={112} height={112} />
          </span>
        </span>

        {/* Each line is uncovered from behind its own edge, so the two arrive
            one after the other instead of the block fading in together. */}
        <h1 className="display">
          <span className="reveal">
            <span>Trade fake money</span>
          </span>
          <span className="reveal">
            <span>on real tokens.</span>
          </span>
        </h1>

        <p className="hero-tagline" aria-hidden="true">
          <span>Real prices</span>
          <span>Honest fills</span>
          <span>Provable record</span>
        </p>

        <p className="lede">
          Practice money, live prices, and fills that model real slippage and real delay. Every
          trade is hashed as it fills and committed to Solana, so a record can be checked by
          anyone and edited by nobody, <a href="/trust">including what that does not cover yet</a>.
        </p>

        <div className="cta-row">
          <SignIn />
          <a href="/feed" className="ghost-link">
            Browse the terminal
          </a>
        </div>
      </div>
    </section>
  );
}
