'use client';

import { useEffect, useRef } from 'react';

/**
 * The market as a landscape, behind the hero.
 *
 * A trading site's backdrop should be the thing it is about, so this is a
 * skyline built out of price: three ridgelines at different depths, drifting at
 * their own speeds, with candlesticks running along the front. It reads as a
 * vista and it is made entirely of the shape a market makes.
 *
 * It does not sit still. Four moods — an advance, a range, a flush, a recovery
 * — are held for a few seconds each and then morphed into, geometry and colour
 * together, so the scene is always somewhere between two markets rather than
 * cutting between them. That is a real interpolation of every point, not a
 * cross-fade of two pictures.
 *
 * Nothing here is real data and it never pretends to be. Like the rest of the
 * ambient layer, it is unlabelled, unreadable as a price, and generated from a
 * seeded walk, because decoration that could be mistaken for a number to act on
 * is the one thing this product refuses to draw.
 */

/** Points per ridgeline. One full cycle spans the canvas width, and wraps. */
const POINTS = 96;
/** How long a mood is held, and how long the morph into the next one takes. */
const HOLD_MS = 6_200;
const MORPH_MS = 4_200;

interface Mood {
  /** Ridge shapes, far to near, each normalised to 0..1. */
  readonly far: number[];
  readonly mid: number[];
  /** Candle bodies along the front, as [open, close] pairs in 0..1. */
  readonly candles: { open: number; close: number; high: number; low: number }[];
  /** The light this mood is lit by. */
  readonly sky: [number, number, number];
  readonly ridge: [number, number, number];
}

/** A small deterministic generator, so a mood is the same every time it comes round. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

/**
 * One ridgeline: a random walk, normalised, with its tail blended back into its
 * head so scrolling it forever never shows a seam.
 */
function ridgeline(random: () => number, drift: number, volatility: number): number[] {
  const raw: number[] = [];
  let value = 0.5;
  for (let i = 0; i < POINTS; i += 1) {
    value += drift + (random() - 0.5) * volatility;
    raw.push(value);
  }

  const low = Math.min(...raw);
  const high = Math.max(...raw);
  const span = high - low || 1;
  const norm = raw.map((v) => (v - low) / span);

  const blend = Math.floor(POINTS * 0.22);
  for (let i = 0; i < blend; i += 1) {
    const t = i / blend;
    const index = POINTS - blend + i;
    norm[index] = norm[index]! * (1 - t) + norm[i]! * t;
  }
  return norm;
}

function candlesFrom(random: () => number, drift: number, volatility: number) {
  const out: Mood['candles'] = [];
  let price = 0.5;
  for (let i = 0; i < POINTS; i += 1) {
    const open = price;
    let high = open;
    let low = open;
    for (let tick = 0; tick < 4; tick += 1) {
      price += drift + (random() - 0.5) * volatility;
      price = Math.min(0.95, Math.max(0.05, price));
      high = Math.max(high, price);
      low = Math.min(low, price);
    }
    out.push({ open, close: price, high, low });
  }
  // Wrap the last few back toward the first, so the scroll has no step in it.
  const blend = Math.floor(POINTS * 0.18);
  for (let i = 0; i < blend; i += 1) {
    const t = i / blend;
    const index = POINTS - blend + i;
    const a = out[index]!;
    const b = out[i]!;
    out[index] = {
      open: a.open * (1 - t) + b.open * t,
      close: a.close * (1 - t) + b.close * t,
      high: a.high * (1 - t) + b.high * t,
      low: a.low * (1 - t) + b.low * t,
    };
  }
  return out;
}

function mood(
  seed: number,
  drift: number,
  volatility: number,
  sky: [number, number, number],
  ridge: [number, number, number],
): Mood {
  const random = seeded(seed);
  return {
    far: ridgeline(random, drift * 0.35, volatility * 0.5),
    mid: ridgeline(random, drift * 0.7, volatility * 0.85),
    candles: candlesFrom(random, drift, volatility),
    sky,
    ridge,
  };
}

/*
 * The four moods, in the order they come round. The palette stays inside the
 * product's own: the green it marks a gain with, the red it marks a loss with,
 * and the steel everything else is drawn in.
 */
const MOODS: Mood[] = [
  mood(0x51a3, 0.014, 0.05, [16, 46, 34], [63, 224, 138]), // an advance
  mood(0x7f21, 0.0, 0.055, [22, 30, 38], [120, 150, 170]), // a range
  mood(0x2c9d, -0.014, 0.07, [48, 22, 24], [255, 95, 86]), // a flush
  mood(0x9e44, 0.011, 0.045, [18, 42, 44], [70, 200, 190]), // a recovery
];

const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
const rgb = (c: [number, number, number], alpha: number): string =>
  `rgba(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])}, ${alpha})`;

