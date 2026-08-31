import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  cpSync,
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
import test from 'node:test';
import {
  createAttempt,
  createTask,
  releaseClaim,
  routeTask,
} from '../src/pipeline.js';
import { readJson, writeJson } from '../src/io.js';
import {
  NEXT_UNSATISFIED_REQUIREMENT_ACTION,
  emit,
  initialize,
  paths,
  setRequirements,
  updateState,
  validateDurableState,
} from '../src/state.js';
import { runAttempt } from '../src/runner.js';

const sourceRoot = resolve(new URL('..', import.meta.url).pathname);
const cliPath = join(sourceRoot, 'bin', 'opsle.js');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'durable-supervisor-recovery-'));
  mkdirSync(join(root, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(root, '.git', 'refs', 'heads', 'main'), `${'2'.repeat(40)}\n`);
  writeFileSync(join(root, '.git', 'config'), [
    '[core]',
    '\trepositoryformatversion = 0',
    '[remote "origin"]',
    '\turl = https://example.invalid/recovery-fixture.git',
    '',
  ].join('\n'));
  writeFileSync(join(root, 'README.md'), '# recovery fixture\n');
  mkdirSync(join(root, '.opsle'));
  cpSync(join(sourceRoot, '.opsle', 'specification.md'), join(root, '.opsle', 'specification.md'));
  cpSync(join(sourceRoot, '.opsle', 'requirements.json'), join(root, '.opsle', 'requirements.json'));
  initialize(root, { actor: 'recovery-test' });
  return root;
}

function handoff(overrides = {}) {
  return {
    task_id: 'task-recovery-fixture',
    title: 'Persist a deterministic fixture result',
    objective: 'Create recovery-output.txt without invoking a provider.',
    scope: ['recovery-output.txt'],
    authorization: {
      may: ['inspect repository', 'create recovery-output.txt'],
      may_modify: ['recovery-output.txt'],
      may_not: ['invoke a provider', 'modify sibling repositories', 'deploy'],
    },
    required_inputs: [],
    relevant_context: [],
    expected_deliverable: 'recovery-output.txt containing recovered',
    expected_evidence: ['process exit status', 'actual changed files'],
    acceptance_criteria: ['exit code 0', 'only recovery-output.txt changed'],
    prohibited_actions: ['provider invocation', 'deployment'],
    requirement_ids: ['DS-068'],
    route_hint: 'deterministic',
    deterministic_command: [
      process.execPath,
      '-e',
      "require('fs').writeFileSync('recovery-output.txt','recovered\\n')",
    ],
    verification_command: [
      process.execPath,
      '-e',
      "process.exit(require('fs').readFileSync('recovery-output.txt','utf8')==='recovered\\n'?0:1)",
    ],
    ...overrides,
  };
}

function runCli(root, args) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const capture = mkdtempSync(join(tmpdir(), 'durable-supervisor-recovery-cli-'));
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
      signal: result.signal,
      stdout: readFileSync(stdoutPath, 'utf8'),
      stderr: readFileSync(stderrPath, 'utf8'),
    };
  } finally {
    try { closeSync(stdout); } catch {}
    try { closeSync(stderr); } catch {}
    rmSync(capture, { recursive: true, force: true });
  }
}

function eventLines(root) {
  const value = readFileSync(paths(root).eventsLog, 'utf8').trim();
  return value ? value.split('\n').map((line) => JSON.parse(line)) : [];
}

