#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const args = process.argv.slice(2);
let receiptPath;
let offline = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--receipt' && args[i + 1]) receiptPath = resolve(args[++i]);
  else if (args[i] === '--offline') offline = true;
  else throw new Error('Usage: scan.mjs [--receipt PATH] [--offline]');
}

const git = (...argv) => execFileSync('git', argv, {
  cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
}).trim();
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const stackAt = commit => JSON.parse(git('show', `${commit}:.cfos/stack.json`));
const localStack = JSON.parse(readFileSync(resolve(root, '.cfos/stack.json'), 'utf8'));
if (localStack.upstream !== 'cloudflare/cloudflare-os' ||
    localStack.fork !== 'kumoly/cloudflare-os') throw new Error('Unexpected CFOS fork identity');
const remote = git('remote', 'get-url', 'upstream');
if (remote !== 'https://github.com/cloudflare/cloudflare-os.git') {
  throw new Error('Unexpected upstream fetch URL');
}

let installed;
if (receiptPath) {
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  if (!sha(receipt.source_commit) || !sha(receipt.source_tree)) {
    throw new Error('Invalid installed source receipt');
  }
  installed = { commit: receipt.source_commit, tree: receipt.source_tree };
  if (git('rev-parse', `${installed.commit}^{tree}`) !== installed.tree) {
    throw new Error('Installed receipt tree differs from its Git commit');
  }
}
const baseSource = installed?.commit ?? git('rev-parse', 'cfos/main');
const stack = stackAt(baseSource);
if (stack.upstream !== localStack.upstream || !sha(stack.upstreamBase)) {
  throw new Error('Invalid upstream base in source stack');
}

if (!offline) git('fetch', '--no-tags', 'upstream', 'main');
const upstreamHead = git('rev-parse', offline ? 'upstream/main' : 'FETCH_HEAD');
const forkHead = offline
  ? git('rev-parse', 'refs/remotes/origin/cfos/main')
  : git('ls-remote', '--heads', 'origin', 'cfos/main').split(/\s+/)[0];
if (!sha(upstreamHead) || !sha(forkHead)) throw new Error('Invalid remote head');
const baseIsAncestor = (() => {
  try { git('merge-base', '--is-ancestor', stack.upstreamBase, upstreamHead); return true; }
  catch { return false; }
})();
if (!baseIsAncestor) throw new Error('Pinned upstream base is not an ancestor of upstream main');
const count = Number(git('rev-list', '--count', `${stack.upstreamBase}..${upstreamHead}`));
const lines = count ? git('log', '--no-merges', '--format=%H%x09%s', '--max-count=150',
  `${stack.upstreamBase}..${upstreamHead}`).split('\n') : [];
const commits = lines.map(line => {
  const [commit, title] = line.split('\t', 2);
  return { commit, title, url: `https://github.com/cloudflare/cloudflare-os/commit/${commit}` };
});
console.log(JSON.stringify({
  checkedAt: new Date().toISOString(),
  offline,
  baseline: installed ? 'installed' : 'repository',
  installed,
  forkHead,
  installedBehindFork: installed ? installed.commit !== forkHead : null,
  upstreamBase: stack.upstreamBase,
  upstreamHead,
  newCommitCount: count,
  commitListTruncated: count > 150,
  commits,
}, null, 2));
