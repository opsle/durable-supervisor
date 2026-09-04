import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { fileSha256, readJson, writeJson } from '../src/io.js';
import {
  registerRepository,
  readRegistry,
  registryPaths,
} from '../src/opsled-registry.js';
import { createRunnerRequest } from '../src/opsled-runner.js';
import {
  assertRuntimeStartAllowed,
  inventoryManagedRuntime,
  readCurrentRuntime,
  upgradeHostRuntime,
} from '../src/runtime-upgrade.js';
import { processStartIdentity } from '../src/runtime-release.js';
import { initialize } from '../src/state.js';

const sourceRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');
const priorRuntime = process.env.OPSLE_PRIOR_RUNTIME
  ?? '/home/deploy/.npm-global/lib/node_modules/@opsle/durable-supervisor';
const priorWakeupSha256 = process.env.OPSLE_PRIOR_WAKEUP_SHA256
  ?? 'e4c6cdc6da82904c363b934b9be1e764555377b909fae7ccad5a2ccf410e511a';

async function waitFor(check, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const value = check();
    if (value) return value;
    await sleep(20);
  }
  assert.fail(message);
}

async function startInstalledOpsled(releaseRoot, hostRoot) {
  const moduleUrl = pathToFileURL(join(releaseRoot, 'src', 'opsled.js'));
  moduleUrl.searchParams.set('host', hostRoot);
  const runtime = await import(moduleUrl.href);
  const started = await runtime.startOpsled(hostRoot, { intervalMs: 20 });
  return { runtime, started };
}

async function stopInstalledOpsled(started, hostRoot) {
  if (!started?.runtime) return;
  const status = started.runtime.opsledStatus(hostRoot);
  const identity = status.opsled.process;
  started.runtime.stopOpsled(hostRoot);
  if (identity) {
    await waitFor(
      () => !processStartIdentity(identity.pid)
        || processStartIdentity(identity.pid).start_time_ticks !== identity.start_time_ticks,
      'installed opsled did not stop',
    );
  }
}

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

