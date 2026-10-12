# Local document runner

This is the first execution backend for the Documents gatekeeper. It runs Poppler
and Tesseract on an explicitly configured local host. The gatekeeper supplies
account/workspace scope; gadgets never receive the service token or its URL.
PDF files remain files, and this backend has no application-specific behavior.

Install `poppler` and `tesseract` (including the languages needed for OCR). Run
`pnpm --filter @gadgets/document-runner start` with `DOCUMENT_RUNNER_TOKEN` supplied
by protected host configuration. It must be a random base64url token of at least
32 characters. `DOCUMENT_RUNNER_PORT` defaults to 8790. The listener always binds
`127.0.0.1`; publishing this HTTP endpoint is unsupported. No shell commands are
accepted, and tool subprocesses receive a narrow environment with no credentials.

All HTTP endpoints require `Authorization: Bearer <token>`. Versioned API:

- `GET /health`: `{version: "1.0.0", capabilities, limits}`. Tool availability is
  checked with bounded subprocesses and cached for 30 seconds.
- `POST /v1/scopes/{scope}/jobs`: `{operation,inputBase64,pages?,dpi?,language?}`.
  Operation is `inspect`, `extract`, `render`, or `ocr`. Scope is an opaque SHA256
  account/workspace identifier selected by the gatekeeper, never by document code.
- `GET /v1/scopes/{scope}/jobs/{id}`: `{id,operation,status,errorCode?}`.
  Status is `queued`, `running`, `succeeded`, `failed`, or `cancelled`. Polling
  contains no document content. Errors never contain parser output or host paths.
- `GET /v1/scopes/{scope}/jobs/{id}/result?offset=0&limit=20`: completed metadata
  `{pageCount,encrypted,pdfVersion,totalPages,nextOffset?}` plus selected `pages`.
  Extract/OCR pages are `{page,text}`; rendered pages are
  `{page,artifactId,mimeType:"image/png",bytes}`. Inspect omits `pages`.
  Pagination preserves complete individual page text. Offsets address the
  requested page sequence, and `totalPages` is its length for non-inspect jobs.
- `GET /v1/scopes/{scope}/jobs/{id}/artifacts/{artifactId}`: a PNG belonging only
  to that scoped job.
- `POST /v1/scopes/{scope}/jobs/{id}/cancel`: cancel queued or running work.
- `POST /v1/scopes/{scope}/jobs/{id}/retry`: a new job from a terminal job's
  retained input. Start, cancel and retry return `{id,operation,status}`.
- `DELETE /v1/scopes/{scope}/jobs`: cancel and erase all data for that scope.

The service accepts at most 16 MiB per PDF and 200 pages; rendering/OCR processes
at most 20 selected pages, at 72–144 dpi and at most 4 million pixels per page.
Aggregate output including JSON and images is limited to 8 MiB. Reaching a limit
fails explicitly rather than truncating text. There are at most 32 retained jobs,
128 MiB of conservatively accounted inputs/results, 2 concurrent jobs, and a
120-second job deadline. Completed inputs/results expire after 10 minutes.
Subprocess working directories are private and removed on all completion paths;
inputs retained for retries are bounded in memory. Restarting loses jobs.

This is an authenticated local service, not an operating-system sandbox for PDF
parsers. The initial backend trusts installed tool binaries and host admin
configuration. Keep tools updated; a future execution adapter can isolate them
in containers without changing the native gatekeeper API.

`pnpm --filter @gadgets/document-runner test:run` exercises authentication,
scope isolation, validation, budgets, cancellation, timeout, retry, expiry,
cleanup and real Poppler/Tesseract processing. Synthetic PDFs are generated in
memory during tests; no document fixtures or outputs are committed. The real
CLI test fails if tools are absent. Public CI installs the required binaries.
