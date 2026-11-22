# Frozen OpenClaw client

`core.mjs` and `contracts/weather.json` are byte-for-byte runtime files from the released kumoly-os plugin 0.2.1. `provenance.json` records its source commit, original release archive SHA256 and individual file digests. The host-specific README and SDK registration entrypoint are deliberately excluded. Dependencies are installed separately with the pinned fixture lockfile, never resolved from the candidate workspace.

Do not update these files alongside a server API rename. Advancing the supported client baseline is an explicit compatibility-policy change. The test runs the released GadgetClient in a separate Node process over a real WebSocket. The fixture server is deterministic and needs neither a model nor weather credentials.

`test:client-compat` runs fresh-candidate and pinned-old-backend-to-candidate cases. The latter keeps account token and workspace/gadget identifiers and all server storage across update. The oldest supported backend is pinned in `scripts/build-client-compat.ts`.
