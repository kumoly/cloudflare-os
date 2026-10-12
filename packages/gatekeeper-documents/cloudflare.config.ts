import {
  DEFAULT_GATEKEEPER_WRANGLER, OBSERVABILITY, defineGadgetsWorker,
  type DurableObjectMigration,
} from "@gadgets/scripts/worker-config";

export default defineGadgetsWorker({
  name: "gatekeeper-documents",
  entrypoint: ".wrangler/validate/src/worker.ts",
  compatibilityFlags: ["allow_irrevocable_stub_storage", "nodejs_als"],
  observability: OBSERVABILITY,
});
export const wrangler = DEFAULT_GATEKEEPER_WRANGLER;
/** Account revocation and inherited workspace capabilities use SQLite-backed Durable Objects. */
export const migrations: DurableObjectMigration[] = [
  { tag: "v1", new_sqlite_classes: ["DocumentAccountState", "DocumentsGatekeeper"] },
];
