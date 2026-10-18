import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MineruWorker, MineruError } from "./mineru-worker.mjs";

const VERSION = "1.1.0";
const SCOPE = /^[a-f0-9]{64}$/;
const ID = /^[a-f0-9-]{36}$/;
const OPERATIONS = new Set(["inspect", "extract", "render", "ocr", "parse"]);
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const DEFAULT_LIMITS = {
  inputBytes: 16 * 1024 * 1024,
  outputBytes: 8 * 1024 * 1024,
  retainedBytes: 128 * 1024 * 1024,
  pages: 200,
  imagePages: 20,
  pixels: 4_000_000,
  concurrency: 2,
  jobs: 32,
  timeoutMs: 120_000,
  expiryMs: 600_000,
};

class RunnerError extends Error {
  constructor(code, httpStatus = 400) {
    super(code);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

async function body(req, limit, accounting) {
  const chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of req) {
      bytes += chunk.length;
      accounting.add(chunk.length);
      if (bytes > limit) throw new RunnerError("INPUT_LIMIT", 413);
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch { throw new RunnerError("INVALID_REQUEST"); }
  } finally {
    accounting.release(bytes);
  }
}

function requestInput(value, limits) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some((key) => !["operation", "inputBase64", "pages", "dpi", "language"].includes(key))
      || !OPERATIONS.has(value.operation) || typeof value.inputBase64 !== "string"
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.inputBase64)) {
    throw new RunnerError("INVALID_REQUEST");
  }
  const input = Buffer.from(value.inputBase64, "base64");
  if (!input.length || input.length > limits.inputBytes) throw new RunnerError("INPUT_LIMIT", 413);
  if (!input.subarray(0, 1024).includes(Buffer.from("%PDF-"))) throw new RunnerError("INVALID_PDF");
  if (value.pages !== undefined && (!Array.isArray(value.pages) || !value.pages.length
      || value.pages.length > limits.pages || value.pages.some((p) => !Number.isSafeInteger(p) || p < 1)
      || new Set(value.pages).size !== value.pages.length)) throw new RunnerError("INVALID_PAGES");
  if (value.operation === "parse" && (value.dpi !== undefined || value.language !== undefined)) {
    throw new RunnerError("INVALID_PARSE_OPTIONS");
  }
  if (value.operation === "parse" && value.pages?.length > 20) throw new RunnerError("PAGE_LIMIT");
  const dpi = value.dpi ?? 110;
  if (!Number.isSafeInteger(dpi) || dpi < 72 || dpi > 144) throw new RunnerError("INVALID_DPI");
  const language = value.language ?? "eng";
  if (typeof language !== "string" || !/^[a-z_]{2,16}(?:\+[a-z_]{2,16}){0,3}$/.test(language)) {
    throw new RunnerError("INVALID_LANGUAGE");
  }
  return { input, operation: value.operation, pages: value.pages, dpi, language };
}

function summary(job) {
  const value = { id: job.id, status: job.status, operation: job.operation };
  if (job.errorCode) value.errorCode = job.errorCode;
  return value;
}

function runTool(binary, args, { signal, cwd, maxBytes }) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new RunnerError("CANCELLED"));
    const child = spawn(binary, args, {
      cwd,
      // Deliberately omit the runner token, deployment credentials and caller environment.
      env: { PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", LANG: "C", HOME: cwd, TMPDIR: cwd },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    const chunks = [];
    let bytes = 0;
    let failure;
    const stop = () => child.kill("SIGKILL");
    signal.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        failure = new RunnerError("OUTPUT_LIMIT");
        stop();
      } else chunks.push(chunk);
    });
    // Drain stderr without retaining potentially sensitive parser diagnostics.
    child.stderr.resume();
    child.once("error", () => { failure = new RunnerError("TOOL_UNAVAILABLE"); });
    child.once("close", (code) => {
      signal.removeEventListener("abort", stop);
      if (signal.aborted) reject(new RunnerError("CANCELLED"));
      else if (failure) reject(failure);
      else if (code !== 0) reject(new RunnerError("PROCESSING_FAILED"));
      else resolve(Buffer.concat(chunks));
    });
  });
}

