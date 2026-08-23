/**
 * The repository checking itself.
 *
 * Four mechanical checks, run on a schedule, with the result written back into
 * the repository as a committed file rather than into a database.
 *
 * That last part is the whole design. This site's argument is that a record you
 * cannot quietly edit beats a number you are asked to believe, and a self-audit
 * kept in a database I control would be exactly the thing it argues against.
 * Committed, the history is the git history: anyone can see when a check
 * started failing, and nobody can make it look like it never did.
 *
 * Every check here is mechanical. No check reports an opinion, because a
 * finding somebody has to argue with is a finding nobody acts on, and a page
 * full of maybes is worth less than an empty one. The four are not generic
 * either. Each is a bug that actually happened in this repository:
 *
 *   Dead exports        `drift-watch.ts` says it in its own header: assessDrift,
 *                       recordDrift and suspendToken were written, tested, and
 *                       had no caller. The engine-versus-reality watchdog
 *                       existed and never ran.
 *   Undefined CSS vars  Cost the /telegram page its colours once and a brand
 *                       template its red sparkline another time. Undefined
 *                       custom properties fail silently, which is why both
 *                       shipped.
 *   Internal links      The backtest reached the world through exactly one
 *                       link, and the phone layout hid it.
 *   Undocumented env    Six PROBATIO_* flags and a credit ceiling decide
 *                       whether the site stays up. Not knowing which knobs
 *                       existed is part of how the RPC budget went.
 *
 * Usage:
 *   npx tsx scripts/audit.mts            write the result, exit 0
 *   npx tsx scripts/audit.mts --check    exit 1 if anything is an error
 */

import { readFileSync, readdirSync, statSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * The tree to check, overridable so the checks can be pointed at a fixture.
 *
 * A gate with no tests of its own is the thing this file exists to find, and
 * without a way to aim it somewhere else the only way to test a check was to
 * break the repository on purpose.
 *
 * `fileURLToPath`, not `.pathname`: a URL percent-encodes a space, and this
 * repository lives in a directory with one in the name.
 */
const ROOT = process.env['AUDIT_ROOT'] ?? fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = join(ROOT, 'audit');

/** A single thing worth saying about the repository. */
interface Finding {
  readonly severity: 'error' | 'warning';
  readonly file: string;
  readonly line: number | null;
  readonly detail: string;
}

/** One line of the strip the page draws. */
interface AuditSummary {
  readonly at: number;
  readonly checks: number;
  readonly inspected: number;
  readonly errors: number;
  readonly warnings: number;
}

interface CheckResult {
  readonly id: string;
  readonly title: string;
  /** What it looked at, so "0 findings" can be told from "0 looked at". */
  readonly inspected: number;
  readonly findings: readonly Finding[];
}

/* ------------------------------------------------------------------ walking */

const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'audit', 'brand', 'coverage']);

function walk(dir: string, keep: (path: string) => boolean, out: string[] = []): string[] {
  // A directory that is not there is not an error, it is a tree without one.
  // The link check reads `app/`, which every deployment of this repository has
  // and a fixture, a package extracted from it, or a future layout need not:
  // missing, the whole audit died on an ENOENT instead of reporting anything.
  if (!existsSync(dir)) return out;

  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, keep, out);
    else if (keep(full)) out.push(full);
  }
  return out;
}

const rel = (p: string) => relative(ROOT, p);

/*
 * Whether one file mentions a name, as a whole word.
 *
 * Not `\b`, and the reason is narrow enough to be worth writing down.
 * Identifiers may contain `$`, which is both an anchor in a pattern and, more
 * awkwardly, not a word character. So `\b$live\b` fails twice over: escaping
 * the dollar fixes the anchor, and the boundary still cannot match, because
 * between a space and a `$` there is no transition from word to non-word for
 * `\b` to find. A live export came back as called by nobody.
 *
 * Lookarounds over the set JavaScript actually allows in an identifier say what
 * was meant: this name, not a longer one containing it.
 */
const escapeForRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const mentions = (haystack: string, name: string): boolean =>
  new RegExp(`(?<![\\w$])${escapeForRegex(name)}(?![\\w$])`).test(haystack);
