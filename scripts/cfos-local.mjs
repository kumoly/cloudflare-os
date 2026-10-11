#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const blobHash = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const same = (a, b) => a?.hash === b?.hash && a?.mode === b?.mode;
let interrupted = false;

/** Read Git's source manifest, including symlinks and executable bits. */
export function sourceTree(source, commit) {
  return Object.fromEntries(git(source, 'ls-tree', '-r', '-z', commit).split('\0').filter(Boolean).map(line => {
    const [, mode, hash, path] = line.match(/^(\d+) blob ([a-f0-9]{40})\t(.+)$/s) ?? [];
    if (!path || !['100644', '100755', '120000'].includes(mode)) throw new Error('Unsupported source tree entry.');
    return [path, { mode, hash }];
  }));
}

/** Refuse traversal through runtime directories that have been replaced with symlinks. */
function destination(app, path) {
  if (isAbsolute(path) || path.split('/').some(part => ['..', '.git', 'node_modules', '.wrangler'].includes(part))) throw new Error('Unsafe source path.');
  const full = resolve(app, path);
  if (relative(app, full).startsWith('..')) throw new Error('Source path escapes runtime.');
  let parent = dirname(full);
  while (parent !== app) {
    if (existsSync(parent) && !lstatSync(parent).isDirectory()) throw new Error(`Runtime parent is not a directory: ${path}`);
    parent = dirname(parent);
  }
  return full;
}

/** Fingerprint source without following source symlinks or reading generated configuration. */
export function runtimeEntry(app, path) {
  const full = destination(app, path);
  let stat;
  try { stat = lstatSync(full); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`Unexpected runtime source entry: ${path}`);
  const bytes = stat.isSymbolicLink() ? Buffer.from(readlinkSync(full)) : readFileSync(full);
  return { mode: stat.isSymbolicLink() ? '120000' : stat.mode & 0o111 ? '100755' : '100644', hash: blobHash(bytes) };
}

/** Build a delta and refuse drift or collisions with unmanaged runtime files. */
export function planChanges(app, previous, target) {
  const changes = [];
  for (const path of [...new Set([...Object.keys(previous), ...Object.keys(target)])].toSorted()) {
    const actual = runtimeEntry(app, path);
    if (!same(actual, previous[path])) throw new Error(`Runtime source drift: ${path}`);
    if (!same(actual, target[path])) changes.push({ path, before: actual, after: target[path] ?? null });
  }
  return changes;
}

