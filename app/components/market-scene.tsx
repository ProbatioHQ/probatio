'use client';

import { useEffect, useRef } from 'react';

/**
 * The market as a landscape, behind the hero.
 *
 * A trading site's backdrop should be the thing it is about, so this is a vista
 * built entirely out of price: four ranges of it receding into haze, and a
 * skyline of candlesticks standing along the front.
 *
 * What makes a range read as distance is not drawing it smaller, it is
 * atmospheric perspective: the far ones sit pale and low-contrast because there
 * is air in the way, the near ones fall to almost black, and each one catches a
 * line of light along its top edge. Drawn as flat translucent shapes of the
 * same tone they read as overlapping smears, which is what this used to be.
 *
 * It does not sit still. Four moods (an advance, a range, a flush, a recovery)
 * are held and then morphed into, geometry and light together, so the scene is
 * always somewhere between two markets rather than cutting between them. Every
 * point is interpolated; nothing is cross-faded.
 *
 * Nothing here is real data and it never pretends to be. Like the rest of the
 * ambient layer it is seeded, unlabelled and unreadable as a price, because
 * decoration that could be mistaken for a number to act on is the one thing
 * this product will not draw.
 */

/** Points per range. One cycle spans the canvas width, and wraps seamlessly. */
const POINTS = 112;
/** How long a mood is held, and how long the morph into the next one takes. */
const HOLD_MS = 6_500;
const MORPH_MS = 4_500;

/**
 * The ranges, far to near.
 *
 * `haze` is how much air is in front of a range: one is the horizon, zero is
 * close enough to be a silhouette. It drives colour, contrast and the strength
 * of the light along the top edge all at once, which is what keeps the depth
 * consistent rather than four separately tuned layers.
 */
const RANGES = [
  { baseY: 0.66, amplitude: 0.15, speed: 2.5, haze: 0.78 },
  { baseY: 0.75, amplitude: 0.19, speed: 5, haze: 0.55 },
  { baseY: 0.85, amplitude: 0.23, speed: 9.5, haze: 0.32 },
  { baseY: 0.97, amplitude: 0.27, speed: 17, haze: 0.13 },
];

interface Candle {
  open: number;
  close: number;
  high: number;
  low: number;
}

interface Mood {
  /** One ridgeline per range, each normalised to 0..1. */
  readonly ranges: number[][];
  /** The skyline of candles along the front. */
  readonly candles: Candle[];
  /** The light this mood is lit by, and the colour its edges catch. */
  readonly sky: [number, number, number];
  readonly accent: [number, number, number];
}

/** A small deterministic generator, so a mood is identical every time round. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

/** A ridgeline: a walk, normalised, with its tail blended back into its head. */
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

  const blend = Math.floor(POINTS * 0.24);
  for (let i = 0; i < blend; i += 1) {
    const t = i / blend;
    const index = POINTS - blend + i;
    norm[index] = norm[index]! * (1 - t) + norm[i]! * t;
  }
  return norm;
}

function candlesFrom(random: () => number, drift: number, volatility: number): Candle[] {
  const out: Candle[] = [];
  let price = 0.5;
  for (let i = 0; i < POINTS; i += 1) {
    const open = price;
    let high = open;
    let low = open;
    for (let tick = 0; tick < 4; tick += 1) {
      price += drift + (random() - 0.5) * volatility;
      price = Math.min(0.95, Math.max(0.08, price));
      high = Math.max(high, price);
      low = Math.min(low, price);
    }
    out.push({ open, close: price, high, low });
  }
  const blend = Math.floor(POINTS * 0.2);
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
  accent: [number, number, number],
): Mood {
  const random = seeded(seed);
  return {
    // Further ranges are shallower and calmer, the way distance flattens relief.
    ranges: RANGES.map((range) =>
      ridgeline(random, drift * (1.15 - range.haze * 0.8), volatility * (1.1 - range.haze * 0.55)),
    ),
    candles: candlesFrom(random, drift, volatility),
    sky,
    accent,
  };
}

/* The palette stays inside the product's own: the green a gain is marked with,
   the red a loss is, and the steel everything else is drawn in. */
const MOODS: Mood[] = [
  mood(0x51a3, 0.015, 0.05, [22, 74, 52], [63, 224, 138]), // an advance
  mood(0x7f21, 0.0, 0.055, [28, 40, 52], [128, 158, 178]), // a range
  mood(0x2c9d, -0.015, 0.072, [70, 30, 32], [255, 95, 86]), // a flush
  mood(0x9e44, 0.012, 0.045, [20, 60, 62], [72, 206, 196]), // a recovery
];