async function inspect(tools, file, execution, limits) {
  const info = (await runTool(tools.pdfinfo, [file], { ...execution, maxBytes: 65536 })).toString("utf8");
  const pageCount = Number(info.match(/^Pages:\s+(\d+)\s*$/m)?.[1]);
  if (!Number.isSafeInteger(pageCount) || pageCount < 1) throw new RunnerError("INVALID_PDF");
  if (pageCount > limits.pages) throw new RunnerError("PAGE_LIMIT");
  return {
    pageCount,
    encrypted: /^Encrypted:\s+yes/m.test(info),
    pdfVersion: info.match(/^PDF version:\s+([\d.]+)\s*$/m)?.[1] ?? "unknown",
  };
}

async function imagePage(tools, file, page, dpi, execution, limits) {
  const info = (await runTool(tools.pdfinfo, ["-f", String(page), "-l", String(page), file],
    { ...execution, maxBytes: 65536 })).toString("utf8");
  const size = info.match(/(?:Page\s+\d+ size|Page size):\s+([\d.]+) x ([\d.]+) pts/);
  if (!size || Math.ceil(Number(size[1]) * dpi / 72) * Math.ceil(Number(size[2]) * dpi / 72) > limits.pixels) {
    throw new RunnerError("IMAGE_DIMENSION_LIMIT");
  }
  const prefix = join(execution.cwd, `page-${page}`);
  await runTool(tools.pdftoppm, ["-f", String(page), "-l", String(page), "-singlefile", "-r", String(dpi),
    "-png", file, prefix], { ...execution, maxBytes: 65536 });
  const path = `${prefix}.png`;
  if ((await stat(path)).size > limits.outputBytes) throw new RunnerError("OUTPUT_LIMIT");
  return path;
}