export function MarketScene() {
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

    const resize = (): void => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.offsetWidth;
      height = canvas.offsetHeight;
      canvas.width = Math.max(1, Math.floor(width * ratio));
      canvas.height = Math.max(1, Math.floor(height * ratio));
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    /** A ridge, drawn twice end to end so it can scroll without a seam. */
    const drawRidge = (
      from: number[],
      to: number[],
      t: number,
      baseY: number,
      amplitude: number,
      offset: number,
      colour: [number, number, number],
      fillAlpha: number,
      lineAlpha: number,
    ): void => {
      const dx = width / POINTS;
      const shift = offset % width;

      context.beginPath();
      context.moveTo(-shift, height);
      for (let pass = 0; pass < 2; pass += 1) {
        const originX = pass * width - shift;
        for (let i = 0; i <= POINTS; i += 1) {
          const index = i % POINTS;
          const value = mix(from[index]!, to[index]!, t);
          context.lineTo(originX + i * dx, baseY - value * amplitude);
        }
      }
      context.lineTo(width * 2 - shift, height);
      context.closePath();

      const gradient = context.createLinearGradient(0, baseY - amplitude, 0, height);
      gradient.addColorStop(0, rgb(colour, fillAlpha));
      gradient.addColorStop(1, rgb(colour, 0));
      context.fillStyle = gradient;
      context.fill();

      context.strokeStyle = rgb(colour, lineAlpha);
      context.lineWidth = 1;
      context.stroke();
    };

    const drawCandles = (
      from: Mood['candles'],
      to: Mood['candles'],
      t: number,
      baseY: number,
      amplitude: number,
      offset: number,
    ): void => {
      const dx = width / POINTS;
      const shift = offset % width;
      const bodyWidth = Math.max(3, dx * 0.42);

      for (let pass = 0; pass < 2; pass += 1) {
        const originX = pass * width - shift;
        for (let i = 0; i < POINTS; i += 1) {
          const a = from[i]!;
          const b = to[i]!;
          const open = mix(a.open, b.open, t);
          const close = mix(a.close, b.close, t);
          const high = mix(a.high, b.high, t);
          const low = mix(a.low, b.low, t);

          const x = originX + i * dx;
          if (x < -dx || x > width + dx) continue;

          const y = (v: number): number => baseY - v * amplitude;
          const rising = close >= open;
          const colour = rising ? '63, 224, 138' : '255, 95, 86';

          // Nearer candles read brighter, which is what gives the front layer
          // its depth against the ridges behind it.
          context.globalAlpha = 1;
          context.strokeStyle = `rgba(${colour}, 0.42)`;
          context.lineWidth = 1;
          context.beginPath();
          context.moveTo(x + bodyWidth / 2, y(high));
          context.lineTo(x + bodyWidth / 2, y(low));
          context.stroke();

          context.fillStyle = `rgba(${colour}, 0.5)`;
          const top = y(Math.max(open, close));
          const bodyHeight = Math.max(1.5, Math.abs(y(open) - y(close)));
          context.fillRect(x, top, bodyWidth, bodyHeight);
        }
      }
      context.globalAlpha = 1;
    };

    const render = (elapsed: number): void => {
      const cycle = HOLD_MS + MORPH_MS;
      const index = Math.floor(elapsed / cycle) % MOODS.length;
      const next = (index + 1) % MOODS.length;
      const into = elapsed % cycle;
      // Eased, so a mood settles rather than sliding at a constant rate.
      const raw = Math.min(1, Math.max(0, (into - HOLD_MS) / MORPH_MS));
      const t = raw * raw * (3 - 2 * raw);

      const a = MOODS[index]!;
      const b = MOODS[next]!;
      const sky: [number, number, number] = [
        mix(a.sky[0], b.sky[0], t),
        mix(a.sky[1], b.sky[1], t),
        mix(a.sky[2], b.sky[2], t),
      ];
      const ridge: [number, number, number] = [
        mix(a.ridge[0], b.ridge[0], t),
        mix(a.ridge[1], b.ridge[1], t),
        mix(a.ridge[2], b.ridge[2], t),
      ];

      context.clearRect(0, 0, width, height);

      // The light of the mood, low and wide, like a sun behind the range.
      const glow = context.createRadialGradient(
        width * 0.5,
        height * 0.82,
        0,
        width * 0.5,
        height * 0.82,
        Math.max(width, height) * 0.75,
      );
      glow.addColorStop(0, rgb(sky, 0.5));
      glow.addColorStop(0.55, rgb(sky, 0.16));
      glow.addColorStop(1, rgb(sky, 0));
      context.fillStyle = glow;
      context.fillRect(0, 0, width, height);

      const seconds = elapsed / 1000;
      // Parallax: the far range barely moves, the front runs.
      drawRidge(a.far, b.far, t, height * 0.86, height * 0.34, seconds * 5, ridge, 0.1, 0.16);
      drawRidge(a.mid, b.mid, t, height * 0.95, height * 0.28, seconds * 13, ridge, 0.14, 0.22);
      drawCandles(a.candles, b.candles, t, height * 1.02, height * 0.24, seconds * 26);
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
