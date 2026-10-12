import { env, RpcStub } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import type { DocumentAccountState } from "../src/documents.js";
import { DocumentSessionImpl } from "../src/session.js";
import {
  DocumentRunner, documentScope, parseRunnerJob, runnerEndpoint, validateOptions, validatePdf,
} from "../src/runner.js";
import type { DocumentJob } from "../src/types.js";
import type { ScopeParent } from "./worker.js";

const health = { version: "1.0.0", capabilities: {
  pdfinfo: true, pdftotext: true, pdftoppm: true, tesseract: true,
} };
const settings = { url: "http://127.0.0.1:8899", token: ["synthetic", "fixture", "credential", "value", "0".repeat(8)].join("-") };
const pdf = new TextEncoder().encode("%PDF-1.4\nsynthetic test input");
const job: DocumentJob = { id: "job-one", operation: "extract", status: "succeeded" };
const metadata = { pageCount: 25, encrypted: false, pdfVersion: "1.4" };
function runner(fetcher: typeof fetch) {
  return new DocumentRunner(settings, "a".repeat(64), fetcher);
}
function session(backend: DocumentRunner, authorize = vi.fn(async () => {}), active = vi.fn(async () => {})) {
  return new DocumentSessionImpl({ runner: backend, assertActive: active,
    approvalQueue: { authorizeObservation: authorize } as unknown as RpcStub<ApprovalQueue> });
}
function json(value: unknown) { return Response.json(value); }

it("accepts only explicitly configured HTTPS or loopback HTTP endpoints", () => {
  expect(runnerEndpoint(settings).hostname).toBe("127.0.0.1");
  expect(() => runnerEndpoint({})).toThrow("not configured");
  for (const url of ["http://example.com", "http://127.0.0.1/a", "https://example.com/?q=a", "https://user:pass@example.com"]) {
    expect(() => runnerEndpoint({ ...settings, url })).toThrow();
  }
});
it("rejects invalid bytes, traversal, excessive resolution and duplicate pages before networking", async () => {
  expect(() => validatePdf(new TextEncoder().encode("not a pdf"))).toThrow();
  expect(() => validatePdf(new Uint8Array(16 * 1024 * 1024 + 1))).toThrow();
  for (const options of [{ operation: "render", dpi: 300 }, { operation: "extract", pages: [1, 1] },
    { operation: "ocr", language: "eng;command" }, { operation: "render", pages: Array.from({ length: 21 }, (_, i) => i + 1) }]) {
    expect(() => validateOptions(options as Parameters<typeof validateOptions>[0])).toThrow();
  }
  const fetcher = vi.fn();
  await expect(session(runner(fetcher)).getStatus("../other")).rejects.toThrow("identifier");
  expect(fetcher).not.toHaveBeenCalled();
});
it("uses different namespaces for account and workspace identities without delimiter ambiguity", async () => {
  expect(await documentScope("account", "workspace")).toMatch(/^[0-9a-f]{64}$/);
  expect(await documentScope("account", "workspace")).not.toBe(await documentScope("other", "workspace"));
  expect(await documentScope("account", "workspace")).not.toBe(await documentScope("account", "other"));
  await expect(documentScope("account\0other", "workspace")).rejects.toThrow();
});
it("preserves complete page text over 2000 characters and parses only successful results", () => {
  const text = "complete text ".repeat(400);
  expect(parseRunnerJob({ ...job, result: { ...metadata, pages: [{ page: 1, text }] } }).result?.textPages?.[0].text).toBe(text);
  expect(() => parseRunnerJob({ ...job, status: "running", result: metadata })).toThrow();
  expect(() => parseRunnerJob({ ...job, result: { ...metadata, pages: [{ page: 1, text }, { page: 1, text }] } })).toThrow();
});
it("authorizes before any backend health check or PDF transmission", async () => {
  const events: string[] = [];
  const fetcher = vi.fn(async (url: RequestInfo | URL) => {
    events.push(String(url).endsWith("/health") ? "health" : "process");
    return json(String(url).endsWith("/health") ? health : { ...job, status: "queued" });
  });
  const authorize = vi.fn(async () => { events.push("authorize"); });
  await session(runner(fetcher), authorize).start(pdf, { operation: "extract" });
  expect(events).toEqual(["authorize", "health", "process"]);
  expect(fetcher.mock.calls[1][0].toString()).toContain(`/v1/scopes/${"a".repeat(64)}/jobs`);
});
it("preserves the branded global fetch receiver in Workers", async () => {
  const fetcher: typeof fetch = async function (this: unknown, url: RequestInfo | URL) {
    if (this !== globalThis) throw new TypeError("Illegal invocation");
    return json(String(url).endsWith("/health") ? health : job);
  };
  expect(await session(runner(fetcher)).getStatus("job-one")).toEqual(job);
});

