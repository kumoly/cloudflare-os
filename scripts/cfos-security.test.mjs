import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditSecurity, contentViolation, forbiddenPath, publicAuthorName, publicIdentity } from './cfos-security.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const anonymous = '131692551+kumoly@users.noreply.github.com';
const canary = () => ['ghp_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');
function fixture(t) {
  const root = mkdtempSync(resolve(tmpdir(), 'cfos-security-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '--initial-branch=main');
  git('config', 'user.name', 'Synthetic Maintainer');
  git('config', 'user.email', 'upstream@example.invalid');
  writeFileSync(resolve(root, 'upstream.txt'), 'trusted source');
  git('add', '.'); git('commit', '-qm', 'trusted upstream'); git('branch', 'trusted');
  git('config', 'user.email', anonymous);
  git('config', 'user.name', 'synthetic-maintainer');
  mkdirSync(resolve(root, '.cfos'));
  copyFileSync(resolve(source, '.gitleaks.toml'), resolve(root, '.gitleaks.toml'));
  copyFileSync(resolve(source, '.cfos/security.json'), resolve(root, '.cfos/security.json'));
  const add = (path, text) => { mkdirSync(dirname(resolve(root, path)), { recursive: true }); writeFileSync(resolve(root, path), text); git('add', path); git('commit', '-qm', 'synthetic change'); };
  return { root, git, add, audit: () => auditSecurity({ root, trusted: 'refs/heads/trusted', policyRoot: root }) };
}

test('sensitive path policy cannot be bypassed by force adding ignored files', () => {
  for (const path of ['.env.local', 'config/admin-bootstrap.txt', 'packages/x/.dev.vars', 'logs/result.txt', 'secrets/key.pem', 'fixtures/account.sqlite', 'private-fixtures/doc.txt', 'packages/x/private-fixtures/person.txt', 'state.tfvars.json', 'state.tfstate.backup', 'result.log.1', '.terraform/cache.txt']) assert.equal(forbiddenPath(path), true, path);
  for (const path of ['.env.example', 'packages/x/src/config.ts', 'packages/x/package.json']) assert.equal(forbiddenPath(path), false, path);
});
test('identity policy permits noreply identities and rejects ordinary emails', () => {
  assert.equal(publicIdentity(anonymous), true);
  assert.equal(publicIdentity('noreply@github.com'), true);
  assert.equal(publicIdentity('maintainer@example.invalid'), false);
  assert.equal(publicAuthorName('kumoly'), true);
  assert.equal(publicAuthorName('Synthetic Person'), false);
});
test('reserved synthetic content and official history pass without changing source', t => {
  const f = fixture(t);
  f.add('src/example.txt', 'user@example.invalid\nphone = "+1 202-555-0101"\n');
  const before = f.git('rev-parse', 'HEAD');
  assert.equal(f.audit().commits, 1);
  assert.equal(f.git('rev-parse', 'HEAD'), before);
});
test('missing scanner fails closed', t => {
  const f = fixture(t);
  assert.throws(() => auditSecurity({ root: f.root, trusted: 'trusted', policyRoot: f.root, scanner: 'cfos-nonexistent-scanner' }), /required.*blocked/);
});
test('ordinary commit identity is blocked without revealing the email', t => {
  const f = fixture(t);
  const email = ['synthetic-person', 'mail-provider.invalid'].join('@');
  f.git('config', 'user.email', email);
  f.add('src/a.txt', 'safe');
  assert.throws(f.audit, error => error.message.includes('private-author-identity') && !error.message.includes(email));
});
test('a credential committed then removed remains blocked and output is redacted', t => {
  const f = fixture(t);
  const token = canary();
  f.add('src/intermediate.txt', token);
  f.git('rm', 'src/intermediate.txt'); f.git('commit', '-qm', 'remove synthetic canary');
  assert.throws(f.audit, error => error.message.includes('secret-or-pii') && !error.message.includes(token));
});
test('private emails in source are blocked while reserved examples are allowed', t => {
  const f = fixture(t);
  const email = ['synthetic-person', 'gmail.com'].join('@');
  f.add('src/contact.txt', email);
  assert.throws(f.audit, error => error.message.includes('cfos-private-email') && !error.message.includes(email));
});
test('commit messages are scanned for secrets', t => {
  const f = fixture(t);
  f.git('commit', '--allow-empty', '-qm', canary());
  assert.throws(f.audit, /secret-or-pii/);
});
test('credentials and email addresses in filenames are blocked', t => {
  const f = fixture(t);
  f.add(`src/${canary()}.txt`, 'safe content');
  assert.throws(f.audit, /secret-or-pii/);
  assert.equal(forbiddenPath(['src/contact', 'example.invalid.txt'].join('@')), true);
});
test('machine-specific user paths are blocked', t => {
  const f = fixture(t);
  f.add('src/local.json', JSON.stringify({ path: ['', 'Users', 'synthetic-owner', 'config'].join('/') }));
  assert.throws(f.audit, /cfos-local-user-path/);
});
test('JSON credential literals and contact fields are blocked', t => {
  const f = fixture(t);
  f.add('src/contact.json', JSON.stringify({ password: ['runtime', 'canary', 'value'].join('-'), full_name: ['Synthetic', 'Person'].join(' '), phone: ['+1', '203', '555', '0101'].join(' ') }));
  assert.throws(f.audit, /cfos-credential-literal|cfos-phone-literal/);
});
test('short and punctuation-containing credential literals are blocked', t => {
  const f = fixture(t);
  f.add('src/short.json', JSON.stringify({ password: ['x', '!'].join('') }));
  assert.throws(f.audit, /cfos-credential-literal/);
});
test('encoded credentials are scanned and failed scanners remain fail closed', t => {
  const f = fixture(t);
  f.add('src/encoded.txt', Buffer.from(canary()).toString('base64'));
  assert.throws(f.audit, /secret-or-pii/);
  const fake = resolve(f.root, 'scanner');
  writeFileSync(fake, '#!/bin/sh\nif [ "$1" = version ]; then echo 8.30.1; else echo failed >&2; exit 2; fi\n', { mode: 0o700 });
  assert.throws(() => auditSecurity({ root: f.root, trusted: 'trusted', policyRoot: f.root, scanner: fake }), /scanner failed.*blocked/);
});
test('merge-only secrets are blocked', t => {
  const f = fixture(t);
  f.git('checkout', '-qb', 'other', 'trusted'); f.add('src/right.txt', 'right');
  f.git('checkout', '-q', 'main'); f.add('src/left.txt', 'left');
  f.git('merge', '--no-ff', '--no-commit', 'other');
  writeFileSync(resolve(f.root, 'src/resolution.txt'), canary());
  f.git('add', 'src/resolution.txt'); f.git('commit', '-qm', 'synthetic merge');
  assert.throws(f.audit, /secret-or-pii/);
});
test('ignored runtime files in commit history are blocked even if later deleted', t => {
  const f = fixture(t);
  f.add('config/admin-bootstrap.txt', 'synthetic runtime file');
  f.git('rm', 'config/admin-bootstrap.txt'); f.git('commit', '-qm', 'remove');
  assert.throws(f.audit, /forbidden-path/);
});
test('asset approval binds synthetic provenance to both path and exact bytes', t => {
  const f = fixture(t);
  const policy = JSON.parse(readFileSync(resolve(f.root, '.cfos/security.json')));
  const bytes = Buffer.from('%PDF synthetic test data');
  assert.equal(contentViolation('fixtures/example.pdf', bytes, policy), 'unreviewed-asset');
  policy.syntheticAssets.push({ path: 'fixtures/example.pdf', sha256: createHash('sha256').update(bytes).digest('hex'), synthetic: true, reason: 'Generated synthetic example in this test.' });
  assert.equal(contentViolation('fixtures/example.pdf', bytes, policy), null);
  assert.equal(contentViolation('fixtures/example.pdf', Buffer.from('changed'), policy), 'unreviewed-asset');
  assert.equal(contentViolation('fixtures/renamed.pdf', bytes, policy), 'unreviewed-asset');
});
