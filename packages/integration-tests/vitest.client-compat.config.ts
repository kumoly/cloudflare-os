import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["client-compat/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    env: { WORKSHOP_INTEGRATION_PREBUILT: "1" },
  },
});
