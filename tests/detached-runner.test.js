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
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { activationSummary } from '../src/activation-telemetry.js';
import { createAttempt, createTask, routeTask } from '../src/pipeline.js';
import { readJson, writeJson } from '../src/io.js';
import { initialize, paths } from '../src/state.js';
import { recover } from '../src/cli.js';
import { runAttempt, runDetachedWorker } from '../src/runner.js';
import { registerWait } from '../src/wakeup.js';

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
  initialize(root, { actor: 'detached-test' });
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
    writeJson(join(paths(root).attempts, `${attempt.attempt_id}.json`), attempt);
    const supervisor = readJson(paths(root).supervisor);
    const launchNonce = 'runner-launch-fixture';
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

test('task run defaults to a detached worker that outlives the launcher and owns terminal lifecycle', async () => {
  const root = fixture();
  try {
    const task = createTask(root, handoff('task-detached-default', 700));
    const started = Date.now();
    const launched = runCli(root, ['task', 'run', task.task_id]);
    const elapsed = Date.now() - started;
    assert.equal(launched.code, 0, launched.stderr);
    assert.ok(launched.stdout.trim(), JSON.stringify(launched));
    const launch = JSON.parse(launched.stdout);
    assert.equal(launch.launch_mode, 'detached');
    assert.ok(['LAUNCHING', 'RUNNING'].includes(launch.child_state));
    assert.ok(elapsed < 600, `detached launch took ${elapsed}ms`);
    assert.equal(readJson(paths(root).state).supervisor_state, 'DORMANT');

    const recordPath = join(root, '.opsle', 'workers', `${launch.attempt_id}.json`);
    const owned = readJson(recordPath);
    assert.ok(['OWNED', 'TERMINAL'].includes(owned.status));
    assert.equal(owned.worker_pid, launch.worker_pid);
    await waitFor(() => {
      try { process.kill(owned.launcher_pid, 0); return false; } catch { return true; }
    }, 'initiating CLI launcher remained alive');

    const attemptPath = join(paths(root).attempts, `${launch.attempt_id}.json`);
    const completed = await waitFor(() => {
      const value = readJson(attemptPath);
      return value.child_state === 'COMPLETED' ? value : null;
    }, 'detached worker did not publish terminal attempt state');
    assert.equal(completed.acceptance.state, 'SATISFIED');
    assert.equal(completed.telemetry.activation_counts.wait_induced_automatic, 0);
    assert.equal(readFileSync(join(root, `${task.task_id}.txt`), 'utf8'), 'done\n');
    await waitFor(() => readJson(recordPath).status === 'TERMINAL', 'worker terminal record was not persisted');
    await waitFor(() => {
      try { process.kill(launch.worker_pid, 0); return false; } catch { return true; }
    }, 'detached Runner process did not exit after terminal record');
    assert.equal(readJson(paths(root).state).supervisor_state, 'DORMANT');
    assert.equal(readJson(join(paths(root).claims, `${completed.claim_id}.json`)).status, 'COMPLETED');

    const completion = events(root).find((event) => (
      event.type === 'CHILD_COMPLETION' && event.attempt_id === launch.attempt_id
    ));
    assert.ok(completion);
    assert.match(completion.wait_mechanism, /detached Runner worker/);
    assert.equal(events(root).filter((event) => (
      event.type === 'SUPERVISOR_ACTIVATION'
      && event.classification === 'terminal-event'
      && event.attempt_id === launch.attempt_id
    )).length, 0);
    assert.equal(activationSummary(events(root)).wait_induced_automatic, 0);
    assert.ok(existsSync(join(root, '.opsle', 'wake', 'requests', `${completion.event_id}.json`)));
  } finally {
    rmSync(root, { recursive: true, force: true });
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
    assert.ok(elapsed >= 200);
    assert.equal(readJson(paths(root).state).supervisor_state, 'ACTIVE');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('detached pause-after-current survives recovery, evaluates, then prevents a new launch', async () => {
  const root = fixture();
  try {
    const task = createTask(root, handoff('task-detached-pause', 650));
    const launched = runCli(root, ['task', 'run', task.task_id]);
    assert.equal(launched.code, 0, launched.stderr);
    assert.ok(launched.stdout.trim(), JSON.stringify(launched));
    const launch = JSON.parse(launched.stdout);
    const attemptPath = join(paths(root).attempts, `${launch.attempt_id}.json`);
    await waitFor(() => readJson(attemptPath).child_state === 'RUNNING', 'child never entered RUNNING');

    const paused = runCli(root, ['pause', '--after-current', '--reason', 'detached fixture boundary']);
    assert.equal(paused.code, 0, paused.stderr);
    const recovered = runCli(root, ['recover']);
    assert.equal(recovered.code, 0, recovered.stderr);
    assert.equal(JSON.parse(recovered.stdout).reconciliation.classification, 'known_running');

    await waitFor(() => readJson(attemptPath).child_state === 'COMPLETED', 'child did not finish after recovery');
    await waitFor(() => {
      try { process.kill(launch.worker_pid, 0); return false; } catch { return true; }
    }, 'detached Runner process did not exit after pause completion');
    const state = readJson(paths(root).state);
    assert.equal(state.supervisor_state, 'DORMANT');
    assert.equal(state.pause.active, true);
    assert.equal(state.pause.after_current, true);
    assert.equal(readJson(join(paths(root).tasks, `${task.task_id}.json`)).state, 'AWAITING_SUPERVISOR');
    const evaluated = runCli(root, [
      'task', 'evaluate', task.task_id,
      '--reject', '--rationale', 'recovery changed protected generation evidence during execution',
    ]);
    assert.equal(evaluated.code, 0, evaluated.stderr);
    const terminal = readJson(paths(root).state);
    assert.equal(terminal.supervisor_state, 'PAUSED');
    assert.equal(terminal.pause.active, true);
    assert.equal(terminal.pause.after_current, false);
    assert.equal(readJson(join(paths(root).tasks, `${task.task_id}.json`)).state, 'REJECTED');
    const next = createTask(root, handoff('task-detached-must-not-run', 50));
    const blocked = runCli(root, ['task', 'run', next.task_id]);
    assert.equal(blocked.code, 1);
    assert.match(blocked.stderr, /automatic progression is paused/);
    assert.deepEqual(readJson(join(paths(root).tasks, `${next.task_id}.json`)).attempts, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
