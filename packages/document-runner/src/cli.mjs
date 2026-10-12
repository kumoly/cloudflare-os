import { createDocumentRunner } from "./server.mjs";

const port = Number(process.env.DOCUMENT_RUNNER_PORT ?? "8790");
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("INVALID_SERVER_PORT");
const runner = createDocumentRunner({ token: process.env.DOCUMENT_RUNNER_TOKEN });
await runner.listen(port);
// Print only a stable lifecycle message; never token, document metadata, or tool diagnostics.
process.stdout.write("Document runner ready on loopback.\n");
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    await runner.close();
    process.exit(0);
  });
}
