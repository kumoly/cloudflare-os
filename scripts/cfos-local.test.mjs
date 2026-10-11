import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, readlinkSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { changeMode, planChanges, replaceEntry, runtimeEntry } from './cfos-local.mjs';

function fixture(t) {
  const app = mkdtempSync(resolve(tmpdir(), 'cfos-loop-test-'));
  t.after(() => rmSync(app, { recursive: true, force: true }));
  mkdirSync(resolve(app, 'src'));
  return app;
}

test('delta handles add, edit, delete and retains ignored state and generated files', t => {
  const app = fixture(t);
  writeFileSync(resolve(app, 'src/keep.ts'), 'keep');
  writeFileSync(resolve(app, 'src/edit.ts'), 'before');
  writeFileSync(resolve(app, 'src/remove.ts'), 'remove');
  writeFileSync(resolve(app, 'wrangler.dev.jsonc'), 'private generated config');
  mkdirSync(resolve(app, 'node_modules'));
  writeFileSync(resolve(app, 'node_modules/cache'), 'cache');
  const previous = Object.fromEntries(['keep', 'edit', 'remove'].map(name => [`src/${name}.ts`, runtimeEntry(app, `src/${name}.ts`)]));
  const template = fixture(t);
  writeFileSync(resolve(template, 'src/edit.ts'), 'after');
  writeFileSync(resolve(template, 'src/add.ts'), 'new');
  const target = { 'src/keep.ts': previous['src/keep.ts'], 'src/edit.ts': runtimeEntry(template, 'src/edit.ts'), 'src/add.ts': runtimeEntry(template, 'src/add.ts') };
  const changes = planChanges(app, previous, target);
  assert.deepEqual(changes.map(item => item.path), ['src/add.ts', 'src/edit.ts', 'src/remove.ts']);
  for (const item of changes) replaceEntry(app, item.path, item.after, item.after ? readFileSync(resolve(template, item.path)) : null);
  assert.deepEqual(planChanges(app, target, target), []);
  assert.equal(existsSync(resolve(app, 'src/remove.ts')), false);
  assert.equal(readFileSync(resolve(app, 'wrangler.dev.jsonc'), 'utf8'), 'private generated config');
  assert.equal(readFileSync(resolve(app, 'node_modules/cache'), 'utf8'), 'cache');
});

test('runtime edits and collisions refuse overwrite before copying anything', t => {
  const app = fixture(t);
  writeFileSync(resolve(app, 'src/a.ts'), 'original');
  const previous = { 'src/a.ts': runtimeEntry(app, 'src/a.ts') };
  writeFileSync(resolve(app, 'src/a.ts'), 'manual change');
  assert.throws(() => planChanges(app, previous, previous), /drift/);
  assert.throws(() => planChanges(app, {}, previous), /drift/);
  assert.equal(readFileSync(resolve(app, 'src/a.ts'), 'utf8'), 'manual change');
});

test('source symlinks round trip and unsafe target paths are rejected', t => {
  const app = fixture(t);
  writeFileSync(resolve(app, 'src/type.d.ts'), 'type');
  symlinkSync('type.d.ts', resolve(app, 'src/type.txt'));
  const entry = runtimeEntry(app, 'src/type.txt');
  replaceEntry(app, 'src/type.txt', null, null);
  replaceEntry(app, 'src/type.txt', entry, Buffer.from('type.d.ts'));
  assert.equal(readlinkSync(resolve(app, 'src/type.txt')), 'type.d.ts');
  assert.throws(() => replaceEntry(app, 'src/bad.txt', entry, Buffer.from('../../outside')), /escapes/);
  assert.throws(() => runtimeEntry(app, '../outside'), /Unsafe/);
  assert.throws(() => runtimeEntry(app, 'node_modules/cache'), /Unsafe/);
  symlinkSync(tmpdir(), resolve(app, 'linked'));
  assert.throws(() => runtimeEntry(app, 'linked/anything'), /not a directory/);
});

test('restoring source bytes returns the old fingerprint including executable mode', t => {
  const app = fixture(t);
  const original = Buffer.from('#!/bin/sh\nexit 0\n');
  replaceEntry(app, 'src/run', { mode: '100755' }, original);
  const before = runtimeEntry(app, 'src/run');
  replaceEntry(app, 'src/run', { mode: '100644' }, Buffer.from('broken'));
  replaceEntry(app, 'src/run', before, original);
  assert.deepEqual(runtimeEntry(app, 'src/run'), before);
});

test('path policy uses hot reload, assets or restart and escalates structural changes', () => {
  assert.equal(changeMode(['docs/cfos-development.md', 'scripts/cfos-local.mjs']), 'source-only');
  assert.equal(changeMode(['packages/workshop-backend/__tests__/agent.test.ts']), 'source-only');
  assert.equal(changeMode(['packages/gatekeeper-documents/src/index.ts']), 'hot');
  assert.equal(changeMode(['packages/workshop-shared/src/api.ts']), 'frontend');
  assert.equal(changeMode(['scripts/run-dev-server.ts']), 'restart');
  assert.equal(changeMode(['packages/gatekeeper-documents/wrangler.jsonc']), 'restart');
  assert.equal(changeMode(['pnpm-lock.yaml']), 'full-update');
  assert.equal(changeMode(['packages/gatekeeper-documents/package.json']), 'full-update');
  assert.equal(changeMode(['packages/workshop-backend/src/migrations/next.ts']), 'full-update');
});
