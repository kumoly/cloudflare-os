import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidateManifest, pushViolations, repositoryIdentity, violations } from './cfos.mjs';

const sha = 'a'.repeat(40);
const report = {
  config: { fork: 'kumoly/cloudflare-os', upstreamBase: sha, compatibilityCommits: [], requiredChecks: ['Build and test'] },
  branch: 'feat/documents', clean: true, upstreamBasePresent: true, missingCompatibility: [],
  upstream: 'cloudflare/cloudflare-os', upstreamPushDisabled: true,
  fork: 'kumoly/cloudflare-os', forkPush: 'kumoly/cloudflare-os',
  commit: sha, tree: 'b'.repeat(40), lockfileSha256: 'c'.repeat(64), stackSha256: 'd'.repeat(64), upstreamHead: sha,
};
const zero = '0'.repeat(40);
const refs = (name, previous = zero, local = sha) => `refs/heads/${name} ${local} refs/heads/${name} ${previous}\n`;

test('recognizes HTTPS and the configured SSH account alias without exposing credentials', () => {
  assert.equal(repositoryIdentity('https://secret@github.com/kumoly/cloudflare-os.git'), 'kumoly/cloudflare-os');
  assert.equal(repositoryIdentity('git@github-kumoly:kumoly/cloudflare-os.git'), 'kumoly/cloudflare-os');
  assert.equal(repositoryIdentity('git@github.com:cloudflare/cloudflare-os.git'), 'cloudflare/cloudflare-os');
  assert.equal(repositoryIdentity('https://evil.example/kumoly/cloudflare-os'), null);
});
test('blocks a dirty tree, wrong base, missing compatibility and upstream push access', () => {
  for (const invalid of [{clean:false}, {upstreamBasePresent:false}, {missingCompatibility:['cache']}, {upstreamPushDisabled:false}, {branch:'main'}]) {
    assert.ok(violations({...report,...invalid}).length);
  }
  assert.deepEqual(violations(report, {publish:true}), []);
  assert.ok(violations({...report,fork:null},{publish:true}).length);
});
test('allows new feature branches but blocks main, upstream, deletes and force pushes', () => {
  const check = (remote, url, lines, ancestor = true) => pushViolations(report, remote, url, lines, () => ancestor);
  assert.deepEqual(check('origin','git@github-kumoly:kumoly/cloudflare-os.git',refs('feat/documents')), []);
  assert.ok(check('upstream','https://github.com/cloudflare/cloudflare-os.git',refs('feat/documents')).length);
  assert.ok(check('origin','https://github.com/kumoly/cloudflare-os.git',refs('main')).length);
  assert.ok(check('origin','https://github.com/kumoly/cloudflare-os.git',refs('cfos/main',sha,'b'.repeat(40)),false).length);
  assert.ok(check('origin','https://github.com/kumoly/cloudflare-os.git',refs('feat/documents',sha,zero)).length);
});
test('release tags cannot be replaced and malformed ref data fails closed', () => {
  const check = lines => pushViolations(report,'origin','https://github.com/kumoly/cloudflare-os.git',lines,()=>true);
  assert.deepEqual(check(`refs/tags/cfos-v0.1.0 ${sha} refs/tags/cfos-v0.1.0 ${zero}`), []);
  assert.ok(check(`refs/tags/cfos-v0.1.0 ${sha} refs/tags/cfos-v0.1.0 ${sha}`).length);
  assert.ok(check('garbage').length);
});
test('publishing another branch cannot borrow the current checkout verification', () => {
  const other = 'e'.repeat(40);
  const errors = pushViolations(report,'origin','git@github-kumoly:kumoly/cloudflare-os.git',refs('feat/other',zero,other),(a,b)=>a===b);
  assert.ok(errors.some(message=>message.includes('checked HEAD')));
  assert.ok(errors.some(message=>message.includes('upstream base')));
});
test('candidate records pin exact source and never invent passing validation', () => {
  const manifest = candidateManifest(report);
  assert.equal(manifest.sourceCommit, sha);
  assert.equal(manifest.deployable, false);
  assert.equal(manifest.isolatedAcceptance, 'not_run');
  assert.equal(manifest.requiredChecks[0].status, 'not_run');
  assert.throws(()=>candidateManifest({...report,clean:false}));
});
