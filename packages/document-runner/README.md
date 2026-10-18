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

- `GET /health`: `{version: "1.1.0", capabilities, limits, features, parseReady}`. Tool availability is
  checked with bounded subprocesses and cached for 30 seconds.
- `POST /v1/scopes/{scope}/jobs`: `{operation,inputBase64,pages?,dpi?,language?}`.
  Operation is `inspect`, `extract`, `render`, `ocr`, or optional `parse`. Scope is an opaque SHA256
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

## Structured parsing with MinerU Basic

Runner version `1.1.0` adds `operation: "parse"`. This is an optional execution
backend. The original four operations and their budgets remain available when
MinerU is absent. Health retains the existing tool capability booleans and adds
`features` (operation names) and `parseReady`. Configured MinerU is advertised in
`features`; `parseReady` becomes true after exact-version, offline model preloading.
A deployment should wait for readiness before offering structured parsing.

The operator installs Python, the pinned `mineru==4.0.12` Basic dependencies and
verified local Basic model files outside this repository, then supplies:

- `DOCUMENT_MINERU_PYTHON`: an absolute path to that environment's Python executable.
- `DOCUMENT_MINERU_CONFIG`: an absolute path to a regular, single-link, operator-owned
  YAML file with mode `0600`.

The YAML config sets `model.source: local`, `model.small_backend: torch`, and an
absolute `model.base_dir` containing the installed weights. Both
`model.vlm.server_url` and `model.vlm.api_key` are empty. `llm_aided.base_url`,
`llm_aided.api_key`, and `llm_aided.model` are empty, and both LLM-aided feature
flags are false. No provider credentials are required. Model downloads and
package installation are explicit operator steps; the service never downloads
models. Installing this JavaScript package alone does not install MinerU.

One long-lived Python process preloads only the Basic OCR, layout and table
models, using Torch's automatic device selection (MPS where available) and eight
CPU threads. It receives a fixed environment with Hugging Face and Transformers
offline flags, local model configuration, and no runner token or cloud credentials.
Python Internet socket connections are refused as an additional guard. The
backend constructs neither a remote VLM nor an LLM client. Native/Python library
stdout and stderr are suppressed at the file-descriptor boundary because parser
diagnostics may contain document content.

Parse input is the usual PDF bytes plus optional one-based `pages`; `dpi` and
`language` are rejected. At most 20 selected pages are parsed, even when the PDF
has up to 200 pages. Result pagination preserves their requested order and
original PDF page numbers; `pageCount` remains the original document's count.

Completed results add `parser: { name: "mineru", version: "4.0.12", tier: "basic" }`.
Each result page contains:

- `page`, optional `widthPoints`/`heightPoints`, `blocks`, `tables`, and `warnings`.
- Blocks: `{id, order, type, text, bbox?, tableId?}`.
- Tables: `{id, order, bbox?, sourceLocator, continuesPrevious, rowCount,
  columnCount, cells}`.
- Cells: `{row, col, rowSpan, colSpan, text}`, retaining native empty cells and
  HTML spans. Row/column offsets are zero-based.
- Optional native boxes are `{left, top, right, bottom}`, normalized to `0..1`
  with a top-left origin. Cell boxes are never fabricated from a table box.
- `sourceLocator` is `page:N/block:B/table:T` using the original page and native
  block index. `continuesPrevious` carries only the parser's native hint; the
  runner does not infer exam sections or join answers across page boundaries.

A page with no recognized text returns `NO_RECOGNIZED_CONTENT`; it is not declared
blank. Recognition can be incorrect, so consumers should preserve source pages
and uncertain structure for verification. The implementation has no JLPT-specific
parsing, labels, answer keys, coordinates or document fixtures.

The normalizer enforces at most 1,000 blocks/tables and 5,000 cells per page,
1,000 rows/columns, positive bounded spans within the declared grid, 100,000
expanded span slots across the result, and 65,536 characters per text value.
Invalid native geometry or malformed table HTML fails explicitly. The existing
16 MiB input, 8 MiB output, 128 MiB retained input/result budget, 32 jobs,
120-second job deadline, and ten-minute expiry remain unchanged. Resident model
memory is separate from the document retention budget.

Node's existing job queue can continue other PDF operations while parse requests
are serialized through the one Python worker. Its private NDJSON pipe carries
only random request IDs and Node-generated private job-directory paths; no HTTP
caller can supply a filesystem path. Results are read from a bounded file in the
same job directory, then retained through the existing scoped job API.

Cancelling or timing out an active parse kills its process group and waits for
exit before removing job files. A queued parse can be cancelled without killing
another job's worker. A terminated or crashed worker is restarted and warmed;
request IDs and fresh processes prevent late results from being assigned to a
later job. Retry uses the same bounded retained PDF input and creates a new job.
All success and failure paths release Python document references and temporary
request files. A service restart still loses transient jobs.

`pnpm --filter @gadgets/document-runner test:run` includes dependency-free Python
normalizer tests and a fake-worker protocol/lifecycle suite. These run in public
CI without downloading weights. Actual pinned-model inference is verified during
local deployment against synthetic generated tables and separately authorized
private acceptance files; those inputs and model caches stay outside the fork.
