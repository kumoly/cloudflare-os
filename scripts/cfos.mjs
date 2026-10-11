#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditSecurity } from './cfos-security.mjs';

const official = 'cloudflare/cloudflare-os';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const optionalGit = (cwd, ...args) => { try { return git(cwd, ...args); } catch { return null; } };

/** Extract repository identity without printing credentials or host-specific SSH configuration. */
export function repositoryIdentity(url) {
  if (!url) return null;
  const ssh = url.match(/^(?:git@)?github(?:-[\w-]+)?\.?(?:com)?:([^?#]+)$/);
  if (ssh) return ssh[1].replace(/\.git\/?$/, '').replace(/\/$/, '');
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'github.com' || !['https:', 'ssh:'].includes(parsed.protocol)) return null;
    return parsed.pathname.replace(/^\//, '').replace(/\.git\/?$/, '').replace(/\/$/, '');
  } catch { return null; }
}

/** Inspect local refs and tracked release inputs. This command never fetches or changes Git state. */
export function inspectRepository(cwd = process.cwd()) {
  const root = git(cwd, 'rev-parse', '--show-toplevel');
  const config = JSON.parse(readFileSync(resolve(root, '.cfos/stack.json'), 'utf8'));
  if (config.schemaVersion !== 1 || config.upstream !== official || !/^[a-f0-9]{40}$/.test(config.upstreamBase)) {
    throw new Error('Invalid CFOS stack configuration.');
  }
  const ancestor = commit => optionalGit(root, 'merge-base', '--is-ancestor', commit, 'HEAD') !== null;
  const upstreamHead = optionalGit(root, 'rev-parse', '--verify', 'refs/remotes/upstream/main');
  const divergence = upstreamHead ? optionalGit(root, 'rev-list', '--left-right', '--count', 'HEAD...upstream/main') : null;
  const [downstreamCommits, upstreamCommits] = divergence ? divergence.split(/\s+/).map(Number) : [null, null];
  const missingCompatibility = config.compatibilityCommits.filter(entry => !ancestor(entry.commit));
  return {
    config, root,
    branch: optionalGit(root, 'symbolic-ref', '--short', 'HEAD'),
    commit: git(root, 'rev-parse', 'HEAD'),
    tree: git(root, 'rev-parse', 'HEAD^{tree}'),
    clean: git(root, 'status', '--porcelain').length === 0,
    upstreamBasePresent: ancestor(config.upstreamBase),
    missingCompatibility: missingCompatibility.map(entry => entry.name),
    upstream: repositoryIdentity(optionalGit(root, 'remote', 'get-url', 'upstream')),
    upstreamPushDisabled: optionalGit(root, 'remote', 'get-url', '--push', 'upstream') === 'DISABLED',
    fork: repositoryIdentity(optionalGit(root, 'remote', 'get-url', 'origin')),
    forkPush: repositoryIdentity(optionalGit(root, 'remote', 'get-url', '--push', 'origin')),
    upstreamHead, downstreamCommits, upstreamCommits,
    lockfileSha256: hash(readFileSync(resolve(root, 'pnpm-lock.yaml'))),
    stackSha256: hash(readFileSync(resolve(root, '.cfos/stack.json'))),
  };
}

/** Fail before publishing or building a candidate from the wrong repository, base or worktree. */
export function violations(report, { publish = false, detached = false } = {}) {
  const failures = [];
  if (!report.clean) failures.push('Commit or preserve local changes before release checks.');
  if (!report.upstreamBasePresent) failures.push('The pinned upstream base is not an ancestor of HEAD.');
  if (report.missingCompatibility.length) failures.push('Missing required compatibility commits: ' + report.missingCompatibility.join(', '));
  if (report.upstream !== official) failures.push('upstream must fetch cloudflare/cloudflare-os.');
  if (!report.upstreamPushDisabled) failures.push('Disable upstream pushes with: git remote set-url --push upstream DISABLED');
  if (!report.branch && !detached) failures.push('Use a named development branch; detached HEAD is only accepted with --detached.');
  if (report.branch === 'main') failures.push('main is the upstream mirror. Develop and release from downstream branches.');
  if (report.branch && !/^(cfos\/main|feat\/.+|fix\/.+|chore\/.+|sync\/.+|release\/.+)$/.test(report.branch)) failures.push('Use a documented downstream branch prefix.');
  if (publish && (report.fork !== report.config.fork || report.forkPush !== report.config.fork)) {
    failures.push('origin fetch and push must both target the configured personal fork.');
  }
  return failures;
}

/** Refuse upstream pushes, rewrites of published history and changes to existing release tags. */
export function pushViolations(report, remoteName, remoteUrl, refLines, isAncestor) {
  const failures = violations(report, { publish: true });
  if (remoteName !== 'origin' || repositoryIdentity(remoteUrl) !== report.config.fork) failures.push('Push only to the configured origin fork.');
  for (const line of refLines.trim().split('\n').filter(Boolean)) {
    const [localRef, localSha, remoteRef, remoteSha] = line.split(/\s+/);
    if (remoteRef === 'refs/heads/main') failures.push('Do not push main; sync the fork mirror from upstream.');
    if (!/^refs\/(heads\/(cfos\/main|feat\/.+|fix\/.+|chore\/.+|sync\/.+|release\/.+)|tags\/cfos-v.+)$/.test(remoteRef ?? '')) failures.push('Unexpected push ref.');
    if (/^0+$/.test(localSha ?? '')) failures.push('Deleting remote refs requires a separate reviewed operation.');
    if (!isAncestor(report.commit, localSha) || !isAncestor(localSha, report.commit)) failures.push('Push the checked HEAD revision; check out other branches before publishing them.');
    if (!isAncestor(report.config.upstreamBase, localSha)) failures.push('The pushed revision must include the pinned upstream base.');
    if (report.config.compatibilityCommits.some(entry => !isAncestor(entry.commit, localSha))) failures.push('The pushed revision is missing a required compatibility commit.');
    if (remoteRef?.startsWith('refs/tags/') && !/^0+$/.test(remoteSha ?? '')) failures.push('Release tags are immutable.');
    if (remoteRef?.startsWith('refs/heads/') && !/^0+$/.test(remoteSha ?? '') && !isAncestor(remoteSha, localSha)) failures.push('Fetch the remote and use a merge; do not rewrite published history.');
    if (!localRef || !/^[a-f0-9]{40}$/.test(localSha ?? '') || !/^[a-f0-9]{40}$/.test(remoteSha ?? '')) failures.push('Malformed Git push input.');
  }
  return [...new Set(failures)];
}

/** Create an immutable-source candidate record; this does not certify tests or authorize deployment. */
export function candidateManifest(report) {
  const failures = violations(report);
  if (failures.length) throw new Error(failures.join('\n'));
  return {
    schemaVersion: 1, status: 'candidate', createdAt: new Date().toISOString(),
    repository: report.config.fork, sourceCommit: report.commit, sourceTree: report.tree,
    upstreamBase: report.config.upstreamBase, upstreamObserved: report.upstreamHead,
    lockfileSha256: report.lockfileSha256, stackSha256: report.stackSha256,
    compatibilityCommits: report.config.compatibilityCommits,
    nodeVersion: process.version,
    requiredChecks: report.config.requiredChecks.map(name => ({ name, status: 'not_run' })),
    isolatedAcceptance: 'not_run', deployable: false,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command = 'status', ...args] = process.argv.slice(2);
    const report = inspectRepository();
    if (command === 'status') {
      const { config, root, ...summary } = report;
      console.log(JSON.stringify({ ...summary, integrationBranch: config.integrationBranch, expectedFork: config.fork }, null, 2));
    } else if (command === 'verify') {
      if (args.some(arg => !['--publish', '--detached'].includes(arg))) throw new Error('Unknown verify option.');
      const errors = violations(report, { publish: args.includes('--publish'), detached: args.includes('--detached') });
      if (errors.length) throw new Error(errors.join('\n'));
      console.log('CFOS repository and branch checks passed. Build, tests and acceptance remain separate checks.');
    } else if (command === 'manifest') {
      if (args.length !== 2 || args[0] !== '--output') throw new Error('Usage: node scripts/cfos.mjs manifest --output PATH');
      writeFileSync(resolve(args[1]), JSON.stringify(candidateManifest(report), null, 2) + '\n', { flag: 'wx' });
      console.log('Candidate manifest created; validation and deployment have not been performed.');
    } else if (command === 'pre-push') {
      if (args.length !== 2) throw new Error('Expected Git remote name and URL.');
      const errors = pushViolations(report, args[0], args[1], readFileSync(0, 'utf8'), (a, b) => optionalGit(report.root, 'merge-base', '--is-ancestor', a, b) !== null);
      if (errors.length) throw new Error(errors.join('\n'));
      const privacy = auditSecurity({ root: report.root });
      console.log(`CFOS publication privacy passed: ${privacy.commits} downstream commits.`);
    } else throw new Error('Usage: node scripts/cfos.mjs status|verify|manifest|pre-push');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
