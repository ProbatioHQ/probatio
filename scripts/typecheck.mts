/**
 * Typecheck every project in the workspace.
 *
 * `npm run typecheck` used to be `tsc --build --force`, which needs either a
 * root project with references or `composite: true` on each package. This
 * repository has neither — there is a `tsconfig.base.json` that the packages
 * extend, and no root `tsconfig.json` at all. So the command failed on every
 * run with "Cannot read file tsconfig.json", and had done since it was written.
 *
 * Nothing caught it because nothing ran it: there was no CI, and checking a
 * single project by hand is what everyone actually did.
 *
 * Each project is checked on its own rather than through a build graph. That is
 * slower than an incremental build and it needs no `composite` flags, no emitted
 * declarations and no ordering — for twenty-two small packages the difference is
 * seconds, and the cheaper thing to get right is the one that runs.
 *
 *   npm run typecheck
 */
import { readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/*
 * Where a project's config lives, since one of them is not `<dir>/tsconfig.json`.
 *
 * `scripts` was missing from this list entirely, and it is the directory that
 * drives the restore drill, loads the database and runs the audit. Two of those
 * had been sitting with a required property missing from a call, unable to run
 * at all, because the only place in the workspace that would have said so was
 * never pointed at them.
 */
const projects: readonly { name: string; config: string }[] = [
  ...readdirSync('packages')
    .map((name) => ({ name: `packages/${name}`, config: `packages/${name}/tsconfig.json` }))
    .filter((p) => existsSync(p.config)),
  { name: 'app', config: 'app/tsconfig.json' },
  { name: 'scripts', config: 'tsconfig.scripts.json' },
].sort((a, b) => a.name.localeCompare(b.name));

let failed = 0;

for (const project of projects) {
  const result = spawnSync(
    'npx',
    ['tsc', '--noEmit', '-p', project.config],
    { encoding: 'utf8' },
  );

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (result.status === 0 && output === '') {
    console.log(`  ok    ${project.name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${project.name}`);
    for (const line of output.split('\n').slice(0, 12)) console.log(`        ${line}`);
  }
}

console.log(
  failed === 0
    ? `\n${projects.length} projects typecheck clean`
    : `\n${failed} of ${projects.length} projects failed`,
);

// A non-zero exit is the whole point: this runs in CI.
process.exit(failed === 0 ? 0 : 1);
