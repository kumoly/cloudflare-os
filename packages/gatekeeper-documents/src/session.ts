import { RpcTarget, RpcStub } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import { DocumentRunner, validateId, validateOptions, validatePdf } from "./runner.js";
import type { DocumentJob, DocumentOptions, DocumentResult, DocumentSession } from "./types.js";

/** Narrow runtime collaborators let workerd tests observe authorization ordering. */
export type DocumentSessionDependencies = {
  approvalQueue: RpcStub<ApprovalQueue>;
  runner: DocumentRunner;
  assertActive(): Promise<void>;
};

/** Remove content-bearing result fields from status receipts. */
function receipt(job: DocumentJob): DocumentJob {
  return { id: job.id, operation: job.operation, status: job.status,
    ...(job.errorCode ? { errorCode: job.errorCode } : {}) };
}

@validateRpc()
export class DocumentSessionImpl extends RpcTarget implements DocumentSession {
  readonly #dependencies: DocumentSessionDependencies;
  constructor(dependencies: DocumentSessionDependencies) {
    super();
    this.#dependencies = dependencies;
  }
  /** Authorize before transmitting document bytes to the fixed processing backend. */
  async start(pdf: Uint8Array, options: DocumentOptions): Promise<DocumentJob> {
    validatePdf(pdf);
    const normalized = validateOptions(options);
    await this.#authorize(`Process PDF: ${normalized.operation}`);
    return receipt(await this.#dependencies.runner.start(pdf, normalized));
  }
  /** Every job lookup uses the session's immutable namespace. */
  async getStatus(id: string): Promise<DocumentJob> {
    validateId(id);
    await this.#authorize("Read document job status");
    return receipt(await this.#dependencies.runner.get(id));
  }
  /** Paginate complete pages; no page text is truncated to fit a result. */
  async getResult(id: string, options?: { offset?: number; limit?: number }): Promise<DocumentResult> {
    validateId(id);
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? 20;
    if (!Number.isInteger(offset) || offset < 0 || offset > 200 || !Number.isInteger(limit) ||
        limit < 1 || limit > 20) throw new TypeError("Invalid document result pagination.");
    await this.#authorize("Read document result");
    const status = await this.#dependencies.runner.get(id);
    if (status.status !== "succeeded") throw new Error("Document job has not succeeded.");
    const job = await this.#dependencies.runner.result(id, status.operation, offset, limit);
    if (!job.result || job.totalPages === undefined) throw new Error("Invalid document result.");
    const { textPages, imagePages, ...metadata } = job.result;
    return { id: job.id, operation: job.operation, metadata, totalPages: job.totalPages,
      ...(textPages ? { textPages } : {}), ...(imagePages ? { imagePages } : {}),
      ...(job.nextOffset !== undefined ? { nextOffset: job.nextOffset } : {}) };
  }
  /** Check that an artifact belongs to the requested completed render job before retrieving it. */
  async getArtifact(id: string, artifactId: string): Promise<Uint8Array> {
    validateId(id); validateId(artifactId);
    await this.#authorize("Read document page image");
    const status = await this.#dependencies.runner.get(id);
    if (status.status !== "succeeded" || status.operation !== "render") {
      throw new Error("Document artifact is not available for this job.");
    }
    const job = await this.#dependencies.runner.result(id, "render");
    if (!job.result?.imagePages?.some(p => p.artifactId === artifactId)) {
      throw new Error("Document artifact is not available for this job.");
    }
    const bytes = await this.#dependencies.runner.artifact(id, artifactId);
    if (bytes.length < 8 || bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71) {
      throw new Error("Invalid document PNG artifact.");
    }
    return bytes;
  }
  /** Cancel only scoped transient computation, leaving original document content unchanged. */
  async cancel(id: string): Promise<DocumentJob> {
    validateId(id);
    await this.#authorize("Cancel document processing");
    return receipt(await this.#dependencies.runner.cancel(id));
  }
  /** Retry retained input in the same namespace after authorization. */
  async retry(id: string): Promise<DocumentJob> {
    validateId(id);
    await this.#authorize("Retry document processing");
    return receipt(await this.#dependencies.runner.retry(id));
  }
  [Symbol.dispose](): void {
    this.#dependencies.approvalQueue[Symbol.dispose]?.();
  }
  async #authorize(title: string): Promise<void> {
    await this.#dependencies.assertActive();
    await this.#dependencies.approvalQueue.authorizeObservation({
      title,
      description: "Process caller-supplied PDF bytes or read transient results in this workspace.",
    });
    // Revocation may occur while an observation waits for approval.
    await this.#dependencies.assertActive();
  }
}
