import assert from 'node:assert/strict';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';
import { canonicalJson, readJson, writeJson } from '../src/io.js';
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
import {
  WAKE_DISPATCHER_IMPLEMENTATION_SHA256,
  runWakeDispatcher,
} from '../src/wakeup.js';

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

function operationalBytes(root) {
  const base = join(root, '.opsle');
  const values = new Map();
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) values.set(relative(base, path), readFileSync(path));
    }
  }
  walk(base);
  return values;
}

function assertBytesEqual(actual, expected) {
  assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort());
  for (const [path, bytes] of expected) assert.deepEqual(actual.get(path), bytes, path);
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

test('old helper fence denies representative mutation, launch, wake, and authority actions', () => {
  const identity = processStartIdentity();
  const old = createReleaseFence('runner-worker', identity);
  old.runtime_epoch = 'superseded-runtime-epoch';
  for (const action of ['state-mutation', 'child-launch', 'wake-delivery', 'authority-transition']) {
    let sideEffect = false;
    assert.throws(() => {
      assertReleaseFence(old, { role: 'runner-worker', processIdentity: identity });
      sideEffect = true;
    }, /runtime release fence mismatch/, action);
    assert.equal(sideEffect, false, action);
  }
});

test('superseded wake helper retires before ownership or delivery mutation', async () => {
  const root = repository();
  try {
    const wake = join(root, '.opsle', 'wake');
    mkdirSync(join(wake, 'requests'), { recursive: true });
    const identity = { pid: 8123, start_time_ticks: '812300', executable: '/usr/bin/node' };
    const supervisor = readJson(paths(root).supervisor);
    const fence = createReleaseFence('wake-delivery', identity);
    fence.packaged_artifact_sha256 = '0'.repeat(64);
    writeJson(join(wake, 'dispatcher.json'), {
      schema: 'opsle.durable-supervisor.host-wake-dispatcher/v1',
      dispatcher_id: 'dispatcher-old-release',
      dispatcher_generation: 1,
      implementation_sha256: WAKE_DISPATCHER_IMPLEMENTATION_SHA256,
      release_fence: fence,
      supervisor_id: supervisor.supervisor_id,
      supervisor_generation: supervisor.generation,
      queue_generation: supervisor.generation,
      launch_nonce: 'old-release-launch',
      process: identity,
      status: 'LAUNCHED',
    });
    const before = operationalBytes(root);
    const result = await runWakeDispatcher(root, {
      dispatcherId: 'dispatcher-old-release',
      dispatcherGeneration: 1,
      launchNonce: 'old-release-launch',
      pid: identity.pid,
      getProcessIdentity: (pid) => pid === identity.pid ? identity : null,
      delay: async () => {},
      maxCycles: 0,
    });
    assert.deepEqual(result, {
      status: 'STALE',
      reason: 'dispatcher-runtime-release-fence-mismatch',
    });
    assertBytesEqual(operationalBytes(root), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
