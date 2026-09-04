import assert from 'node:assert/strict';
import {
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
import { canonicalJson, writeJson } from '../src/io.js';
import {
  createReleaseFence,
  processStartIdentity,
} from '../src/runtime-release.js';
import {
  OPSLED_REGISTRY_SCHEMA,
  readRegistry,
  registerRepository,
  registryPaths,
  validateRegistry,
} from '../src/opsled-registry.js';
import {
  OPSLED_SERVICE_SCHEMA,
  opsledStatus,
  renderOpsledStatus,
  runOpsledService,
} from '../src/opsled.js';
import { dispatchRepositoryWakes } from '../src/opsled-wake.js';
import {
  launchOpsledRunner,
  superviseOpsledRunner,
  validateOpsledRunnerRecord,
} from '../src/opsled-runner.js';

function repository(name = 'repository') {
  const root = mkdtempSync(join(tmpdir(), `opsled-${name}-`));
  mkdirSync(join(root, '.opsle', 'wake', 'requests'), { recursive: true });
  writeJson(join(root, '.opsle', 'runtime-compatibility.json'), {
    schema: 'opsle.durable-supervisor.runtime-compatibility/v1',
    state_version: 3,
  });
  writeJson(join(root, '.opsle', 'supervisor.json'), {
    schema: 'fixture',
    repository: realpathSync(root),
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
      'added_at', 'enabled', 'host_state_path', 'repository_id',
      'repository_realpath', 'schema', 'updated_at',
    ]);
  } finally {
    rmSync(alias, { force: true });
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
      schema: 'opsle.durable-supervisor.opsled-registry/v2',
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

function readJsonForTest(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

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
    assert.equal(status.repositories.length, 1);
    assert.equal(status.repositories[0].repository_realpath, realpathSync(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(hostRoot, { recursive: true, force: true });
  }
});
