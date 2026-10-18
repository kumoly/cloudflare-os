import { withTestTimeout } from "@gadgets/scripts/vitest-task";

/** Real CLI tests stay uncached so installed tools are verified on every host. */
export default {
  run: {
    tasks: {
      test: {
        command: withTestTimeout('node --test src/*.test.mjs && python3 -B -m unittest discover -s src -p "*_test.py"'),
        // Uncached tasks retain their environment. TESTS_WITH_TIMEOUT_ENV is needed only
        // for cached tasks (see @gadgets/scripts/vitest-task).
        cache: false,
      },
    },
  },
};
