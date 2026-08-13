import { build } from 'esbuild';
import { chmodSync } from 'node:fs';

// The workspace packages are TypeScript source, so the binary is bundled: the
// SDK and its dependencies are inlined into one self-contained file. The banner
// carries the shebang and a createRequire shim, since a bundled CommonJS
// dependency may reach for `require` inside an ESM output.
await build({
  entryPoints: ['src/bin.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile: 'dist/bin.js',
  banner: {
    js: "#!/usr/bin/env node\nimport{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
  },
});
chmodSync('dist/bin.js', 0o755);
