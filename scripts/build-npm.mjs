#!/usr/bin/env node
/**
 * Build the two packages that go to npm, into a directory that is published
 * as-is.
 *
 * Why a staging directory rather than publishing the package folder. Inside
 * this repo every package resolves through `main: ./src/index.ts`, which is
 * what lets the app and the tests import them without a build step. A published
 * package has to point at compiled JavaScript instead. Those two cannot both be
 * the `main` field of one file.
 *
 * `publishConfig` looks like the answer and is not: npm 11 carries `access` and
 * `registry` through and ignores field overrides for `main`, `types` and
 * `exports`. Verified before relying on it, by packing a probe package and
 * reading back what landed in the tarball, which still said `./src/index.ts`.
 *
 * So the repo's package.json is left exactly as it is and the thing published
 * is assembled here: compiled output, a manifest written for consumers, the
 * licence and the readme. `npm publish packages/<name>/npm` takes a directory,
 * so nothing has to be moved or restored afterwards and a failed publish leaves
 * no half-edited manifest behind.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Give every relative import the file extension Node insists on.
 *
 * This repo compiles with `moduleResolution: bundler`, so its source writes
 * `from './leaf'` and tsc emits that specifier unchanged. Node's ESM loader
 * does not guess extensions, so a package published that way throws
 * ERR_MODULE_NOT_FOUND on first import.
 *
 * Fixing it at the source was the obvious move and was wrong: the app resolves
 * these packages through `main: ./src/index.ts` and Turbopack hands the raw
 * TypeScript to its own resolver, which does not map a `.js` specifier back
 * onto the `.ts` file beside it the way tsc does. Every relative import in the
 * two packages became unresolvable and the site stopped building.
 *
 * So the extensions are added to the compiled output, where they are correct
 * for the only consumer that output has. Both `.js` and `.d.ts` are rewritten,
 * because a declaration file with an extensionless specifier fails exactly the
 * same way under `moduleResolution: nodenext`.
 */
function addExtensions(dir) {
  const specifier = /(from\s+['"])(\.\.?\/[^'"]+)(['"])/g;
  let changed = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      changed += addExtensions(join(dir, entry.name));
      continue;
    }
    if (!/\.(js|d\.ts)$/.test(entry.name)) continue;
    const file = join(dir, entry.name);
    const before = readFileSync(file, 'utf8');
    const after = before.replace(specifier, (whole, open, spec, close) =>
      spec.endsWith('.js') ? whole : `${open}${spec}.js${close}`,
    );
    if (after !== before) {
      writeFileSync(file, after);
      changed += 1;
    }
  }
  return changed;
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Published together, and in this order: the SDK depends on commit. */
const VERSION = '0.1.0';

const REPOSITORY = 'https://github.com/ProbatioHQ/probatio';

const COMMON = {
  license: 'MIT',
  author: 'ProbatioHQ',
  homepage: 'https://probatiotrade.com',
  bugs: { url: `${REPOSITORY}/issues` },
  engines: { node: '>=18' },
  // Nothing in either package runs at import time, so a bundler is free to drop
  // whatever the caller does not use.
  sideEffects: false,
  publishConfig: { access: 'public' },
};

const PACKAGES = [
  {
    dir: 'commit',
    name: '@probatio/commit',
    description:
      'Canonical trade encoding, merkle trees and proofs. The primitives that make a Probatio record checkable by someone who does not trust Probatio.',
    keywords: ['merkle', 'merkle-tree', 'merkle-proof', 'hash', 'verification', 'probatio'],
    dependencies: { '@noble/hashes': '^2.0.1', bs58: '^6.0.0' },
  },
  {
    dir: 'sdk',
    name: '@probatio/sdk',
    description:
      'Read a Probatio trading record and verify it yourself. Rehashes every fill against the seal recorded with it and rebuilds the root, locally.',
    keywords: ['probatio', 'solana', 'trading', 'verification', 'merkle', 'audit'],
    dependencies: { '@probatio/commit': `^${VERSION}` },
  },
  {
    dir: 'cli',
    name: '@probatio/cli',
    description:
      'Verify a Probatio record from your terminal. Prints every check and sets its exit code to the verdict.',
    keywords: ['probatio', 'cli', 'verification', 'solana', 'trading', 'audit'],
    dependencies: { '@probatio/sdk': `^${VERSION}` },
    // Bundled by esbuild rather than compiled by tsc: it needs a shebang, one
    // executable file and no import of its own internals at runtime.
    bundled: true,
    bin: { probatio: './dist/bin.js' },
  },
];

function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit' });
}

for (const pkg of PACKAGES) {
  const from = join(root, 'packages', pkg.dir);
  const out = join(from, 'npm');

  console.log(`\n[npm] building ${pkg.name}`);
  rmSync(out, { recursive: true, force: true });
  rmSync(join(from, 'dist'), { recursive: true, force: true });
  if (pkg.bundled) {
    execFileSync('node', ['build.mjs'], { cwd: from, stdio: 'inherit' });
  } else {
    run('npx', ['tsc', '-p', join('packages', pkg.dir, 'tsconfig.build.json')]);
  }

  mkdirSync(out, { recursive: true });
  cpSync(join(from, 'dist'), join(out, 'dist'), { recursive: true });
  // A bundle has no relative imports left to fix, and rewriting inside one
  // would only risk touching a string that happens to look like a specifier.
  if (!pkg.bundled) {
    console.log(`[npm] extensions added in ${addExtensions(join(out, 'dist'))} file(s)`);
  }
  // tsc leaves its incremental state in the output directory; it is not part of
  // the package and publishing it would leak absolute paths from this machine.
  rmSync(join(out, 'dist', 'tsconfig.tsbuildinfo'), { force: true });

  cpSync(join(from, 'README.md'), join(out, 'README.md'));
  cpSync(join(root, 'LICENSE-MIT'), join(out, 'LICENSE'));

  const manifest = {
    name: pkg.name,
    version: VERSION,
    description: pkg.description,
    keywords: pkg.keywords,
    ...COMMON,
    repository: { type: 'git', url: `git+${REPOSITORY}.git`, directory: `packages/${pkg.dir}` },
    type: 'module',
    // Both spellings, because `exports` is what modern resolvers read and
    // `main` is what anything older falls back to. They point at the same file.
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    main: './dist/index.js',
    types: './dist/index.d.ts',
    files: ['dist', 'README.md', 'LICENSE'],
    dependencies: pkg.dependencies,
  };

  // A command is not imported, so it publishes a `bin` and none of the entry
  // points a library needs. Leaving `main` pointing at an index that the
  // bundle does not emit would be a broken import waiting for someone to try.
  if (pkg.bin) {
    manifest.bin = pkg.bin;
    delete manifest.exports;
    delete manifest.main;
    delete manifest.types;
  }

  writeFileSync(join(out, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[npm] staged at packages/${pkg.dir}/npm`);
}

// The source entry points must survive this: if either package.json ever starts
// pointing at dist, the app and the tests break the moment dist is stale.
for (const pkg of PACKAGES) {
  const manifest = JSON.parse(readFileSync(join(root, 'packages', pkg.dir, 'package.json'), 'utf8'));
  if (manifest.main !== './src/index.ts') {
    throw new Error(`${pkg.name}: the workspace manifest should still point at src, got ${manifest.main}`);
  }
}

console.log('\n[npm] done. Publish with:');
for (const pkg of PACKAGES) console.log(`  npm publish packages/${pkg.dir}/npm`);
