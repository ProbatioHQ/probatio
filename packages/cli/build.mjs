import { build } from 'esbuild';
import { chmodSync } from 'node:fs';

/*
 * One file, and the SDK left out of it.
 *
 * This used to bundle @probatio/sdk in, because the workspace packages were
 * TypeScript source with nothing on npm to depend on. There is now, so the
 * binary imports it like anybody else would.
 *
 * That is the point rather than a tidiness preference. The docs call this "the
 * SDK as a command", and a reader can only check that claim if the dependency
 * is visible in the package rather than compiled into an opaque blob. The
 * verifier a person runs should be the verifier they can read.
 *
 * Still bundled otherwise, so the CLI's own modules land in one file with the
 * shebang on top. The createRequire shim stays: a CommonJS dependency reaching
 * for `require` inside ESM output would otherwise throw at startup.
 */
await build({
  entryPoints: ['src/bin.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile: 'dist/bin.js',
  external: ['@probatio/sdk', '@probatio/commit'],
  banner: {
    js: "#!/usr/bin/env node\nimport{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
  },
});
chmodSync('dist/bin.js', 0o755);
