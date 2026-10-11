# CFOS development and upstream synchronization

CFOS is the `kumoly/cloudflare-os` downstream of `cloudflare/cloudflare-os`.
Keep upstream history intact, preserve local compatibility as small commits,
and distinguish local development validation from a stable release.
The owner authorizes the existing local CFOS deployment as the development
validation environment. Local checks and actual CFOS acceptance are the
default verification; GitHub CI is optional and currently disabled on the fork.
PDF is the first general capability extension; JLPT is an acceptance use case.

## Repository ownership

The canonical development checkout is `~/src/kumoly/cloudflare-os`.
`origin` fetches and pushes `git@github-kumoly:kumoly/cloudflare-os.git`.
`upstream` fetches `https://github.com/cloudflare/cloudflare-os.git` and has
the push URL `DISABLED`. The older `~/src/cloudflare/cloudflare-os` checkout
is an upstream cache, not a second development source.

`~/services/cloudflare-os/app` is a deployment target. Never edit its tracked
files to implement a feature. Host configuration, backups, and operational
records remain in the existing deployment repository. Credentials and local
data never belong in the source fork or release assets.

## Branches and worktrees

| Branch | Purpose | Rule |
| --- | --- | --- |
| `main` | Unmodified upstream mirror | Only fast-forward from `upstream/main`; no feature commits |
| `cfos/main` | Tested downstream integration | Changes arrive through reviewed feature or synchronization PRs |
| `feat/<name>` | One feature | Start from `cfos/main`; use its own worktree |
| `fix/<name>` or `chore/<name>` | Fix or maintenance | Same isolation and checks as a feature |
| `sync/upstream-<sha>` | Upstream merge candidate | Merge upstream here and resolve conflicts before integration |
| `release/<version>` | Release candidate | Fix the source revision; no unrelated feature development |
| `cfos-v<version>` tag | Validated source release | Immutable; never move or replace a published tag |

Use real Git worktrees sharing the canonical repository, not independent
clones called worktrees. Keep the integration worktree available so its
versioned pre-push hook remains reachable. Worktree dependencies are generated,
ignored, and installed from the lockfile; they are not release source.

```sh
git worktree add .worktrees/documents -b feat/documents cfos/main
git -C .worktrees/documents status --short
```

Never reset another chat's worktree. Never force-push integration, synchronization,
release, or published feature history. Merge upstream into shared branches;
do not rebase the downstream baseline out from under other worktrees.

## Compatibility and feature ownership

`.cfos/stack.json` records the exact upstream base and compatibility commits.
The three legacy macOS and gateway patches have been converted into separate
commits, with their original patch names in commit trailers. The deployment
patch files remain recovery inputs for the current release; a future release
uses the fork's exact source commit and manifest.

Keep runtime compatibility, kernel API changes, capability packages, and host
deployment changes in separate commits or PRs. Prefer new gatekeeper packages
to expanding the kernel. Do not change the gadget sandbox's network boundary
to make one extension work. Every public API change needs documented symbols
and a backwards-compatible migration path.

A skill describes a workflow; executable dependencies live in a versioned
tool service or image. An extension declares its capabilities and file/job
contract. Platform document methods contain no JLPT-specific logic.

## Fast local development loop

Use the existing `127.0.0.1:8787` CFOS instance to validate small, committed
changes from a feature worktree. This is the default development path. A stable
release requires the protected integration PR, recorded local validation and
an exact source record. GitHub CI is not a required merge check. A green local
smoke test alone does not certify a stable release: affected type checks,
functional tests and feature acceptance must be recorded for its source commit.

1. Implement one small change in the feature worktree. Keep dependencies and
   Vite+ caches between iterations; install with `pnpm install --frozen-lockfile`
   when first preparing a worktree or when its lockfile changes.
2. Run the affected tests and type check. Use `pnpm --filter PACKAGE test:run`
   for short suites and `pnpm exec vp run -F PACKAGE --cache build` for the
   affected package and its dependencies. Do not repeat all-repository build,
   type check and lint aliases that perform the same work.
