import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),

  {
    rules: {
      /*
       * A warning, not an error, and the distinction is the point.
       *
       * This rule flags `setState` reached from inside an effect. It cannot see
       * through an `await`, so it fires on the ordinary shape of loading data
       * in a client component — an effect that calls an async function which
       * sets state once the response arrives. Six of those in this app were
       * checked one by one and every setState happens after the await, which is
       * a normal commit and not the cascading render the rule is warning about.
       *
       * It stays on because the shape it describes is a real mistake when it
       * genuinely is synchronous, and two cases here were: a page transition
       * that rendered every navigation twice, and a filter restore that wrote
       * its defaults back over saved settings. Both were found this way and
       * both are fixed.
       *
       * As an error it would fail CI on every commit, and a check that is
       * always red is a check nobody reads. As a warning it is still in front
       * of whoever adds the next effect.
       */
      "react-hooks/set-state-in-effect": "warn",
    },
  },
]);

export default eslintConfig;
