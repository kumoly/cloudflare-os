#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
class PublicationError extends Error {}

/** Only public GitHub identities may author new downstream commits. */
export function publicIdentity(email) {
  return /^(?:\d+\+)?[\w-]+@users\.noreply\.github\.com$/.test(email) || email === 'noreply@github.com';
}

/** Public handles avoid publishing a local full name in commit identity fields. */
export function publicAuthorName(name) {
  return /^[a-z0-9][a-z0-9-]{0,38}$/i.test(name) || name === 'github-actions[bot]';
}

/** Paths that belong to runtime state or credentials cannot be published, even with git add -f. */
export function forbiddenPath(path) {
  const parts = path.toLowerCase().split('/');
  const name = parts.at(-1);
  if (/[a-z0-9][^\s/@]*@[a-z0-9.-]+/i.test(path)) return true;
  if (parts.some(part => ['..', '.git', 'node_modules', '.wrangler', '.terraform', '.local', '.decrypted', 'private-fixtures'].includes(part))) return true;
  if (['config', 'data', 'logs', 'backups', 'tmp', 'output', 'private', 'private-fixtures'].includes(parts[0])) return true;
  if (/^\.env(?:\..*)?$|^\.dev\.vars(?:\..*)?$/.test(name)) return !/\.(example|sample|template)$/.test(name);
  return /^(admin-bootstrap\.txt|google-oauth-client\.json|credentials(?:\..*)?\.json|id_rsa|id_ed25519|dev-loop-state\.json|journal\.json|wrangler\.(dev|prod|staging)\.jsonc)$/.test(name) ||
    /\.(pem|key|p12|pfx|agekey|tfplan|sqlite|sqlite3|db|zip|gz|age)$/.test(name) || /\.(tfstate|tfvars|log)(?:\..*)?$/.test(name);
}

/** Binary/sample approval is exact by path and content, with a recorded synthetic origin. */
export function contentViolation(path, bytes, policy) {
  if (forbiddenPath(path)) return 'forbidden-path';
  if (bytes.length > policy.maxBlobBytes) return 'oversize-source';
  const asset = /\.(pdf|docx?|xlsx?|pptx?|csv|png|jpe?g|gif|webp|mp[34]|wav|ogg|tiff?|heic|bin)$/i.test(path) || bytes.includes(0);
  if (!asset) return null;
  const sample = policy.syntheticAssets.find(entry => entry.path === path && entry.sha256 === sha256(bytes));
  return sample ? null : 'unreviewed-asset';
}

/** Error labels contain rule IDs, commit IDs and hashes of filenames, never matched values. */
function label(code, commit, path) {
  return `${code} commit=${commit.slice(0, 8)}${path ? ` path-id=${sha256(Buffer.from(path)).slice(0, 12)}` : ''}`;
}

