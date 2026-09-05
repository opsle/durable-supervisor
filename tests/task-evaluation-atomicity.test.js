import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { evaluateTask } from '../src/cli.js';
import { readJson, writeJson } from '../src/io.js';
import { initialize, paths, updateState } from '../src/state.js';

const sourceRoot = resolve(new URL('..', import.meta.url).pathname);
const workerPath = join(sourceRoot, 'tests', 'fixtures', 'task-evaluation-worker.js');

function fixture({ pauseAfterCurrent = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'durable-supervisor-evaluation-'));
  mkdirSync(join(root, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(root, '.git', 'refs', 'heads', 'main'), `${'5'.repeat(40)}\n`);
  writeFileSync(join(root, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');
  writeFileSync(join(root, 'README.md'), '# atomic evaluation fixture\n');
  mkdirSync(join(root, '.opsle'));
  cpSync(join(sourceRoot, '.opsle', 'specification.md'), join(root, '.opsle', 'specification.md'));
  cpSync(join(sourceRoot, '.opsle', 'requirements.json'), join(root, '.opsle', 'requirements.json'));
  initialize(root, { actor: 'atomic-evaluation-test', objectiveText: 'Evaluate one task once.' });

  const p = paths(root);
  const objective = readJson(p.objective);
  const requirements = readJson(p.requirements);
  const requirementId = requirements.requirements[0].id;
  const requirement = requirements.requirements[0];
  requirement.state = 'UNSTARTED';
  requirement.evidence = [];
  requirement.justification = null;
  writeJson(p.requirements, requirements);
  const taskId = 'task-atomic-evaluation';
  const attemptId = `${taskId}-attempt-001`;
  const task = {
    schema: 'opsle.durable-supervisor.task-handoff/v1',
    task_id: taskId,
    parent_objective_id: objective.objective_id,
    parent_objective_revision: objective.current_revision,
    state: 'AWAITING_SUPERVISOR',
    attempts: [attemptId],
    requirement_ids: [requirementId],
  };
  const attempt = {
    schema: 'opsle.durable-supervisor.child-attempt/v1',
    task_id: taskId,
    attempt_id: attemptId,
    child_state: 'COMPLETED',
    compact_packet: '.opsle/evidence/compact/atomic.json',
    completion_handoff: '.opsle/evidence/compact/atomic-completion.json',
    acceptance: { state: 'SATISFIED' },
    supervisor_evaluation: null,
  };
  writeJson(join(p.tasks, `${taskId}.json`), task);
  writeJson(join(p.attempts, `${attemptId}.json`), attempt);
  updateState(root, {
    active_task_id: taskId,
    active_attempt_id: attemptId,
    pause: pauseAfterCurrent ? {
      active: true,
      after_current: true,
      reason: 'pause after atomic evaluation',
      changed_at: new Date().toISOString(),
    } : readJson(p.state).pause,
  });
  return { root, p, taskId, attemptId, requirementId };
}

function jsonLines(path) {
  if (!existsSync(path)) return [];
  const bytes = readFileSync(path, 'utf8').trim();
  return bytes ? bytes.split('\n').map((line) => JSON.parse(line)) : [];
}

function startWorker(root, taskId, readyPath, gatePath, resultPath, workerId) {
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [
    workerPath, root, taskId, readyPath, gatePath, resultPath, String(workerId),
  ], { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolveWorker) => {
    child.on('close', (code, signal) => resolveWorker({ code, signal, stdout, stderr }));
  });
}

async function waitUntilReady(pathsToCheck) {
  const deadline = Date.now() + 10_000;
  while (!pathsToCheck.every((path) => existsSync(path))) {
    if (Date.now() >= deadline) throw new Error('evaluation workers did not reach the start gate');
    await sleep(5);
  }
}

function assertConverged(value, decisionId, { paused = false } = {}) {
  const decisions = jsonLines(value.p.decisionsLog)
    .filter((entry) => entry.task_id === value.taskId);
  const decisionEvents = jsonLines(value.p.eventsLog)
    .filter((entry) => entry.type === 'SUPERVISOR_DECISION' && entry.task_id === value.taskId);
  const pauseEvents = jsonLines(value.p.eventsLog)
    .filter((entry) => entry.type === 'PAUSE_AFTER_CURRENT_APPLIED' && entry.task_id === value.taskId);
  const attempt = readJson(join(value.p.attempts, `${value.attemptId}.json`));
  const task = readJson(join(value.p.tasks, `${value.taskId}.json`));
  const requirement = readJson(value.p.requirements).requirements
    .find((entry) => entry.id === value.requirementId);
  const state = readJson(value.p.state);

  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].decision_id, decisionId);
  assert.equal(decisionEvents.length, 1);
  assert.equal(decisionEvents[0].decision_id, decisionId);
  assert.deepEqual(readJson(join(value.p.events, `${decisionEvents[0].event_id}.json`)), decisionEvents[0]);
  assert.equal(pauseEvents.length, paused ? 1 : 0);
  if (paused) {
    assert.deepEqual(readJson(join(value.p.events, `${pauseEvents[0].event_id}.json`)), pauseEvents[0]);
    assert.equal(state.pause.applied_decision_id, decisionId);
    assert.equal(state.pause.after_current, false);
    assert.equal(state.supervisor_state, 'PAUSED');
  }
  assert.equal(attempt.supervisor_evaluation.decision_id, decisionId);
  assert.equal(task.state, 'ACCEPTED');
  assert.equal(requirement.state, 'IMPLEMENTED');
  assert.equal(state.active_task_id, null);
  assert.equal(state.active_attempt_id, null);
  assert.equal(state.latest_accepted_task_id, value.taskId);
}

