import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { writeJson } from '../src/io.js';
import { registerRepository, readRegistry } from '../src/opsled-registry.js';
import {
  assertRuntimeStartAllowed,
  inventoryManagedRuntime,
  readCurrentRuntime,
  upgradeHostRuntime,
} from '../src/runtime-upgrade.js';
import { initialize } from '../src/state.js';

const sourceRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');

function repository(name) {
  const root = mkdtempSync(join(tmpdir(), `opsle-runtime-${name}-`));
  mkdirSync(join(root, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(root, '.git', 'refs', 'heads', 'main'), `${'7'.repeat(40)}\n`);
  writeFileSync(join(root, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');
  writeFileSync(join(root, 'README.md'), `# ${name}\n`);
  initialize(root, { actor: 'runtime-upgrade-test', objectiveText: `Operate ${name}.` });
  writeJson(join(root, '.opsle', 'wake', 'codex-session-binding.json'), {
    schema: 'opsle.durable-supervisor.codex-session-binding/v3',
    state: 'CURRENT',
    repository_realpath: realpathSync(root),
    sessions_root_realpath: join(root, 'sessions'),
    host: {
      kind: 'herdr',
      workspace_id: `workspace-${name}`,
      pane_id: `pane-${name}`,
      terminal_id: `terminal-${name}`,
    },
  });
  return root;
}

test('host runtime upgrade installs by digest, migrates managed repositories, and records current authority', async () => {
  const hostRoot = mkdtempSync(join(tmpdir(), 'opsle-runtime-host-'));
  const root = repository('install');
  let started = null;
  try {
    registerRepository(hostRoot, root);
    const upgraded = await upgradeHostRuntime(hostRoot, sourceRoot, {
      startTarget: async (releaseRoot, targetHost) => { started = { releaseRoot, targetHost }; },
    });
    assert.equal(upgraded.status, 'COMPLETED');
    assert.equal(upgraded.repositories.length, 1);
    assert.equal(upgraded.repositories[0].status, 'OK');
    const current = readCurrentRuntime(hostRoot);
    assert.equal(current.release_root, started.releaseRoot);
    assert.equal(started.targetHost, realpathSync(hostRoot));
    assert.equal(current.release_root.endsWith(current.packaged_artifact_sha256), true);
    assert.equal((statSync(join(current.release_root, 'bin', 'opsled.js')).mode & 0o222), 0);
    assert.throws(
      () => assertRuntimeStartAllowed(hostRoot, { root: sourceRoot }),
      (error) => error.classification === 'UPGRADE_REQUIRED',
    );
    assert.equal(
      assertRuntimeStartAllowed(hostRoot, { root: current.release_root }).managed,
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(hostRoot, { recursive: true, force: true });
  }
});

test('runtime inventory reports one corrupt repository without hiding its healthy peer', () => {
  const hostRoot = mkdtempSync(join(tmpdir(), 'opsle-runtime-inventory-'));
  const first = repository('inventory-a');
  const second = repository('inventory-b');
  try {
    registerRepository(hostRoot, first);
    registerRepository(hostRoot, second);
    const mapping = Object.values(readRegistry(hostRoot).repositories)
      .find((entry) => entry.repository_realpath === first);
    mkdirSync(join(mapping.host_state_path, 'runners'), { recursive: true });
    writeJson(join(mapping.host_state_path, 'runners', 'corrupt.json'), {
      worker: { pid: 'not-a-pid' },
    });
    const inventory = inventoryManagedRuntime(hostRoot);
    assert.equal(inventory.repositories.length, 2);
    assert.equal(inventory.failures.length, 1);
    assert.equal(inventory.failures[0].repository_realpath, first);
    assert.deepEqual(
      inventory.repositories.find((entry) => entry.repository_realpath === second).errors,
      [],
    );
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
    rmSync(hostRoot, { recursive: true, force: true });
  }
});
