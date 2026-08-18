import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

/**
 * The 1500x500 header, for X and DEX Screener.
 *
 * Rendered rather than drawn by hand so it can be regenerated when the wordmark
 * or the palette moves, and so the numbers below are the only thing anyone has
 * to argue with.
 *
 * Two constraints shape the layout and neither is negotiable:
 *
 *  - X hangs the avatar over the bottom left. It is roughly a 200px circle
 *    sitting about 60px in and overlapping the lower edge, so anything below
 *    y=330 and left of x=420 is covered on the one platform this is mostly for.
 *  - DEX Screener shows the whole frame, so the parts X covers still have to
 *    look deliberate rather than empty.
 *
 * So the lockup sits above the avatar line, and the space it leaves is given to
 * the chart rather than padded out.
 */

const W = 1500;
const H = 500;

const INK = '#07090b';
const ACCENT = '#3fe08a';
const TEXT = '#f2f4f6';
const DIM = '#99a0ab';

/**
 * A price line with an upward drift, generated from a fixed seed.
 *
 * Deterministic on purpose: the header should be byte-identical when it is
 * regenerated, or every rebuild is a gratuitous diff and nobody can tell a
 * deliberate change from noise.
 */
function priceLine(x0, x1, yLow, yHigh, seed, points = 74) {
  let state = seed;
  const rand = () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };

  const raw = [];
  let level = 0.18;
  for (let i = 0; i < points; i += 1) {
    // Drift up, with enough noise to look like a market rather than a ramp.
    level += (rand() - 0.36) * 0.085;
    level = Math.max(0, Math.min(1, level));
    raw.push(level);
  }

  // Smoothed, so it reads as a chart at this size instead of a sawtooth.
  const smooth = raw.map((_, i) => {
    const window = raw.slice(Math.max(0, i - 2), i + 3);
    return window.reduce((sum, value) => sum + value, 0) / window.length;
  });

  return smooth.map((value, i) => {
    const x = x0 + ((x1 - x0) * i) / (points - 1);
    const y = yHigh + (yLow - yHigh) * (1 - value);
    return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
  });
}

const path = (pts) => pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x} ${y}`).join(' ');

const lead = priceLine(210, 1398, 404, 118, 20260818);
const trail = priceLine(210, 1398, 414, 216, 77712345);
const [endX, endY] = lead[lead.length - 1];

// The mark, inlined. librsvg reads a data URI, and this keeps the whole render
// to one file with no path to get wrong.
const mark = readFileSync(join(process.cwd(), 'app/public/probatio-logo.png')).toString('base64');

// A grid, not a texture. Wide enough spacing to read as an instrument rather
// than as graph paper, and faint enough to sit under everything.
const grid = [];
for (let x = 0; x <= W; x += 50) {
  grid.push(`<line x1="${x}" y1="0" x2="${x}" y2="${H}" stroke="${ACCENT}" stroke-opacity="0.045" stroke-width="1"/>`);
}
for (let y = 0; y <= H; y += 50) {
  grid.push(`<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="${ACCENT}" stroke-opacity="0.045" stroke-width="1"/>`);
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <radialGradient id="lift" cx="0.14" cy="0.02" r="0.78">
      <stop offset="0" stop-color="${ACCENT}" stop-opacity="0.20"/>
      <stop offset="0.55" stop-color="${ACCENT}" stop-opacity="0.04"/>
      <stop offset="1" stop-color="${ACCENT}" stop-opacity="0"/>
    </radialGradient>
    <!-- The chart is masked in rather than overlaid with ink. Overlaying left
         a visible point where the line simply began, a few pixels under the
         tagline; masking means it has no beginning to see. -->
    <linearGradient id="revealgrad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0.13" stop-color="#000000"/>
      <stop offset="0.47" stop-color="#ffffff"/>
    </linearGradient>
    <mask id="reveal">
      <rect width="${W}" height="${H}" fill="url(#revealgrad)"/>
    </mask>
    <filter id="glow" x="-25%" y="-60%" width="150%" height="220%">
      <feGaussianBlur stdDeviation="9"/>
    </filter>
    <filter id="softglow" x="-25%" y="-60%" width="150%" height="220%">
      <feGaussianBlur stdDeviation="3.2"/>
    </filter>
  </defs>

  <rect width="${W}" height="${H}" fill="${INK}"/>
  <g>${grid.join('')}</g>
  <rect width="${W}" height="${H}" fill="url(#lift)"/>

  <!-- The market, behind the words. The quieter line first so the bright one
       reads as the subject rather than as one of a pair. -->
  <g mask="url(#reveal)">
  <path d="${path(trail)}" fill="none" stroke="${ACCENT}" stroke-opacity="0.22" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round"/>
  <path d="${path(lead)}" fill="none" stroke="${ACCENT}" stroke-opacity="0.30" stroke-width="7"
        stroke-linecap="round" stroke-linejoin="round" filter="url(#glow)"/>
  <path d="${path(lead)}" fill="none" stroke="${ACCENT}" stroke-opacity="0.92" stroke-width="2.6"
        stroke-linecap="round" stroke-linejoin="round"/>

  <!-- An axis, unlabelled. Numbers here would be a claim about a market that
       does not exist; the ticks alone say what kind of object this is. -->
  <!-- Where the line is now: the one detail that says this is a live thing. -->
  <line x1="${endX}" y1="${endY}" x2="${W - 46}" y2="${endY}" stroke="${ACCENT}" stroke-opacity="0.45"
        stroke-width="1.4" stroke-dasharray="5 7"/>
  <circle cx="${endX}" cy="${endY}" r="11" fill="${ACCENT}" opacity="0.22" filter="url(#softglow)"/>
  <circle cx="${endX}" cy="${endY}" r="4.6" fill="${ACCENT}"/>

  </g>

  <!-- An axis, unlabelled. Numbers here would be a claim about a market that
       does not exist; the ticks alone say what kind of object this is. -->
  ${Array.from({ length: 7 }, (_, i) => {
    const y = 104 + i * 44;
    return `<line x1="${W - 34}" y1="${y}" x2="${W - 18}" y2="${y}" stroke="${ACCENT}" stroke-opacity="0.22" stroke-width="1.4"/>`;
  }).join('')}

  <image href="data:image/png;base64,${mark}" x="104" y="176" width="150" height="150"/>

  <text x="288" y="252" font-family="Helvetica Neue, Helvetica, Arial, sans-serif"
        font-size="70" font-weight="600" letter-spacing="7" fill="${TEXT}">PROBATIO</text>

  <text x="292" y="300" font-family="Helvetica Neue, Helvetica, Arial, sans-serif"
        font-size="25" font-weight="400" fill="${DIM}">Trade fake money on real tokens.</text>

  <!-- Bottom right, because X covers bottom left with the avatar. -->
  <text x="${W - 78}" y="442" text-anchor="end" font-family="Menlo, Monaco, monospace"
        font-size="19" letter-spacing="2.2" fill="${ACCENT}" fill-opacity="0.85">probatiotrade.com</text>
</svg>`;

const out = join(process.cwd(), 'brand/x-header.png');
await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(out);
const meta = await sharp(out).metadata();
console.log(`wrote ${out} — ${meta.width}x${meta.height}`);