test('four evaluator processes commit and apply one supervisor evaluation', async () => {
  const value = fixture();
  const gatePath = join(value.root, 'evaluation.start');
  const readyPaths = Array.from({ length: 4 }, (_, index) => join(value.root, `evaluation.${index}.ready`));
  const resultPaths = Array.from({ length: 4 }, (_, index) => join(value.root, `evaluation.${index}.result`));
  try {
    const workers = readyPaths.map((readyPath, index) => (
      startWorker(value.root, value.taskId, readyPath, gatePath, resultPaths[index], index)
    ));
    await waitUntilReady(readyPaths);
    writeFileSync(gatePath, 'start\n');
    const results = await Promise.all(workers);
    results.forEach((result) => assert.equal(result.code, 0, result.stderr));
    const outcomes = resultPaths.map((path) => readJson(path));
    const decisions = jsonLines(value.p.decisionsLog)
      .filter((entry) => entry.task_id === value.taskId);
    const events = jsonLines(value.p.eventsLog)
      .filter((entry) => entry.type === 'SUPERVISOR_DECISION' && entry.task_id === value.taskId);
    const requirement = readJson(value.p.requirements).requirements
      .find((entry) => entry.id === value.requirementId);
    const task = readJson(join(value.p.tasks, `${value.taskId}.json`));
    const attempt = readJson(join(value.p.attempts, `${value.attemptId}.json`));
    const state = readJson(value.p.state);

    assert.equal(decisions.length, 1);
    assert.equal(events.length, 1);
    assert.equal(outcomes.filter((entry) => !entry.idempotent).length, 1);
    assert.equal(new Set(outcomes.map((entry) => entry.decision_id)).size, 1);
    assert.equal(attempt.supervisor_evaluation.decision_id, decisions[0].decision_id);
    assert.equal(task.state, 'ACCEPTED');
    assert.equal(requirement.state, 'IMPLEMENTED');
    assert.equal(state.active_task_id, null);
    assert.equal(state.active_attempt_id, null);
    assert.equal(state.latest_accepted_task_id, value.taskId);

    const sequential = evaluateTask(
      value.root,
      value.taskId,
      false,
      'a later conflicting evaluation must preserve the first decision',
    );
    assert.equal(sequential.idempotent, true);
    assert.equal(sequential.attempt.supervisor_evaluation.decision_id, decisions[0].decision_id);
    assert.equal(jsonLines(value.p.decisionsLog).filter((entry) => entry.task_id === value.taskId).length, 1);
    assert.equal(jsonLines(value.p.eventsLog).filter((entry) => (
      entry.type === 'SUPERVISOR_DECISION' && entry.task_id === value.taskId
    )).length, 1);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test('interruption after the immutable commit reconciles the committed decision suffix', () => {
  const value = fixture();
  try {
    let committedDecisionId;
    assert.throws(() => evaluateTask(
      value.root,
      value.taskId,
      true,
      'commit before interruption',
      {
        afterEvaluationCommit(decision) {
          committedDecisionId = decision.decision_id;
          throw new Error('injected post-commit interruption');
        },
      },
    ), /injected post-commit interruption/);

    const retry = evaluateTask(
      value.root,
      value.taskId,
      false,
      'retry must not replace the committed acceptance',
    );
    const committed = readJson(join(
      value.p.attempts,
      'supervisor-evaluations',
      `${value.attemptId}.json`,
    ));
    assert.equal(retry.idempotent, true);
    assert.equal(retry.decision.decision_id, committedDecisionId);
    assert.equal(retry.decision.decision, 'ACCEPT');
    assert.equal(retry.decision.rationale, 'commit before interruption');
    assert.equal(committed.decision_id, committedDecisionId);
    assertConverged(value, committedDecisionId);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test('retry reconciles every evaluation projection interruption boundary', () => {
  const boundaries = [
    'decision-log',
    'attempt',
    'task',
    'requirements',
    'supervisor-decision-event-log',
    'supervisor-decision-event-file',
    'lifecycle-state',
    'pause-event-log',
    'pause-event-file',
  ];
  for (const boundary of boundaries) {
    const value = fixture({ pauseAfterCurrent: true });
    try {
      let committedDecision;
      assert.throws(() => evaluateTask(
        value.root,
        value.taskId,
        true,
        `committed rationale before ${boundary}`,
        {
          afterProjection(name, decision) {
            if (name !== boundary) return;
            committedDecision = decision;
            throw new Error(`injected interruption after ${boundary}`);
          },
        },
      ), new RegExp(`injected interruption after ${boundary}`));
      assert.ok(committedDecision);

      const retry = evaluateTask(
        value.root,
        value.taskId,
        false,
        `opposite retry after ${boundary}`,
      );
      assert.equal(retry.idempotent, true);
      assert.equal(retry.decision.decision, 'ACCEPT');
      assert.equal(retry.decision.rationale, `committed rationale before ${boundary}`);
      assertConverged(value, committedDecision.decision_id, { paused: true });

      const before = [
        readFileSync(value.p.decisionsLog, 'utf8'),
        readFileSync(value.p.eventsLog, 'utf8'),
        readFileSync(value.p.requirements, 'utf8'),
        readFileSync(value.p.state, 'utf8'),
      ];
      evaluateTask(value.root, value.taskId, false, 'another conflicting retry');
      assert.deepEqual([
        readFileSync(value.p.decisionsLog, 'utf8'),
        readFileSync(value.p.eventsLog, 'utf8'),
        readFileSync(value.p.requirements, 'utf8'),
        readFileSync(value.p.state, 'utf8'),
      ], before);
    } finally {
      rmSync(value.root, { recursive: true, force: true });
    }
  }
});

test('concurrent retries reconcile one interrupted evaluation without duplicates', async () => {
  const value = fixture();
  const gatePath = join(value.root, 'retry.start');
  const readyPaths = Array.from({ length: 4 }, (_, index) => join(value.root, `retry.${index}.ready`));
  const resultPaths = Array.from({ length: 4 }, (_, index) => join(value.root, `retry.${index}.result`));
  try {
    let committedDecisionId;
    assert.throws(() => evaluateTask(value.root, value.taskId, true, 'first immutable rationale', {
      afterEvaluationCommit(decision) {
        committedDecisionId = decision.decision_id;
        throw new Error('stop before projections');
      },
    }), /stop before projections/);

    const workers = readyPaths.map((readyPath, index) => (
      startWorker(value.root, value.taskId, readyPath, gatePath, resultPaths[index], index)
    ));
    await waitUntilReady(readyPaths);
    writeFileSync(gatePath, 'start\n');
    const results = await Promise.all(workers);
    results.forEach((result) => assert.equal(result.code, 0, result.stderr));
    resultPaths.map((path) => readJson(path)).forEach((result) => {
      assert.equal(result.idempotent, true);
      assert.equal(result.decision_id, committedDecisionId);
    });
    assertConverged(value, committedDecisionId);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test('retry preserves later requirement and lifecycle state', () => {
  const value = fixture();
  try {
    const first = evaluateTask(value.root, value.taskId, true, 'committed acceptance');
    const requirements = readJson(value.p.requirements);
    const requirement = requirements.requirements.find((entry) => entry.id === value.requirementId);
    requirement.state = 'VERIFIED';
    requirement.justification = 'later verification';
    writeJson(value.p.requirements, requirements);
    updateState(value.root, {
      active_task_id: 'task-later',
      active_attempt_id: 'task-later-attempt-001',
      pending_next_action: 'Monitor later work.',
      latest_unresolved_issue: 'later issue',
    });
    const beforeState = readFileSync(value.p.state, 'utf8');

    evaluateTask(value.root, value.taskId, false, 'must preserve the acceptance');

    assert.equal(readJson(value.p.requirements).requirements
      .find((entry) => entry.id === value.requirementId).state, 'VERIFIED');
    assert.equal(readFileSync(value.p.state, 'utf8'), beforeState);
    assert.equal(readJson(join(
      value.p.attempts,
      'supervisor-evaluations',
      `${value.attemptId}.json`,
    )).decision_id, first.decision.decision_id);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test('rejected evaluation and its pause event reconcile from committed rationale', () => {
  const value = fixture({ pauseAfterCurrent: true });
  try {
    let decisionId;
    assert.throws(() => evaluateTask(value.root, value.taskId, false, 'committed rejection', {
      afterProjection(name, decision) {
        if (name !== 'lifecycle-state') return;
        decisionId = decision.decision_id;
        throw new Error('stop after rejected lifecycle');
      },
    }), /stop after rejected lifecycle/);

    const retry = evaluateTask(value.root, value.taskId, true, 'conflicting acceptance');
    const state = readJson(value.p.state);
    const pauseEvents = jsonLines(value.p.eventsLog).filter((entry) => (
      entry.type === 'PAUSE_AFTER_CURRENT_APPLIED' && entry.decision_id === decisionId
    ));
    assert.equal(retry.decision.decision, 'REJECT');
    assert.equal(retry.decision.rationale, 'committed rejection');
    assert.equal(readJson(join(value.p.tasks, `${value.taskId}.json`)).state, 'REJECTED');
    assert.equal(readJson(value.p.requirements).requirements
      .find((entry) => entry.id === value.requirementId).state, 'UNSTARTED');
    assert.equal(state.latest_unresolved_issue, `Supervisor rejected ${value.taskId}: committed rejection`);
    assert.equal(state.pause.applied_decision_id, decisionId);
    assert.equal(pauseEvents.length, 1);
    assert.deepEqual(readJson(join(value.p.events, `${pauseEvents[0].event_id}.json`)), pauseEvents[0]);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test('reconciliation fails closed on a conflicting stable projection', () => {
  const value = fixture();
  try {
    const result = evaluateTask(value.root, value.taskId, true, 'immutable acceptance');
    const event = jsonLines(value.p.eventsLog).find((entry) => (
      entry.type === 'SUPERVISOR_DECISION' && entry.decision_id === result.decision.decision_id
    ));
    writeJson(join(value.p.events, `${event.event_id}.json`), { ...event, decision: 'REJECT' });

    assert.throws(() => evaluateTask(
      value.root,
      value.taskId,
      false,
      'must not repair by overwriting conflict',
    ), /conflicting evaluation event file/);
    assert.equal(jsonLines(value.p.eventsLog).filter((entry) => (
      entry.type === 'SUPERVISOR_DECISION' && entry.decision_id === result.decision.decision_id
    )).length, 1);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});
