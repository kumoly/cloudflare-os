/** Supported read-only PDF processing operations. */
export type DocumentOperation = "inspect" | "extract" | "render" | "ocr";
/** Bounded processing options; page numbers are one-based. */
export type DocumentOptions = {
  operation: DocumentOperation;
  /** Omit for all pages; rendering and OCR require at most 20 pages. */
  pages?: number[];
  /** Rendering/OCR resolution, between 72 and 144 DPI. Defaults to 110. */
  dpi?: number;
  /** Tesseract language expression such as eng or jpn+eng. */
  language?: string;
};
/** Ephemeral job lifecycle. Completed documents expire after ten minutes. */
export type DocumentStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
/** Job receipt/status, without document content. */
export type DocumentJob = {
  id: string;
  operation: DocumentOperation;
  status: DocumentStatus;
  /** Stable, sanitized failure code. No native process output is exposed. */
  errorCode?: string;
};
/** One complete page of extracted or OCR text; never silently truncated. */
export type DocumentTextPage = { page: number; text: string };
/** A rendered page image; fetch its bytes through getArtifact. */
export type DocumentImagePage = {
  page: number;
  artifactId: string;
  mimeType: "image/png";
  bytes: number;
};
/** Bounded PDF metadata; document text is obtained through extract or OCR. */
export type DocumentMetadata = {
  pageCount: number;
  encrypted: boolean;
  /** PDF format version reported by pdfinfo. */
  pdfVersion: string;
};
/** A bounded page of a completed job result. */
export type DocumentResult = {
  id: string;
  operation: DocumentOperation;
  metadata?: DocumentMetadata;
  textPages?: DocumentTextPage[];
  imagePages?: DocumentImagePage[];
  /** Offset to use for the next result page, absent at the end. */
  nextOffset?: number;
  totalPages: number;
};
/**
 * Generic document processing capability, scoped to this account and workspace.
 * Supply actual PDF bytes, never a filesystem path or URL. Every call is audited as an observation.
 * Maximum input is 16 MiB / 200 PDF pages; render/OCR process at most 20 selected pages.
 * getResult paginates whole pages (default/max 20) without truncating page text. Jobs/artifacts
 * expire after ten minutes and are unavailable in other workspaces. Retry requires retained input.
 * The deployment admin chooses disabled/optional/enabled, and users opt in under optional mode.
 * Agents receive DOCUMENTS after provisioning; a gadget uses it only after an explicit binding.
 *
 * @example
 * const job = await env.DOCUMENTS.start(pdfBytes, { operation: "extract" });
 * let status = await env.DOCUMENTS.getStatus(job.id);
 * while (status.status === "queued" || status.status === "running") {
 *   await new Promise(resolve => setTimeout(resolve, 250));
 *   status = await env.DOCUMENTS.getStatus(job.id);
 * }
 * const result = await env.DOCUMENTS.getResult(job.id);
 */
export interface DocumentSession {
  /** Validate supplied PDF bytes and start a bounded processing job. */
  start(pdf: Uint8Array, options: DocumentOptions): Promise<DocumentJob>;
  /** Read a job status without returning PDF-derived content. */
  getStatus(id: string): Promise<DocumentJob>;
  /** Read complete page text, metadata, or image handles of a completed job. */
  getResult(id: string, options?: { offset?: number; limit?: number }): Promise<DocumentResult>;
  /** Retrieve one rendered image belonging to this job and workspace. */
  getArtifact(id: string, artifactId: string): Promise<Uint8Array>;
  /** Stop temporary processing; this never mutates the original PDF. */
  cancel(id: string): Promise<DocumentJob>;
  /** Start a fresh attempt using a retained failed/cancelled job's input. */
  retry(id: string): Promise<DocumentJob>;
}
