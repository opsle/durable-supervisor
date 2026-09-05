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

function fixture() {
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
  const requirementId = readJson(p.requirements).requirements[0].id;
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
  updateState(root, { active_task_id: taskId, active_attempt_id: attemptId });
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

test('interruption after the immutable commit cannot create a second decision', () => {
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
    assert.equal(committed.decision_id, committedDecisionId);
    assert.equal(jsonLines(value.p.decisionsLog).filter((entry) => entry.task_id === value.taskId).length, 0);
    assert.equal(jsonLines(value.p.eventsLog).filter((entry) => (
      entry.type === 'SUPERVISOR_DECISION' && entry.task_id === value.taskId
    )).length, 0);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});
