'use client';

import { useEffect, useRef } from 'react';

/**
 * The side gutters, running.
 *
 * The margins either side of the page were dead space, and a dark page with
 * nothing happening in the periphery is what made this read as a document. So
 * they carry the one thing this product is actually made of: hex, scrolling.
 *
 * Every trade here becomes a digest, and digests fold into a chain — so the
 * ambient layer is that, rendered small and dim in the gutters. It is not real
 * data and never claims to be, which is why it is unreadable at this size and
 * never given a label. The difference between decoration and a lie is whether
 * anybody could mistake it for a number they can act on.
 *
 * Canvas rather than a few hundred animated DOM nodes: this runs for as long as
 * the tab is open, and text nodes at this count would cost layout on every
 * frame.
 */

/**
 * Where the columns are allowed to run.
 *
 * Outside the rails, which are just outside the content: the page reads as
 * content, then a rule, then the stream. Anything narrower than this has no
 * gutter worth drawing in and the layer hides itself rather than crowding the
 * text.
 */
const RAIL_HALF = 556;
const GUTTER_PAD = 14;
const MIN_GUTTER = 58;
const MIN_VIEWPORT = (RAIL_HALF + GUTTER_PAD + MIN_GUTTER) * 2;

const FONT_SIZE = 11;
const LINE_HEIGHT = 17;
/** Pixels per second. Slow enough to read as drift rather than motion. */
const SPEED = 14;

const HEX = '0123456789abcdef';

function hexRun(length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    // Grouped in bytes, so it reads as a digest rather than noise.
    out += i > 0 && i % 2 === 0 ? ' ' : '';
    out += HEX[Math.floor(Math.random() * 16)];
  }
  return out;
}

interface Row {
  text: string;
  /** A row that just landed is brighter, and fades to the floor. */
  heat: number;
}

export function AmbientTerminal() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;

    const context = canvas.getContext('2d');
    if (!context) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');

    let width = 0;
    let height = 0;
    let gutter = 0;
    let perRow = 0;
    let left: Row[] = [];
    let right: Row[] = [];
    let offset = 0;
    let animation = 0;
    let last = 0;
    let running = false;

    const makeRow = (): Row => ({ text: hexRun(perRow), heat: 0 });

    const fill = (rows: Row[], count: number): Row[] => {
      const next = rows.slice(-count);
      while (next.length < count) next.unshift(makeRow());
      return next;
    };

    const measure = (): boolean => {
      width = window.innerWidth;
      height = window.innerHeight;
      gutter = Math.floor(width / 2 - RAIL_HALF - GUTTER_PAD * 2);
      return width >= MIN_VIEWPORT && gutter >= MIN_GUTTER;
    };

    const resize = (): void => {
      if (!measure()) {
        canvas.style.display = 'none';
        return;
      }
      canvas.style.display = '';

      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(width * ratio));
      canvas.height = Math.max(1, Math.floor(height * ratio));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      // A canvas font string is not CSS and will not resolve a custom property
      // — setting `var(--font-geist-mono)` here parses as invalid and silently
      // leaves the previous font in place, which is a sans-serif. Resolved off
      // the document instead, so this uses the same mono face as the page.
      const mono =
        getComputedStyle(document.documentElement)
          .getPropertyValue('--font-geist-mono')
          .trim() || 'ui-monospace';
      context.font = `${FONT_SIZE}px ${mono}, ui-monospace, monospace`;
      context.textBaseline = 'top';

      // How many characters fit, given the grouping spaces. Measured rather
      // than assumed: the mono face is loaded by the framework and its advance
      // width is not something to hard-code.
      const advance = context.measureText('0').width || 6.6;
      // A row is not `perRow` characters wide: the byte grouping adds a space
      // after every pair, so the rendered string is half again as long. Sizing
      // off the raw count spilled the columns out of the gutter and under the
      // text.
      const slots = Math.floor(gutter / advance);
      perRow = Math.max(8, Math.floor((slots * 2) / 3) - 2);
      // Even, so the grouping never ends on a half pair.
      perRow -= perRow % 2;

      const rows = Math.ceil(height / LINE_HEIGHT) + 2;
      left = fill(left, rows);
      right = fill(right, rows);
    };

    const draw = (): void => {
      context.clearRect(0, 0, width, height);

      const leftX = Math.floor(width / 2 - RAIL_HALF - GUTTER_PAD - gutter);
      const rightX = Math.floor(width / 2 + RAIL_HALF + GUTTER_PAD);

      const column = (rows: Row[], x: number): void => {
        rows.forEach((row, index) => {
          const y = index * LINE_HEIGHT - offset;
          if (y < -LINE_HEIGHT || y > height) return;

          // Dimmest at the top and bottom edges, so the columns dissolve into
          // the page rather than being cut off by it.
          const edge = Math.min(1, Math.min(y + LINE_HEIGHT, height - y) / 90);
          const alpha = (0.05 + row.heat * 0.5) * Math.max(0, edge);
          if (alpha <= 0.005) return;

          context.fillStyle = `rgba(63, 224, 138, ${alpha.toFixed(3)})`;
          context.fillText(row.text, x, y);
        });
      };

      column(left, leftX);
      column(right, rightX);
    };

    const frame = (now: number): void => {
      const elapsed = last === 0 ? 0 : Math.min(100, now - last);
      last = now;
      offset += (elapsed / 1000) * SPEED;

      while (offset >= LINE_HEIGHT) {
        offset -= LINE_HEIGHT;
        // One row off the top, one new one at the bottom. The new row lands
        // lit and cools, so the eye catches an arrival rather than a wall.
        left.shift();
        right.shift();
        const hot = (): Row => ({ text: hexRun(perRow), heat: Math.random() < 0.14 ? 1 : 0 });
        left.push(hot());
        right.push(hot());
      }

      for (const row of left) row.heat *= 0.965;
      for (const row of right) row.heat *= 0.965;

      draw();
      animation = requestAnimationFrame(frame);
    };

    const start = (): void => {
      if (running) return;
      running = true;
      last = 0;
      animation = requestAnimationFrame(frame);
    };

    const stop = (): void => {
      running = false;
      cancelAnimationFrame(animation);
    };

    // A canvas painting into a tab nobody is looking at is pure battery.
    const onVisibility = (): void => {
      if (document.hidden) stop();
      else if (!reduced.matches) start();
    };

    const onMotionChange = (): void => {
      if (reduced.matches) {
        stop();
        draw();
      } else start();
    };

    resize();
    draw();
    if (!reduced.matches) start();

    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', onVisibility);
    reduced.addEventListener('change', onMotionChange);

    return () => {
      stop();
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVisibility);
      reduced.removeEventListener('change', onMotionChange);
    };
  }, []);

  return <canvas ref={ref} className="ambient" aria-hidden="true" />;
}
