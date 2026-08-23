import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The checks, checked.
 *
 * This gate now decides whether a change may merge, and until this file existed
 * it had no tests at all: exactly the thing it was written to find, sitting in
 * the thing that finds it. The prefix bug below is not hypothetical either. A
 * single route at `/[slug]` produced a prefix of `/`, every internal link on the
 * site begins with `/`, and the check would have passed everything forever while
 * reporting itself green.
 *
 * Each case plants a specific fault in a throwaway tree and asserts the audit
 * finds that one and does not invent others.
 */

const SCRIPT = fileURLToPath(new URL('../audit.mts', import.meta.url));
/* The resolved binary, not `npx`: thirteen of these run per suite and npx spends
   most of a second resolving the same package every time. */
const TSX = fileURLToPath(new URL('../../node_modules/.bin/tsx', import.meta.url));

/*
 * Each case runs the audit as a real process against a real tree, which takes
 * seconds rather than milliseconds. At the five second default the suite passed
 * or failed depending on how busy the machine was, which is worse than a slow
 * test and much worse than no test.
 */
const RUNS_A_PROCESS = 60_000;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'probatio-audit-'));
  mkdirSync(join(root, 'app', 'app'), { recursive: true });
});

/** A tree without the directory a check happens to read. */
function withoutApp(): void {
  rmSync(join(root, 'app'), { recursive: true, force: true });
}

afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(relative: string, contents: string): void {
  const full = join(root, relative);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, contents);
}

/** A route, which is how the link check learns what exists. */
function page(route: string): void {
  write(join('app', 'app', route, 'page.tsx'), 'export default function P() { return null; }\n');
}

interface Finding {
  severity: 'error' | 'warning';
  file: string;
  detail: string;
}

interface Summary {
  at: number;
  checks: number;
  inspected: number;
  errors: number;
  warnings: number;
}

function history(): Summary[] {
  try {
    return JSON.parse(readFileSync(join(root, 'audit', 'history.json'), 'utf8')) as Summary[];
  } catch {
    return [];
  }
}

function run(): { errors: number; warnings: number; byCheck: Record<string, Finding[]> } {
  execFileSync(TSX, [SCRIPT], {
    env: { ...process.env, AUDIT_ROOT: root },
    stdio: 'pipe',
  });
  const pass = JSON.parse(readFileSync(join(root, 'audit', 'latest.json'), 'utf8')) as {
    errors: number;
    warnings: number;
    results: { id: string; findings: Finding[] }[];
  };
  const byCheck: Record<string, Finding[]> = {};
  for (const check of pass.results) byCheck[check.id] = check.findings;
  return { errors: pass.errors, warnings: pass.warnings, byCheck };
}

describe('custom properties that resolve to nothing', () => {
  it('finds one that is used and never defined', () => {
    write('app/app/globals.css', ':root { --ink: #000; }\n.a { color: var(--ink); }\n.b { color: var(--ghost); }\n');
    const { byCheck, errors } = run();

    expect(errors).toBe(1);
    expect(byCheck['css-vars']).toHaveLength(1);
    expect(byCheck['css-vars']![0]!.detail).toContain('--ghost');
  }, RUNS_A_PROCESS);

  /* A fallback is a decision, not a mistake: it renders the second argument. */
  it('leaves a var with a fallback alone', () => {
    write('app/app/globals.css', '.a { color: var(--missing, #fff); }\n');
    expect(run().byCheck['css-vars']).toHaveLength(0);
  }, RUNS_A_PROCESS);

  /*
   * next/font names the variable in TypeScript and injects the declaration at
   * runtime, so reading only stylesheets called every font on the site broken.
   */
  it('counts a variable declared by next/font as defined', () => {
    write('app/app/layout.tsx', "const f = Geist({ variable: '--font-geist-sans' });\n");
    write('app/app/globals.css', 'body { font-family: var(--font-geist-sans); }\n');
    expect(run().byCheck['css-vars']).toHaveLength(0);
  }, RUNS_A_PROCESS);
});

describe('links to pages that exist', () => {
  it('finds a link to a page nothing answers', () => {
    page('about');
    write('app/components/nav.tsx', '<a href="/about">a</a><a href="/nowhere">b</a>');
    const { byCheck } = run();

    expect(byCheck['internal-links']).toHaveLength(1);
    expect(byCheck['internal-links']![0]!.detail).toContain('/nowhere');
  }, RUNS_A_PROCESS);

  it('accepts a link into a dynamic segment', () => {
    page('t/[mint]');
    write('app/components/nav.tsx', '<a href="/t/So1111">a</a>');
    expect(run().byCheck['internal-links']).toHaveLength(0);
  }, RUNS_A_PROCESS);

  /*
   * The bug this test exists for. A route at the root of a dynamic segment
   * yields a prefix of `/`, which every internal link starts with, so the check
   * passed everything and still reported itself as having run.
   */
  it('is not disabled entirely by a root level dynamic route', () => {
    page('[slug]');
    write('app/components/nav.tsx', '<a href="/nowhere">b</a>');

    const { byCheck } = run();
    expect(byCheck['internal-links']).toHaveLength(1);
  }, RUNS_A_PROCESS);
});

