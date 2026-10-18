import { RpcStub } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import { DocumentRunner, parseRunnerJob, validateOptions } from "../src/runner.js";
import { DocumentSessionImpl } from "../src/session.js";

const settings = { url: "http://127.0.0.1:8899",
  token: ["synthetic", "parse", "fixture", "0".repeat(32)].join("-") };
const health = { version: "1.1.0", capabilities: {
  pdfinfo: true, pdftotext: true, pdftoppm: true, tesseract: true,
}, features: ["inspect", "extract", "render", "ocr", "parse"], parseReady: true };
const pdf = new TextEncoder().encode("%PDF-1.4\nsynthetic");
const receipt = { id: "parse-one", operation: "parse", status: "succeeded" };
const metadata = { pageCount: 25, encrypted: false, pdfVersion: "1.4" };
function page(number = 2) {
  return { page: number, widthPoints: 600, heightPoints: 800, warnings: [],
    blocks: [{ id: "block-one", order: 0, type: "table", text: "", tableId: "table-one" }],
    tables: [{ id: "table-one", order: 0, sourceLocator: `page:${number}/block:0/table:0`,
      bbox: { left: 0.1, top: 0.2, right: 0.9, bottom: 0.8 }, continuesPrevious: true,
      rowCount: 2, columnCount: 2, cells: [
        { row: 0, col: 0, rowSpan: 1, colSpan: 2, text: "  heading  " },
        { row: 1, col: 0, rowSpan: 1, colSpan: 1, text: "" },
        { row: 1, col: 1, rowSpan: 1, colSpan: 1, text: "7" },
      ] }] };
}
function result(pages: unknown[] = [page()]) {
  return { ...metadata, parser: { name: "mineru", version: "4.0.12", tier: "basic" }, pages };
}
function parse(value: unknown) { return parseRunnerJob({ ...receipt, result: value }); }
function backend(fetcher: typeof fetch) { return new DocumentRunner(settings, "a".repeat(64), fetcher); }
function session(runner: DocumentRunner, authorize = vi.fn(async () => {}), active = vi.fn(async () => {})) {
  return new DocumentSessionImpl({ runner, assertActive: active,
    approvalQueue: { authorizeObservation: authorize } as unknown as RpcStub<ApprovalQueue> });
}

it("validates parse selection limits and rejects unrelated OCR options", () => {
  expect(validateOptions({ operation: "parse", pages: [2, 1] })).toEqual({ operation: "parse", pages: [2, 1] });
  expect(() => validateOptions({ operation: "parse", pages: Array.from({ length: 21 }, (_, i) => i + 1) })).toThrow();
  expect(() => validateOptions({ operation: "parse", dpi: 110 })).toThrow();
  expect(() => validateOptions({ operation: "parse", language: "jpn" })).toThrow();
});
it("preserves native spans, whitespace, empty cells, selected page order and geometry without making cell boxes", () => {
  const parsed = parse(result([page(25), page(2)])).result;
  expect(parsed?.parsedPages?.map(p => p.page)).toEqual([25, 2]);
  expect(parsed?.pageCount).toBe(25);
  expect(parsed?.parser).toEqual({ name: "mineru", version: "4.0.12", tier: "basic" });
  expect(parsed?.parsedPages?.[0].tables[0].cells).toEqual(page().tables[0].cells);
  expect(parsed?.parsedPages?.[0].tables[0].cells[0]).not.toHaveProperty("bbox");
  expect(parsed?.textPages).toBeUndefined();
});