3. Commit the reviewed local delta. Push to the fork to preserve and review it.
   Push and PR events do not start CI. The local update does not wait for a PR,
   merge or release tag.
4. Run the host `dev-loop` adapter. It verifies the branch, fingerprints all
   managed runtime source, runs the focused checks, saves only changed source
   files for rollback, applies the delta and verifies login and persistence.
5. Run a feature acceptance through CFOS's actual agent/gadget interface. A
   runtime change requires an explicit acceptance command; HTTP health alone
   is insufficient. Failures automatically restore the previous source and
   repeat the smoke checks. Fix, commit and repeat.

On the current Mac the installed adapter is
`~/services/cloudflare-os/config/dev-loop`; its source belongs to
`connright/nodes/clawxu/cloudflare-os/scripts/dev-loop`. The updater and its
filesystem tests are versioned in this fork as `scripts/cfos-local.mjs` and
`scripts/cfos-local.test.mjs`. The adapter installs their tested versions in
the service configuration directory, together with `doctor`, the password
parser and login/persistence smoke script from the host operations repository.

```sh
# SOURCE is an existing, clean feature worktree; do not run in the service app.
~/services/cloudflare-os/config/dev-loop "$SOURCE" plan
~/services/cloudflare-os/config/dev-loop "$SOURCE" apply --state-compatible \
  --check 'pnpm --filter @gadgets/gatekeeper-documents test:run' \
  --check 'pnpm exec vp run -F @gadgets/gatekeeper-documents --cache build' \
  --accept '/absolute/path/to/document-acceptance'
~/services/cloudflare-os/config/dev-loop "$SOURCE" rollback
```

The documents package and acceptance command above illustrate the future PDF
iteration; use real commands for the package being changed. `--check` runs in
the feature worktree; `--accept` runs against the service app after updating.
Commands must not contain credentials. `--state-compatible` is a developer's
assertion that this change can be undone by restoring source alone. It is not
an extra user approval on each iteration. The owner has already authorized
these local validation updates.

| Change | Local update path |
| --- | --- |
| Documentation or tests | Source synchronization and smoke; no restart |
| Existing backend or gatekeeper source | Changed-file synchronization and Wrangler hot reload |
| Workshop UI or shared API used by it | Rebuild cached frontend assets, then smoke and feature acceptance |
| Worker inventory or startup configuration | Explicit `--restart`; cached startup and acceptance |
| Package manifests, lockfile, toolchain or data migration | Full update with scoped state backup and compatibility validation |

Migration-like paths are refused automatically, but path names cannot prove
storage compatibility. Inspect Durable Object initialization and storage
writes before asserting `--state-compatible`. A new PDF worker's initial
installation may need the full path; subsequent source-only iterations use
hot reload. A changed runner dependency belongs to the full path too.

The updater shares `tmp/backup-operation.lock` with backups. It preserves
ignored dependencies, generated OAuth configuration and persistent state,
refuses unmanaged source edits and records the exact installed source tree
in `config/dev-loop-state.json`. This local receipt takes precedence over
`app`'s legacy Git HEAD and the old stable runtime metadata while development
source is installed. It records `channel: local-dev`, measured duration,
focused checks, acceptance and rollback location; it never asserts CI passed
or moves a release tag. Interrupted operations retain a source journal; do
not remove an operation lock until its recorded process has stopped.

The `apply` operation repeats checks so one command is sufficient after a
commit. If those checks already ran during editing, cached builds replay.
The fork CI workflows are disabled in repository settings and their source
definitions expose only `workflow_dispatch`. Required GitHub status checks are
removed from `cfos/main`; PRs, force-push/deletion protection and immutable
release tags remain. When cross-platform checks become useful, merge the
manual workflow definitions into the default branch, enable the desired
workflow and dispatch it for an exact ref. This optional run does not change
the local development path. Target ordinary source iterations at under
one minute excluding model response time; measure actual receipts before
claiming a latency guarantee.

