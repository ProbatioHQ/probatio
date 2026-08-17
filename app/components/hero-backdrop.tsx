'use client';

import { useEffect, useRef } from 'react';

/**
 * The ground behind the hero: a market, drawn as one line.
 *
 * Candles were too much and light alone was too little. A price line is the
 * shape a market makes at its simplest, and the only thing on a trading screen
 * that reads instantly without asking to be studied: no bodies, no wicks, no
 * grid, nothing to count. Two of them at different depths drift left at their
 * own speeds, the near one lit along its edge with its fall shaded underneath,
 * the far one barely there.
 *
 * Seeded and unlabelled, like the rest of the ambient layer. It is not a price
 * and could not be read as one at this scale, which is the line this product
 * draws between decoration and a number somebody might act on.
 */

/** Points along a line. One cycle spans the width and wraps without a seam. */
const POINTS = 120;

interface Layer {
  /** Height at each point, normalised to 0..1. */
  readonly shape: number[];
  /** Where it sits, how tall it stands, how fast it runs, how strongly it is lit. */
  readonly baseY: number;
  readonly amplitude: number;
  readonly speed: number;
  readonly alpha: number;
  readonly width: number;
  readonly fill: number;
}

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
}

/** A walk, normalised, with its tail blended back into its head so it wraps. */
function shapeOf(random: () => number, volatility: number): number[] {
  const raw: number[] = [];
  let value = 0.5;
  for (let i = 0; i < POINTS; i += 1) {
    value += (random() - 0.5) * volatility;
    raw.push(value);
  }
  const low = Math.min(...raw);
  const high = Math.max(...raw);
  const span = high - low || 1;
  const norm = raw.map((v) => (v - low) / span);

  const blend = Math.floor(POINTS * 0.26);
  for (let i = 0; i < blend; i += 1) {
    const t = i / blend;
    const index = POINTS - blend + i;
    norm[index] = norm[index]! * (1 - t) + norm[i]! * t;
  }
  return norm;
}

export function HeroBackdrop() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;

    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const random = seeded(0x3ac1);

    const layers: Layer[] = [
      // Far: a suggestion of a second market, well back.
      {
        shape: shapeOf(random, 0.055),
        baseY: 0.58,
        amplitude: 0.2,
        speed: 5,
        alpha: 0.16,
        width: 1,
        fill: 0.03,
      },
      // Near: the one the eye actually follows.
      {
        shape: shapeOf(random, 0.075),
        baseY: 0.82,
        amplitude: 0.3,
        speed: 12,
        alpha: 0.5,
        width: 1.6,
        fill: 0.09,
      },
    ];

    let width = 0;
    let height = 0;
    let animation = 0;
    let start = 0;

    const resize = (): void => {
      const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      width = canvas.offsetWidth;
      height = canvas.offsetHeight;
      canvas.width = Math.max(1, Math.floor(width * ratio));
      canvas.height = Math.max(1, Math.floor(height * ratio));
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    const drawLayer = (layer: Layer, seconds: number): void => {
      const dx = width / POINTS;
      const shift = (seconds * layer.speed) % width;
      const baseY = height * layer.baseY;
      const amplitude = height * layer.amplitude;

      // Built once and used for both the shading underneath and the line on top.
      const points: { x: number; y: number }[] = [];
      for (let pass = 0; pass < 2; pass += 1) {
        const originX = pass * width - shift;
        for (let i = 0; i <= POINTS; i += 1) {
          points.push({
            x: originX + i * dx,
            y: baseY - layer.shape[i % POINTS]! * amplitude,
          });
        }
      }

      const line = new Path2D();
      line.moveTo(points[0]!.x, points[0]!.y);
      for (let i = 1; i < points.length - 1; i += 1) {
        const midX = (points[i]!.x + points[i + 1]!.x) / 2;
        const midY = (points[i]!.y + points[i + 1]!.y) / 2;
        line.quadraticCurveTo(points[i]!.x, points[i]!.y, midX, midY);
      }
      const last = points[points.length - 1]!;
      line.lineTo(last.x, last.y);

      // The fall under the line, fading out, so it has weight without an edge.
      const under = new Path2D();
      under.moveTo(points[0]!.x, height);
      under.lineTo(points[0]!.x, points[0]!.y);
      under.addPath(line);
      under.lineTo(last.x, height);
      under.closePath();

      const shade = context.createLinearGradient(0, baseY - amplitude, 0, height);
      shade.addColorStop(0, `rgba(63, 224, 138, ${layer.fill})`);
      shade.addColorStop(1, 'rgba(63, 224, 138, 0)');
      context.fillStyle = shade;
      context.fill(under);

      context.strokeStyle = `rgba(63, 224, 138, ${layer.alpha})`;
      context.lineWidth = layer.width;
      context.lineJoin = 'round';
      context.stroke(line);
    };

    const render = (elapsed: number): void => {
      const seconds = elapsed / 1000;
      context.clearRect(0, 0, width, height);
      for (const layer of layers) drawLayer(layer, seconds);
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

  return (
    <div className="scene" aria-hidden="true">
      <span className="scene-wash one" />
      <span className="scene-wash two" />
      <canvas ref={ref} className="scene-line" />
    </div>
  );
}
