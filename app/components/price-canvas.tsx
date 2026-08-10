'use client';

import { useEffect, useRef } from 'react';

/**
 * A market drawing itself behind the hero.
 *
 * Candles, not particles. A generic node graph would say nothing about what
 * this is, and the one thing worth showing on a trading site is a chart moving.
 *
 * Nothing here is real data and it never pretends to be. It is a random walk
 * with a bias that flips, rendered small and faded, which is decoration doing a
 * decoration's job. Showing a fabricated price series at any size that could be
 * read as a real market would be exactly the thing this product refuses to do
 * everywhere else.
 */
export function PriceCanvas() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;

    const context = canvas.getContext('2d');
    if (!context) return;

    // Anybody who asked for less motion gets a still frame.
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const GAIN = '#3fb950';
    const LOSS = '#f85149';
    const CANDLE_WIDTH = 9;
    const GAP = 5;

    interface Candle {
      open: number;
      close: number;
      high: number;
      low: number;
    }

    let width = 0;
    let height = 0;
    let candles: Candle[] = [];
    let price = 0.5;
    let drift = 0.0016;
    let frame = 0;
    let animation = 0;

    const step = (): Candle => {
      const open = price;
      // The bias flips now and then, so it reads as a market rather than a
      // ramp, but it is biased upward on balance. A hero chart falling to the
      // right is the wrong picture whatever the random walk happens to do.
      // Pullbacks are shallower than the advances and end sooner, so the walk
      // wanders like a market and still finishes higher than it started. A
      // hero chart falling to the right is the wrong picture whatever the
      // randomness happens to do.
      if (drift > 0 ? Math.random() < 0.03 : Math.random() < 0.12) {
        drift = drift > 0 ? -Math.abs(drift) * 0.5 : Math.abs(drift) * 2;
      }
      let high = open;
      let low = open;

      for (let tick = 0; tick < 6; tick += 1) {
        price += drift + (Math.random() - 0.5) * 0.02;
        price = Math.min(0.92, Math.max(0.08, price));
        high = Math.max(high, price);
        low = Math.min(low, price);
      }

      return { open, close: price, high, low };
    };

    const resize = (): void => {
      const ratio = window.devicePixelRatio || 1;
      width = canvas.offsetWidth;
      height = canvas.offsetHeight;
      canvas.width = Math.max(1, Math.floor(width * ratio));
      canvas.height = Math.max(1, Math.floor(height * ratio));
      context.setTransform(ratio, 0, 0, ratio, 0, 0);

      const needed = Math.ceil(width / (CANDLE_WIDTH + GAP)) + 2;
      while (candles.length < needed) candles.push(step());
      candles = candles.slice(-needed);
    };

    const draw = (): void => {
      context.clearRect(0, 0, width, height);

      const top = height * 0.12;
      const usable = height * 0.76;

      candles.forEach((candle, index) => {
        const x = index * (CANDLE_WIDTH + GAP);
        const y = (value: number): number => top + (1 - value) * usable;

        const rising = candle.close >= candle.open;
        context.strokeStyle = rising ? GAIN : LOSS;
        context.fillStyle = rising ? GAIN : LOSS;

        // Fades toward the left, so the eye lands on the newest candles and
        // the oldest never compete with the headline.
        // Never fully transparent: at 0.12 the left third read as empty and
        // the chart looked like it started halfway across the page.
        context.globalAlpha = 0.3 + (index / candles.length) * 0.4;

        context.beginPath();
        context.moveTo(x + CANDLE_WIDTH / 2, y(candle.high));
        context.lineTo(x + CANDLE_WIDTH / 2, y(candle.low));
        context.lineWidth = 1;
        context.stroke();

        const bodyTop = y(Math.max(candle.open, candle.close));
        const bodyHeight = Math.max(1.5, Math.abs(y(candle.open) - y(candle.close)));
        context.fillRect(x, bodyTop, CANDLE_WIDTH, bodyHeight);
      });

      context.globalAlpha = 1;
    };

    const loop = (): void => {
      frame += 1;
      // A new candle every second or so. Faster reads as a slot machine.
      if (frame % 42 === 0) {
        candles.push(step());
        candles.shift();
      }
      draw();
      animation = requestAnimationFrame(loop);
    };

    resize();
    draw();
    if (!still) animation = requestAnimationFrame(loop);

    window.addEventListener('resize', resize);
    return () => {
      cancelAnimationFrame(animation);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return <canvas ref={ref} className="hero-canvas" aria-hidden="true" />;
}