function stageRunnerIntent(root, suffix) {
  const supervisor = readJson(join(root, '.opsle', 'supervisor.json'));
  const task = { task_id: `task-${suffix}`, attempts: [`attempt-${suffix}`] };
  const attempt = {
    task_id: task.task_id,
    attempt_id: task.attempts[0],
    claim_id: `claim-${suffix}`,
    fence_generation: 1,
    child_state: 'QUEUED',
  };
  const claim = {
    task_id: task.task_id,
    attempt_id: attempt.attempt_id,
    claim_id: attempt.claim_id,
    fence_generation: attempt.fence_generation,
    owner_supervisor_id: supervisor.supervisor_id,
    status: 'ACTIVE',
  };
  for (const name of ['tasks', 'children', 'claims']) {
    mkdirSync(join(root, '.opsle', name), { recursive: true });
  }
  writeJson(join(root, '.opsle', 'tasks', `${task.task_id}.json`), task);
  writeJson(join(root, '.opsle', 'children', `${attempt.attempt_id}.json`), attempt);
  writeJson(join(root, '.opsle', 'claims', `${claim.claim_id}.json`), claim);
  const state = readJson(join(root, '.opsle', 'state.json'));
  state.active_task_id = task.task_id;
  state.active_attempt_id = attempt.attempt_id;
  state.pause = { active: false, after_current: false };
  writeJson(join(root, '.opsle', 'state.json'), state);
  return { task, attempt, claim };
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

test('takeover retires an already-running managed prior helper before release B becomes current', {
  skip: !existsSync(join(priorRuntime, 'bin', 'opsle-wake-delivery.js')),
  timeout: 30000,
}, async () => {
  const hostRoot = mkdtempSync(join(tmpdir(), 'opsle-runtime-prior-helper-'));
  const root = repository('prior-helper');
  const installedWakeup = join(priorRuntime, 'src', 'wakeup.js');
  let priorIdentity = null;
  let targetStarted = null;
  let sawQuiescedLaunchGate = false;
  try {
    assert.equal(fileSha256(installedWakeup), priorWakeupSha256);
    const launched = spawnSync(process.execPath, [
      join(priorRuntime, 'bin', 'opsle.js'), 'wake', 'start',
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(launched.status, 0, launched.stderr);
    const dispatcherPath = join(root, '.opsle', 'wake', 'dispatcher.json');
    const dispatcher = await waitFor(() => {
      const record = readJson(dispatcherPath);
      return record.status === 'OWNED' ? record : null;
    }, 'Sep-2 wake helper did not establish its managed role');
    priorIdentity = dispatcher.process;
    assert.ok(processStartIdentity(priorIdentity.pid));

    registerRepository(hostRoot, root);
    const upgraded = await upgradeHostRuntime(hostRoot, sourceRoot, {
      signal: (pid, signal) => {
        assert.throws(
          () => assertRuntimeStartAllowed(hostRoot, { root: sourceRoot }),
          (error) => error.classification === 'BUSY',
        );
        sawQuiescedLaunchGate = true;
        process.kill(pid, signal);
      },
      startTarget: async (releaseRoot, targetHost) => {
        assert.equal(sawQuiescedLaunchGate, true);
        assert.equal(processStartIdentity(priorIdentity.pid), null);
        targetStarted = await startInstalledOpsled(releaseRoot, targetHost);
      },
    });

    assert.equal(upgraded.status, 'COMPLETED');
    const retired = upgraded.retired_processes.find((entry) => (
      entry.kind === 'repository-wake-dispatcher'
      && entry.process.pid === priorIdentity.pid
      && entry.process.start_time_ticks === priorIdentity.start_time_ticks
      && entry.process.executable === priorIdentity.executable
    ));
    assert.ok(retired);
    assert.equal(retired.verified_absent, true);
    assert.equal(processStartIdentity(priorIdentity.pid), null);
    assert.equal(readCurrentRuntime(hostRoot).release_root, upgraded.target.release_root);
    await waitFor(() => {
      const status = targetStarted.runtime.opsledStatus(hostRoot);
      return status.opsled.status === 'RUNNING'
        && status.repositories[0]?.status === 'OK'
        ? status
        : null;
    }, 'release B did not own normal repository operation');
    assert.equal(fileSha256(installedWakeup), priorWakeupSha256);
  } finally {
    await stopInstalledOpsled(targetStarted, hostRoot);
    if (priorIdentity && processStartIdentity(priorIdentity.pid)?.start_time_ticks
        === priorIdentity.start_time_ticks) {
      process.kill(priorIdentity.pid, 'SIGTERM');
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(hostRoot, { recursive: true, force: true });
  }
});

test('takeover waits for child-owned transients without signaling them', async () => {
  const hostRoot = mkdtempSync(join(tmpdir(), 'opsle-runtime-transient-'));
  const root = repository('transient');
  const service = { pid: 1_600_000_101, start_time_ticks: '1600000101', executable: process.execPath };
  const transient = { pid: 1_600_000_102, start_time_ticks: '1600000102', executable: process.execPath };
  let serviceLive = true;
  let transientReads = 0;
  const signaled = [];
  try {
    registerRepository(hostRoot, root);
    const mapping = Object.values(readRegistry(hostRoot).repositories)[0];
    writeJson(registryPaths(hostRoot).service, {
      process: service,
      release_fence: {
        packaged_artifact_sha256: '1'.repeat(64),
        helper_process: service,
      },
    });
    mkdirSync(join(mapping.host_state_path, 'runners'), { recursive: true });
    writeJson(join(mapping.host_state_path, 'runners', 'active.json'), {
      schema: 'opsle.durable-supervisor.opsled-runner/v1',
      repository_id: mapping.repository_id,
      repository_realpath: mapping.repository_realpath,
      host_state_path: mapping.host_state_path,
      task_id: 'task-active',
      attempt_id: 'attempt-active',
      claim_id: 'claim-active',
      fence_generation: 1,
      worker: transient,
      worker_release_fence: { helper_process: transient },
    });
    const upgraded = await upgradeHostRuntime(hostRoot, sourceRoot, {
      getProcessIdentity: (pid) => {
        if (pid === service.pid) return serviceLive ? service : null;
        if (pid === transient.pid) {
          transientReads += 1;
          return transientReads < 3 ? transient : null;
        }
        return null;
      },
      signal: (pid) => {
        signaled.push(pid);
        if (pid === service.pid) serviceLive = false;
      },
      startTarget: async () => {},
    });
    assert.deepEqual(signaled, [service.pid]);
    assert.ok(transientReads >= 3);
    assert.equal(
      upgraded.retired_processes.find((entry) => entry.process.pid === transient.pid)
        .verified_absent,
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

test('corrupt-neighbor upgrade quarantines B while A and C remain serviceable', {
  timeout: 30000,
}, async () => {
  const hostRoot = mkdtempSync(join(tmpdir(), 'opsle-runtime-neighbors-'));
  const roots = [repository('neighbor-a'), repository('neighbor-b'), repository('neighbor-c')];
  let targetStarted = null;
  try {
    roots.forEach((root) => registerRepository(hostRoot, root));
    const registry = readRegistry(hostRoot);
    const mappings = roots.map((root) => Object.values(registry.repositories)
      .find((entry) => entry.repository_realpath === realpathSync(root)));
    const blocked = stageRunnerIntent(roots[1], 'quarantined');
    const runnerRequest = createRunnerRequest(
      roots[1], blocked.task, blocked.attempt, blocked.claim,
    );
    const supervisor = readJson(join(roots[1], '.opsle', 'supervisor.json'));
    writeJson(join(roots[1], '.opsle', 'wake', 'requests', 'event-quarantined.json'), {
      schema: 'opsle.durable-supervisor.native-wake-request/v2',
      event_id: 'event-quarantined',
      task_id: blocked.task.task_id,
      attempt_id: blocked.attempt.attempt_id,
      target: {
        repository: roots[1],
        supervisor_id: supervisor.supervisor_id,
        supervisor_generation: supervisor.generation,
      },
      queue_version: 1,
    });
    const corruptBytes = '{malformed-neighbor-state\n';
    writeFileSync(join(roots[1], '.opsle', 'compatibility.json'), corruptBytes);

    const upgraded = await upgradeHostRuntime(hostRoot, sourceRoot, {
      startTarget: async (releaseRoot, targetHost) => {
        targetStarted = await startInstalledOpsled(releaseRoot, targetHost);
      },
    });
    assert.equal(upgraded.status, 'COMPLETED');
    const upgradesByPath = new Map(upgraded.repositories.map((entry) => [
      entry.repository_realpath,
      entry,
    ]));
    assert.equal(upgradesByPath.get(roots[0]).status, 'OK');
    assert.equal(upgradesByPath.get(roots[2]).status, 'OK');
    const quarantined = upgradesByPath.get(roots[1]);
    assert.equal(quarantined.availability, 'QUARANTINED');
    assert.equal(quarantined.classification, 'CORRUPT');
    assert.equal(quarantined.evidence_preserved, true);
    assert.equal(readFileSync(join(roots[1], '.opsle', 'compatibility.json'), 'utf8'), corruptBytes);

    const status = await waitFor(() => {
      const observed = targetStarted.runtime.opsledStatus(hostRoot);
      const byPath = new Map(observed.repositories.map((entry) => [entry.repository_realpath, entry]));
      return observed.opsled.status === 'RUNNING'
        && byPath.get(roots[0])?.status === 'OK'
        && byPath.get(roots[1])?.status === 'ATTENTION'
        && byPath.get(roots[2])?.status === 'OK'
        ? observed
        : null;
    }, 'healthy repositories did not resume around the quarantined neighbor');
    assert.equal(status.state, 'ATTENTION');
    assert.deepEqual(status.summary, { repositories: 3, healthy: 2, attention: 1 });
    assert.match(
      targetStarted.runtime.renderOpsledStatus(status),
      /neighbor-b-\S+ ATTENTION \u00b7 corrupt state/,
    );

    assert.equal(existsSync(join(
      mappings[1].host_state_path,
      'runner-requests',
      `${runnerRequest.request_id}.json`,
    )), false);
    assert.equal(existsSync(join(
      mappings[1].host_state_path,
      'wake-transports',
      'event-quarantined.json',
    )), false);
    assert.equal(existsSync(join(
      mappings[0].host_state_path,
      'status.json',
    )), true);
    assert.equal(existsSync(join(
      mappings[2].host_state_path,
      'status.json',
    )), true);
  } finally {
    await stopInstalledOpsled(targetStarted, hostRoot);
    roots.forEach((root) => rmSync(root, { recursive: true, force: true }));
    rmSync(hostRoot, { recursive: true, force: true });
  }
});
