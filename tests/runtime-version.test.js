import assert from 'node:assert/strict';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalJson, readJson } from '../src/io.js';
import {
  assertReleaseFence,
  createReleaseFence,
  loadRuntimeRelease,
  processStartIdentity,
  releaseIdentity,
  runtimePackageRoot,
  sameReleaseIdentity,
} from '../src/runtime-release.js';
import { initialize, paths } from '../src/state.js';

function repository() {
  const root = mkdtempSync(join(tmpdir(), 'opsle-runtime-version-'));
  mkdirSync(join(root, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(root, '.git', 'refs', 'heads', 'main'), `${'7'.repeat(40)}\n`);
  writeFileSync(join(root, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');
  writeFileSync(join(root, 'README.md'), '# runtime fixture\n');
  initialize(root, { actor: 'runtime-version-test', objectiveText: 'Test runtime boundaries.' });
  return root;
}

test('immutable release manifest verifies the complete normalized package and every helper', () => {
  const release = loadRuntimeRelease({ refresh: true });
  assert.match(release.runtime_release_id, /^opsle-runtime-/);
  assert.match(release.version, /^\d+\.\d+\.\d+/);
  assert.ok(release.source_revision);
  assert.match(release.packaged_artifact_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(release.helpers.map((entry) => entry.role).sort(), [
    'cli', 'codex-resume', 'opsled', 'opsled-wake-worker', 'opsled-worker',
    'runner-worker', 'wake-delivery',
  ]);
  assert.ok(release.artifact.files.some((entry) => entry.path === 'release-manifest.json'));
  assert.ok(release.artifact.files.some((entry) => entry.path === 'package.json'));
});

test('release digest is stable across checkout umasks', () => {
  const source = runtimePackageRoot();
  const release = loadRuntimeRelease();
  const root = mkdtempSync(join(tmpdir(), 'opsle-runtime-umask-'));
  try {
    for (const entry of release.artifact.files) {
      const from = join(source, entry.path);
      const to = join(root, entry.path);
      mkdirSync(join(to, '..'), { recursive: true });
      cpSync(from, to);
      chmodSync(to, (statSync(from).mode & 0o111) === 0 ? 0o664 : 0o775);
    }
    assert.equal(
      loadRuntimeRelease({ root }).packaged_artifact_sha256,
      release.packaged_artifact_sha256,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('artifact and manifest mismatches fail closed', () => {
  const source = runtimePackageRoot();
  const release = loadRuntimeRelease();
  for (const mutation of ['helper', 'manifest']) {
    const root = mkdtempSync(join(tmpdir(), `opsle-runtime-artifact-${mutation}-`));
    try {
      for (const entry of release.artifact.files) {
        const from = join(source, entry.path);
        const to = join(root, entry.path);
        mkdirSync(join(to, '..'), { recursive: true });
        cpSync(from, to, { preserveTimestamps: true });
      }
      if (mutation === 'helper') {
        writeFileSync(join(root, 'bin', 'opsle.js'), '#!/usr/bin/env node\n// tampered\n');
      } else {
        const manifest = JSON.parse(readFileSync(join(root, 'release-manifest.json'), 'utf8'));
        manifest.runtime_epoch = `${manifest.runtime_epoch}-tampered`;
        writeFileSync(join(root, 'release-manifest.json'), canonicalJson(manifest));
      }
      assert.throws(() => loadRuntimeRelease({ root }), /digest mismatch/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('malformed durable state is classified as CORRUPT', () => {
  const root = repository();
  try {
    const statePath = paths(root).state;
    writeFileSync(statePath, '{ malformed\n');
    assert.throws(
      () => readJson(statePath),
      (error) => error.classification === 'CORRUPT' && error.classification !== 'UPGRADE_REQUIRED',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('release fence rejects superseded artifact, role, epoch, and stale PID/start identities', () => {
  const identity = processStartIdentity();
  const valid = createReleaseFence('runner-worker', identity);
  assert.equal(assertReleaseFence(valid, { role: 'runner-worker', processIdentity: identity }), true);
  for (const mutation of [
    (fence) => { fence.runtime_release_id = 'opsle-runtime-0.0.0-deadbeefdeadbeef'; },
    (fence) => { fence.release_root = '/different/runtime/root'; },
    (fence) => { fence.packaged_artifact_sha256 = '0'.repeat(64); },
    (fence) => { fence.runtime_epoch = 'superseded'; },
    (fence) => { fence.helper_role = 'wake-delivery'; },
    (fence) => { fence.helper_process.pid += 1; },
    (fence) => { fence.helper_process.start_time_ticks = `${fence.helper_process.start_time_ticks}0`; },
  ]) {
    const candidate = structuredClone(valid);
    mutation(candidate);
    assert.throws(
      () => assertReleaseFence(candidate, { role: 'runner-worker', processIdentity: identity }),
      /runtime release fence mismatch/,
    );
  }
});

test('release identity equality ignores object key ordering but rejects changed identity fields', () => {
  const expected = releaseIdentity('codex-resume');
  const reordered = {
    helper_role: expected.helper_role,
    runtime_epoch: expected.runtime_epoch,
    packaged_artifact_sha256: expected.packaged_artifact_sha256,
    release_root: expected.release_root,
    runtime_release_id: expected.runtime_release_id,
  };
  assert.equal(sameReleaseIdentity(reordered, expected), true);

  for (const [field, value] of [
    ['runtime_release_id', 'opsle-runtime-0.0.0-deadbeefdeadbeef'],
    ['release_root', '/different/runtime/root'],
    ['packaged_artifact_sha256', '0'.repeat(64)],
    ['runtime_epoch', 'superseded-runtime-epoch'],
    ['helper_role', 'wake-delivery'],
  ]) {
    assert.equal(sameReleaseIdentity({ ...reordered, [field]: value }, expected), false, field);
  }
});