describe('exports nothing calls', () => {
  it('finds one no other file mentions', () => {
    write('packages/x/src/a.ts', 'export function used() {}\nexport function orphan() {}\n');
    write('packages/x/src/b.ts', "import { used } from './a';\nused();\n");

    const dead = run().byCheck['dead-exports']!;
    expect(dead.map((f) => f.detail).join(' ')).toContain('orphan');
    expect(dead.map((f) => f.detail).join(' ')).not.toContain('used');
  }, RUNS_A_PROCESS);

  /* The drift watchdog's failure: written, tested, and called by nothing. */
  it('separates one that only its own tests mention', () => {
    write('packages/x/src/a.ts', 'export function watchdog() {}\n');
    write('packages/x/test/a.test.ts', "import { watchdog } from '../src/a';\nwatchdog();\n");

    const dead = run().byCheck['dead-exports']!;
    expect(dead).toHaveLength(1);
    expect(dead[0]!.detail).toContain('only by tests');
  }, RUNS_A_PROCESS);

  /*
   * A dollar is legal in an identifier and an anchor in a pattern, so an
   * unescaped name matched nothing and the export was reported as dead.
   */
  it('handles a name a regular expression would choke on', () => {
    write('packages/x/src/a.ts', 'export function $live() {}\n');
    write('packages/x/src/b.ts', "import { $live } from './a';\n$live();\n");

    const dead = run().byCheck['dead-exports']!;
    expect(dead.map((f) => f.detail).join(' ')).not.toContain('$live');
  }, RUNS_A_PROCESS);
});

/**
 * What decides whether this job writes to the repository.
 *
 * The workflow commits when `history.json` changes, and the first version
 * appended on every pass. An hourly job would have committed eight thousand
 * seven hundred and sixty times a year to say nothing had happened, and the
 * guard written to stop that could never fire, because the file it tested had
 * always changed. These are the two halves of the rule that replaced it.
 */
describe('what gets recorded', () => {
  beforeEach(() => {
    write('app/app/globals.css', ':root { --ink: #000; }\n.a { color: var(--ink); }\n');
  });

  it('does not record a pass that says the same as the last one', () => {
    run();
    expect(history()).toHaveLength(1);

    run();
    expect(history()).toHaveLength(1);
  }, RUNS_A_PROCESS);

  it('records a pass whose findings differ', () => {
    run();
    expect(history()).toHaveLength(1);

    write('app/app/extra.css', '.b { color: var(--ghost); }\n');
    run();

    const log = history();
    expect(log).toHaveLength(2);
    expect(log[0]!.errors).toBe(1);
    expect(log[1]!.errors).toBe(0);
  }, RUNS_A_PROCESS);

  /*
   * The half that is easy to leave out. A log that only moves when something
   * changes cannot be told apart from a job that stopped running, and "last
   * checked" is the one thing a status board must not get wrong.
   */
  it('records an unchanged pass once half a day has gone by', () => {
    run();
    const first = history();
    expect(first).toHaveLength(1);

    const stale = [{ ...first[0]!, at: first[0]!.at - 13 * 60 * 60 }];
    writeFileSync(join(root, 'audit', 'history.json'), JSON.stringify(stale, null, 2) + '\n');

    run();
    expect(history()).toHaveLength(2);
  }, RUNS_A_PROCESS);
});

describe('a tree that is not shaped like this one', () => {
  /*
   * The link check reads `app/`, and read it without asking whether it was
   * there. Every deployment of this repository has one, so the crash needed a
   * fixture, an extracted package or a future layout to surface, and it took
   * the entire audit down rather than skipping one check.
   */
  it('reports the checks it can run when a directory is missing', () => {
    withoutApp();
    write('packages/x/src/a.ts', 'export function orphan() {}\n');

    const { byCheck, errors } = run();
    expect(errors).toBe(0);
    expect(byCheck['internal-links']).toEqual([]);
    expect(byCheck['dead-exports']!.map((f) => f.detail).join(' ')).toContain('orphan');
  }, RUNS_A_PROCESS);
});