test('fresh-process recovery reconstructs accepted work using durable repository files only', async () => {
  const root = fixture();
  try {
    const p = paths(root);
    const task = createTask(root, handoff());
    const decision = routeTask(root, task);
    const { attempt, claim } = createAttempt(root, task, decision);
    const completed = await runAttempt(root, task, attempt, claim);
    assert.equal(completed.packet.completeness, 'complete_for_decision');
    assert.equal(completed.attempt.acceptance.state, 'SATISFIED');

    const evaluated = await runCli(root, [
      'task',
      'evaluate',
      task.task_id,
      '--accept',
      '--rationale',
      'deterministic fixture evidence is complete',
    ]);
    assert.equal(evaluated.code, 0, evaluated.stderr);
    updateState(root, { pending_next_action: 'Continue with durable decision B.' });

    const before = {
      supervisor: readJson(p.supervisor),
      objective: readJson(p.objective),
      policy: readJson(p.policy),
      requirements: readJson(p.requirements),
      task: readJson(join(p.tasks, `${task.task_id}.json`)),
      attempt: readJson(join(p.attempts, `${attempt.attempt_id}.json`)),
      decisions: readFileSync(p.decisionsLog, 'utf8'),
    };

    const recovered = await runCli(root, ['recover']);
    assert.equal(recovered.code, 0, recovered.stderr);
    const status = await runCli(root, ['status', '--json']);
    assert.equal(status.code, 0, status.stderr);

    const afterState = readJson(p.state);
    assert.equal(readJson(p.supervisor).supervisor_id, before.supervisor.supervisor_id);
    assert.equal(readJson(p.supervisor).generation, before.supervisor.generation + 1);
    assert.deepEqual(readJson(p.objective), before.objective);
    assert.deepEqual(readJson(p.policy), before.policy);
    assert.deepEqual(readJson(p.requirements), before.requirements);
    assert.deepEqual(readJson(join(p.tasks, `${task.task_id}.json`)), before.task);
    assert.deepEqual(readJson(join(p.attempts, `${attempt.attempt_id}.json`)), before.attempt);
    assert.equal(readFileSync(p.decisionsLog, 'utf8'), before.decisions);
    assert.equal(afterState.latest_accepted_task_id, task.task_id);
    assert.equal(afterState.pending_next_action, 'Continue with durable decision B.');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fresh recovery preserves canonical terminal state and historical next-action text', async () => {
  const root = fixture();
  try {
    const p = paths(root);
    updateState(root, {
      phase: 'COMPLETE',
      pending_next_action: NEXT_UNSATISFIED_REQUIREMENT_ACTION,
    });
    const historical = emit(root, 'LEGACY_TERMINAL_STATE_OBSERVED', {
      pending_next_action: NEXT_UNSATISFIED_REQUIREMENT_ACTION,
    });
    const historicalEvent = readFileSync(join(p.events, `${historical.event_id}.json`), 'utf8');

    const recovered = await runCli(root, ['recover']);
    assert.equal(recovered.code, 0, recovered.stderr);
    assert.equal(JSON.parse(recovered.stdout).reconciliation.classification, 'no_active_work');
    assert.equal(readJson(p.state).pending_next_action, null);
    assert.equal(readFileSync(join(p.events, `${historical.event_id}.json`), 'utf8'), historicalEvent);
    const canonicalState = readFileSync(p.state, 'utf8');

    const recoveredAgain = await runCli(root, ['recover']);
    assert.equal(recoveredAgain.code, 0, recoveredAgain.stderr);
    assert.equal(readFileSync(p.state, 'utf8'), canonicalState);

    const status = await runCli(root, ['status']);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /^next: none$/m);
    const jsonStatus = await runCli(root, ['status', '--json']);
    assert.equal(jsonStatus.code, 0, jsonStatus.stderr);
    assert.equal(JSON.parse(jsonStatus.stdout).progress.pending_next_action, null);
    assert.deepEqual(validateDurableState(root), { valid: true, errors: [] });

    setRequirements(root, ['DS-000'], 'IN_PROGRESS');
    const reopened = await runCli(root, ['recover']);
    assert.equal(reopened.code, 0, reopened.stderr);
    assert.equal(readJson(p.state).pending_next_action, NEXT_UNSATISFIED_REQUIREMENT_ACTION);
    assert.deepEqual(validateDurableState(root), { valid: true, errors: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pause persists across separate CLI processes and blocks automatic task launch', async () => {
  const root = fixture();
  try {
    const task = createTask(root, handoff());
    const paused = await runCli(root, ['pause', '--reason', 'fixture pause']);
    assert.equal(paused.code, 0, paused.stderr);
    assert.deepEqual(readJson(paths(root).state).pause, {
      active: true,
      after_current: false,
      reason: 'fixture pause',
      changed_at: readJson(paths(root).state).pause.changed_at,
    });

    const status = await runCli(root, ['status', '--json']);
    assert.equal(status.code, 0, status.stderr);
    assert.equal(readJson(paths(root).state).pause.active, true);

    const blocked = await runCli(root, ['task', 'run', task.task_id]);
    assert.equal(blocked.code, 1);
    assert.equal(readJson(paths(root).tasks + `/${task.task_id}.json`).attempts.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('live policy changes are prospective and retry creates immutable distinct attempts', async () => {
  const root = fixture();
  try {
    const p = paths(root);
    const task = createTask(root, handoff());
    const firstDecision = routeTask(root, task);
    const first = createAttempt(root, task, firstDecision);
    releaseClaim(root, first.claim, 'FAILED');
    const firstPath = join(p.attempts, `${first.attempt.attempt_id}.json`);
    const firstBytes = readFileSync(firstPath, 'utf8');

    const enabled = await runCli(root, ['policy', 'enable', 'claude']);
    assert.equal(enabled.code, 0, enabled.stderr);
    const review = await runCli(root, ['policy', 'review', 'risk_based', '--reviewer', 'claude']);
    assert.equal(review.code, 0, review.stderr);

    const currentTask = readJson(join(p.tasks, `${task.task_id}.json`));
    const secondDecision = routeTask(root, currentTask);
    const second = createAttempt(root, currentTask, secondDecision);
    assert.equal(first.attempt.attempt_id, `${task.task_id}-attempt-001`);
    assert.equal(second.attempt.attempt_id, `${task.task_id}-attempt-002`);
    assert.notEqual(second.attempt.claim_id, first.attempt.claim_id);
    assert.equal(readFileSync(firstPath, 'utf8'), firstBytes);
    assert.deepEqual(readJson(firstPath).policy_snapshot.allowed_providers, ['codex']);
    assert.equal(readJson(firstPath).policy_snapshot.review_mode, 'off');
    assert.deepEqual(second.attempt.policy_snapshot.allowed_providers.sort(), ['claude', 'codex']);
    assert.equal(second.attempt.policy_snapshot.review_mode, 'risk_based');
    assert.equal(second.attempt.policy_snapshot.reviewer, 'claude');
    assert.equal(readJson(join(p.tasks, `${task.task_id}.json`)).attempts.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('duplicate completion event consumption is idempotent', async () => {
  const root = fixture();
  try {
    const event = emit(root, 'CHILD_COMPLETION', {
      task_id: 'task-event-fixture',
      attempt_id: 'task-event-fixture-attempt-001',
      child_state: 'COMPLETED',
    });
    const beforeConsumed = eventLines(root).filter((item) => item.type === 'EVENT_CONSUMED').length;

    const first = await runCli(root, ['events', 'consume', event.event_id]);
    const second = await runCli(root, ['events', 'consume', event.event_id]);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(second.code, 0, second.stderr);

    const state = readJson(paths(root).state);
    assert.deepEqual(state.processed_event_ids, [event.event_id]);
    const consumed = eventLines(root).filter((item) => (
      item.type === 'EVENT_CONSUMED' && item.source_event_id === event.event_id
    ));
    assert.equal(consumed.length, beforeConsumed + 1);
    assert.equal(existsSync(paths(root).decisionsLog), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recovery fences an absent running child as unknown without retrying it', async () => {
  const root = fixture();
  try {
    const p = paths(root);
    const task = createTask(root, handoff());
    const decision = routeTask(root, task);
    const { attempt, claim } = createAttempt(root, task, decision);
    const attemptPath = join(p.attempts, `${attempt.attempt_id}.json`);
    const uncertain = readJson(attemptPath);
    uncertain.child_state = 'RUNNING';
    uncertain.pid = 2147483647;
    writeJson(attemptPath, uncertain);
    const generation = readJson(p.supervisor).generation;

    const recovered = await runCli(root, ['recover']);
    assert.equal(recovered.code, 0, recovered.stderr);
    assert.equal(readJson(attemptPath).child_state, 'UNKNOWN');
    assert.equal(readJson(p.state).pause.active, true);
    assert.match(readJson(p.state).pause.reason, /Recovery ambiguity/);
    assert.equal(readJson(join(p.claims, `${claim.claim_id}.json`)).status, 'ACTIVE');
    assert.equal(readJson(join(p.tasks, `${task.task_id}.json`)).attempts.length, 1);
    assert.equal(readJson(p.supervisor).generation, generation + 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