const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length;

/* ------------------------------------------------------- 1. dead exports */

/*
 * A named export no other file mentions.
 *
 * Textual, not type-aware, and worded to say only that. A symbol used inside
 * its own file still shows up here, because what it measures is whether the
 * `export` is reaching anybody, and a finding phrased as more than it checked
 * is a finding somebody disproves once and then stops reading.
 *
 * Test files count as callers, which is deliberate and is the interesting case:
 * something exercised only by its own tests is exactly the drift watchdog
 * before it had a caller, so those are reported as warnings rather than
 * ignored. A type-only export is skipped, since a type with no importer costs
 * nothing at runtime and is often a public shape on purpose.
 */
function checkDeadExports(): CheckResult {
  const files = walk(ROOT, (p) => /\.(ts|tsx|mts)$/.test(p) && !p.endsWith('.d.ts'));
  const source = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));

  const findings: Finding[] = [];
  let inspected = 0;

  for (const [file, text] of source) {
    // Entry points are meant to be unreferenced from inside the repository.
    if (/\/(app|pages)\/.*\/(page|layout|route|not-found|error)\.tsx?$/.test(file)) continue;
    if (/\/scripts\//.test(file)) continue;
    if (/\/(index|globals)\.tsx?$/.test(file)) continue;

    const pattern = /^export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/gm;
    for (const match of text.matchAll(pattern)) {
      const name = match[1];
      if (!name) continue;
      inspected += 1;

      const isTest = /\.(test|spec)\.tsx?$/.test(file) || /\/(test|__tests__)\//.test(file);
      if (isTest) continue;

      let used = 0;
      let onlyTests = true;
      for (const [other, otherText] of source) {
        if (other === file) continue;
        // Word-boundary match: enough to tell "referenced somewhere" from "not
        // referenced at all", which is the only question being asked.
        if (!mentions(otherText, name)) continue;
        used += 1;
        if (!(/\.(test|spec)\.tsx?$/.test(other) || /\/(test|__tests__)\//.test(other))) {
          onlyTests = false;
        }
      }

      if (used === 0) {
        findings.push({
          severity: 'warning',
          file: rel(file),
          line: lineOf(text, match.index ?? 0),
          detail: `${name} is exported and no other file mentions it`,
        });
      } else if (onlyTests) {
        findings.push({
          severity: 'warning',
          file: rel(file),
          line: lineOf(text, match.index ?? 0),
          detail: `${name} is mentioned only by tests, so nothing in the app runs it`,
        });
      }
    }
  }

  return { id: 'dead-exports', title: 'Exports nothing calls', inspected, findings };
}

/* --------------------------------------------- 2. undefined CSS variables */

/*
 * `var(--something)` with no `--something` defined anywhere.
 *
 * The failure mode is the reason this is checked at all: an undefined custom
 * property does not error, it resolves to nothing, and the element is drawn
 * with no colour. That is invisible in review and obvious on a screenshot,
 * which is the worst order for those two to happen in.
 *
 * A fallback is not a finding: `var(--x, #fff)` renders the fallback and was
 * written by somebody who knew the variable might be missing.
 */
function checkCssVars(): CheckResult {
  const files = walk(ROOT, (p) => extname(p) === '.css' || /\.(tpl|html)$/.test(p));
  const defined = new Set<string>();
  const used: { name: string; file: string; line: number }[] = [];

  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(--[\w-]+)\s*:/g)) if (m[1]) defined.add(m[1]);
    for (const m of text.matchAll(/var\(\s*(--[\w-]+)\s*([,)])/g)) {
      if (m[2] === ',') continue;
      if (m[1]) used.push({ name: m[1], file: rel(file), line: lineOf(text, m.index ?? 0) });
    }
  }

  /*
   * Not every custom property is declared in a stylesheet.
   *
   * `next/font` takes the name in TypeScript and injects the declaration as a
   * class at runtime, so `--font-geist-sans` is real and appears in no CSS file
   * anywhere. Reading only the stylesheets called every font on the site
   * undefined, which is the check being wrong rather than the site, and a check
   * that cries wolf a hundred and twenty-nine times is one nobody reads again.
   */
  for (const file of walk(ROOT, (p) => /\.(ts|tsx)$/.test(p))) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/variable:\s*['"`](--[\w-]+)['"`]/g)) if (m[1]) defined.add(m[1]);
    // Set inline on an element, e.g. style={{ '--x': value }}.
    for (const m of text.matchAll(/['"`](--[\w-]+)['"`]\s*:/g)) if (m[1]) defined.add(m[1]);
  }

  const findings: Finding[] = used
    .filter((u) => !defined.has(u.name))
    .map((u) => ({
      severity: 'error' as const,
      file: u.file,
      line: u.line,
      detail: `var(${u.name}) is used and never defined, so it paints nothing`,
    }));

  return { id: 'css-vars', title: 'Custom properties that resolve to nothing', inspected: used.length, findings };
}

/* ------------------------------------------------------- 3. internal links */

/*
 * An href to a page this app does not have.
 *
 * Only static, literal paths. A template literal is a route computed at
 * runtime and checking it would mean guessing what it computes, which is the
 * kind of judgment this file stays out of.
 */
function checkInternalLinks(): CheckResult {
  const appDir = join(ROOT, 'app', 'app');
  const routes = new Set<string>(['/']);
  if (existsSync(appDir)) {
    for (const page of walk(appDir, (p) => /\/page\.tsx$/.test(p))) {
      const route = '/' + relative(appDir, page).replace(/\/page\.tsx$/, '');
      // A dynamic segment matches anything, so it is recorded as a prefix.
      routes.add(route === '/' ? '/' : route.replace(/\/$/, ''));
    }
  }
  const dynamicPrefixes = [...routes].filter((r) => r.includes('['))
    .map((r) => r.slice(0, r.indexOf('[')));

  const files = walk(join(ROOT, 'app'), (p) => /\.tsx$/.test(p));
  const findings: Finding[] = [];
  let inspected = 0;

  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/href="(\/[^"{}#?]*)"/g)) {
      const href = (m[1] ?? '').replace(/\/$/, '') || '/';
      inspected += 1;
      if (routes.has(href)) continue;
      /*
       * A prefix has to be a real one. A route at `/[slug]` yields a prefix of
       * `/`, and every internal link on the site starts with `/`, so one such
       * route would quietly pass the entire check forever. A check that cannot
       * fail is worse than no check, because the page reports it as green.
       */
      if (dynamicPrefixes.some((prefix) => prefix.length > 1 && href.startsWith(prefix))) continue;
      findings.push({
        severity: 'error',
        file: rel(file),
        line: lineOf(text, m.index ?? 0),
        detail: `${href} is linked and no page answers it`,
      });
    }
  }

  return { id: 'internal-links', title: 'Links to pages that exist', inspected, findings };
}

