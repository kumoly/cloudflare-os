import { withVitestTask } from "@gadgets/scripts/vitest-task";
/** Run native document tests in the root cached build/test pipeline. */
export default withVitestTask({}, "vitest run");