/** Create an authenticated, loopback-only PDF job server. All document bytes remain ephemeral. */
export function createDocumentRunner({ token, tools = {}, limits: overrides = {}, mineru = {}, tempRoot = tmpdir() }) {
  if (typeof token !== "string" || token.length < 32 || token.length > 256 || !/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new RunnerError("INVALID_SERVER_TOKEN");
  }
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  const parser = new MineruWorker({ ...mineru, maxBytes: limits.outputBytes, jobsRoot: tempRoot });
  parser.warm();
  const binaries = { pdfinfo: "pdfinfo", pdftotext: "pdftotext", pdftoppm: "pdftoppm", tesseract: "tesseract", ...tools };
  const expected = Buffer.from(`Bearer ${token}`);
  const jobs = new Map();
  const queue = [];
  let active = 0;
  let closed = false;
  let retainedBytes = 0;
  let incomingBytes = 0;
  let healthPromise;
  let healthExpires = 0;

  const accounting = {
    add(bytes) {
      incomingBytes += bytes;
      if (incomingBytes > limits.retainedBytes) throw new RunnerError("BUSY", 429);
    },
    release(bytes) { incomingBytes -= bytes; },
  };

  async function capabilities() {
    if (healthPromise && healthExpires > Date.now()) return healthPromise;
    healthExpires = Date.now() + 30000;
    healthPromise = (async () => {
      const available = {};
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        for (const [name, binary] of Object.entries(binaries)) {
          try {
            await runTool(binary, [name === "tesseract" ? "--version" : "-v"],
              { signal: controller.signal, cwd: tmpdir(), maxBytes: 65536 });
            available[name] = true;
          } catch { available[name] = false; }
        }
      } finally { clearTimeout(timeout); }
      return available;
    })();
    return healthPromise;
  }

  function cancel(job) {
    if (TERMINAL.has(job.status)) return;
    job.cancelRequested = true;
    job.controller.abort();
    if (job.status === "queued") {
      job.status = "cancelled";
      job.expiresAt = Date.now() + limits.expiryMs;
    }
  }

  async function execute(job) {
    let dir;
    job.status = "running";
    const timer = setTimeout(() => {
      job.timedOut = true;
      job.controller.abort();
    }, limits.timeoutMs);
    try {
      dir = await mkdtemp(join(tempRoot, "cfos-pdf-"));
      const file = join(dir, "input.pdf");
      await writeFile(file, job.input, { mode: 0o600 });
      const execution = { signal: job.controller.signal, cwd: dir };
      const metadata = await inspect(binaries, file, execution, limits);
      const pages = job.pages ?? Array.from({ length: metadata.pageCount }, (_, i) => i + 1);
      if (pages.some((p) => p > metadata.pageCount)) throw new RunnerError("INVALID_PAGES");
      if (["render", "ocr", "parse"].includes(job.operation) && pages.length > limits.imagePages) throw new RunnerError("PAGE_LIMIT");
      let result = { ...metadata };
      if (job.operation === "parse") {
        const parsed = await parser.parse(dir, pages, job.controller.signal);
        result = { ...metadata, parser: parsed.parser, pages: parsed.pages };
      } else if (job.operation !== "inspect") {
        result.pages = [];
        let bytes = 0;
        for (const page of pages) {
          if (job.controller.signal.aborted) throw new RunnerError("CANCELLED");
          if (job.operation === "extract") {
            const text = (await runTool(binaries.pdftotext, ["-f", String(page), "-l", String(page),
              "-layout", "-enc", "UTF-8", file, "-"], { ...execution, maxBytes: limits.outputBytes - bytes })).toString("utf8");
            bytes += Buffer.byteLength(text);
            result.pages.push({ page, text });
          } else {
            const path = await imagePage(binaries, file, page, job.dpi, execution, limits);
            if (job.operation === "ocr") {
              const text = (await runTool(binaries.tesseract, [path, "stdout", "-l", job.language],
                { ...execution, maxBytes: limits.outputBytes - bytes })).toString("utf8");
              bytes += Buffer.byteLength(text);
              result.pages.push({ page, text });
            } else {
              const image = await readFile(path);
              bytes += image.length;
              if (bytes > limits.outputBytes) throw new RunnerError("OUTPUT_LIMIT");
              const artifactId = randomUUID();
              job.artifacts.set(artifactId, image);
              result.pages.push({ page, artifactId, mimeType: "image/png", bytes: image.length });
            }
            await rm(path, { force: true });
          }
        }
      }
      if (job.controller.signal.aborted) throw new RunnerError("CANCELLED");
      const size = Buffer.byteLength(JSON.stringify(result))
        + [...job.artifacts.values()].reduce((total, image) => total + image.length, 0);
      if (size > limits.outputBytes || retainedBytes + size > limits.retainedBytes) throw new RunnerError("OUTPUT_LIMIT");
      job.result = result;
      job.resultBytes = size;
      retainedBytes += size;
      job.status = "succeeded";
    } catch (error) {
      job.artifacts.clear();
      job.status = job.cancelRequested ? "cancelled" : "failed";
      if (job.status === "failed") job.errorCode = job.timedOut ? "TIMEOUT" : (error instanceof RunnerError || error instanceof MineruError) ? error.code : "PROCESSING_FAILED";
    } finally {
      clearTimeout(timer);
      try {
        if (dir) await rm(dir, { recursive: true, force: true });
      } catch {
        retainedBytes -= job.resultBytes ?? 0;
        job.resultBytes = 0;
        job.result = undefined;
        job.artifacts.clear();
        job.status = "failed";
        job.errorCode = "CLEANUP_FAILED";
      } finally {
        job.expiresAt = Date.now() + limits.expiryMs;
        active--;
        pump();
      }
    }
  }

  function pump() {
    if (closed) return;
    while (active < limits.concurrency && queue.length) {
      const job = queue.shift();
      if (job.status !== "queued") continue;
      active++;
      job.promise = execute(job);
    }
  }

  const sweep = setInterval(() => {
    for (const [id, job] of jobs) {
      if (job.expiresAt && job.expiresAt <= Date.now()) {
        retainedBytes -= (job.resultBytes ?? 0) + job.input.length;
        jobs.delete(id);
      }
    }
  }, Math.min(limits.expiryMs, 30000));
  sweep.unref();

  const server = createServer(async (req, res) => {
    try {
      const supplied = Buffer.from(req.headers.authorization ?? "");
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        throw new RunnerError("UNAUTHORIZED", 401);
      }
      if (closed) throw new RunnerError("UNAVAILABLE", 503);
      const url = new URL(req.url, "http://localhost");
      const pathname = url.pathname;
      if (pathname === "/health" && req.method === "GET") {
        return json(res, 200, { version: VERSION, capabilities: await capabilities(), limits,
          features: ["inspect", "extract", "render", "ocr", ...(parser.configured ? ["parse"] : [])],
          parseReady: parser.ready });
      }
      const match = pathname.match(/^\/v1\/scopes\/([^/]+)\/jobs(?:\/([^/]+)(?:\/(cancel|retry|result|artifacts\/([^/]+)))?)?$/);
      if (!match || !SCOPE.test(match[1]) || (match[2] && !ID.test(match[2]))) throw new RunnerError("NOT_FOUND", 404);
      const [, scope, id, action, artifactId] = match;
      if (!id && req.method === "DELETE") {
        const scoped = [...jobs.values()].filter((job) => job.scope === scope);
        for (const job of scoped) cancel(job);
        await Promise.allSettled(scoped.map((job) => job.promise));
        for (const job of scoped) {
          if (jobs.delete(job.id)) retainedBytes -= (job.resultBytes ?? 0) + job.input.length;
        }
        return json(res, 200, { deleted: scoped.length });
      }
      if (!id && req.method === "POST") {
        if (jobs.size >= limits.jobs) throw new RunnerError("BUSY", 429);
        const input = requestInput(await body(req, Math.ceil(limits.inputBytes * 4 / 3) + 4096, accounting), limits);
        // Body reads yield; concurrent requests may have filled the queue meanwhile.
        if (jobs.size >= limits.jobs) throw new RunnerError("BUSY", 429);
        if (retainedBytes + input.input.length > limits.retainedBytes) throw new RunnerError("BUSY", 429);
        const job = { ...input, id: randomUUID(), scope, status: "queued", controller: new AbortController(), artifacts: new Map() };
        retainedBytes += job.input.length;
        jobs.set(job.id, job);
        queue.push(job);
        const submitted = summary(job);
        pump();
        return json(res, 202, submitted);
      }
      const job = jobs.get(id);
      if (!job || job.scope !== scope) throw new RunnerError("NOT_FOUND", 404);
      if (!action && req.method === "GET") return json(res, 200, summary(job));
      if (action === "result" && req.method === "GET") {
        if (job.status !== "succeeded") throw new RunnerError("JOB_NOT_FINISHED", 409);
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? 20);
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
          throw new RunnerError("INVALID_PAGINATION");
        }
        const { pages, ...metadata } = job.result;
        const result = { ...metadata, totalPages: pages?.length ?? metadata.pageCount };
        if (pages) {
          result.pages = pages.slice(offset, offset + limit);
          if (offset + limit < pages.length) result.nextOffset = offset + limit;
        }
        return json(res, 200, result);
      }
      if (action === "cancel" && req.method === "POST") {
        cancel(job);
        return json(res, 200, summary(job));
      }
      if (action === "retry" && req.method === "POST") {
        if (!TERMINAL.has(job.status)) throw new RunnerError("JOB_NOT_FINISHED", 409);
        if (jobs.size >= limits.jobs || retainedBytes + job.input.length > limits.retainedBytes) throw new RunnerError("BUSY", 429);
        const retry = {
          input: job.input, operation: job.operation, pages: job.pages, dpi: job.dpi, language: job.language,
          id: randomUUID(), scope, status: "queued", controller: new AbortController(), artifacts: new Map(),
        };
        retainedBytes += retry.input.length;
        jobs.set(retry.id, retry);
        queue.push(retry);
        const submitted = summary(retry);
        pump();
        return json(res, 202, submitted);
      }
      if (artifactId && ID.test(artifactId) && req.method === "GET" && job.status === "succeeded") {
        const image = job.artifacts.get(artifactId);
        if (!image) throw new RunnerError("NOT_FOUND", 404);
        res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store", "content-length": image.length });
        return res.end(image);
      }
      throw new RunnerError("NOT_FOUND", 404);
    } catch (error) {
      if (!res.headersSent) json(res, error instanceof RunnerError ? error.httpStatus : 500,
        { errorCode: error instanceof RunnerError ? error.code : "INTERNAL_ERROR" });
      else res.end();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.maxConnections = 32;

  return {
    /** Bind only IPv4 loopback. Port zero is useful for isolated contract tests. */
    async listen(port = 8790) {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
      return `http://127.0.0.1:${server.address().port}`;
    },
    /** Cancel work, wait for tool termination, clear retained data and close the listener. */
    async close() {
      closed = true;
      clearInterval(sweep);
      for (const job of jobs.values()) cancel(job);
      await parser.close();
      const closing = new Promise((resolve) => server.close(resolve));
      server.closeIdleConnections();
      await Promise.allSettled([...jobs.values()].map((job) => job.promise));
      jobs.clear();
      queue.length = 0;
      await closing;
    },
  };
}
