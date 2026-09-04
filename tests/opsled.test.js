import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalJson, sha256, writeJson } from '../src/io.js';
import {
  createReleaseFence,
  processStartIdentity,
} from '../src/runtime-release.js';
import {
  OPSLED_REGISTRY_SCHEMA,
  ensureRepositoryOwnershipPointer,
  readRegistry,
  readHostOwnershipPointer,
  registerRepository,
  repositoryOperationalId,
  registryPaths,
  updateRepositoryHerdrBinding,
  validateRegistry,
} from '../src/opsled-registry.js';
import {
  OPSLED_SERVICE_SCHEMA,
  defaultOpsledHome,
  opsledStatus,
  renderOpsledStatus,
  runOpsledService,
  startOpsled,
} from '../src/opsled.js';
import { canonicalOpsledEnvironment, dispatchRepositoryWakes } from '../src/opsled-wake.js';
import {
  createRunnerRequest,
  executeRunnerRequest,
  launchOpsledRunner,
  processRunnerRequests,
  superviseOpsledRunner,
  validateOpsledRunnerRecord,
} from '../src/opsled-runner.js';
import { launchRepositoryWakeTransports } from '../src/opsled-wake.js';

function repository(name = 'repository') {
  const root = mkdtempSync(join(tmpdir(), `opsled-${name}-`));
  mkdirSync(join(root, '.opsle', 'wake', 'requests'), { recursive: true });
  writeJson(join(root, '.opsle', 'supervisor.json'), {
    schema: 'opsle.durable-supervisor.supervisor/v1',
    repository: realpathSync(root),
    supervisor_id: `supervisor-${name}`,
    authority_status: 'AUTHORITATIVE',
  });
  writeJson(join(root, '.opsle', 'state.json'), {
    schema: 'opsle.durable-supervisor.state/v1',
    active_task_id: null,
    active_attempt_id: null,
  });
  writeJson(join(root, '.opsle', 'objective.json'), {
    schema: 'opsle.durable-supervisor.objective/v2',
    current_revision: 0,
    history: [],
  });
  writeJson(join(root, '.opsle', 'policy.json'), {
    schema: 'opsle.durable-supervisor.policy/v1',
  });
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

function host() {
  return mkdtempSync(join(tmpdir(), 'opsled-host-'));
}

function register(hostRoot, root) {
  registerRepository(hostRoot, root);
  return Object.values(readRegistry(hostRoot).repositories)
    .find((mapping) => mapping.repository_realpath === realpathSync(root));
}

function stageService(hostRoot, status = 'LAUNCHED') {
  const identity = processStartIdentity();
  const service = {
    schema: OPSLED_SERVICE_SCHEMA,
    service_id: 'opsled-test-service',
    generation: 1,
    launch_nonce: 'opsled-test-launch',
    expected_release: {
      runtime_release_id: createReleaseFence('opsled-worker', identity).runtime_release_id,
    },
    release_fence: createReleaseFence('opsled-worker', identity),
    process: identity,
    status,
    launched_at: '2026-09-04T00:00:00.000Z',
    owned_at: status === 'OWNED' ? '2026-09-04T00:00:01.000Z' : null,
    stopped_at: null,
    heartbeat_at: null,
    interval_ms: 10,
    last_cycle: null,
    failure: null,
  };
  writeJson(registryPaths(hostRoot).service, service);
  return service;
}

test('registry canonicalizes repository aliases to exactly one operational mapping', () => {
  const hostRoot = host();
  const root = repository('registry');
  const alias = `${root}-alias`;
  try {
    symlinkSync(root, alias);
    const first = registerRepository(hostRoot, root);
    const second = registerRepository(hostRoot, alias);
    const registry = readRegistry(hostRoot);
    assert.equal(Object.keys(registry.repositories).length, 1);
    assert.equal(first.result.repository_id, second.result.repository_id);
    assert.equal(second.result.created, false);
    assert.equal(readFileSync(registryPaths(hostRoot).registry, 'utf8'), canonicalJson(registry));
    assert.deepEqual(Object.keys(Object.values(registry.repositories)[0]).sort(), [
      'added_at', 'enabled', 'herdr', 'host_state_path', 'ownership_pointer_path',
      'repository_id', 'repository_realpath', 'schema', 'updated_at',
    ]);
  } finally {
    rmSync(alias, { force: true });
    rmSync(root, { recursive: true, force: true });
    rmSync(hostRoot, { recursive: true, force: true });
  }
});

test('legacy registry migration backfills repository ownership during isolated processing', () => {
  const hostRoot = host();
  const root = repository('legacy-registry');
  try {
    const repositoryId = repositoryOperationalId(realpathSync(root));
    mkdirSync(hostRoot, { recursive: true });
    writeFileSync(registryPaths(hostRoot).registry, canonicalJson({
      schema: 'opsle.durable-supervisor.opsled-registry/v1',
      revision: 1,
      updated_at: '2026-09-02T00:00:00.000Z',
      repositories: {
        [repositoryId]: {
          schema: 'opsle.durable-supervisor.opsled-repository/v1',
          repository_id: repositoryId,
          repository_realpath: realpathSync(root),
          host_state_path: join(registryPaths(hostRoot).repositories, repositoryId),
          enabled: true,
          added_at: '2026-09-02T00:00:00.000Z',
          updated_at: '2026-09-02T00:00:00.000Z',
        },
      },
    }));
    const mapping = readRegistry(hostRoot).repositories[repositoryId];
    assert.equal(mapping.schema, 'opsle.durable-supervisor.opsled-repository/v2');
    assert.equal(readHostOwnershipPointer(root), null);
    const pointer = ensureRepositoryOwnershipPointer(mapping);
    assert.equal(pointer.opsled_root, hostRoot);
    assert.equal(pointer.herdr.workspace_id, 'workspace-legacy-registry');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(hostRoot, { recursive: true, force: true });
  }
});

test('registry fails closed for reasoning authority and newer schemas', () => {
  assert.throws(() => validateRegistry({
    schema: OPSLED_REGISTRY_SCHEMA,
    revision: 1,
    updated_at: '2026-09-04T00:00:00.000Z',
    repositories: {},
    objective: 'forbidden',
  }), /authority field is forbidden/);

  const hostRoot = host();
  try {
    writeFileSync(registryPaths(hostRoot).registry, canonicalJson({
      schema: 'opsle.durable-supervisor.opsled-registry/v3',
      revision: 1,
      updated_at: '2026-09-04T00:00:00.000Z',
      repositories: {},
    }));
    assert.throws(
      () => readRegistry(hostRoot),
      (error) => error.classification === 'UPGRADE_REQUIRED',
    );
  } finally {
    rmSync(hostRoot, { recursive: true, force: true });
  }
});

test('UPGRADE_REQUIRED names managed/current and invoking roots and artifacts', async () => {
  const hostRoot = host();
  try {
    const service = stageService(hostRoot);
    service.release_fence.release_root = '/managed/same-semver-release';
    service.release_fence.packaged_artifact_sha256 = '0'.repeat(64);
    writeJson(registryPaths(hostRoot).service, service);
    await assert.rejects(
      startOpsled(hostRoot, { getProcessIdentity: () => service.process }),
      (error) => error.classification === 'UPGRADE_REQUIRED'
        && /managed\/current root=\/managed\/same-semver-release artifact=0{64}/.test(error.message)
        && /invoking root=.* artifact=[a-f0-9]{64}/.test(error.message),
    );
  } finally {
    rmSync(hostRoot, { recursive: true, force: true });
  }
});

test('opsled daemon launch has no inherited Codex or pane authority and duplicate start is inert', async () => {
  const hostRoot = host();
  const worker = {
    pid: 1_600_000_001,
    start_time_ticks: '1600000001',
    executable: process.execPath,
  };
  let spawned = 0;
  let launchOptions = null;
  try {
    const spawnProcess = (_command, _args, options) => {
      spawned += 1;
      launchOptions = options;
      setTimeout(() => {
        const servicePath = registryPaths(hostRoot).service;
        if (!existsSync(servicePath)) return;
        const service = readJsonForTest(servicePath);
        service.status = 'OWNED';
        service.owned_at = '2026-09-04T00:00:01.000Z';
        writeJson(servicePath, service);
      }, 10);
      return { pid: worker.pid, unref() {} };
    };
    const first = await startOpsled(hostRoot, {
      spawnProcess,
      getProcessIdentity: () => worker,
      handshakeTimeoutMs: 500,
    });
    assert.equal(first.started, true);
    assert.equal(launchOptions.env.CODEX_SESSION_ID, undefined);
    assert.equal(launchOptions.env.CODEX_THREAD_ID, undefined);
    assert.equal(launchOptions.env.CODEX_HOME, undefined);
    assert.equal(launchOptions.env.TMUX, undefined);
    assert.deepEqual(Object.keys(launchOptions.env).sort(), ['HOME', 'LANG', 'PATH']);
    const duplicate = await startOpsled(hostRoot, {
      spawnProcess,
      getProcessIdentity: () => worker,
    });
    assert.equal(duplicate.started, false);
    assert.equal(duplicate.reason, 'current-opsled-already-live');
    assert.equal(spawned, 1);
  } finally {
    rmSync(hostRoot, { recursive: true, force: true });
  }
});

test('one broken repository does not prevent another repository cycle', async () => {
  const hostRoot = host();
  const first = repository('broken');
  const second = repository('healthy');
  try {
    const broken = register(hostRoot, first);
    const healthy = register(hostRoot, second);
    const service = stageService(hostRoot);
    const seen = [];
    const result = await runOpsledService(hostRoot, service, {
      intervalMs: 10,
      maxCycles: 1,
      processIdentity: processStartIdentity(),
      processRepository: async (mapping) => {
        seen.push(mapping.repository_id);
        if (mapping.repository_id === broken.repository_id) throw new Error('fixture failure');
        return { repository_id: mapping.repository_id };
      },
    });
    assert.equal(result.status, 'OWNED');
    assert.deepEqual(new Set(seen), new Set([broken.repository_id, healthy.repository_id]));
    const current = readJsonForTest(registryPaths(hostRoot).service);
    assert.equal(current.last_cycle.ok, 1);
    assert.equal(current.last_cycle.failed, 1);
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
    rmSync(hostRoot, { recursive: true, force: true });
  }
});

test('a corrupt managed repository does not block a healthy repository', async () => {
  const hostRoot = host();
  const first = repository('corrupt');
  const second = repository('still-healthy');
  try {
    const corrupt = register(hostRoot, first);
    const healthy = register(hostRoot, second);
    writeFileSync(join(first, '.opsle', 'compatibility.json'), '{malformed');
    const service = stageService(hostRoot);
    const result = await runOpsledService(hostRoot, service, {
      intervalMs: 10,
      maxCycles: 1,
      processIdentity: processStartIdentity(),
    });
    assert.equal(result.status, 'OWNED');
    const current = readJsonForTest(registryPaths(hostRoot).service);
    assert.equal(current.last_cycle.ok, 1);
    assert.equal(current.last_cycle.failed, 1);
    assert.equal(
      current.last_cycle.outcomes.find((item) => item.repository_id === corrupt.repository_id).status,
      'CORRUPT',
    );
    assert.equal(
      current.last_cycle.outcomes.find((item) => item.repository_id === healthy.repository_id).status,
      'OK',
    );
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
    rmSync(hostRoot, { recursive: true, force: true });
  }
});

function readJsonForTest(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function stageRunnerAuthority(root, suffix = 'intent') {
  const supervisor = readJsonForTest(join(root, '.opsle', 'supervisor.json'));
  const task = {
    task_id: `task-${suffix}`,
    attempts: [`attempt-${suffix}`],
  };
  const attempt = {
    task_id: task.task_id,
    attempt_id: task.attempts[0],
    claim_id: `claim-${suffix}`,
    fence_generation: 4,
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
  for (const name of ['tasks', 'children', 'claims', 'workers']) {
    mkdirSync(join(root, '.opsle', name), { recursive: true });
  }
  writeJson(join(root, '.opsle', 'tasks', `${task.task_id}.json`), task);
  writeJson(join(root, '.opsle', 'children', `${attempt.attempt_id}.json`), attempt);
  writeJson(join(root, '.opsle', 'claims', `${claim.claim_id}.json`), claim);
  writeJson(join(root, '.opsle', 'state.json'), {
    schema: 'opsle.durable-supervisor.state/v1',
    active_task_id: task.task_id,
    active_attempt_id: attempt.attempt_id,
    pause: { active: false, after_current: false },
  });
  return { task, attempt, claim };
}

test('default host ownership ignores hostile caller environment', () => {
  const expected = defaultOpsledHome();
  assert.equal(defaultOpsledHome({
    OPSLED_HOME: '/tmp/attacker-opsled',
    XDG_STATE_HOME: '/tmp/attacker-xdg',
    HOME: '/tmp/attacker-home',
    CODEX_HOME: '/tmp/attacker-codex',
    CODEX_SESSION_ID: 'attacker-session',
    TMUX: 'attacker-tmux',
  }), expected);
  assert.doesNotMatch(expected, /^\/tmp\/attacker/);
  const root = repository('canonical-env');
  const hostRoot = host();
  try {
    const mapping = register(hostRoot, root);
    const environment = canonicalOpsledEnvironment(mapping);
    assert.equal(environment.CODEX_SESSION_ID, undefined);
    assert.equal(environment.CODEX_THREAD_ID, undefined);
    assert.equal(environment.CODEX_HOME, root);
    assert.doesNotMatch(environment.PATH, /attacker/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(hostRoot, { recursive: true, force: true });
  }
});

test('repository ownership pointer rejects a second host opsled', () => {
  const firstHost = host();
  const secondHost = host();
  const root = repository('one-owner');
  try {
    registerRepository(firstHost, root);
    const pointer = readHostOwnershipPointer(root);
    assert.equal(pointer.opsled_root, firstHost);
    rmSync(join(root, '.opsle', 'compatibility.json'));
    assert.throws(
      () => registerRepository(secondHost, root),
      (error) => error.classification === 'OWNERSHIP_CONFLICT',
    );
    assert.equal(readHostOwnershipPointer(root).opsled_root, firstHost);
    assert.equal(existsSync(join(root, '.opsle', 'compatibility.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(firstHost, { recursive: true, force: true });
    rmSync(secondHost, { recursive: true, force: true });
  }
});

test('one Herdr workspace cannot own two repositories', () => {
  const hostRoot = host();
  const first = repository('workspace-left');
  const second = repository('workspace-right');
  try {
    registerRepository(hostRoot, first);
    const secondBindingPath = join(second, '.opsle', 'wake', 'codex-session-binding.json');
    const secondBinding = readJsonForTest(secondBindingPath);
    secondBinding.host.workspace_id = 'workspace-workspace-left';
    writeJson(secondBindingPath, secondBinding);
    assert.throws(
      () => registerRepository(hostRoot, second),
      (error) => error.classification === 'OWNERSHIP_CONFLICT',
    );
    assert.equal(readHostOwnershipPointer(second), null);
    assert.equal(Object.keys(readRegistry(hostRoot).repositories).length, 1);
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
    rmSync(hostRoot, { recursive: true, force: true });
  }
});

test('successful session rotation updates the registered pane without caller authority', () => {
  const hostRoot = host();
  const root = repository('session-rotation');
  try {
    const mapping = register(hostRoot, root);
    const binding = readJsonForTest(join(root, '.opsle', 'wake', 'codex-session-binding.json'));
    binding.host.pane_id = 'pane-session-rotation-next';
    binding.host.terminal_id = 'terminal-session-rotation-next';
    const updated = updateRepositoryHerdrBinding(hostRoot, mapping.repository_id, binding);
    assert.equal(updated.herdr.pane_id, 'pane-session-rotation-next');
    assert.equal(readHostOwnershipPointer(root).herdr.terminal_id, 'terminal-session-rotation-next');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(hostRoot, { recursive: true, force: true });
  }
});

test('post-registration Runner intent is executed once by opsled and rejected by another repository', async () => {
  const hostRoot = host();
  const first = repository('intent-a');
  const second = repository('intent-b');
  try {
    const left = register(hostRoot, first);
    const right = register(hostRoot, second);
    const authority = stageRunnerAuthority(first);
    const request = createRunnerRequest(first, authority.task, authority.attempt, authority.claim);
    const identity = processStartIdentity();
    const releaseFence = createReleaseFence('opsled-worker', identity);
    let launches = 0;
    const launch = async () => {
      launches += 1;
      writeJson(join(first, '.opsle', 'workers', `${authority.attempt.attempt_id}.json`), {
        task_id: authority.task.task_id,
        attempt_id: authority.attempt.attempt_id,
        claim_id: authority.claim.claim_id,
        fence_generation: authority.claim.fence_generation,
        worker_pid: identity.pid,
        release_fence: createReleaseFence('runner-worker', identity),
        status: 'OWNED',
        owned_at: '2026-09-04T00:00:01.000Z',
        terminal_at: null,
        failure: null,
      });
      return { worker_pid: identity.pid, ownership: 'OWNED' };
    };
    const serviceIdentity = {
      service_id: 'opsled-service',
      generation: 1,
      launch_nonce: 'existing-service-fence',
      process: identity,
      host_root: hostRoot,
    };
    const [result] = await processRunnerRequests(left, {
      releaseFence,
      processIdentity: identity,
      serviceIdentity,
      launch,
    });
    assert.equal(result.status, 'RUNNING');
    assert.equal(launches, 1);
    const [repeated] = await processRunnerRequests(left, {
      releaseFence,
      processIdentity: identity,
      serviceIdentity,
      launch,
    });
    assert.equal(repeated.request_id, request.request_id);
    assert.equal(launches, 1);
    await assert.rejects(executeRunnerRequest(right, request, {
      releaseFence,
      processIdentity: identity,
      serviceIdentity,
      launch,
    }), /does not belong to the registered repository/);
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
    rmSync(hostRoot, { recursive: true, force: true });
  }
});

test('opsled adopts an exact Runner published before a service interruption', async () => {
  const hostRoot = host();
  const root = repository('intent-recovery');
  try {
    const mapping = register(hostRoot, root);
    const authority = stageRunnerAuthority(root, 'recovery');
    const request = createRunnerRequest(root, authority.task, authority.attempt, authority.claim);
    const identity = processStartIdentity();
    const releaseFence = createReleaseFence('opsled-worker', identity);
    writeJson(join(root, '.opsle', 'workers', `${authority.attempt.attempt_id}.json`), {
      task_id: authority.task.task_id,
      attempt_id: authority.attempt.attempt_id,
      claim_id: authority.claim.claim_id,
      fence_generation: authority.claim.fence_generation,
      worker_pid: identity.pid,
      release_fence: createReleaseFence('runner-worker', identity),
      status: 'OWNED',
      owned_at: '2026-09-04T00:00:01.000Z',
      terminal_at: null,
      failure: null,
    });
    const resultPath = join(
      mapping.host_state_path,
      'runner-requests',
      `${request.request_id}.json`,
    );
    mkdirSync(join(mapping.host_state_path, 'runner-requests'), { recursive: true });
    writeJson(resultPath, {
      schema: 'opsle.durable-supervisor.runner-request-result/v1',
      request_id: request.request_id,
      request_sha256: sha256(canonicalJson(request)),
      repository_id: mapping.repository_id,
      status: 'LAUNCHING',
      opsled_process: identity,
      runner_process: null,
      launched_at: null,
      terminal_at: null,
      failure: null,
    });
    let launches = 0;
    const recovered = await executeRunnerRequest(mapping, request, {
      releaseFence,
      processIdentity: identity,
      serviceIdentity: {
        service_id: 'opsled-recovered-service',
        generation: 2,
        launch_nonce: 'existing-recovery-fence',
        process: identity,
        host_root: hostRoot,
      },
      launch: async () => { launches += 1; },
    });
    assert.equal(recovered.status, 'RUNNING');
    assert.equal(recovered.runner_process.pid, identity.pid);
    assert.equal(launches, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(hostRoot, { recursive: true, force: true });
  }
});

test('repo A and repo B wake transports launch independently without waiting for delivery', () => {
  const hostRoot = host();
  const first = repository('wake-a');
  const second = repository('wake-b');
  try {
    const mappings = [register(hostRoot, first), register(hostRoot, second)];
    const identity = processStartIdentity();
    const releaseFence = createReleaseFence('opsled-worker', identity);
    const serviceIdentity = {
      service_id: 'opsled-service',
      generation: 1,
      launch_nonce: 'existing-service-fence',
      process: identity,
      host_root: hostRoot,
    };
    let nextPid = 1_500_000_000;
    const identities = new Map();
    const spawnProcess = () => {
      const pid = nextPid += 1;
      identities.set(pid, { pid, start_time_ticks: String(pid), executable: process.execPath });
      return { pid, unref() {} };
    };
    for (const mapping of mappings) {
      writeJson(join(mapping.repository_realpath, '.opsle', 'wake', 'requests', 'event-parallel.json'), {
        event_id: 'event-parallel',
        target: { repository: mapping.repository_realpath },
        queue_version: 1,
      });
    }
    const results = mappings.map((mapping) => launchRepositoryWakeTransports(mapping, {
      releaseFence,
      processIdentity: identity,
      serviceIdentity,
      spawnProcess,
      getProcessIdentity: (pid) => identities.get(pid) ?? null,
    }));
    assert.deepEqual(results.map((result) => result.results[0].classification), [
      'transport-launched', 'transport-launched',
    ]);
    assert.notEqual(results[0].results[0].record.worker.pid, results[1].results[0].record.worker.pid);
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
    rmSync(hostRoot, { recursive: true, force: true });
  }
});

test('wake scan is repository-scoped, replayable, and fenced before access', () => {
  const hostRoot = host();
  const root = repository('wake');
  try {
    const mapping = register(hostRoot, root);
    writeJson(join(root, '.opsle', 'wake', 'requests', 'event-one.json'), {
      event_id: 'event-one',
      queue_version: 4,
    });
    const identity = processStartIdentity();
    const fence = createReleaseFence('opsled-worker', identity);
    const serviceIdentity = { service_id: 'opsled-test-service', generation: 1 };
    const calls = [];
    const deliver = (repositoryRoot, eventId, options) => {
      calls.push({ repositoryRoot, eventId, options });
      return { event_id: eventId, classification: 'queued', delivered: false };
    };
    const first = dispatchRepositoryWakes(mapping, {
      releaseFence: fence,
      processIdentity: identity,
      serviceIdentity,
      deliver,
    });
    const restarted = dispatchRepositoryWakes(mapping, {
      releaseFence: fence,
      processIdentity: identity,
      serviceIdentity,
      deliver,
    });
    assert.equal(first.scanned, 1);
    assert.equal(restarted.scanned, 1);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].repositoryRoot, mapping.repository_realpath);
    assert.equal(calls[0].options.expectedQueueVersion, 4);
    const stale = structuredClone(fence);
    stale.runtime_epoch = 'superseded';
    assert.throws(() => dispatchRepositoryWakes(mapping, {
      releaseFence: stale,
      processIdentity: identity,
      serviceIdentity,
      deliver,
    }), /runtime release fence mismatch/);
    assert.equal(calls.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(hostRoot, { recursive: true, force: true });
  }
});

test('Runner records reject cross-repository mapping confusion', () => {
  const hostRoot = host();
  const first = repository('runner-a');
  const second = repository('runner-b');
  try {
    const left = register(hostRoot, first);
    const right = register(hostRoot, second);
    const record = {
      schema: 'opsle.durable-supervisor.opsled-runner/v1',
      repository_id: left.repository_id,
      repository_realpath: left.repository_realpath,
      host_state_path: left.host_state_path,
      task_id: 'task-one',
      attempt_id: 'attempt-one',
      claim_id: 'claim-one',
      fence_generation: 1,
      worker: { pid: 123, start_time_ticks: '456', executable: '/usr/bin/node' },
    };
    assert.equal(validateOpsledRunnerRecord(record, left), true);
    assert.throws(() => validateOpsledRunnerRecord(record, right), /repository\/PID\/fence identity mismatch/);
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
    rmSync(hostRoot, { recursive: true, force: true });
  }
});

test('opsled Runner launch and supervision retain heartbeat, raw result, and terminal fences', async () => {
  const hostRoot = host();
  const root = repository('runner-lifecycle');
  try {
    const mapping = register(hostRoot, root);
    const identity = processStartIdentity();
    const ownerFence = createReleaseFence('opsled-worker', identity);
    const task = { task_id: 'task-lifecycle' };
    const claim = { claim_id: 'claim-lifecycle', fence_generation: 7 };
    const attempt = {
      task_id: task.task_id,
      attempt_id: 'attempt-lifecycle',
      claim_id: claim.claim_id,
      fence_generation: claim.fence_generation,
      child_state: 'RUNNING',
      heartbeat_at: '2026-09-04T00:00:02.000Z',
      wait_registration: { deadline_at: '2026-09-04T01:00:00.000Z' },
    };
    const attemptPath = join(root, '.opsle', 'children', `${attempt.attempt_id}.json`);
    const repositoryWorkerPath = join(root, '.opsle', 'workers', `${attempt.attempt_id}.json`);
    mkdirSync(join(root, '.opsle', 'children'), { recursive: true });
    mkdirSync(join(root, '.opsle', 'workers'), { recursive: true });
    writeJson(attemptPath, attempt);
    const runnerFence = createReleaseFence('runner-worker', identity);
    const launch = async () => {
      writeJson(repositoryWorkerPath, {
        task_id: task.task_id,
        attempt_id: attempt.attempt_id,
        claim_id: claim.claim_id,
        fence_generation: claim.fence_generation,
        worker_pid: identity.pid,
        release_fence: runnerFence,
        status: 'OWNED',
        owned_at: '2026-09-04T00:00:01.000Z',
        terminal_at: null,
        failure: null,
      });
      return { worker_pid: identity.pid, ownership: 'OWNED' };
    };
    const launched = await launchOpsledRunner(mapping, task, attempt, claim, {
      releaseFence: ownerFence,
      processIdentity: identity,
      launch,
    });
    assert.equal(launched.opsled_runner.worker.start_time_ticks, identity.start_time_ticks);

    const worker = readJsonForTest(repositoryWorkerPath);
    worker.status = 'TERMINAL';
    worker.terminal_at = '2026-09-04T00:00:03.000Z';
    writeJson(repositoryWorkerPath, worker);
    const completed = readJsonForTest(attemptPath);
    completed.child_state = 'COMPLETED';
    completed.completed_at = worker.terminal_at;
    completed.raw_evidence = [{ path: '.opsle/evidence/raw/attempt-lifecycle/stdout.jsonl' }];
    completed.completion_handoff = '.opsle/evidence/compact/attempt-lifecycle.completion.json';
    writeJson(attemptPath, completed);

    const supervised = superviseOpsledRunner(mapping, attempt.attempt_id, {
      releaseFence: ownerFence,
      processIdentity: identity,
      getProcessIdentity: () => identity,
    });
    assert.equal(supervised.status, 'TERMINAL');
    assert.equal(supervised.raw_result_references.length, 1);
    assert.equal(supervised.completion_handoff, completed.completion_handoff);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(hostRoot, { recursive: true, force: true });
  }
});

test('status has concise OPSLED and REPOSITORIES sections with JSON detail', () => {
  const hostRoot = host();
  const root = repository('status');
  try {
    register(hostRoot, root);
    const status = opsledStatus(hostRoot);
    const output = renderOpsledStatus(status);
    assert.match(output, /^OPSLED\n/m);
    assert.match(output, /^REPOSITORIES\n/m);
    assert.doesNotMatch(output, /generation=|service=/);
    assert.equal(status.repositories.length, 1);
    assert.equal(status.repositories[0].repository_realpath, realpathSync(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(hostRoot, { recursive: true, force: true });
  }
});
