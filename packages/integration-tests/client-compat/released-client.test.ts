import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { diffFiles, type CodeContent } from "@gadgets/workshop-shared/code-change";
import { startHarness, type Harness, type WorkerConfig } from "../src/harness.js";
import { connect, stubFor, WorkpieceRecorder, waitFor } from "../src/rpc-client.js";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const client = join(pkg, "fixtures/openclaw-client");
const snapshot = {cityId: "fixture", timeZone: "America/Los_Angeles", latest: null, lastAttemptAt: null, lastError: null};
const oldBuild = (config: WorkerConfig) => {
  config.main = join(pkg, ".wrangler/client-upgrade-base/bundle/server.js");
  delete config.build;
};

async function seed(harness: Harness, dir: string) {
  using publicApi = connect(harness.url);
  const username = "compatfixture";
  const token = await publicApi.createAccount(username, "Fixture", new Uint8Array(32));
  if (!token) throw new Error("Fixture signup failed");
  using auth = await publicApi.authenticate(token);
  using ws = await auth.newWorkspace();
  const recorder = new WorkpieceRecorder();
  using subscriber = stubFor(recorder);
  using _subscription = await ws.subscribeToWorkpieces(subscriber);
  await recorder.loaded;
  using gadget = await ws.createGadget("Fixture", undefined, "FIXTURE");
  const gadgetId = await gadget.getId();
  const head = await waitFor("fixture head", async () => {
    const value = recorder.summaries.get(gadgetId);
    return value?.type === "gadget" ? value.commitId ?? null : null;
  });
  const files = (text?: string): CodeContent => new Map([[gadgetId,
    new Map(text === undefined ? [] : [["server.js", text]])]]);
  const chat = await ws.newChat("Seed", null);
  await ws.submitCodeChange(chat, {
    generation: 0, revision: 0, clientId: "fixture", seq: 1, pins: [{gadgetId, baseCommit: head}],
    change: diffFiles(files(), files(`import { DurableObject } from 'cloudflare:workers';
      export class Gadget extends DurableObject { getSnapshot() { return ${JSON.stringify(snapshot)}; } }`)),
  });
  expect(await ws.mergeChanges(chat)).toEqual({outcome: "merged"});
  const workspaceId = (await ws.getMetadata()).id;
  writeFileSync(join(dir, "session.json"), JSON.stringify({token}), {mode: 0o600});
  writeFileSync(join(dir, "state.json"), JSON.stringify({workspaceId, gadgetId}), {mode: 0o600});
  const endpoint = new URL("/api", harness.url); endpoint.protocol = "ws:";
  const config = {
    instances: {local: {endpoint: endpoint.toString()}},
    identities: {fixture: {expectedUsername: username, requireNonAdmin: true, sessionFile: join(dir, "session.json")}},
    gadgets: {weather: {instance: "local", stateFile: join(dir, "state.json"), contract: "weather", requireOwner: true}},
    agents: {fixture: {identity: "fixture", allow: {weather: ["snapshot"]}}},
  };
  writeFileSync(join(dir, "client.json"), JSON.stringify(config), {mode: 0o600});
}
async function probe(dir: string) {
  const {stdout} = await promisify(execFile)(process.execPath, [join(client, "probe.mjs"), join(dir, "client.json")], {timeout: 30_000});
  const result = JSON.parse(stdout);
  expect(result.ok).toBe(true);
  expect(result.data).toEqual(snapshot);
}

it("published plugin works against a fresh candidate backend", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cfos-client-"));
  const harness = await startHarness({gatekeepers: [], enableGadgetExecution: true});
  try { await seed(harness, dir); await probe(dir); }
  finally { await harness.server.close(); rmSync(dir, {recursive: true, force: true}); }
});

it("published plugin reuses its old token and gadget IDs after an actual backend version upgrade", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cfos-upgrade-"));
  const harness = await startHarness({gatekeepers: [], enableGadgetExecution: true, patchWorkshop: oldBuild});
  try {
    await seed(harness, dir);
    await probe(dir);
    // One worker only: update completes this worker's reload, and preserves all DO/KV/R2 state.
    await harness.redeployWorkshop();
    // Deliberately do not recreate users, log in, seed gadgets or retry the business call.
    await probe(dir);
  } finally { await harness.server.close(); rmSync(dir, {recursive: true, force: true}); }
});
