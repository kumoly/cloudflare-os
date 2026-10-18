# Documents gatekeeper

`@gadgets/gatekeeper-documents` is the generic native PDF capability. PDF remains a file;
this package does not introduce a new Workshop workpiece type. Agents and explicitly bound gadgets
share the same `DocumentSession` API. JLPT answer-card generation is one consumer of this API.

## Provisioning and authority

Install this Worker and bind its `GatekeeperVendor` as `GATEKEEPER_DOCUMENTS` in the Workshop.
The existing admin Gatekeepers panel chooses **disabled**, **optional**, or **enabled**. Optional is
the platform default: each user connects Documents through the existing Connectors flow. The vendor
never claims ambient authority. A provisioned account exposes the `DOCUMENTS` agent singleton;
a gadget receives it only after its binding list explicitly grants the capability.

Each native facet inherits the parent workspace Durable Object ID. The runner namespace is
SHA-256 of the immutable account capability ID, a zero-byte separator, and that inherited workspace
ID. RPC arguments cannot choose or change the account, workspace, runner endpoint, or credentials.
Configured workspace collaborators may observe caller-supplied documents and their results, matching
the workspace's own content-sharing policy; this is not an account-wide document library.

Every method checks durable account revocation and authorizes an observation **before** contacting
the runner or transmitting PDF bytes. It checks revocation again after approval completes. Revoking
an account disables already minted sessions as well as new sessions. The gatekeeper retains no PDF
bytes or extracted content in Workshop storage. The runner's ephemeral input, job, and artifacts
expire after ten minutes; revocation does not immediately erase files already queued on the runner.

## Processing API

The exported, documented declarations live in `src/types.d.ts`; `src/types.txt` is a symlink to the
same source. The types shown to an agent cannot drift from the implementation's imported types.
`@validateRpc()` generates runtime method and argument validators for all native implementations.

- `start(pdfBytes, { operation, pages?, dpi?, language? })` accepts actual `Uint8Array` PDF bytes.
  Operations are `inspect`, `extract`, `render`, `ocr`, and `parse`.
  Structured `parse` accepts only `pages`; `dpi` and `language` are rejected for this operation. Paths and URLs are never input types.
- `getStatus(id)` returns a lightweight status receipt without document text or images.
- `getResult(id, { offset?, limit? })` returns metadata plus `textPages`, `imagePages`, or `parser`/`parsedPages` of a successful
  job. Offsets refer to positions in the selected page list; page numbers remain one-based.
  Default/max page size is 20. Follow `nextOffset` until absent to read every complete page.
- `getArtifact(id, artifactId)` validates the handle belongs to that completed render job, then
  returns PNG bytes. Artifacts cannot be read through another job or workspace.
- `cancel(id)` cancels scoped temporary computation; `retry(id)` creates a fresh attempt from
  retained terminal-job input. Neither modifies the original PDF.

Lifecycle states are `queued`, `running`, `succeeded`, `failed`, and `cancelled`. Errors expose stable
codes or generic transport failures; native stderr, secret headers, local paths, and document bodies
are never logged or returned as error messages. Missing, expired, and cross-scope job IDs have the
same missing-job response.

Limits: 16 MiB input, 200 PDF pages, at most 20 rendered/OCR/parsed pages, 72–144 DPI, 8 MiB aggregate text
and response JSON, and 16 MiB per retrieved artifact. The runner additionally caps pixels per page,
job counts/concurrency, native execution time, and expiry. Text is never silently truncated: excess
output fails the job with `OUTPUT_LIMIT`. Scanned pages require an explicit `ocr` operation; `extract`
faithfully returns existing text, including empty text when the PDF has no text layer.

## Structured parsing

`start(pdfBytes, { operation: "parse", pages: [2, 1] })` recognizes reading-order blocks and native
HTML table cells. `getResult` returns `parser: { name: "mineru", version, tier: "basic" }` and
`parsedPages`; `metadata.pageCount` remains the original PDF's total page count. Page numbers remain
original one-based PDF numbers, in the requested order. Omit `pages` to parse all pages only when the
PDF has at most 20 pages. Pagination offsets count selected pages, including pages with no recognition.