/** Select the incremental path; dependency and storage changes use the full deployment procedure. */
export function changeMode(paths) {
  const runtime = paths.filter(path => !/^(docs\/|plans\/|\.github\/|\.cfos\/|AGENTS\.md$|README\.md$|scripts\/cfos(?:[.-]|$))/.test(path) && !/(^|\/)__tests__\/|\.test\.[cm]?[jt]sx?$/.test(path));
  if (!runtime.length) return 'source-only';
  if (runtime.some(path => /(^|\/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc)$|(^|\/)(migrations?|schema)(\/|\.)|^packages\/typed-storage\//i.test(path))) return 'full-update';
  if (runtime.every(path => /^packages\/[^/]+\/(src|app)\//.test(path))) {
    return runtime.some(path => /^packages\/(workshop-frontend|workshop-shared|ui|error-reporting)\//.test(path)) ? 'frontend' : 'hot';
  }
  return 'restart';
}

/** Apply a single source entry; generated files, dependencies and persistent data remain separate. */
export function replaceEntry(app, path, entry, bytes) {
  const full = destination(app, path);
  if (!entry) { rmSync(full, { force: true }); return; }
  mkdirSync(dirname(full), { recursive: true });
  if (entry.mode === '120000') {
    const link = bytes.toString();
    const target = resolve(dirname(full), link);
    if (isAbsolute(link) || relative(app, target).startsWith('..')) throw new Error('Source symlink escapes runtime.');
  }
  const staged = `${full}.cfos-${randomUUID()}`;
  try {
    if (entry.mode === '120000') symlinkSync(bytes.toString(), staged);
    else { writeFileSync(staged, bytes, { flag: 'wx', mode: entry.mode === '100755' ? 0o755 : 0o644 }); chmodSync(staged, entry.mode === '100755' ? 0o755 : 0o644); }
    renameSync(staged, full);
  } finally { rmSync(staged, { force: true }); }
}

const json = path => JSON.parse(readFileSync(path, 'utf8'));
function saveJson(path, value) {
  const staged = `${path}.${randomUUID()}`;
  writeFileSync(staged, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(staged, path);
}
function command(text, cwd) {
  if (interrupted) throw new Error('Local loop interrupted.');
  const result = spawnSync('/bin/sh', ['-eu', '-c', text], { cwd, stdio: 'inherit', timeout: 600_000 });
  if (result.error || result.status !== 0) throw new Error('Local check failed.');
}
function commands(list, cwd) { for (const text of list) command(text, cwd); }
async function smoke(list, app) {
  // Let Wrangler's file watcher observe the complete delta before opening a fresh RPC session.
  await new Promise(done => setTimeout(done, 1500));
  const deadline = Date.now() + 90_000;
  let healthy = false;
  while (Date.now() < deadline) {
    try { const response = await fetch('http://127.0.0.1:8787/', { signal: AbortSignal.timeout(3000) }); healthy = response.ok; await response.body?.cancel(); } catch { /* Wrangler may still be rebuilding. */ }
    if (healthy) break;
    await new Promise(done => setTimeout(done, 500));
  }
  if (!healthy) throw new Error('Local CFOS did not become healthy within 90 seconds.');
  commands(list, app);
}
const restart = () => execFileSync('/bin/launchctl', ['kickstart', '-k', `gui/${process.getuid()}/ai.kumoly.cloudflare-os`], { stdio: 'inherit' });
const frontend = app => command('pnpm exec vp run -F @gadgets/workshop-frontend --cache build:assets', app);

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    source: { type: 'string', default: process.cwd() }, service: { type: 'string' }, baseline: { type: 'string' },
    check: { type: 'string', multiple: true, default: [] }, accept: { type: 'string', multiple: true, default: [] },
    smoke: { type: 'string', multiple: true, default: [] }, restart: { type: 'boolean' }, 'state-compatible': { type: 'boolean' },
  } });
  const operation = positionals[0] ?? 'plan';
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { interrupted = true; });
  if (positionals.length > 1 || !['plan', 'apply', 'rollback'].includes(operation) || !values.service) throw new Error('Usage: cfos-local.mjs plan|apply|rollback --service ROOT --source WORKTREE [--baseline SHA] [--check COMMAND] [--accept COMMAND] [--smoke COMMAND] [--state-compatible] [--restart]');
  const service = resolve(values.service);
  const app = resolve(service, 'app');
  const source = resolve(values.source);
  if (app === source || !lstatSync(app).isDirectory() || !lstatSync(resolve(service, 'config')).isDirectory()) throw new Error('Use separate source and service directories.');
  const statePath = resolve(service, 'config/dev-loop-state.json');
  const oldState = existsSync(statePath) ? json(statePath) : null;
  const lock = resolve(service, 'tmp/backup-operation.lock');
  const started = Date.now();
  let locked = false;
  let applied = false;
  let journal;
  let runDir;
  let sourceReport;
  let mode;
  let target;
  let changes;
  const undo = () => {
    for (const item of journal.files.toReversed()) replaceEntry(app, item.path, item.before, item.bytes === null ? null : Buffer.from(item.bytes, 'base64'));
    if (journal.previousState) saveJson(statePath, journal.previousState);
    else rmSync(statePath, { force: true });
  };
  try {
    if (operation === 'rollback') {
      runDir = oldState?.rollbackDirectory;
      if (!runDir || !resolve(runDir).startsWith(resolve(service, 'tmp/dev-loop-') )) throw new Error('No retained local-loop rollback.');
      journal = json(resolve(runDir, 'journal.json'));
      changes = journal.files;
      mode = journal.mode;
      for (const item of changes) if (!same(runtimeEntry(app, item.path), item.after)) throw new Error(`Runtime drift prevents rollback: ${item.path}`);
    } else {
      const { inspectRepository, violations } = await import(pathToFileURL(resolve(source, 'scripts/cfos.mjs')));
      sourceReport = inspectRepository(source);
      const failures = violations(sourceReport, { publish: true });
      if (failures.length) throw new Error(failures.join('\n'));
      target = sourceTree(source, sourceReport.commit);
      let previous;
      if (oldState) previous = oldState.files;
      else {
        if (!/^[a-f0-9]{40}$/.test(values.baseline ?? '')) throw new Error('First run requires the known deployed compatibility commit as --baseline.');
        const base = sourceTree(source, values.baseline);
        // Legacy deployment has the compatibility edits but not the fork governance files.
        const tracked = git(app, 'ls-files', '-z').split('\0').filter(Boolean);
        previous = Object.fromEntries(tracked.map(path => { if (!base[path]) throw new Error(`Baseline is missing runtime source: ${path}`); return [path, base[path]]; }));
        for (const path of Object.keys(base).filter(entryPath => !previous[entryPath])) {
          if (runtimeEntry(app, path)) previous[path] = base[path];
        }
      }
      changes = planChanges(app, previous, target);
      mode = changeMode(changes.map(item => item.path));
      console.log(JSON.stringify({ channel: 'local-dev', sourceCommit: sourceReport.commit, mode, files: changes.map(item => item.path), fullCI: 'public-background' }, null, 2));
      if (operation === 'plan') return;
      if (mode === 'full-update') throw new Error('Dependency, toolchain or storage changes require the full backed-up deployment procedure.');
      if (mode !== 'source-only' && (!values['state-compatible'] || !values.check.length || !values.accept.length)) throw new Error('Runtime changes require --state-compatible, a focused --check and a feature --accept.');
      if (mode === 'restart' && !values.restart) throw new Error('Startup/configuration changes require --restart.');
    }
    if (!values.smoke.length) throw new Error('Supply the host login/persistence smoke commands.');
    mkdirSync(lock); locked = true;
    writeFileSync(resolve(lock, 'pid'), `${process.pid}\n`, { mode: 0o600 });
    commands(values.smoke, app);
    if (operation === 'rollback') {
      // Recheck while holding the same operation lock as backups and updates.
      for (const item of changes) if (!same(runtimeEntry(app, item.path), item.after)) throw new Error('Runtime changed while acquiring the lock.');
      undo();
      if (mode === 'frontend') frontend(app);
      if (mode === 'restart') restart();
      await smoke(values.smoke, app);
      saveJson(resolve(runDir, 'rollback.json'), { status: 'rolled-back', completedAt: new Date().toISOString(), seconds: (Date.now() - started) / 1000 });
      console.log('Local source rollback passed login and persistence checks.');
      return;
    }
    execFileSync(process.execPath, ['--test', 'scripts/cfos.test.mjs', resolve(dirname(fileURLToPath(import.meta.url)), 'cfos-local.test.mjs')], { cwd: source, stdio: 'inherit' });
    commands(values.check, source);
    // Checks must not change the source revision or introduce runtime drift.
    const { inspectRepository, violations } = await import(pathToFileURL(resolve(source, 'scripts/cfos.mjs')));
    const checked = inspectRepository(source);
    if (checked.commit !== sourceReport.commit || violations(checked, { publish: true }).length) throw new Error('Source changed during checks.');
    for (const item of changes) if (!same(runtimeEntry(app, item.path), item.before)) throw new Error('Runtime changed during checks.');
    runDir = resolve(service, `tmp/dev-loop-${randomUUID()}`);
    mkdirSync(runDir, { mode: 0o700 });
    journal = { mode, sourceCommit: sourceReport.commit, previousState: oldState, files: changes.map(item => {
      const full = destination(app, item.path);
      const bytes = item.before ? item.before.mode === '120000' ? Buffer.from(readlinkSync(full)) : readFileSync(full) : null;
      return { ...item, bytes: bytes?.toString('base64') ?? null };
    }) };
    saveJson(resolve(runDir, 'journal.json'), journal);
    if (interrupted) throw new Error('Local loop interrupted.');
    applied = true;
    for (const item of changes) {
      const bytes = item.after ? execFileSync('git', ['cat-file', 'blob', item.after.hash], { cwd: source, maxBuffer: 32 * 1024 * 1024 }) : null;
      replaceEntry(app, item.path, item.after, bytes);
    }
    if (mode === 'frontend') frontend(app);
    if (mode === 'restart') restart();
    await smoke(values.smoke, app);
    commands(values.accept, app);
    if (interrupted) throw new Error('Local loop interrupted.');
    planChanges(app, target, target);
    const receipt = { schemaVersion: 1, channel: 'local-dev', sourceCommit: sourceReport.commit, sourceTree: sourceReport.tree, mode, files: target,
      rollbackDirectory: runDir, checkCommands: values.check, acceptanceCommands: values.accept, completedAt: new Date().toISOString(),
      seconds: (Date.now() - started) / 1000, smoke: 'passed', featureAcceptance: values.accept.length ? 'passed' : 'not-applicable', fullCI: 'public-background', stableRelease: false };
    saveJson(statePath, receipt);
    saveJson(resolve(runDir, 'result.json'), receipt);
    console.log(`Local CFOS updated: ${sourceReport.commit.slice(0, 8)}; ${receipt.seconds}s; ${mode}; smoke passed.`);
  } catch (error) {
    if (applied) {
      try {
        interrupted = false;
        undo();
        if (mode === 'frontend') frontend(app);
        if (mode === 'restart') restart();
        await smoke(values.smoke, app);
        saveJson(resolve(runDir, 'result.json'), { status: 'failed-and-rolled-back', smoke: 'passed' });
        console.error('Candidate failed; previous source restored and smoke passed.');
      } catch {
        console.error(`Source recovery needs attention. Retained journal: ${runDir}`);
      }
    }
    throw error;
  } finally {
    if (locked) { rmSync(resolve(lock, 'pid'), { force: true }); rmdirSync(lock); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
