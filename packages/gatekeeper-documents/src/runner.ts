import type {
  DocumentImagePage, DocumentJob, DocumentMetadata, DocumentOperation, DocumentOptions,
  DocumentTextPage,
} from "./types.js";

/** Maximum input and returned artifact size, independently of the runner's own limits. */
export const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const OPERATIONS: DocumentOperation[] = ["inspect", "extract", "render", "ocr"];
const STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"];

/** The bounded, validated result envelope returned by the native runner. */
export type RunnerJob = DocumentJob & {
  result?: DocumentMetadata & { textPages?: DocumentTextPage[]; imagePages?: DocumentImagePage[] };
  totalPages?: number;
  nextOffset?: number;
};

/** Operator-supplied backend settings; never exposed in the document RPC API. */
export type RunnerSettings = { url?: string; token?: string };

/** Validate a fixed configured endpoint; only HTTPS or loopback HTTP is accepted. */
export function runnerEndpoint(settings: RunnerSettings): URL {
  if (!settings.url || !settings.token || settings.token.length < 32) {
    throw new Error("Document runner is not configured.");
  }
  const url = new URL(settings.url);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      (url.protocol !== "https:" && !(url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) {
    throw new Error("Invalid document runner endpoint.");
  }
  return url;
}

/** Validate options before any processing or network request. */
export function validateOptions(options: DocumentOptions): DocumentOptions {
  if (!options || !OPERATIONS.includes(options.operation)) throw new TypeError("Invalid operation.");
  if (options.pages !== undefined && (!Array.isArray(options.pages) || !options.pages.length ||
      options.pages.length > 200 || options.pages.some(p => !Number.isInteger(p) || p < 1 || p > 200) ||
      new Set(options.pages).size !== options.pages.length)) throw new TypeError("Invalid pages.");
  if ((options.operation === "render" || options.operation === "ocr") &&
      options.pages && options.pages.length > 20) throw new TypeError("Select at most 20 pages.");
  if (options.dpi !== undefined && (!Number.isInteger(options.dpi) || options.dpi < 72 ||
      options.dpi > 144)) throw new TypeError("DPI must be between 72 and 144.");
  if (options.language !== undefined && !/^[a-z_]{2,16}(?:\+[a-z_]{2,16}){0,3}$/.test(options.language)) {
    throw new TypeError("Invalid OCR language.");
  }
  if ((options.language?.length ?? 0) > 128) throw new TypeError("Invalid OCR language.");
  return { operation: options.operation, ...(options.pages ? { pages: [...options.pages] } : {}),
    ...(options.dpi !== undefined ? { dpi: options.dpi } : {}),
    ...(options.language !== undefined ? { language: options.language } : {}) };
}

/** Reject missing, oversized, and non-PDF input without accessing external resources. */
export function validatePdf(pdf: Uint8Array): void {
  if (!(pdf instanceof Uint8Array) || pdf.byteLength < 8 || pdf.byteLength > MAX_DOCUMENT_BYTES) {
    throw new TypeError("PDF input must contain 8 bytes to 16 MiB.");
  }
  if (new TextDecoder().decode(pdf.subarray(0, 5)) !== "%PDF-") {
    throw new TypeError("Input is not a PDF.");
  }
}

/** Validate opaque runner IDs before interpolation into a fixed route. */
export function validateId(id: string): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new TypeError("Invalid document identifier.");
}