describe("rejects malformed or excessive native structure", () => {
  const cases: [string, (value: ReturnType<typeof result>) => void][] = [
    ["unsupported parser", v => { v.parser.tier = "standard"; }],
    ["invalid parser version", v => { v.parser.version = "local/path"; }],
    ["original page beyond PDF", v => { v.pages = [page(26)]; }],
    ["duplicate page", v => { v.pages = [page(), page()]; }],
    ["too many parsed pages", v => { v.pages = Array.from({ length: 21 }, (_, i) => page(i + 1)); }],
    ["native box outside page", v => { const p = v.pages[0] as ReturnType<typeof page>; p.tables[0].bbox.left = -0.1; }],
    ["inverted native box", v => { const p = v.pages[0] as ReturnType<typeof page>; p.tables[0].bbox.top = 0.9; }],
    ["nonfinite dimension", v => { (v.pages[0] as ReturnType<typeof page>).widthPoints = Infinity; }],
    ["wrong page locator", v => { (v.pages[0] as ReturnType<typeof page>).tables[0].sourceLocator = "page:1/block:0/table:0"; }],
    ["filesystem provenance", v => { (v.pages[0] as ReturnType<typeof page>).tables[0].sourceLocator = "/tmp/private.pdf"; }],
    ["dangling block table", v => { (v.pages[0] as ReturnType<typeof page>).blocks[0].tableId = "missing"; }],
    ["out-of-grid span", v => { (v.pages[0] as ReturnType<typeof page>).tables[0].cells[0].colSpan = 3; }],
    ["overlapping cells", v => { const p = v.pages[0] as ReturnType<typeof page>; p.tables[0].cells.push({ ...p.tables[0].cells[0] }); }],
    ["oversized text", v => { (v.pages[0] as ReturnType<typeof page>).tables[0].cells[0].text = "x".repeat(65_537); }],
    ["expanded slots", v => { const t = (v.pages[0] as ReturnType<typeof page>).tables[0]; t.rowCount = 1000; t.columnCount = 1000;
      t.cells = [{ row: 0, col: 0, rowSpan: 1000, colSpan: 1000, text: "" }]; }],
    ["excess blocks", v => { const p = v.pages[0] as ReturnType<typeof page>; p.blocks = Array.from({ length: 1001 }, (_, i) => ({ ...p.blocks[0], id: `b${i}` })); }],
    ["excess cells", v => { const t = (v.pages[0] as ReturnType<typeof page>).tables[0]; t.cells = Array.from({ length: 5001 }, () => ({ ...t.cells[0] })); }],
    ["invented cell geometry", v => { Object.assign((v.pages[0] as ReturnType<typeof page>).tables[0].cells[0], { bbox: { left: 0, top: 0, right: 1, bottom: 1 } }); }],
  ];
  it.each(cases)("%s", (_name, mutate) => {
    const value = result(); mutate(value);
    expect(() => parse(value)).toThrow("structured document");
  });
});
it("allows an empty recognized page without asserting that the original page is blank", () => {
  const p = { page: 1, blocks: [], tables: [], warnings: ["NO_RECOGNIZED_CONTENT"] };
  expect(parse(result([p])).result?.parsedPages).toEqual([p]);
});
it("negotiates old runner compatibility without sending parse bytes", async () => {
  const fetcher = vi.fn(async () => Response.json({ version: "1.0.0", capabilities: health.capabilities }));
  await expect(session(backend(fetcher)).start(pdf, { operation: "parse" })).rejects.toThrow("not ready");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each([
  { ...health, features: ["inspect", "extract", "render", "ocr"] },
  { ...health, parseReady: false },
])("requires advertised parsing and ready local models before transmitting bytes", async response => {
  const fetcher = vi.fn(async () => Response.json(response));
  await expect(session(backend(fetcher)).start(pdf, { operation: "parse" })).rejects.toThrow("not ready");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("reauthorizes and refreshes readiness on each parse attempt", async () => {
  const events: string[] = []; let ready = true;
  const fetcher = vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).endsWith("/health")) { events.push("health"); return Response.json({ ...health, parseReady: ready }); }
    events.push("process"); return Response.json({ ...receipt, status: "queued" });
  });
  const target = session(backend(fetcher), vi.fn(async () => { events.push("authorize"); }));
  await target.start(pdf, { operation: "parse", pages: [2, 1] });
  ready = false;
  await expect(target.start(pdf, { operation: "parse" })).rejects.toThrow("not ready");
  expect(events).toEqual(["authorize", "health", "process", "authorize", "health"]);
});
it("returns typed paginated native structure through real RPC even when models are no longer ready", async () => {
  const fetcher = vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).endsWith("/health")) return Response.json({ ...health, parseReady: false });
    if (String(url).includes("/result?")) return Response.json({ ...result([page(25)]), totalPages: 2 });
    return Response.json(receipt);
  });
  using stub = new RpcStub(session(backend(fetcher)));
  const value = await stub.getResult("parse-one", { offset: 1, limit: 1 });
  expect(value.metadata).toEqual(metadata);
  expect(value.parser?.name).toBe("mineru");
  expect(value.parsedPages?.[0].page).toBe(25);
  expect(value.metadata).not.toHaveProperty("parsedPages");
  expect(value.metadata).not.toHaveProperty("parser");
});
it("rejects malformed parse pagination and oversized JSON instead of truncating", async () => {
  const fetcher = vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).endsWith("/health")) return Response.json(health);
    if (String(url).includes("/result?")) return Response.json({ ...result(), totalPages: 2, nextOffset: 2 });
    return Response.json(receipt);
  });
  await expect(session(backend(fetcher)).getResult("parse-one", { limit: 1 })).rejects.toThrow("pagination");
  const large = backend(vi.fn(async (url: RequestInfo | URL) => String(url).endsWith("/health")
    ? Response.json(health) : new Response(" ".repeat(8 * 1024 * 1024 + 1))));
  await expect(large.result("parse-one", "parse")).rejects.toThrow("response limit");
});
it("keeps parse and retry behind observation approval and durable revocation", async () => {
  const fetcher = vi.fn();
  const denied = session(backend(fetcher), vi.fn(async () => { throw new Error("Denied"); }));
  await expect(denied.start(pdf, { operation: "parse" })).rejects.toThrow("Denied");
  await expect(denied.retry("parse-one")).rejects.toThrow("Denied");
  const revoked = session(backend(fetcher), vi.fn(), vi.fn(async () => { throw new Error("Revoked"); }));
  await expect(revoked.getResult("parse-one")).rejects.toThrow("Revoked");
  expect(fetcher).not.toHaveBeenCalled();
});
it("checks current parser readiness before retrying retained parse input", async () => {
  const fetcher = vi.fn(async (url: RequestInfo | URL) => String(url).endsWith("/health")
    ? Response.json({ ...health, parseReady: false }) : Response.json({ ...receipt, status: "failed" }));
  await expect(session(backend(fetcher)).retry("parse-one")).rejects.toThrow("not ready");
  expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/retry"))).toBe(false);
});
it("bounds expanded cell slots across pages and total cells across tables", () => {
  const pages = [page(1), page(2)];
  for (const p of pages) {
    const t = p.tables[0]; t.rowCount = 300; t.columnCount = 200;
    t.cells = [{ row: 0, col: 0, rowSpan: 300, colSpan: 200, text: "" }];
  }
  expect(() => parse(result(pages))).toThrow("structured document");
  const p = page();
  p.tables = [0, 1].map(index => ({ ...p.tables[0], id: `table-${index}`,
    sourceLocator: `page:2/block:0/table:${index}`, rowCount: 300, columnCount: 10,
    cells: Array.from({ length: index ? 2001 : 3000 }, (_, i) => ({
      row: Math.floor(i / 10), col: i % 10, rowSpan: 1, colSpan: 1, text: "",
    })) }));
  p.blocks = [];
  expect(() => parse(result([p]))).toThrow("structured document");
});
it("preserves a native empty table without filling its grid", () => {
  const p = page(); p.tables[0].rowCount = 0; p.tables[0].columnCount = 0; p.tables[0].cells = [];
  expect(parse(result([p])).result?.parsedPages?.[0].tables[0].cells).toEqual([]);
});
it("keeps original operations compatible with a 1.1 runner without a parser", async () => {
  const fetcher = vi.fn(async (url: RequestInfo | URL) => String(url).endsWith("/health")
    ? Response.json({ ...health, features: ["inspect", "extract", "render", "ocr"], parseReady: false })
    : Response.json({ id: "extract-one", operation: "extract", status: "queued" }));
  expect((await session(backend(fetcher)).start(pdf, { operation: "extract" })).operation).toBe("extract");
});