/** Almost black, with a breath of the mood in it, for the nearest silhouettes. */
const INK: [number, number, number] = [6, 9, 11];

const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
const mixColour = (
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
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

    /* Motes in the air, so the space in front of the ranges is not empty glass. */
    interface Mote {
      x: number;
      y: number;
      radius: number;
      speed: number;
      phase: number;
      depth: number;
    }
    let motes: Mote[] = [];

    const seedMotes = (): void => {
      const random = seeded(0x4d07);
      const count = Math.round(Math.min(40, Math.max(14, width / 52)));
      motes = Array.from({ length: count }, () => ({
        x: random(),
        y: random(),
        radius: 0.7 + random() * 1.6,
        speed: 0.004 + random() * 0.013,
        phase: random() * Math.PI * 2,
        depth: 0.35 + random() * 0.65,
      }));
    };

    const resize = (): void => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = canvas.offsetWidth;
      height = canvas.offsetHeight;
      canvas.width = Math.max(1, Math.floor(width * ratio));
      canvas.height = Math.max(1, Math.floor(height * ratio));
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      seedMotes();
    };

    /**
     * A range, as a smooth silhouette with light along its top.
     *
     * The path runs through midpoints with a quadratic through each sample, so
     * the crest is a curve rather than the string of straight segments that
     * made the old ranges read as folded paper.
     */
    const drawRange = (
      from: number[],
      to: number[],
      t: number,
      baseY: number,
      amplitude: number,
      offset: number,
      fill: [number, number, number],
      rim: [number, number, number],
      rimAlpha: number,
    ): void => {
      const dx = width / POINTS;
      const shift = offset % width;
      const crest: { x: number; y: number }[] = [];

      for (let pass = 0; pass < 2; pass += 1) {
        const originX = pass * width - shift;
        for (let i = 0; i <= POINTS; i += 1) {
          const index = i % POINTS;
          crest.push({
            x: originX + i * dx,
            y: baseY - mix(from[index]!, to[index]!, t) * amplitude,
          });
        }
      }

      const trace = (): void => {
        context.moveTo(crest[0]!.x, crest[0]!.y);
        for (let i = 1; i < crest.length - 1; i += 1) {
          const midX = (crest[i]!.x + crest[i + 1]!.x) / 2;
          const midY = (crest[i]!.y + crest[i + 1]!.y) / 2;
          context.quadraticCurveTo(crest[i]!.x, crest[i]!.y, midX, midY);
        }
        const last = crest[crest.length - 1]!;
        context.lineTo(last.x, last.y);
      };

      // The body, solid, fading out toward its base so ranges sink into one
      // another rather than stacking as four separate cut-outs.
      context.beginPath();
      context.moveTo(crest[0]!.x, height);
      context.lineTo(crest[0]!.x, crest[0]!.y);
      trace();
      context.lineTo(crest[crest.length - 1]!.x, height);
      context.closePath();

      const body = context.createLinearGradient(0, baseY - amplitude, 0, height);
      body.addColorStop(0, rgb(fill, 0.95));
      body.addColorStop(0.75, rgb(fill, 0.82));
      body.addColorStop(1, rgb(fill, 0.6));
      context.fillStyle = body;
      context.fill();

      // The light caught along the crest. This is the line that makes a shape
      // read as a ridge against a lit sky instead of a hole in the page.
      context.beginPath();
      trace();
      context.strokeStyle = rgb(rim, rimAlpha);
      context.lineWidth = 1.2;
      context.stroke();
    };

    /** The candles standing along the front, like a skyline. */
    const drawSkyline = (
      from: Candle[],
      to: Candle[],
      t: number,
      offset: number,
    ): void => {
      const dx = width / POINTS;
      const shift = offset % width;
      const bodyWidth = Math.max(2.5, dx * 0.34);
      const floor = height * 1.04;
      const scale = height * 0.3;

      for (let pass = 0; pass < 2; pass += 1) {
        const originX = pass * width - shift;
        for (let i = 0; i < POINTS; i += 1) {
          const x = originX + i * dx;
          if (x < -dx * 2 || x > width + dx * 2) continue;

          const a = from[i]!;
          const b = to[i]!;
          const open = mix(a.open, b.open, t);
          const close = mix(a.close, b.close, t);
          const high = mix(a.high, b.high, t);
          const low = mix(a.low, b.low, t);

          const y = (v: number): number => floor - v * scale;
          const rising = close >= open;
          const colour: [number, number, number] = rising ? [63, 224, 138] : [255, 95, 86];

          // Near-black bodies with a lit edge, so the skyline belongs to the
          // same world as the ranges rather than sitting on top of them.
          context.strokeStyle = rgb(mixColour(INK, colour, 0.42), 0.75);
          context.lineWidth = 1;
          context.beginPath();
          context.moveTo(x + bodyWidth / 2, y(high));
          context.lineTo(x + bodyWidth / 2, y(low));
          context.stroke();

          const top = y(Math.max(open, close));
          const bodyHeight = Math.max(2, Math.abs(y(open) - y(close)));
          context.fillStyle = rgb(mixColour(INK, colour, 0.3), 0.92);
          context.fillRect(x, top, bodyWidth, bodyHeight);
          context.fillStyle = rgb(colour, 0.65);
          context.fillRect(x, top, bodyWidth, 1.4);
        }
      }
    };

    const drawMotes = (elapsed: number, colour: [number, number, number]): void => {
      const seconds = elapsed / 1000;
      for (const mote of motes) {
        const drifted = (mote.y - seconds * mote.speed) % 1;
        const top = (drifted + 1) % 1;
        const sway = Math.sin(seconds * 0.28 + mote.phase) * 0.012;
        const x = (((mote.x + sway) % 1) + 1) % 1;
        const fade = Math.sin(top * Math.PI);

        context.beginPath();
        context.arc(x * width, top * height * 0.9, mote.radius * mote.depth, 0, Math.PI * 2);
        context.fillStyle = rgb(colour, 0.04 + fade * 0.26 * mote.depth);
        context.fill();
      }
    };

    const render = (elapsed: number): void => {
      const cycle = HOLD_MS + MORPH_MS;
      const index = Math.floor(elapsed / cycle) % MOODS.length;
      const next = (index + 1) % MOODS.length;
      const into = elapsed % cycle;
      const raw = Math.min(1, Math.max(0, (into - HOLD_MS) / MORPH_MS));
      const t = raw * raw * (3 - 2 * raw);

      const a = MOODS[index]!;
      const b = MOODS[next]!;
      const sky = mixColour(a.sky, b.sky, t);
      const accent = mixColour(a.accent, b.accent, t);

      context.clearRect(0, 0, width, height);

      // The sky: darkest overhead, warming toward the horizon the ranges stand on.
      const air = context.createLinearGradient(0, 0, 0, height);
      air.addColorStop(0, rgb(sky, 0));
      air.addColorStop(0.45, rgb(sky, 0.16));
      air.addColorStop(0.72, rgb(sky, 0.42));
      air.addColorStop(1, rgb(sky, 0.12));
      context.fillStyle = air;
      context.fillRect(0, 0, width, height);

      // The light behind the ranges, low and wide, which is what they are lit by.
      const sun = context.createRadialGradient(
        width * 0.5,
        height * 0.72,
        0,
        width * 0.5,
        height * 0.72,
        Math.max(width, height) * 0.6,
      );
      sun.addColorStop(0, rgb(accent, 0.2));
      sun.addColorStop(0.4, rgb(accent, 0.07));
      sun.addColorStop(1, rgb(accent, 0));
      context.fillStyle = sun;
      context.fillRect(0, 0, width, height);

      drawMotes(elapsed, accent);

      const seconds = elapsed / 1000;
      // Far to near, so each range is drawn over the one behind it.
      RANGES.forEach((range, layer) => {
        // Atmospheric perspective: the far ranges hold the sky's own colour and
        // barely separate from it, the near ones fall almost to black.
        const fill = mixColour(INK, mixColour(sky, accent, 0.22), range.haze * 0.85);
        const rimAlpha = 0.16 + (1 - range.haze) * 0.4;
        drawRange(
          a.ranges[layer]!,
          b.ranges[layer]!,
          t,
          height * range.baseY,
          height * range.amplitude,
          seconds * range.speed,
          fill,
          accent,
          rimAlpha,
        );
      });

      drawSkyline(a.candles, b.candles, t, seconds * 26);
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