/** Hash trusted account and inherited workspace identity into an opaque runner namespace. */
export async function documentScope(accountId: string, workspaceId: string): Promise<string> {
  if (!accountId || !workspaceId || accountId.includes("\0") || workspaceId.includes("\0")) {
    throw new Error("Invalid document scope.");
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${accountId}\0${workspaceId}`));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid runner response.");
  return value as Record<string, unknown>;
}
function pageNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 200) {
    throw new Error("Invalid runner page.");
  }
  return value;
}
function string(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > max) throw new Error("Invalid runner string.");
  return value;
}

/** Parse the protocol response without trusting backend JSON shapes. */
export function parseRunnerJob(value: unknown): RunnerJob {
  const input = object(value);
  const id = string(input.id, 128); validateId(id);
  const operation = input.operation;
  const status = input.status;
  if (!OPERATIONS.includes(operation as DocumentOperation) ||
      !STATUSES.includes(status as string)) throw new Error("Invalid runner job.");
  const job: RunnerJob = { id, operation: operation as DocumentOperation,
    status: status as DocumentJob["status"] };
  if (input.errorCode !== undefined) {
    job.errorCode = string(input.errorCode, 80);
    if (!/^[A-Z_]+$/.test(job.errorCode)) throw new Error("Invalid runner failure code.");
  }
  if (input.result !== undefined) {
    if (status !== "succeeded") throw new Error("Invalid runner result state.");
    const raw = object(input.result);
    const pageCount = pageNumber(raw.pageCount);
    if (typeof raw.encrypted !== "boolean") throw new Error("Invalid PDF metadata.");
    const result: NonNullable<RunnerJob["result"]> = {
      pageCount, encrypted: raw.encrypted, pdfVersion: string(raw.pdfVersion, 32),
    };
    if (operation !== "inspect") {
      if (!Array.isArray(raw.pages) || raw.pages.length > 200) throw new Error("Invalid runner pages.");
      const seen = new Set<number>();
      if (operation === "render") {
        result.imagePages = raw.pages.map(pageValue => {
          const p = object(pageValue); const page = pageNumber(p.page);
          if (page > pageCount) throw new Error("Invalid runner page count.");
          if (seen.has(page)) throw new Error("Duplicate runner page."); seen.add(page);
          const artifactId = string(p.artifactId, 128); validateId(artifactId);
          if (p.mimeType !== "image/png" || typeof p.bytes !== "number" ||
              !Number.isInteger(p.bytes) || p.bytes < 1 || p.bytes > MAX_DOCUMENT_BYTES) {
            throw new Error("Invalid runner artifact.");
          }
          return { page, artifactId, mimeType: "image/png", bytes: p.bytes };
        });
      } else {
        result.textPages = raw.pages.map(pageValue => {
          const p = object(pageValue); const page = pageNumber(p.page);
          if (page > pageCount) throw new Error("Invalid runner page count.");
          if (seen.has(page)) throw new Error("Duplicate runner page."); seen.add(page);
          return { page, text: string(p.text, MAX_RESPONSE_BYTES) };
        });
      }
    }
    job.result = result;
  }
  return job;
}

/** Encode PDF bytes without a giant argument spread that can exhaust the JS call stack. */
function base64(bytes: Uint8Array): string {
  let value = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    value += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(value);
}

/** Fixed-endpoint HTTP adapter for the v1 PDF runner. Caller supplies only opaque job IDs. */
export class DocumentRunner {
  readonly #endpoint: URL;
  readonly #token: string;
  readonly #scope: string;
  readonly #fetch: typeof fetch;
  #verified = false;
  constructor(settings: RunnerSettings, scope: string, fetcher: typeof fetch = fetch) {
    this.#endpoint = runnerEndpoint(settings);
    if (!/^[0-9a-f]{64}$/.test(scope)) throw new Error("Invalid runner namespace.");
    this.#token = settings.token!;
    this.#scope = scope;
    // Workers fetch is branded to the global object; a stored method must preserve its receiver.
    this.#fetch = fetcher.bind(globalThis);
  }
  async start(pdf: Uint8Array, options: DocumentOptions): Promise<RunnerJob> {
    return parseRunnerJob(await this.#json("", "POST", { ...options, inputBase64: base64(pdf) }));
  }
  async get(id: string): Promise<RunnerJob> {
    validateId(id);
    return parseRunnerJob(await this.#json(`/${id}`, "GET"));
  }
  async result(id: string, operation: DocumentOperation, offset = 0, limit = 20): Promise<RunnerJob> {
    validateId(id);
    const raw = object(await this.#json(`/${id}/result?offset=${offset}&limit=${limit}`, "GET"));
    const job = parseRunnerJob({ id, status: "succeeded", operation, result: raw });
    const totalPages = raw.totalPages;
    const nextOffset = raw.nextOffset;
    if (typeof totalPages !== "number" || !Number.isInteger(totalPages) || totalPages < 0 ||
        totalPages > 200 || (nextOffset !== undefined && (typeof nextOffset !== "number" ||
        !Number.isInteger(nextOffset) || nextOffset <= offset || nextOffset > totalPages))) {
      throw new Error("Invalid document result pagination.");
    }
    return { ...job, totalPages, ...(nextOffset !== undefined ? { nextOffset } : {}) };
  }
  async cancel(id: string): Promise<RunnerJob> {
    validateId(id);
    return parseRunnerJob(await this.#json(`/${id}/cancel`, "POST"));
  }
  async retry(id: string): Promise<RunnerJob> {
    validateId(id);
    return parseRunnerJob(await this.#json(`/${id}/retry`, "POST"));
  }
  async artifact(id: string, artifactId: string): Promise<Uint8Array> {
    validateId(id); validateId(artifactId);
    const response = await this.#request(`/${id}/artifacts/${artifactId}`, "GET");
    if (response.headers.get("content-type") !== "image/png") throw new Error("Invalid artifact type.");
    return this.#bytes(response, MAX_DOCUMENT_BYTES);
  }
  async #json(path: string, method: string, body?: unknown): Promise<unknown> {
    const response = await this.#request(path, method, body);
    const bytes = await this.#bytes(response, MAX_RESPONSE_BYTES);
    try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
    catch { throw new Error("Invalid document runner response."); }
  }
  async #request(path: string, method: string, body?: unknown): Promise<Response> {
    await this.#verify();
    let response: Response;
    try {
      response = await this.#fetch(new URL(`/v1/scopes/${this.#scope}/jobs${path}`, this.#endpoint), {
        method, redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${this.#token}`, "Content-Type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw new Error("Document runner is unavailable."); }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404) throw new Error("Document job is missing or expired.");
      throw new Error(`Document runner request failed (${response.status}).`);
    }
    return response;
  }
  async #verify(): Promise<void> {
    if (this.#verified) return;
    let response: Response;
    try {
      response = await this.#fetch(new URL("/health", this.#endpoint), {
        redirect: "error", signal: AbortSignal.timeout(5_000),
        headers: { Authorization: `Bearer ${this.#token}` },
      });
    } catch { throw new Error("Document runner is unavailable."); }
    if (!response.ok) { await response.body?.cancel(); throw new Error("Document runner health check failed."); }
    let health: Record<string, unknown>;
    try { health = object(JSON.parse(new TextDecoder().decode(await this.#bytes(response, 16_384))) as unknown); }
    catch { throw new Error("Invalid document runner health response."); }
    if (health.version !== "1.0.0") throw new Error("Unsupported document runner version.");
    const capabilities = object(health.capabilities);
    if (!["pdfinfo", "pdftotext", "pdftoppm", "tesseract"].every(key => capabilities[key] === true)) {
      throw new Error("Document runner is missing required PDF tools.");
    }
    this.#verified = true;
  }
  async #bytes(response: Response, limit: number): Promise<Uint8Array> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing runner response.");
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > limit) throw new Error("Document result exceeds the response limit.");
        chunks.push(value);
      }
    } catch (error) { await reader.cancel(); throw error; }
    finally { reader.releaseLock(); }
    const result = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result;
  }
}
