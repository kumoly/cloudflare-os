---
name: cfos-upstream-sync
description: Compare the installed CFOS fork with cloudflare/cloudflare-os upstream, or carry an explicitly requested upstream sync through validation, PR integration, and local refresh.
---

# CFOS upstream workflow

Use this skill for CFOS upstream monitoring and for a user-requested end-to-end upstream update. Use the canonical fork's `~/src/kumoly/cloudflare-os/.worktrees/integration` checkout; the repository root is the unmodified upstream mirror and does not contain this skill. Read `docs/cfos-development.md` and `.cfos/stack.json` before changing Git state. The running `~/services/cloudflare-os/app` checkout is an installation target, never an implementation worktree.

## Scan and report

Run `node .agents/skills/cfos-upstream-sync/scripts/scan.mjs --receipt ~/services/cloudflare-os/config/runtime-version.json` from this repository. It fetches upstream `main` into `FETCH_HEAD` without moving a branch and reports the installed source commit, its pinned upstream base, the fork head, upstream head, and new commits. If the fetch fails, report the failure rather than using a stale ref. Inspect the new commits and relevant diffs before describing functionality; separate user-visible features, fixes, and maintenance. State any connector, OAuth, deployment, or feature-flag prerequisites before saying a feature can be tried locally. Include exact commit links and a concise comparison against the installed version.

A scheduled scan stops here. It does not create branches, push, merge, deploy, or alter the installed app. If no upstream change exists and the install matches the fork, stay quiet unless the user requested a status report. Report a newly discovered upstream SHA, installed/fork drift, non-ancestral upstream history, or a scan failure.

## End-to-end sync

Only when the user requests integration, follow [the sync and acceptance procedure](references/e2e.md). Preserve their stated rebase or merge preference while explaining what protected-branch PR integration can actually produce. Finish with the branch graph, CI result for the integrated SHA, local installation SHA, and live acceptance outcome.
