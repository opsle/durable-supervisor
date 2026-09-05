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
import { main as runOpsledCommand } from '../bin/opsled.js';
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
  runtimeHostPaths,
  upgradeHostRuntime,
} from '../src/runtime-upgrade.js';
import { defaultOpsledHome } from '../src/opsled.js';
import {
  loadPriorManagedRelease,
  loadRuntimeRelease,
  processStartIdentity,
} from '../src/runtime-release.js';
import { initialize } from '../src/state.js';

const sourceRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');

// The prior-runtime takeover proof needs a real managed runtime that still
// carries the historical wake dispatcher helper. Resolve it from canonical
// host state so no caller has to know a machine-specific install path, and
// derive its implementation identity from the artifact actually selected
// rather than from a hardcoded digest that goes stale on every release.
const REQUIRED_PRIOR_HELPER_FILES = [
  join('bin', 'opsle.js'),
  join('bin', 'opsle-wake-delivery.js'),
  join('src', 'wakeup.js'),
];

function resolvePriorRuntime() {
  const override = process.env.OPSLE_PRIOR_RUNTIME;
  if (override) return { root: override, source: 'OPSLE_PRIOR_RUNTIME' };
  // Read the canonical managed runtime pointer directly. readCurrentRuntime()
  // validates the pointer against the *current* runtime's expectations, which a
  // prior release is not required to satisfy, so it cannot resolve a checkpoint.
  const pointerPath = runtimeHostPaths(defaultOpsledHome()).current;
  if (existsSync(pointerPath)) {
    try {
      const pointer = readJson(pointerPath);
      if (typeof pointer?.release_root === 'string') {
        return { root: pointer.release_root, source: 'managed-host-runtime-pointer' };
      }
    } catch {
      // Unreadable pointer: treated as no managed prior runtime.
    }
  }
  return { root: null, source: null };
}

function priorRuntimeProof() {
  const { root, source } = resolvePriorRuntime();
  if (!root) {
    return { available: false, reason: 'no OPSLE_PRIOR_RUNTIME and no managed current runtime on this host' };
  }
  if (!existsSync(root)) {
    return { available: false, reason: `prior runtime ${source} path does not exist: ${root}` };
  }
  const missing = REQUIRED_PRIOR_HELPER_FILES.filter((name) => !existsSync(join(root, name)));
  if (missing.length > 0) {
    return {
      available: false,
      reason: `prior runtime ${root} lacks the historical managed helper: ${missing.join(', ')}`,
    };
  }
  const wakeupPath = join(root, 'src', 'wakeup.js');
  const wakeupSha256 = fileSha256(wakeupPath);
  const expected = process.env.OPSLE_PRIOR_WAKEUP_SHA256;
  if (expected && expected !== wakeupSha256) {
    return {
      available: false,
      reason: `prior runtime wakeup digest ${wakeupSha256} does not match OPSLE_PRIOR_WAKEUP_SHA256 ${expected}`,
    };
  }
  return { available: true, root, source, wakeupPath, wakeupSha256 };
}

