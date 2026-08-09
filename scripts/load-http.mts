/**
 * Load against a running server.
 *
 * Read routes only, and on purpose: the trade path reads live pool state from
 * an RPC provider, so loading it would measure somebody else's endpoint and
 * risk having it taken away. What our own code does under concurrency is
 * measured directly by scripts/load-db.mts instead.
 *
 * The rate limiter is expected to refuse requests here. A run where nothing is
 * refused has not reached the limit and has measured nothing.
 *
 *   npx tsx scripts/load-http.mts <baseUrl> [concurrency] [requestsEach]
 */
const base = process.argv[2] ?? 'http://localhost:3000';
const concurrency = Number(process.argv[3] ?? '20');
const each = Number(process.argv[4] ?? '20');

const ROUTES = ['/api/season', '/api/leaderboard', '/api/launches', '/api/health'];

interface Sample {
  route: string;
  status: number;
  ms: number;
}

const samples: Sample[] = [];
const errors: string[] = [];

async function worker(id: number): Promise<void> {
  for (let i = 0; i < each; i += 1) {
    const route = ROUTES[(id + i) % ROUTES.length]!;
    const began = performance.now();
    try {
      const response = await fetch(`${base}${route}`, {
        // Each worker is a distinct caller, so the limiter is exercised per
        // caller rather than all of them sharing one bucket.
        headers: { 'x-forwarded-for': `203.0.113.${id % 250}` },
      });
      await response.text();
      samples.push({ route, status: response.status, ms: performance.now() - began });
    } catch (error) {
      errors.push(error instanceof Error ? error.message.slice(0, 80) : String(error));
    }
  }
}

console.log(`${concurrency} callers x ${each} requests against ${base}\n`);
const began = performance.now();
await Promise.all(Array.from({ length: concurrency }, (_, id) => worker(id)));
const wall = performance.now() - began;

const times = samples.map((s) => s.ms).sort((a, b) => a - b);
const at = (q: number): string =>
  times.length === 0 ? '—' : `${times[Math.min(times.length - 1, Math.floor(times.length * q))]!.toFixed(0)}ms`;

console.log(`wall clock    ${wall.toFixed(0)}ms`);
console.log(`throughput    ${((samples.length / wall) * 1000).toFixed(0)} req/sec`);
console.log(`latency p50   ${at(0.5)}`);
console.log(`latency p95   ${at(0.95)}`);
console.log(`latency p99   ${at(0.99)}`);

const byStatus = new Map<number, number>();
for (const sample of samples) byStatus.set(sample.status, (byStatus.get(sample.status) ?? 0) + 1);
console.log('\nstatus');
for (const [status, count] of [...byStatus].sort((a, b) => a[0] - b[0])) {
  console.log(`  ${status}  ${count}`);
}

console.log('\nslowest route by p95');
for (const route of ROUTES) {
  const forRoute = samples.filter((s) => s.route === route).map((s) => s.ms).sort((a, b) => a - b);
  if (forRoute.length === 0) continue;
  const p95 = forRoute[Math.min(forRoute.length - 1, Math.floor(forRoute.length * 0.95))]!;
  console.log(`  ${route.padEnd(20)} ${p95.toFixed(0)}ms  (${forRoute.length} requests)`);
}

if (errors.length > 0) {
  console.log(`\n${errors.length} connection errors`);
  console.log(`  ${errors[0]}`);
}

// A 5xx is the only genuinely bad outcome. A 429 is the limiter working.
const server = [...byStatus].filter(([status]) => status >= 500).reduce((sum, [, n]) => sum + n, 0);
console.log(server === 0 ? '\nno server errors' : `\n${server} server errors`);
process.exit(server === 0 ? 0 : 1);
