import { build } from 'esbuild';
import { chmodSync } from 'node:fs';

// The workspace packages are TypeScript source, so the server is bundled: the
// SDK, the MCP SDK and their dependencies are inlined into one self-contained
// file. The banner carries the shebang and a createRequire shim, since a
// bundled CommonJS dependency may reach for `require` inside an ESM output.
await build({
  entryPoints: ['src/server.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile: 'dist/server.js',
  banner: {
    js: "#!/usr/bin/env node\nimport{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);",
  },
});
chmodSync('dist/server.js', 0o755);
