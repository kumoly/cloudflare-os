import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { createDocumentRunner } from "./server.mjs";

const scope = "a".repeat(64);
const otherScope = "b".repeat(64);
const token = randomUUID().replaceAll("-", "");
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const dummyPdf = Buffer.from("%PDF-1.4\nnot a real PDF").toString("base64");

async function fixture(t, options = {}) {
  const runner = createDocumentRunner({ token, ...options });
  const base = await runner.listen(0);
  t.after(() => runner.close());
  async function request(path, method = "GET", value) {
    const requestOptions = { method, headers };
    if (value !== undefined) requestOptions.body = JSON.stringify(value);
    return fetch(`${base}${path}`, requestOptions);
  }
  async function start(operation = "inspect", extra = {}) {
    const res = await request(`/v1/scopes/${scope}/jobs`, "POST", { operation, inputBase64: dummyPdf, ...extra });
    assert.equal(res.status, 202);
    return res.json();
  }
  async function status(id) { return (await request(`/v1/scopes/${scope}/jobs/${id}`)).json(); }
  async function done(id) {
    for (let i = 0; i < 600; i++) {
      const job = await status(id);
      if (["succeeded", "failed", "cancelled"].includes(job.status)) {
        assert.equal(job.result, undefined, "Polling status must not carry document content");
        if (job.status === "succeeded") job.result = await (await request(`/v1/scopes/${scope}/jobs/${id}/result`)).json();
        return job;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("Job did not terminate");
  }
  return { runner, base, request, start, status, done };
}

test("authentication, invalid options and invalid scopes fail without diagnostics", async (t) => {
  const { base, request } = await fixture(t);
  const denied = await fetch(`${base}/health`);
  assert.equal(denied.status, 401);
  assert.deepEqual(await denied.json(), { errorCode: "UNAUTHORIZED" });
  assert.equal((await request("/v1/scopes/../jobs", "POST", {})).status, 404);
  for (const extra of [
    { operation: "shell" }, { pages: [0] }, { pages: [1, 1] }, { dpi: 300 },
    { language: "eng;echo" }, { filename: "/private/file" }, { inputBase64: "%%%" },
  ]) {
    const res = await request(`/v1/scopes/${scope}/jobs`, "POST", { operation: "inspect", inputBase64: dummyPdf, ...extra });
    assert.equal(res.status, 400);
    assert.match((await res.json()).errorCode, /^INVALID_/);
  }
});

test("missing tools fail with generic errors and jobs/artifacts are scoped", async (t) => {
  const missing = join(tmpdir(), randomUUID(), "not-installed");
  const { start, request, done } = await fixture(t, { tools: { pdfinfo: missing } });
  const job = await start();
  assert.deepEqual(await done(job.id), { id: job.id, operation: "inspect", status: "failed", errorCode: "TOOL_UNAVAILABLE" });
  assert.equal((await request(`/v1/scopes/${otherScope}/jobs/${job.id}`)).status, 404);
  assert.equal((await request(`/v1/scopes/${otherScope}/jobs/${job.id}/cancel`, "POST")).status, 404);
  const retry = await request(`/v1/scopes/${scope}/jobs/${job.id}/retry`, "POST");
  assert.equal(retry.status, 202);
  assert.notEqual((await retry.json()).id, job.id);
  const deleted = await request(`/v1/scopes/${scope}/jobs`, "DELETE");
  assert.equal(deleted.status, 200);
  assert.equal((await request(`/v1/scopes/${scope}/jobs/${job.id}`)).status, 404);
});

test("input and job queue are bounded; running and queued jobs cancel and timeout", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cfos-runner-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tool = join(dir, "slow-tool");
  await writeFile(tool, `#!${process.execPath}\nsetTimeout(() => process.exit(0), 60000);\n`, { mode: 0o700 });
  const { start, request, done } = await fixture(t, {
    tools: { pdfinfo: tool }, limits: { jobs: 2, concurrency: 1, inputBytes: 100, timeoutMs: 500 },
  });
  const tooLarge = await request(`/v1/scopes/${scope}/jobs`, "POST", {
    operation: "inspect", inputBase64: Buffer.from("%PDF-" + "x".repeat(101)).toString("base64"),
  });
  assert.equal(tooLarge.status, 413);
  const running = await start();
  const queued = await start();
  assert.equal((await request(`/v1/scopes/${scope}/jobs`, "POST", { operation: "inspect", inputBase64: dummyPdf })).status, 429);
  assert.equal((await request(`/v1/scopes/${scope}/jobs/${queued.id}/cancel`, "POST")).status, 200);
  assert.equal((await done(queued.id)).status, "cancelled");
  await request(`/v1/scopes/${scope}/jobs/${running.id}/cancel`, "POST");
  assert.equal((await done(running.id)).status, "cancelled");
  await request(`/v1/scopes/${scope}/jobs`, "DELETE");
  const timed = await start();
  const result = await done(timed.id);
  assert.equal(result.status, "failed");
  assert.equal(result.errorCode, "TIMEOUT");
});

test("completed job retention expires and temporary directories are removed", async (t) => {
  const before = new Set((await readdir(tmpdir())).filter((name) => name.startsWith("cfos-pdf-")));
  const { start, done, request } = await fixture(t, {
    tools: { pdfinfo: join(tmpdir(), randomUUID(), "not-installed") }, limits: { expiryMs: 40 },
  });
  const job = await start();
  await done(job.id);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await request(`/v1/scopes/${scope}/jobs/${job.id}`)).status, 404);
  const after = (await readdir(tmpdir())).filter((name) => name.startsWith("cfos-pdf-") && !before.has(name));
  assert.deepEqual(after, []);
});

