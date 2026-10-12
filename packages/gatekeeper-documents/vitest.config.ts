import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";
import deployed from "./cloudflare.config.ts";

export default defineConfig({
  plugins: [capnwebValidate(), cloudflareTest({
    main: "./__tests__/worker.ts",
    miniflare: {
      compatibilityDate: deployed.worker.compatibilityDate,
      compatibilityFlags: deployed.worker.compatibilityFlags,
      durableObjects: {
        ACCOUNT_STATE: { className: "DocumentAccountState", useSQLite: true },
        SCOPE_PARENT: { className: "ScopeParent", useSQLite: true },
        SCOPE_FACET: { className: "ScopeFacet", useSQLite: true },
      },
    },
  })],
  test: { include: ["__tests__/*.test.ts"], setupFiles: ["@gadgets/scripts/assert-workerd"] },
});
