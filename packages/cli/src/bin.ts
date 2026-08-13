// The shebang is added by the bundler (see build.mjs).
import { run } from './cli';

run(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(2);
  });