test("concurrent streamed submissions cannot exceed the retained job count", async (t) => {
  const { base } = await fixture(t, {
    tools: { pdfinfo: join(tmpdir(), randomUUID(), "not-installed") }, limits: { jobs: 1 },
  });
  const responses = await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
    const req = httpRequest(`${base}/v1/scopes/${scope}/jobs`, { method: "POST", headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    // Leave every request awaiting its body before completing any submission.
    req.write('{"operation":"inspect",');
    setTimeout(() => req.end(`"inputBase64":"${dummyPdf}"}`), 40);
  })));
  assert.equal(responses.filter((code) => code === 202).length, 1);
  assert.equal(responses.filter((code) => code === 429).length, 5);
});

function syntheticPdf(width = 612, height = 792) {
  const objects = [];
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push("<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>");
  objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>`);
  objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const longText = Array.from({ length: 58 }, (_, i) => `(${String(i).padStart(2, "0")} Synthetic complete extraction line repeated content.) Tj 0 -12 Td`).join("\n");
  for (const stream of [`BT /F1 8 Tf 40 750 Td\n${longText}\nET`, "BT /F1 32 Tf 50 700 Td (Synthetic OCR Document) Tj ET"]) {
    objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf).toString("base64");
}

const toolEnv = { ...process.env, PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" };
const actualTools = ["pdfinfo", "pdftotext", "pdftoppm", "tesseract"].every((tool) =>
  spawnSync(tool, [tool === "tesseract" ? "--version" : "-v"], { env: toolEnv, stdio: "ignore" }).status === 0);

test("actual Poppler and Tesseract inspect, complete text, image and OCR E2E", async (t) => {
  assert.ok(actualTools, "Install Poppler and Tesseract before running document runner E2E tests");
  const { start, done, request } = await fixture(t);
  const health = await (await request("/health")).json();
  assert.equal(health.version, "1.0.0");
  assert.ok(Object.values(health.capabilities).every(Boolean));
  const inputBase64 = syntheticPdf();
  const info = await done((await start("inspect", { inputBase64 })).id);
  assert.equal(info.status, "succeeded");
  assert.equal(info.result.pageCount, 2);
  const extracted = await done((await start("extract", { inputBase64 })).id);
  assert.equal(extracted.status, "succeeded");
  assert.equal(extracted.result.pages.length, 2);
  assert.ok(extracted.result.pages[0].text.length > 2000);
  assert.match(extracted.result.pages[0].text, /57 Synthetic complete/);
  assert.match(extracted.result.pages[1].text, /Synthetic OCR Document/);
  const firstPage = await (await request(`/v1/scopes/${scope}/jobs/${extracted.id}/result?offset=0&limit=1`)).json();
  assert.equal(firstPage.pages.length, 1);
  assert.equal(firstPage.totalPages, 2);
  assert.equal(firstPage.nextOffset, 1);
  assert.equal((await request(`/v1/scopes/${scope}/jobs/${extracted.id}/result?limit=21`)).status, 400);
  const rendered = await done((await start("render", { inputBase64, pages: [2] })).id);
  assert.equal(rendered.status, "succeeded");
  const artifact = rendered.result.pages[0];
  const imageRes = await request(`/v1/scopes/${scope}/jobs/${rendered.id}/artifacts/${artifact.artifactId}`);
  assert.equal(imageRes.status, 200);
  assert.equal(imageRes.headers.get("content-type"), "image/png");
  const image = Buffer.from(await imageRes.arrayBuffer());
  assert.equal(image.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal((await request(`/v1/scopes/${otherScope}/jobs/${rendered.id}/artifacts/${artifact.artifactId}`)).status, 404);
  const ocr = await done((await start("ocr", { inputBase64, pages: [2] })).id);
  assert.equal(ocr.status, "succeeded");
  assert.match(ocr.result.pages[0].text, /Synthetic OCR Document/);
  const badPage = await done((await start("extract", { inputBase64, pages: [3] })).id);
  assert.equal(badPage.errorCode, "INVALID_PAGES");
});

test("actual processing fails explicitly on text, page and image dimension budgets", async (t) => {
  assert.ok(actualTools, "Install Poppler and Tesseract before running document runner E2E tests");
  const inputBase64 = syntheticPdf();
  const output = await fixture(t, { limits: { outputBytes: 256 } });
  const text = await output.done((await output.start("extract", { inputBase64 })).id);
  assert.equal(text.errorCode, "OUTPUT_LIMIT");
  assert.equal(text.result, undefined);
  const pages = await fixture(t, { limits: { pages: 1 } });
  assert.equal((await pages.done((await pages.start("inspect", { inputBase64 })).id)).errorCode, "PAGE_LIMIT");
  const images = await fixture(t, { limits: { imagePages: 1 } });
  assert.equal((await images.done((await images.start("render", { inputBase64 })).id)).errorCode, "PAGE_LIMIT");
  const huge = await fixture(t);
  const image = await huge.done((await huge.start("render", { inputBase64: syntheticPdf(100000, 100000), pages: [1] })).id);
  assert.equal(image.errorCode, "IMAGE_DIMENSION_LIMIT");
});