/** Scan every untrusted downstream commit, including removed files and merge-only changes. */
function inspectSecurity({ root = process.cwd(), head = 'HEAD', trusted = 'refs/remotes/upstream/main', policyRoot = resolve(here, '..'), scanner = 'gitleaks' } = {}) {
  const policy = JSON.parse(readFileSync(resolve(policyRoot, '.cfos/security.json'), 'utf8'));
  if (policy.schemaVersion !== 1 || policy.gitleaksVersion !== '8.30.1' || !Number.isSafeInteger(policy.maxBlobBytes) || policy.maxBlobBytes < 1 || policy.maxBlobBytes > 2 * 1024 * 1024 || !Array.isArray(policy.syntheticAssets)) throw new PublicationError('Invalid publication privacy policy.');
  const samples = new Set();
  for (const sample of policy.syntheticAssets) {
    if (typeof sample.path !== 'string' || forbiddenPath(sample.path) || !/^[a-f0-9]{64}$/.test(sample.sha256) || sample.synthetic !== true || typeof sample.reason !== 'string' || !sample.reason.trim() || samples.has(sample.path)) throw new PublicationError('Invalid synthetic sample approval.');
    samples.add(sample.path);
  }
  const version = spawnSync(scanner, ['version'], { encoding: 'utf8', timeout: 10_000 });
  if (version.error || version.status !== 0 || version.stdout.trim() !== policy.gitleaksVersion) throw new PublicationError('Pinned gitleaks 8.30.1 is required; publication blocked.');
  let commit;
  let upstream;
  let commits;
  let objects;
  try {
    commit = git(root, 'rev-parse', '--verify', `${head}^{commit}`).trim();
    upstream = git(root, 'rev-parse', '--verify', `${trusted}^{commit}`).trim();
    commits = git(root, 'rev-list', '--reverse', commit, '--not', upstream).trim().split('\n').filter(Boolean);
    objects = git(root, 'rev-list', '--objects', commit, '--not', upstream).trim().split('\n').filter(Boolean).map(line => line.split(' ')[0]);
  } catch { throw new PublicationError('Cannot resolve publication history and official upstream; publication blocked.'); }
  const issues = [];
  const directory = mkdtempSync(resolve(tmpdir(), 'cfos-privacy-'));
  const providerDirectory = resolve(directory, 'providers');
  const privacyDirectory = resolve(directory, 'privacy');
  mkdirSync(providerDirectory, { mode: 0o700 });
  mkdirSync(privacyDirectory, { mode: 0o700 });
  const staged = new Map();
  const blobs = new Map();
  const pathsByBlob = new Map();
  let fileCount = 0;
  try {
    // Official blobs are excluded by reachability, not by filename or a broad scanner allowlist.
    const trustedEntries = new Map(git(root, 'ls-tree', '-r', '-z', upstream).split('\0').filter(Boolean).map(line => {
      const [, hash, path] = line.match(/^\d+ blob ([a-f0-9]{40})\t(.+)$/s) ?? [];
      return [path, hash];
    }));
    for (const id of commits) {
      const raw = git(root, 'cat-file', 'commit', id);
      const boundary = raw.indexOf('\n\n');
      const header = raw.slice(0, boundary);
      for (const field of ['author', 'committer']) {
        const match = header.match(new RegExp(`^${field} (.+) <([^>]+)> \\d+ [+-]\\d+$`, 'm'));
        if (!match || !publicIdentity(match[2]) || !publicAuthorName(match[1])) issues.push(label(`private-${field}-identity`, id));
      }
      const messageFile = resolve(providerDirectory, `message-${fileCount++}.txt`);
      writeFileSync(messageFile, raw, { mode: 0o600 });
      staged.set(messageFile, { commit: id, path: null });
      writeFileSync(resolve(privacyDirectory, `message-${fileCount++}.txt`), raw, { mode: 0o600 });
      const changed = new Set(git(root, 'diff-tree', '--root', '--no-commit-id', '--name-only', '-r', '-m', '--no-renames', '-z', id).split('\0').filter(Boolean));
      for (const line of git(root, 'ls-tree', '-r', '-z', id).split('\0').filter(Boolean)) {
        const [, mode, hash, path] = line.match(/^(\d+) blob ([a-f0-9]{40})\t(.+)$/s) ?? [];
        if (!path) { issues.push(label('unsupported-tree-entry', id)); continue; }
        if (!changed.has(path) || trustedEntries.get(path) === hash) continue;
        for (const input of [providerDirectory, privacyDirectory]) {
          const pathFile = resolve(input, `path-${fileCount++}.txt`);
          writeFileSync(pathFile, path, { mode: 0o600 });
          staged.set(pathFile, { commit: id, path });
        }
        if (!pathsByBlob.has(hash)) pathsByBlob.set(hash, new Set());
        pathsByBlob.get(hash).add(path);
        if (forbiddenPath(path)) { issues.push(label('forbidden-path', id, path)); continue; }
        let bytes = blobs.get(hash);
        if (!bytes) { bytes = execFileSync('git', ['cat-file', 'blob', hash], { cwd: root, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }); blobs.set(hash, bytes); }
        const violation = contentViolation(path, bytes, policy);
        if (violation) issues.push(label(violation, id, path));
        if (mode === '120000' && (bytes.toString().startsWith('/') || !resolve('/', dirname(path), bytes.toString()).startsWith('/packages/'))) {
          issues.push(label('unsafe-source-symlink', id, path));
        }
      }
    }
    // Objects include intermediate blobs no longer present at the tip, and merge-resolution blobs.
    for (const hash of new Set(objects)) {
      const type = git(root, 'cat-file', '-t', hash).trim();
      if (type !== 'blob') continue;
      const size = Number(git(root, 'cat-file', '-s', hash).trim());
      if (size > policy.maxBlobBytes) { issues.push(label('oversize-history-blob', commit)); continue; }
      const bytes = blobs.get(hash) ?? execFileSync('git', ['cat-file', 'blob', hash], { cwd: root, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
      const name = resolve(providerDirectory, `blob-${fileCount++}.txt`);
      writeFileSync(name, bytes, { mode: 0o600 });
      staged.set(name, { commit, path: null });
      for (const path of pathsByBlob.get(hash) ?? [null]) {
        // Keep built-in secret detection on full blobs. Contact/literal rules inspect only lines
        // not already published in the same official source file, avoiding upstream test examples.
        let text = bytes.toString('utf8');
        const trustedHash = trustedEntries.get(path);
        if (trustedHash && !bytes.includes(0)) {
          const official = execFileSync('git', ['cat-file', 'blob', trustedHash], { cwd: root, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
          const knownLines = new Set(official.toString('utf8').split('\n'));
          text = text.split('\n').filter(line => !knownLines.has(line)).join('\n');
        }
        const privacyFile = resolve(privacyDirectory, `delta-${fileCount++}.txt`);
        writeFileSync(privacyFile, text, { mode: 0o600 });
        staged.set(privacyFile, { commit, path });
      }
    }
    const ignore = resolve(directory, 'empty-ignore');
    writeFileSync(ignore, '', { mode: 0o600 });
    const defaults = resolve(directory, 'default.toml');
    writeFileSync(defaults, '[extend]\nuseDefault = true\n', { mode: 0o600 });
    for (const [input, config] of [[providerDirectory, defaults], [privacyDirectory, resolve(policyRoot, '.gitleaks.toml')]]) {
    const report = resolve(directory, 'report.json');
    const result = spawnSync(scanner, ['dir', '--config', config, '--gitleaks-ignore-path', ignore,
      '--ignore-gitleaks-allow', '--redact=100', '--no-banner', '--no-color', '--log-level=error', '--exit-code=3',
      '--max-decode-depth=5', '--timeout=60', '--report-format=json', '--report-path', report, input], {
      cwd: root, encoding: 'utf8', timeout: 70_000, maxBuffer: 4 * 1024 * 1024,
    });
    if (result.error || ![0, 3].includes(result.status)) throw new PublicationError('Secret/PII scanner failed; publication blocked.');
    const findings = JSON.parse(readFileSync(report, 'utf8'));
    if (!Array.isArray(findings) || (result.status === 3 && !findings.length)) throw new PublicationError('Invalid scanner result; publication blocked.');
    for (const finding of findings) {
      const location = staged.get(resolve(input, finding.File)) ?? staged.get(resolve(finding.File));
      const rule = String(finding.RuleID).replace(/[^a-z0-9-]/gi, '').slice(0, 80);
      issues.push(label(`secret-or-pii:${rule}`, location?.commit ?? commit));
    }
    }
    if (issues.length) throw new PublicationError(`Publication blocked:\n${[...new Set(issues)].join('\n')}`);
    return { commits: commits.length, scannedFiles: fileCount, secretsAndPII: 'passed', identity: 'passed', sensitiveFiles: 'passed' };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

/** Fail closed with sanitized diagnostics, including malformed reports and filesystem errors. */
export function auditSecurity(options = {}) {
  try { return inspectSecurity(options); }
  catch (error) {
    if (error instanceof PublicationError) throw error;
    throw new PublicationError('Privacy audit could not complete; publication blocked.');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 2) throw new PublicationError('Usage: node scripts/cfos-security.mjs');
    console.log(JSON.stringify(auditSecurity()));
  } catch (error) {
    console.error(error instanceof PublicationError ? error.message : 'Publication audit failed; publication blocked.');
    process.exitCode = 1;
  }
}