it("denied observations or revoked accounts transmit no data", async () => {
  const fetcher = vi.fn();
  await expect(session(runner(fetcher), vi.fn(async () => { throw new Error("Denied"); })).start(pdf, { operation: "extract" })).rejects.toThrow("Denied");
  await expect(session(runner(fetcher), vi.fn(), vi.fn(async () => { throw new Error("Revoked"); })).getStatus("job-one")).rejects.toThrow("Revoked");
  expect(fetcher).not.toHaveBeenCalled();
});
it("blocks an account revoked while authorization waits", async () => {
  const fetcher = vi.fn(); let revoked = false;
  const active = vi.fn(async () => { if (revoked) throw new Error("Revoked"); });
  await expect(session(runner(fetcher), vi.fn(async () => { revoked = true; }), active).getStatus("job-one")).rejects.toThrow("Revoked");
  expect(fetcher).not.toHaveBeenCalled();
});
it("refuses backend version mismatch before processing", async () => {
  const fetcher = vi.fn(async () => json({ ...health, version: "2.0.0" }));
  await expect(session(runner(fetcher)).start(pdf, { operation: "extract" })).rejects.toThrow("version");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("reads paginated result at requested offsets and keeps polling content-free", async () => {
  const fetcher = vi.fn(async (url: RequestInfo | URL) => {
    const path = new URL(String(url));
    if (path.pathname === "/health") return json(health);
    if (path.pathname.endsWith("/result")) return json({ ...metadata, totalPages: 25, nextOffset: 3,
      pages: [{ page: 2, text: "complete page two" }, { page: 3, text: "complete page three" }] });
    return json(job);
  });
  const s = session(runner(fetcher));
  expect(await s.getStatus("job-one")).toEqual(job);
  const result = await s.getResult("job-one", { offset: 1, limit: 2 });
  expect(result.textPages?.map(p => p.page)).toEqual([2, 3]);
  expect(result.nextOffset).toBe(3);
  expect(fetcher.mock.calls.map(c => String(c[0]))).toEqual(expect.arrayContaining([expect.stringContaining("/result?offset=1&limit=2")]));
});
it("rejects unbound artifact handles and sanitizes backend errors", async () => {
  const fetcher = vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).endsWith("/health")) return json(health);
    return new Response("sensitive process output", { status: 404 });
  });
  await expect(session(runner(fetcher)).getArtifact("job-one", "artifact")).rejects.toThrow("missing or expired");
});
it("validates malformed arguments with generated decorators in the actual Workers runtime", async () => {
  const fetcher = vi.fn();
  const target = session(runner(fetcher));
  // The generated decorator rejects malformed values synchronously before the RPC method body.
  // Test this inside workerd to avoid the pool reporting an intentionally failed remote call as
  // an unhandled server-side exception, even when the caller catches the RPC rejection.
  expect(() => target.start("not bytes" as unknown as Uint8Array, { operation: "extract" })).toThrow();
  expect(() => target.start(pdf, { operation: "shell" } as unknown as Parameters<typeof target.start>[1])).toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});

it("returns a status receipt through real native Workers RPC", async () => {
  const fetcher = vi.fn(async (url: RequestInfo | URL) => json(String(url).endsWith("/health") ? health : job));
  using stub = new RpcStub(session(runner(fetcher)));
  expect(await stub.getStatus("job-one")).toEqual(job);
});

describe("real Durable Object state and facet authority", () => {
  const testEnv = env as unknown as {
    ACCOUNT_STATE: DurableObjectNamespace<DocumentAccountState>;
    SCOPE_PARENT: DurableObjectNamespace<ScopeParent>;
  };
  it("stores the native account capability used by provisioning", async () => {
    const parent = testEnv.SCOPE_PARENT.getByName("persistent-account-parent");
    expect(await parent.persistedAccount()).toBe("Documents");
  });
  it("permanently revokes existing account authority", async () => {
    const account = testEnv.ACCOUNT_STATE.getByName("revoked-account");
    await expect(account.assertActive()).resolves.toBeUndefined();
    await account.revoke();
    const message = await runInDurableObject(account, async instance => {
      try { await instance.assertActive(); return "allowed"; }
      catch (error) { return error instanceof Error ? error.message : "rejected"; }
    });
    expect(message).toContain("revoked");
  });
  it("inherits parent workspace scope, including sibling facet names", async () => {
    const a = testEnv.SCOPE_PARENT.getByName("workspace-a");
    const b = testEnv.SCOPE_PARENT.getByName("workspace-b");
    const scope = await a.scope("facet-one", "shared-account");
    expect(scope).toBe(await a.scope("facet-two", "shared-account"));
    expect(scope).not.toBe(await b.scope("facet-one", "shared-account"));
    expect(scope).not.toBe(await a.scope("facet-one", "other-account"));
  });
});
