import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // See test-support/server-only.ts: without this, nothing under app/lib
      // can be imported by a test at all.
      'server-only': fileURLToPath(new URL('./test-support/server-only.ts', import.meta.url)),
    },
  },
  test: {
    /*
     * `scripts` was missing, the same gap the typechecker had.
     *
     * The audit gates CI now, and a gate whose own tests are never collected is
     * a gate that reports green because nothing ran. Between this and the
     * typecheck, `scripts` was the one directory in the workspace that neither
     * tool looked at, which is how two of the scripts in it had been unable to
     * run at all without anybody hearing about it.
     */
    include: [
      'packages/*/test/**/*.test.ts',
      'app/**/*.test.ts',
      'scripts/__tests__/**/*.test.ts',
    ],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
    },
  },
});