// Release verification sets OPSLE_REQUIRE_PRIOR_RUNTIME_PROOF so that an
// unavailable artifact, or a proof that never ran, fails instead of skipping.
const requirePriorRuntimeProof = process.env.OPSLE_REQUIRE_PRIOR_RUNTIME_PROOF === '1';
const priorRuntime = priorRuntimeProof();
let priorRuntimeProofRan = false;

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
  skip: (!priorRuntime.available && !requirePriorRuntimeProof)
    ? `prior-runtime takeover proof unavailable: ${priorRuntime.reason}`
    : false,
  timeout: 30000,
}, async () => {
  assert.equal(priorRuntime.available, true, priorRuntime.reason);
  const hostRoot = mkdtempSync(join(tmpdir(), 'opsle-runtime-prior-helper-'));
  const root = repository('prior-helper');
  const productionHost = defaultOpsledHome();
  const productionCurrentPath = runtimeHostPaths(productionHost).current;
  const productionServicePath = registryPaths(productionHost).service;
  const productionCurrentBytes = existsSync(productionCurrentPath)
    ? readFileSync(productionCurrentPath, 'utf8') : null;
  const productionService = existsSync(productionServicePath)
    ? readJson(productionServicePath) : null;
  const productionIdentity = productionService?.process ?? null;
  const installedWakeup = priorRuntime.wakeupPath;
  const priorWakeupSha256 = priorRuntime.wakeupSha256;
  let priorIdentity = null;
  let priorOpsledIdentity = null;
  let priorStarted = null;
  let targetStarted = null;
  let sawQuiescedLaunchGate = false;
  try {
    assert.notEqual(resolve(hostRoot), resolve(productionHost));
    assert.equal(fileSha256(installedWakeup), priorWakeupSha256);
    const priorManifest = loadPriorManagedRelease({ root: priorRuntime.root });
    assert.ok(priorManifest.helpers.some((entry) => entry.path === 'bin/opsle-wake-delivery.js'));
    const targetManifest = loadRuntimeRelease({ refresh: true });
    assert.equal(targetManifest.helpers.some((entry) => entry.path === 'bin/opsle-wake-delivery.js'), false);

    registerRepository(hostRoot, root);
    const priorUpgradeUrl = pathToFileURL(join(priorRuntime.root, 'src', 'runtime-upgrade.js'));
    priorUpgradeUrl.searchParams.set('proof', hostRoot);
    const priorUpgrade = await import(priorUpgradeUrl.href);
    const installedPrior = await priorUpgrade.upgradeHostRuntime(hostRoot, priorRuntime.root, {
      startTarget: async (releaseRoot, targetHost) => {
        priorStarted = await startInstalledOpsled(releaseRoot, targetHost);
      },
    });
    assert.equal(installedPrior.status, 'COMPLETED');
    assert.equal(installedPrior.target.packaged_artifact_sha256, priorManifest.packaged_artifact_sha256);
    priorOpsledIdentity = priorStarted.started.service.process;
    assert.ok(processStartIdentity(priorOpsledIdentity.pid));

    const launched = spawnSync(process.execPath, [
      join(priorRuntime.root, 'bin', 'opsle.js'), 'wake', 'start',
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(launched.status, 0, launched.stderr);
    const dispatcherPath = join(root, '.opsle', 'wake', 'dispatcher.json');
    const dispatcher = await waitFor(() => {
      const record = readJson(dispatcherPath);
      return record.status === 'OWNED' ? record : null;
    }, 'Sep-2 wake helper did not establish its managed role');
    priorIdentity = dispatcher.process;
    assert.ok(processStartIdentity(priorIdentity.pid));

    const output = [];
    await runOpsledCommand(['upgrade', '--release', sourceRoot, '--json'], {
      home: hostRoot,
      output: (value) => output.push(value),
      upgradeOptions: {
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
          assert.equal(processStartIdentity(priorOpsledIdentity.pid), null);
          targetStarted = await startInstalledOpsled(releaseRoot, targetHost);
        },
      },
    });
    const [upgraded] = output;

    assert.equal(upgraded.status, 'COMPLETED');
    assert.equal(upgraded.target.packaged_artifact_sha256, targetManifest.packaged_artifact_sha256);
    const retired = upgraded.retired_processes.find((entry) => (
      entry.kind === 'repository-wake-dispatcher'
      && entry.process.pid === priorIdentity.pid
      && entry.process.start_time_ticks === priorIdentity.start_time_ticks
      && entry.process.executable === priorIdentity.executable
    ));
    assert.ok(retired);
    assert.equal(retired.verified_absent, true);
    assert.equal(processStartIdentity(priorIdentity.pid), null);
    assert.equal(processStartIdentity(priorOpsledIdentity.pid), null);
    assert.equal(readCurrentRuntime(hostRoot).release_root, upgraded.target.release_root);
    await waitFor(() => {
      const status = targetStarted.runtime.opsledStatus(hostRoot);
      return status.opsled.status === 'RUNNING'
        && status.repositories[0]?.status === 'OK'
        ? status
        : null;
    }, 'release B did not own normal repository operation');
    assert.equal(fileSha256(installedWakeup), priorWakeupSha256);
    priorRuntimeProofRan = true;
  } finally {
    await stopInstalledOpsled(targetStarted, hostRoot);
    if (priorOpsledIdentity && processStartIdentity(priorOpsledIdentity.pid)?.start_time_ticks
        === priorOpsledIdentity.start_time_ticks) {
      process.kill(priorOpsledIdentity.pid, 'SIGTERM');
    }
    if (priorIdentity && processStartIdentity(priorIdentity.pid)?.start_time_ticks
        === priorIdentity.start_time_ticks) {
      process.kill(priorIdentity.pid, 'SIGTERM');
    }
    assert.equal(
      existsSync(productionCurrentPath) ? readFileSync(productionCurrentPath, 'utf8') : null,
      productionCurrentBytes,
    );
    const currentProductionService = existsSync(productionServicePath)
      ? readJson(productionServicePath) : null;
    assert.equal(currentProductionService?.service_id ?? null, productionService?.service_id ?? null);
    assert.deepEqual(currentProductionService?.process ?? null, productionIdentity);
    assert.equal(
      currentProductionService?.release_fence?.packaged_artifact_sha256 ?? null,
      productionService?.release_fence?.packaged_artifact_sha256 ?? null,
    );
    if (productionIdentity) {
      assert.deepEqual(processStartIdentity(productionIdentity.pid), productionIdentity);
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

// Release verification must never report PASS while silently omitting the real
// prior-runtime takeover proof.
test('REQUIRED mode proves the real prior-runtime takeover actually ran', {
  skip: requirePriorRuntimeProof
    ? false
    : 'set OPSLE_REQUIRE_PRIOR_RUNTIME_PROOF=1 to require the real prior-runtime proof',
}, () => {
  assert.equal(priorRuntime.available, true, priorRuntime.reason ?? 'prior runtime unavailable');
  assert.equal(priorRuntimeProofRan, true, 'the prior-runtime takeover proof did not run');
});
