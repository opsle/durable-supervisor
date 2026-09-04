import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  closeSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { createAttempt, createTask, routeTask } from '../src/pipeline.js';
import { readJson, writeJson } from '../src/io.js';
import { initialize, paths } from '../src/state.js';
import { recover } from '../src/cli.js';
import {
  detachedDormancyContract,
  runAttempt,
  runDetachedWorker,
} from '../src/runner.js';
import { registerWait } from '../src/wakeup.js';
import { createReleaseFence, processStartIdentity } from '../src/runtime-release.js';
import {
  HOST_OWNERSHIP_SCHEMA,
  OPSLED_REPOSITORY_SCHEMA,
  registryPaths,
  repositoryOperationalId,
} from '../src/opsled-registry.js';
import { processRunnerRequests } from '../src/opsled-runner.js';

const sourceRoot = resolve(new URL('..', import.meta.url).pathname);
const cliPath = join(sourceRoot, 'bin', 'opsle.js');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'durable-supervisor-detached-'));
  mkdirSync(join(root, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(root, '.git', 'refs', 'heads', 'main'), `${'5'.repeat(40)}\n`);
  writeFileSync(join(root, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');
  writeFileSync(join(root, 'README.md'), '# detached fixture\n');
  mkdirSync(join(root, '.opsle'));
  cpSync(join(sourceRoot, '.opsle', 'specification.md'), join(root, '.opsle', 'specification.md'));
  cpSync(join(sourceRoot, '.opsle', 'requirements.json'), join(root, '.opsle', 'requirements.json'));
  initialize(root, { actor: 'detached-test', objectiveText: 'Exercise detached Runner behavior.' });
  const hostRoot = join(root, '.fixture-opsled-host');
  writeJson(join(root, '.opsle', 'host-ownership.json'), {
    schema: HOST_OWNERSHIP_SCHEMA,
    repository_id: repositoryOperationalId(root),
    repository_realpath: root,
    opsled_root: hostRoot,
    registry_path: registryPaths(hostRoot).registry,
    herdr: {
      kind: 'herdr',
      workspace_id: 'fixture-workspace',
      pane_id: 'fixture-pane',
      terminal_id: 'fixture-terminal',
      sessions_root_realpath: join(root, '.fixture-codex', 'sessions'),
    },
    session_binding_path: join(root, '.opsle', 'wake', 'codex-session-binding.json'),
    registered_at: '2026-09-04T00:00:00.000Z',
    updated_at: '2026-09-04T00:00:00.000Z',
  });
  return root;
}

function handoff(taskId, delayMs = 500) {
  const output = `${taskId}.txt`;
  return {
    task_id: taskId,
    title: 'Run a detached deterministic fixture',
    objective: `Create ${output} after a bounded delay.`,
    scope: [output],
    authorization: {
      may: [`create ${output}`],
      may_modify: [output],
      may_not: ['invoke a provider', 'deploy', 'modify sibling repositories'],
    },
    required_inputs: [],
    relevant_context: [],
    expected_deliverable: `${output} containing done`,
    expected_evidence: ['detached worker identity', 'terminal event', 'verification'],
    acceptance_criteria: ['exit 0', 'verification 0', `only ${output} changed`],
    prohibited_actions: ['provider invocation', 'deployment'],
    requirement_ids: [],
    route_hint: 'deterministic',
    deterministic_command: [
      process.execPath,
      '-e',
      `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(output)}, 'done\\n'), ${delayMs})`,
    ],
    verification_command: [
      process.execPath,
      '-e',
      `process.exit(require('fs').readFileSync(${JSON.stringify(output)}, 'utf8') === 'done\\n' ? 0 : 1)`,
    ],
    timeout_seconds: 5,
  };
}

function runCli(root, args) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const capture = mkdtempSync(join(tmpdir(), 'durable-supervisor-detached-cli-'));
  const stdoutPath = join(capture, 'stdout.log');
  const stderrPath = join(capture, 'stderr.log');
  const stdout = openSync(stdoutPath, 'w');
  const stderr = openSync(stderrPath, 'w');
  try {
    const result = spawnSync(process.execPath, [cliPath, ...args], {
      cwd: root,
      env,
      stdio: ['ignore', stdout, stderr],
    });
    closeSync(stdout);
    closeSync(stderr);
    return {
      code: result.status,
      stdout: readFileSync(stdoutPath, 'utf8'),
      stderr: readFileSync(stderrPath, 'utf8'),
    };
  } finally {
    try { closeSync(stdout); } catch {}
    try { closeSync(stderr); } catch {}
    rmSync(capture, { recursive: true, force: true });
  }
}

async function waitFor(check, message, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const value = check();
    if (value) return value;
    await sleep(20);
  }
  throw new Error(message);
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function cleanupDetachedFixture(root) {
  const workersPath = join(root, '.opsle', 'workers');
  const workerPaths = existsSync(workersPath)
    ? readdirSync(workersPath)
      .filter((name) => name.endsWith('.json'))
      .map((name) => join(workersPath, name))
    : [];
  for (const workerPath of workerPaths) {
    const worker = readJson(workerPath);
    if (worker.schema !== 'opsle.durable-supervisor.detached-runner/v1') continue;
    await waitFor(() => {
      const status = readJson(workerPath).status;
      return status === 'TERMINAL' || status === 'FAILED';
    }, `fixture Runner ${worker.attempt_id} did not reach terminal state before cleanup`);
    if (Number.isSafeInteger(worker.worker_pid)) {
      await waitFor(
        () => !processAlive(worker.worker_pid),
        `fixture Runner ${worker.attempt_id} did not exit before cleanup`,
      );
    }
    const attemptPath = join(root, '.opsle', 'attempts', `${worker.attempt_id}.json`);
    if (existsSync(attemptPath)) {
      const childPid = readJson(attemptPath).pid;
      if (Number.isSafeInteger(childPid)) {
        await waitFor(
          () => !processAlive(childPid),
          `fixture child ${worker.attempt_id} did not exit before cleanup`,
        );
      }
    }
  }
  const dispatcherPath = join(root, '.opsle', 'wake', 'dispatcher.json');
  if (existsSync(dispatcherPath)) {
    const pid = readJson(dispatcherPath).process?.pid;
    if (Number.isSafeInteger(pid) && processAlive(pid)) {
      try { process.kill(pid, 'SIGTERM'); } catch {}
      await waitFor(() => !processAlive(pid), 'fixture dispatcher did not exit before cleanup');
    }
  }
  rmSync(root, { recursive: true, force: true });
}

function events(root) {
  const text = readFileSync(paths(root).eventsLog, 'utf8').trim();
  return text ? text.split('\n').map((line) => JSON.parse(line)) : [];
}

function stageOwnedAttempt(root, taskId) {
  const task = createTask(root, handoff(taskId, 50));
  const { attempt, claim } = createAttempt(root, task, routeTask(root, task));
  attempt.child_state = 'RUNNING';
  attempt.pid = 9001;
  writeJson(join(paths(root).attempts, `${attempt.attempt_id}.json`), attempt);
  mkdirSync(join(root, '.opsle', 'workers'), { recursive: true });
  const supervisor = readJson(paths(root).supervisor);
  writeJson(join(root, '.opsle', 'workers', `${attempt.attempt_id}.json`), {
    schema: 'opsle.durable-supervisor.detached-runner/v1',
    task_id: task.task_id,
    attempt_id: attempt.attempt_id,
    claim_id: claim.claim_id,
    fence_generation: claim.fence_generation,
    supervisor_id: supervisor.supervisor_id,
    supervisor_generation: supervisor.generation,
    worker_pid: 9002,
    status: 'OWNED',
  });
  return { attempt, claim };
}

const noDispatcher = () => ({ started: false, reason: 'fixture-disabled' });

test('task creation rejects malformed command argv before durable task or claim creation', () => {
  const root = fixture();
  try {
    assert.throws(() => createTask(root, {
      ...handoff('task-string-verification'),
      verification_command: 'node --test tests/example.test.js',
    }), /verification_command must be a nonempty argv array/);
    assert.throws(() => createTask(root, {
      ...handoff('task-string-execution'),
      deterministic_command: 'node fixture.js',
    }), /deterministic_command must be a nonempty argv array/);
    assert.equal(existsSync(join(paths(root).claims, 'index.json')), false);
    assert.equal(existsSync(join(paths(root).tasks, 'task-string-verification.json')), false);
    assert.equal(existsSync(join(paths(root).tasks, 'task-string-execution.json')), false);
    assert.deepEqual(readJson(paths(root).state).active_attempt_id, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('provider process result is write-ahead durable across post-processing failure stages', async () => {
  for (const stage of ['verification', 'reduction', 'terminal-publication']) {
    const root = fixture();
    try {
      const task = createTask(root, handoff(`task-write-ahead-${stage}`, 10));
      const { attempt, claim } = createAttempt(root, task, routeTask(root, task));
      await assert.rejects(
        runAttempt(root, task, attempt, claim, { failureInjection: stage }),
        new RegExp(`injected Runner failure before ${stage === 'reduction'
          ? 'Context Firewall reduction'
          : stage === 'terminal-publication' ? 'terminal event publication' : 'verification'}`),
      );
      const evidence = readJson(join(paths(root).raw, attempt.attempt_id, 'execution.json'));
      assert.equal(evidence.execution.exit_code, 0);
      assert.ok(evidence.provider_process_terminated_at);
      assert.ok(evidence.recorded_at);
      assert.equal(events(root).some((event) => (
        event.type === 'CHILD_COMPLETION' && event.attempt_id === attempt.attempt_id
      )), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('detached worker failure durably separates Runner failure and intervention wake from child outcome', async () => {
  const root = fixture();
  try {
    const task = createTask(root, handoff('task-worker-terminal-failure', 10));
    const { attempt, claim } = createAttempt(root, task, routeTask(root, task));
    const registeredAt = new Date().toISOString();
    attempt.child_state = 'LAUNCHING';
    attempt.wait_registration = registerWait({
      waitId: attempt.attempt_id,
      taskId: task.task_id,
      attemptId: attempt.attempt_id,
      registeredAt,
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    });
    attempt.wait_registration.detached_dormancy = detachedDormancyContract();
    writeJson(join(paths(root).attempts, `${attempt.attempt_id}.json`), attempt);
    const supervisor = readJson(paths(root).supervisor);
    const launchNonce = 'runner-launch-fixture';
    const workerIdentity = processStartIdentity();
    mkdirSync(join(root, '.opsle', 'workers'), { recursive: true });
    writeJson(join(root, '.opsle', 'workers', `${attempt.attempt_id}.json`), {
      schema: 'opsle.durable-supervisor.detached-runner/v1',
      task_id: task.task_id,
      attempt_id: attempt.attempt_id,
      claim_id: claim.claim_id,
      fence_generation: claim.fence_generation,
      supervisor_id: supervisor.supervisor_id,
      supervisor_generation: supervisor.generation,
      launch_nonce: launchNonce,
      launcher_pid: process.pid,
      worker_pid: process.pid,
      expected_release: {
        runtime_release_id: createReleaseFence('runner-worker', workerIdentity).runtime_release_id,
        packaged_artifact_sha256: createReleaseFence('runner-worker', workerIdentity).packaged_artifact_sha256,
        runtime_epoch: createReleaseFence('runner-worker', workerIdentity).runtime_epoch,
        helper_role: 'runner-worker',
      },
      release_fence: createReleaseFence('runner-worker', workerIdentity),
      status: 'LAUNCHED',
      launched_at: registeredAt,
      owned_at: null,
      terminal_at: null,
      failure: null,
    });

    await assert.rejects(runDetachedWorker(root, attempt.attempt_id, launchNonce, {
      runAttemptImpl: async () => { throw new Error('injected post-process terminal failure'); },
    }), /injected post-process terminal failure/);
    const worker = readJson(join(root, '.opsle', 'workers', `${attempt.attempt_id}.json`));
    const failed = readJson(join(paths(root).attempts, `${attempt.attempt_id}.json`));
    assert.equal(worker.status, 'FAILED');
    assert.ok(worker.terminal_at);
    assert.ok(worker.intervention_event_id);
    assert.equal(failed.child_state, 'UNKNOWN');
    assert.equal(failed.runner_failure.runner_outcome, 'FAILED');
    assert.equal(failed.runner_failure.child_outcome, 'UNKNOWN');
    assert.equal(failed.wait_registration.state, 'READY');
    assert.equal(failed.wait_registration.wake.type, 'intervention-required');
    assert.equal(readJson(paths(root).state).supervisor_state, 'PAUSED');
    assert.equal(events(root).filter((event) => (
      event.type === 'CHILD_COMPLETION' && event.attempt_id === attempt.attempt_id
    )).length, 0);
    assert.equal(events(root).filter((event) => (
      event.type === 'INTERVENTION_REQUIRED' && event.attempt_id === attempt.attempt_id
    )).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recovery rejects an orphaned live child when its exact detached Runner worker is dead', () => {
  const root = fixture();
  try {
    const { attempt } = stageOwnedAttempt(root, 'task-orphaned-child');
    const recovered = recover(root, {
      isProcessAlive: (pid) => pid === attempt.pid,
      startWakeDispatcher: noDispatcher,
    });
    assert.equal(recovered.reconciliation.classification, 'unknown_unreconciled');
    assert.equal(recovered.reconciliation.action, 'pause_and_reconcile');
    assert.equal(readJson(join(paths(root).attempts, `${attempt.attempt_id}.json`)).child_state, 'UNKNOWN');
    const state = readJson(paths(root).state);
    assert.equal(state.supervisor_state, 'PAUSED');
    assert.equal(state.pause.active, true);
    assert.match(state.pause.reason, /Recovery ambiguity/);
    const intervention = events(root).find((event) => (
      event.type === 'INTERVENTION_REQUIRED'
      && event.attempt_id === attempt.attempt_id
    ));
    assert.ok(intervention);
    assert.match(intervention.reason, /exact detached Runner owner is absent/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recovery preserves only a live exact detached Runner owner across generations', () => {
  const root = fixture();
  try {
    const { attempt, claim } = stageOwnedAttempt(root, 'task-live-runner');
    const options = {
      isProcessAlive: (pid) => pid === 9002,
      startWakeDispatcher: noDispatcher,
    };
    const first = recover(root, options);
    assert.equal(first.reconciliation.classification, 'known_running');
    assert.equal(first.reconciliation.lifecycle_owner, 'detached-runner-worker');
    assert.equal(first.reconciliation.runner_pid, 9002);
    assert.equal(readJson(join(paths(root).claims, `${claim.claim_id}.json`)).status, 'ACTIVE');
    const second = recover(root, options);
    assert.equal(second.reconciliation.classification, 'known_running');
    assert.equal(readJson(join(paths(root).attempts, `${attempt.attempt_id}.json`)).child_state, 'RUNNING');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('task run publishes a durable Runner request without launching a child', async () => {
  const root = fixture();
  try {
    const task = createTask(root, handoff('task-detached-default', 2400));
    const started = Date.now();
    const launched = runCli(root, ['task', 'run', task.task_id, '--json']);
    const elapsed = Date.now() - started;
    assert.equal(launched.code, 0, launched.stderr);
    assert.ok(launched.stdout.trim(), JSON.stringify(launched));
    const launch = JSON.parse(launched.stdout);
    assert.equal(launch.launch_mode, 'opsled-request');
    assert.equal(launch.action, 'REQUEST_SUBMITTED');
    assert.equal(launch.monitoring_owner, 'OPSLED');
    assert.equal(launch.child_state, 'QUEUED');
    assert.ok(elapsed < 1200, `detached launch took ${elapsed}ms`);
    assert.equal(readJson(paths(root).state).supervisor_state, 'ACTIVE');
    assert.equal(existsSync(join(paths(root).runnerRequests, `${launch.request_id}.json`)), true);
    assert.equal(existsSync(join(root, '.opsle', 'workers')), false);
  } finally {
    await cleanupDetachedFixture(root);
  }
});

test('foreground waiting is available only through the explicit compatibility flag', () => {
  const root = fixture();
  try {
    const task = createTask(root, handoff('task-foreground-fallback', 250));
    const started = Date.now();
    const result = runCli(root, ['task', 'run', task.task_id, '--foreground-wait']);
    const elapsed = Date.now() - started;
    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.stdout.trim(), JSON.stringify(result));
    const value = JSON.parse(result.stdout);
    assert.equal(value.launch_mode, 'foreground-wait');
    assert.equal(value.child_state, 'COMPLETED');
    assert.equal(value.action, undefined);
    assert.ok(elapsed >= 200);
    assert.equal(readJson(paths(root).state).supervisor_state, 'ACTIVE');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('opsled launches and supervises a deterministic Runner from the explicit request', async () => {
  const root = fixture();
  try {
    const task = createTask(root, handoff('task-opsled-intent-live', 100));
    const queued = runCli(root, ['task', 'run', task.task_id, '--json']);
    assert.equal(queued.code, 0, queued.stderr);
    const request = JSON.parse(queued.stdout);
    const pointer = readJson(paths(root).hostOwnership);
    const mapping = {
      schema: OPSLED_REPOSITORY_SCHEMA,
      repository_id: pointer.repository_id,
      repository_realpath: root,
      host_state_path: join(pointer.opsled_root, 'repositories', pointer.repository_id),
      ownership_pointer_path: paths(root).hostOwnership,
      herdr: pointer.herdr,
      enabled: true,
      added_at: pointer.registered_at,
      updated_at: pointer.updated_at,
    };
    const identity = processStartIdentity();
    const options = {
      releaseFence: createReleaseFence('opsled-worker', identity),
      processIdentity: identity,
      serviceIdentity: {
        service_id: 'opsled-fixture-service',
        generation: 1,
        launch_nonce: 'existing-service-fence',
        process: identity,
        host_root: pointer.opsled_root,
      },
    };
    const [launched] = await processRunnerRequests(mapping, options);
    assert.equal(launched.request_id, request.request_id);
    assert.equal(launched.status, 'RUNNING');
    const attemptPath = join(paths(root).attempts, `${request.attempt_id}.json`);
    await waitFor(() => readJson(attemptPath).child_state === 'COMPLETED', 'opsled Runner did not complete');
    await waitFor(() => readJson(join(root, '.opsle', 'workers', `${request.attempt_id}.json`)).status === 'TERMINAL', 'opsled Runner did not publish terminal ownership');
    const [terminal] = await processRunnerRequests(mapping, options);
    assert.equal(terminal.status, 'TERMINAL');
    assert.equal(readFileSync(join(root, `${task.task_id}.txt`), 'utf8'), 'done\n');
  } finally {
    await cleanupDetachedFixture(root);
  }
});

test('default task run reports the durable opsled request without claiming a child launch', async () => {
  const root = fixture();
  try {
    const task = createTask(root, handoff('task-human-launch-notice', 500));
    const launched = runCli(root, ['task', 'run', task.task_id]);
    assert.equal(launched.code, 0, launched.stderr);
    assert.equal(launched.stdout.trim().split('\n').length, 2);
    assert.match(launched.stdout, /^Runner request .* queued for task-human-launch-notice\./);
    assert.match(launched.stdout, /^Opsled owns launch and supervision\.$/m);
    assert.equal(readJson(paths(root).state).supervisor_state, 'ACTIVE');
  } finally {
    await cleanupDetachedFixture(root);
  }
});

test('task run atomically arms pause-after-current before publishing the Runner request', async () => {
  for (const evaluation of ['accept', 'reject']) {
    const root = fixture();
    try {
      const task = createTask(root, handoff(`task-atomic-pause-${evaluation}`, 650));
      const reason = `atomic ${evaluation} fixture boundary`;
      const launched = runCli(root, [
        'task', 'run', task.task_id,
        '--pause-after-current', '--reason', reason, '--json',
      ]);
      assert.equal(launched.code, 0, launched.stderr);
      const launch = JSON.parse(launched.stdout);
      assert.equal(launch.action, 'REQUEST_SUBMITTED');
      assert.equal(launch.monitoring_owner, 'OPSLED');
      assert.equal(launch.pause_after_current, true);

      const armed = readJson(paths(root).state);
      assert.equal(armed.supervisor_state, 'ACTIVE');
      assert.equal(armed.pause.active, true);
      assert.equal(armed.pause.after_current, true);
      assert.equal(armed.pause.reason, reason);
      const armedEvent = events(root).find((event) => (
        event.type === 'PAUSE_AFTER_CURRENT_REQUESTED'
        && event.attempt_id === launch.attempt_id
      ));
      assert.ok(armedEvent);
      assert.equal(existsSync(join(paths(root).runnerRequests, `${launch.request_id}.json`)), true);
      assert.equal(existsSync(join(root, '.opsle', 'workers')), false);
    } finally {
      await cleanupDetachedFixture(root);
    }
  }
});

test('pause before opsled launch leaves the queued request durable and blocks new work', async () => {
  const root = fixture();
  try {
    const task = createTask(root, handoff('task-detached-pause', 650));
    const launched = runCli(root, ['task', 'run', task.task_id, '--json']);
    assert.equal(launched.code, 0, launched.stderr);
    assert.ok(launched.stdout.trim(), JSON.stringify(launched));
    const launch = JSON.parse(launched.stdout);
    const paused = runCli(root, ['pause', '--after-current', '--reason', 'detached fixture boundary']);
    assert.equal(paused.code, 0, paused.stderr);
    const state = readJson(paths(root).state);
    assert.equal(state.supervisor_state, 'PAUSED');
    assert.equal(state.pause.active, true);
    assert.equal(state.pause.after_current, false);
    assert.equal(readJson(join(paths(root).attempts, `${launch.attempt_id}.json`)).child_state, 'QUEUED');
    assert.equal(existsSync(join(paths(root).runnerRequests, `${launch.request_id}.json`)), true);
    assert.equal(existsSync(join(root, '.opsle', 'workers')), false);
    const next = createTask(root, handoff('task-detached-must-not-run', 50));
    const blocked = runCli(root, ['task', 'run', next.task_id]);
    assert.equal(blocked.code, 1);
    assert.match(blocked.stderr, /automatic progression is paused/);
    assert.deepEqual(readJson(join(paths(root).tasks, `${next.task_id}.json`)).attempts, []);
  } finally {
    await cleanupDetachedFixture(root);
  }
});