/* ------------------------------------------------- 4. undocumented env vars */

/*
 * A `process.env` key the deployment notes never mention.
 *
 * These are the knobs that decide whether the site is up, and the RPC budget
 * ran out partly because nobody had the list in one place. A variable read by
 * the code and written down nowhere is a setting somebody has to find by
 * reading the source at the moment it matters most.
 */
function checkEnvDocs(): CheckResult {
  const docs = ['README.md', 'DEPLOY.md', 'docs', 'app/app/docs']
    .map((p) => join(ROOT, p))
    .filter((p) => existsSync(p));

  let documented = '';
  for (const d of docs) {
    documented += statSync(d).isDirectory()
      ? walk(d, (p) => /\.(md|mdx|tsx)$/.test(p)).map((f) => readFileSync(f, 'utf8')).join('\n')
      : readFileSync(d, 'utf8');
  }

  const files = walk(ROOT, (p) => /\.(ts|tsx|mts)$/.test(p));
  const seen = new Map<string, { file: string; line: number }>();
  for (const file of files) {
    if (/\.(test|spec)\.tsx?$/.test(file) || /\/(test|__tests__)\//.test(file)) continue;
    /*
     * Scripts are excluded, and the distinction is the point of the check.
     *
     * What this is for is the settings that decide whether the deployment is
     * up. A one-off tool taking BATCH_SIZE from the environment is an argument
     * to a command somebody is already reading, not a knob anybody has to find
     * at three in the morning.
     */
    if (/\/scripts\//.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/process\.env\[?['"`]?([A-Z][A-Z0-9_]{2,})['"`]?\]?/g)) {
      const name = m[1];
      if (!name || seen.has(name)) continue;
      seen.set(name, { file: rel(file), line: lineOf(text, m.index ?? 0) });
    }
  }

  // Set by the platform rather than by us, so their absence from our notes is
  // not a gap in them.
  const AMBIENT = new Set(['NODE_ENV', 'PORT', 'CI', 'PATH', 'HOME', 'VERCEL', 'RAILWAY_ENVIRONMENT']);

  const findings: Finding[] = [];
  for (const [name, where] of seen) {
    if (AMBIENT.has(name)) continue;
    if (documented.includes(name)) continue;
    findings.push({
      severity: 'warning',
      file: where.file,
      line: where.line,
      detail: `${name} is read by the code and documented nowhere`,
    });
  }

  return { id: 'env-docs', title: 'Settings the notes explain', inspected: seen.size, findings };
}

/* ------------------------------------------------------------------ output */

const CHECKS = [checkDeadExports, checkCssVars, checkInternalLinks, checkEnvDocs];

function main(): void {
  const started = Date.now();
  const checks = CHECKS.map((run) => run());

  const errors = checks.reduce((n, c) => n + c.findings.filter((f) => f.severity === 'error').length, 0);
  const warnings = checks.reduce((n, c) => n + c.findings.filter((f) => f.severity === 'warning').length, 0);
  const inspected = checks.reduce((n, c) => n + c.inspected, 0);

  const pass = {
    // Stamped by the caller, not read from the clock inside a check, so two
    // runs over the same tree differ only where the tree does.
    at: Math.floor(started / 1000),
    checks: checks.length,
    inspected,
    errors,
    warnings,
    results: checks,
  };

  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'latest.json'), JSON.stringify(pass, null, 2) + '\n');

  /*
   * History as a summary per pass rather than the whole pass.
   *
   * The findings are in the commit that produced them, so keeping them twice
   * would grow a file forever to say what git already says. This is the strip
   * the page draws, and nothing else needs it.
   *
   * Appended only when it says something new, which is what makes the whole
   * arrangement viable. The workflow commits when this file changes, and the
   * first version appended on every pass: an hourly job would have written
   * eight thousand seven hundred and sixty commits a year to record that
   * nothing had happened, and the guard meant to prevent that could never fire
   * because the file it checked had always changed.
   *
   * So a pass is recorded when the findings differ from the last one, or when
   * half a day has gone by. The second half matters as much as the first: a
   * log that only moves on change cannot be told apart from a job that died,
   * and "last checked" is the one thing a status board must not get wrong.
   */
  const HEARTBEAT_SECONDS = 12 * 60 * 60;
  const historyPath = join(OUT_DIR, 'history.json');
  const history: AuditSummary[] = existsSync(historyPath)
    ? (JSON.parse(readFileSync(historyPath, 'utf8')) as AuditSummary[])
    : [];

  const previous = history[0];
  const sameAsBefore =
    previous !== undefined &&
    previous.errors === errors &&
    previous.warnings === warnings &&
    previous.inspected === inspected;
  const recent = previous !== undefined && pass.at - previous.at < HEARTBEAT_SECONDS;

  if (!sameAsBefore || !recent) {
    history.unshift({ at: pass.at, checks: pass.checks, inspected, errors, warnings });
    writeFileSync(historyPath, JSON.stringify(history.slice(0, 200), null, 2) + '\n');
  }

  for (const c of checks) {
    console.log(`${c.findings.length ? 'FOUND' : 'clean'}  ${c.title}  (${c.inspected} inspected)`);
    for (const f of c.findings) {
      console.log(`   ${f.severity === 'error' ? 'ERROR' : 'warn '}  ${f.file}:${f.line ?? '?'}  ${f.detail}`);
    }
  }
  console.log(`\n${checks.length} checks, ${inspected} inspected, ${errors} errors, ${warnings} warnings`);

  if (process.argv.includes('--check') && errors > 0) process.exit(1);
}

main();