## Upstream update procedure

1. Check for local changes and preserve them; fetch `upstream/main`.
2. Fast-forward the local upstream mirror only if it remains unmodified.
3. Create a synchronization worktree from `cfos/main`, then merge the fetched
   upstream commit with `--no-ff`. Retain the merge commit to make lineage visible.
4. Resolve conflicts by concern. Run the inherited lint, build and test checks,
   downstream guard tests, and affected capability contracts.
5. Run isolated acceptance against copied state. Verify login, models, existing
   gadgets, file persistence and the changed capability. Never run destructive
   probes on the live database.
6. Update `.cfos/stack.json` to the tested upstream base. Keep compatibility
   commit ancestry, documenting any compatibility retirement explicitly.
7. Open a PR into `cfos/main`. Integration and deployment are separate operations.

```sh
git fetch upstream main
git merge --ff-only --no-stat upstream/main # run in the main mirror checkout
git worktree add .worktrees/upstream-sync -b sync/upstream-TARGET cfos/main
git -C .worktrees/upstream-sync merge --no-ff upstream/main
```

The fork's remote `main` can be synchronized separately with GitHub's upstream
sync operation. CFOS development always fetches the official `upstream` remote,
so it does not depend on how recently the fork mirror was updated.

## Checks and publishing

```sh
node scripts/cfos.mjs status
node --test scripts/cfos.test.mjs
node scripts/cfos.mjs verify --publish
pnpm lint
pnpm test
```

The guard checks source ancestry, required compatibility commits, a clean
worktree, branch names and remote identity. The pre-push hook also refuses
upstream pushes, updates to `main`, remote deletion, release-tag replacement,
and non-fast-forward branch updates. It does not replace functional tests
or CFOS acceptance.

Install the hook with the absolute path of the stable integration worktree:

```sh
git config core.hooksPath "$PWD/.worktrees/integration/.cfos/hooks"
```

Protect `cfos/main` on the fork against force pushes and deletion, and use PRs
for changes. `.cfos/stack.json` has no required GitHub checks; optional checks
are listed separately. Record local validation before merging. Optional CI
uses read-only repository permissions and never deploys. A public fork's
capability tests use synthetic files and disposable services, never private
documents, production credentials or live deployment state.

## Release and deployment

Create a candidate manifest from a clean release checkout:

```sh
node scripts/cfos.mjs manifest --output output/cfos-candidate.json
```

The parent output directory must already exist. The manifest pins the source
commit and tree, upstream base, compatibility commits, lockfile and stack hashes.
It starts with `deployable: false` and validation marked `not_run`. A manifest
is a source record, not evidence that tests passed.

For stable releases, record local lint/type/test results and risk-appropriate
CFOS acceptance for that exact candidate. Record optional CI only when run;
never infer passed checks from an empty required GitHub check list. Use isolated copied-state acceptance for upstream upgrades,
storage changes and recovery exercises; ordinary source-only local iterations
use the fast loop above. Build the
artifact from the fixed revision and record its checksum and toolchain. If the
source or lockfile changes, create a new candidate and rerun affected checks.
Promote through the existing scoped backup and replacement procedure; retain
the previous source/artifact and state checkpoint for rollback. Startup does
not install packages or pull a moving branch. Rolling back source after a data
migration requires a compatible checkpoint or an explicit migration strategy.

## First PDF feature

`feat/documents` owns the native document gatekeeper, its local PDF tool runner,
and contract tests. Initial operations are inspection, complete per-page text
extraction, page rendering, and OCR. Inputs and results are workspace-scoped;
jobs report partial failure and cancellation. Sending files to an execution
service follows the existing gatekeeper action and observation contracts.

The initial validation corpus includes text PDFs, scanned pages, multi-column
Japanese pages, corrupt/encrypted documents, limits, interruption, and access
isolation. JLPT validates one application's integration after the general
capability contracts pass. Multimodal LLM and chat-attachment adapters are
separate kernel changes, reviewed and tested independently.
