declare namespace Cloudflare {
  interface Env {
    /** Fixed, administrator-configured HTTPS or loopback runner endpoint. */
    DOCUMENT_RUNNER_URL?: string;
    /** Out-of-band runner credential, never supplied by a gadget. */
    DOCUMENT_RUNNER_TOKEN?: string;
  }
}
