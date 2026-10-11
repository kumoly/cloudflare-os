# CFOS development and upstream synchronization

CFOS is the `kumoly/cloudflare-os` downstream of `cloudflare/cloudflare-os`.
Keep upstream history intact, preserve local compatibility as small commits,
and deploy only source revisions that have passed CI and isolated acceptance.
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
and non-fast-forward branch updates. It does not replace CI or tests.

Install the hook with the absolute path of the stable integration worktree:

```sh
git config core.hooksPath "$PWD/.worktrees/integration/.cfos/hooks"
```

Protect `cfos/main` on the fork with the required checks named in the stack
configuration, disallow force pushes and deletion, and use PRs for changes.
CI uses read-only repository permissions and never deploys. A public fork's
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

Record CI results and isolated acceptance for that exact candidate. Build the
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