A parsed page exposes optional `widthPoints`/`heightPoints`, `blocks`, `tables`, and `warnings`:

- Each block has an `id`, zero-based reading `order`, native `type`, `text`, optional `bbox`, and
  optional `tableId` referencing a table on the same page.
- Each table has an `id`, reading `order`, optional native `bbox`, logical `sourceLocator`,
  `continuesPrevious` hint, `rowCount`, `columnCount`, and `cells`.
- Each cell preserves zero-based `row`/`col`, positive `rowSpan`/`colSpan`, and complete `text`,
  including whitespace and empty cells. MinerU Basic provides no native cell boxes. This API never
  derives them by dividing table bounds, and never flattens/reorders cells into guessed answers.
- Table/block rectangles contain `left`, `top`, `right`, and `bottom`, normalized to 0..1 from the
  page's top-left corner. They are omitted when native geometry is unavailable.

Recognition is evidence, not a guarantee of correctness: callers must interpret diagnostics and
validate their own domain logic. `NO_RECOGNIZED_CONTENT` means recognition found no content; it does
not prove the original page is blank. `continuesPrevious` is a parser hint and does not prove that
rows across pages pair correctly. A consumer that pairs question and answer tables owns that logic.

The gatekeeper rejects malformed structures instead of repairing them: at most 1000 blocks and
5000 cells per page, 1000 rows/columns and cell spans, 100000 expanded cell slots per response,
and 65536 characters per cell. Spans must fit the declared grid and cannot overlap. The existing
20-page selection and 8 MiB aggregate JSON limits still apply; excess output fails without truncation.

## Local or hosted backend

Configure `DOCUMENT_RUNNER_URL` and `DOCUMENT_RUNNER_TOKEN` outside the repository and workspace.
The URL is a fixed HTTPS origin, or loopback HTTP for local development, with no credentials,
path, query, or fragment. The token is a random credential of at least 32 characters. Each session
requires authenticated runner health version `1.0.0` or `1.1.0` and all four native tools before processing.
`parse` requires version `1.1.0`, the `parse` feature, and `parseReady: true`. Readiness is refreshed
before each parse start/retry, before PDF bytes leave the gatekeeper. Completed results remain
readable when parser readiness subsequently becomes false. Original operations work with `1.0.0`.
Every request rejects redirects; gadgets cannot choose another endpoint.

The versioned initial backend is [`../document-runner`](../document-runner). Poppler handles metadata,
complete per-page extraction and raster rendering; Tesseract performs OCR. HTTPS deployments need a
separately operated runner; installing this gatekeeper alone does not install native binaries in a
Cloudflare Worker. Structured parsing additionally requires the separately operated, pinned
MinerU Basic worker described in the runner README; it runs locally without a remote model API.
Missing configuration or models fails closed. Future backends can implement the same bounded v1 contract.

## Gadget example

After explicitly granting a gadget its `DOCUMENTS` binding, its server module can use:

```js
import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint {
  async extract(pdfBytes) {
    const job = await this.env.DOCUMENTS.start(pdfBytes, { operation: "extract" });
    let status;
    do {
      status = await this.env.DOCUMENTS.getStatus(job.id);
      if (status.status === "queued" || status.status === "running") {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    } while (status.status === "queued" || status.status === "running");
    if (status.status !== "succeeded") throw new Error(status.errorCode ?? status.status);
    const pages = [];
    let offset = 0;
    do {
      const result = await this.env.DOCUMENTS.getResult(job.id, { offset });
      pages.push(...result.textPages);
      offset = result.nextOffset;
    } while (offset !== undefined);
    return pages;
  }
}
```

## Verification

`pnpm --filter @gadgets/gatekeeper-documents build` type-checks the native package.
`pnpm --filter @gadgets/gatekeeper-documents test:run` runs the workerd suite. Tests cover fixed-endpoint
validation, bounded options and IDs, observation ordering and denial, revocation including approval
races, runner-version rejection, complete long page text, pagination, sanitized missing-job errors,
runtime RPC argument validation, real inherited facet scopes, parse readiness and legacy-runner
compatibility, native structure/span/provenance limits, and typed parse results through real RPC. Synthetic inputs are generated as
text in tests; no real PDFs, images, credentials, or contact data are committed.
