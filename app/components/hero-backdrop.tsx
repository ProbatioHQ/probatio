'use client';

import { useEffect, useRef } from 'react';

/**
 * The ground behind the hero.
 *
 * This used to be a landscape built out of price: ranges of it receding into
 * haze with a row of candlesticks along the front. It was a vista, and a vista
 * belongs to a different product. Nothing else on this site looks like that —
 * the pages are terminals, the gutters run hex, the type is monospace, and the
 * one colour is the green a gain is marked in. A painted mountain range under
 * all of that reads as decoration bought in from somewhere else, and when its
 * palette turned over to the red mood it read as a warning.
 *
 * So it is the thing the site already is, at the scale of a whole screen: a
 * faint grid, digests drifting down it, and a single soft light behind the
 * mark. No second colour, no shapes to interpret, nothing moving fast enough to
 * pull the eye off the headline.
 *
 * Every digest is random and unlabelled, like the rest of the ambient layer.
 */

/** Spacing of the grid, and how far a column falls per second. */
const GRID = 68;
const FALL = 14;
const GLYPHS = '0123456789abcdef';

interface Column {
  /** Where it sits across the screen, and how far down it has fallen. */
  x: number;
  y: number;
  speed: number;
  /** The digest it is spelling, top to bottom. */
  glyphs: string[];
  alpha: number;
}

/** Deterministic, so the same screen is the same every time it is drawn. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

export function HeroBackdrop() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;

    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let width = 0;
    let height = 0;
    let animation = 0;
    let start = 0;
    let columns: Column[] = [];

    // The grid is identical every frame, so it is drawn once and blitted.
    const grid = document.createElement('canvas');
    const gridContext = grid.getContext('2d');

    const paintGrid = (): void => {
      const ctx = gridContext;
      if (!ctx) return;
      ctx.clearRect(0, 0, width, height);
      ctx.strokeStyle = 'rgba(63, 224, 138, 0.045)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = GRID / 2; x < width; x += GRID) {
        ctx.moveTo(Math.round(x) + 0.5, 0);
        ctx.lineTo(Math.round(x) + 0.5, height);
      }
      for (let y = GRID / 2; y < height; y += GRID) {
        ctx.moveTo(0, Math.round(y) + 0.5);
        ctx.lineTo(width, Math.round(y) + 0.5);
      }
      ctx.stroke();
    };

    const seedColumns = (): void => {
      const random = seeded(0x7c31);
      const count = Math.round(Math.min(30, Math.max(8, width / 110)));
      columns = Array.from({ length: count }, () => {
        const length = 6 + Math.floor(random() * 12);
        return {
          x: Math.round(random() * (width / GRID)) * GRID + GRID / 2,
          y: random() * height,
          speed: FALL * (0.45 + random() * 1.1),
          glyphs: Array.from(
            { length },
            () => GLYPHS[Math.floor(random() * GLYPHS.length)] ?? '0',
          ),
          alpha: 0.12 + random() * 0.3,
        };
      });
    };

    const resize = (): void => {
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      width = canvas.offsetWidth;
      height = canvas.offsetHeight;
      canvas.width = Math.max(1, Math.floor(width * ratio));
      canvas.height = Math.max(1, Math.floor(height * ratio));
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      grid.width = canvas.width;
      grid.height = canvas.height;
      gridContext?.setTransform(ratio, 0, 0, ratio, 0, 0);
      paintGrid();
      seedColumns();
    };

    const render = (elapsed: number): void => {
      const seconds = elapsed / 1000;
      context.clearRect(0, 0, width, height);

      // The light behind the mark, which is the only bright thing here.
      const glow = context.createRadialGradient(
        width * 0.5,
        height * 0.34,
        0,
        width * 0.5,
        height * 0.34,
        Math.max(width, height) * 0.5,
      );
      glow.addColorStop(0, 'rgba(63, 224, 138, 0.1)');
      glow.addColorStop(0.45, 'rgba(63, 224, 138, 0.03)');
      glow.addColorStop(1, 'rgba(63, 224, 138, 0)');
      context.fillStyle = glow;
      context.fillRect(0, 0, width, height);

      context.drawImage(grid, 0, 0, width, height);

      // Digests, falling. The head of each is brightest and the tail fades, so
      // a column reads as moving rather than as a static string of characters.
      context.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
      context.textBaseline = 'top';
      const span = height + 260;
      for (const column of columns) {
        const head = ((column.y + seconds * column.speed) % span) - 130;
        for (let i = 0; i < column.glyphs.length; i += 1) {
          const y = head - i * 16;
          if (y < -20 || y > height) continue;
          const fade = 1 - i / column.glyphs.length;
          context.fillStyle = `rgba(63, 224, 138, ${(column.alpha * fade * 0.85).toFixed(3)})`;
          context.fillText(column.glyphs[i]!, column.x, y);
        }
      }
    };

    const loop = (now: number): void => {
      if (!start) start = now;
      render(now - start);
      animation = requestAnimationFrame(loop);
    };

    resize();
    if (still) {
      render(0);
    } else {
      animation = requestAnimationFrame(loop);
    }

    const onResize = (): void => {
      resize();
      if (still) render(0);
    };
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(animation);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  return <canvas ref={ref} className="scene-canvas" aria-hidden="true" />;
}
