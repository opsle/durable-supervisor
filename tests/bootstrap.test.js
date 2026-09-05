import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createAttempt, createTask, routeTask } from '../src/pipeline.js';
import { readJson, writeJson } from '../src/io.js';
import { initialize, paths, repositoryRoot, validateDurableState } from '../src/state.js';
import { runAttempt } from '../src/runner.js';

const sourceRoot = resolve(new URL('..', import.meta.url).pathname);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'durable-supervisor-'));
  mkdirSync(join(root, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(root, '.git', 'refs', 'heads', 'main'), `${'1'.repeat(40)}\n`);
  writeFileSync(join(root, '.git', 'config'), [
    '[core]',
    '\trepositoryformatversion = 0',
    '[remote "origin"]',
    '\turl = https://example.invalid/fixture.git',
    '',
  ].join('\n'));
  writeFileSync(join(root, 'README.md'), '# fixture\n');
  mkdirSync(join(root, '.opsle'));
  cpSync(join(sourceRoot, '.opsle', 'specification.md'), join(root, '.opsle', 'specification.md'));
  cpSync(join(sourceRoot, '.opsle', 'requirements.json'), join(root, '.opsle', 'requirements.json'));
  initialize(root, { actor: 'test', objectiveText: 'Exercise the generic requirement matrix.' });
  return root;
}

function handoff(overrides = {}) {
  return {
    title: 'Create a bounded fixture artifact',
    objective: 'Create output.txt through a deterministic command.',
    scope: ['output.txt'],
    authorization: {
      may: ['inspect repository', 'create output.txt'],
      may_modify: ['output.txt'],
      may_not: ['modify .opsle policy', 'modify sibling repositories', 'deploy'],
    },
    required_inputs: [],
    relevant_context: [],
    expected_deliverable: 'output.txt containing ok',
    expected_evidence: ['process exit status', 'actual changed files'],
    acceptance_criteria: ['exit code 0', 'only output.txt changed'],
    prohibited_actions: ['provider fallback', 'deployment'],
    requirement_ids: ['DS-038'],
    route_hint: 'deterministic',
    deterministic_command: [process.execPath, '-e', "require('fs').writeFileSync('output.txt','ok\\n'); console.log('created output.txt')"],
    verification_command: [process.execPath, '-e', "process.exit(require('fs').readFileSync('output.txt','utf8')==='ok\\n'?0:1)"],
    ...overrides,
  };
}

test('initialization establishes one authoritative supervisor and validates', () => {
  const root = fixture();
  try {
    const p = paths(root);
    assert.equal(readJson(p.supervisor).authority_status, 'AUTHORITATIVE');
    assert.equal(readJson(p.policy).providers.codex.enabled, true);
    assert.equal(readJson(p.policy).providers.claude.enabled, false);
    assert.equal(readJson(p.policy).review.mode, 'off');
    assert.deepEqual(validateDurableState(root), { valid: true, errors: [] });
    assert.throws(() => initialize(root), /authoritative supervisor already exists/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('deterministic discovery feeds Gearbox and claim conflict fails closed', () => {
  const root = fixture();
  try {
    const task = createTask(root, handoff());
    const decision = routeTask(root, task);
    assert.equal(decision.selected_route, 'deterministic');
    const { attempt } = createAttempt(root, task, decision);
    assert.throws(() => createAttempt(root, task, decision), /claim conflict/);
    assert.match(attempt.attempt_id, /attempt-001$/);
    assert.equal(attempt.policy_snapshot.review.mode, 'off');
    assert.equal(attempt.policy_snapshot.providers.codex.enabled, true);
    assert.equal(attempt.policy_snapshot.providers.claude.enabled, false);
    assert.deepEqual(attempt.policy_snapshot.review, { mode: 'off', reviewer: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Runner waits, retains raw evidence, reduces a packet, and gates acceptance', async () => {
  const root = fixture();
  try {
    const task = createTask(root, handoff());
    const decision = routeTask(root, task);
    const { attempt, claim } = createAttempt(root, task, decision);
    const result = await runAttempt(root, task, attempt, claim);
    assert.equal(result.attempt.child_state, 'COMPLETED');
    assert.equal(result.attempt.acceptance.state, 'SATISFIED');
    assert.deepEqual(result.completion.actual_changed_artifacts, ['output.txt']);
    assert.equal(result.packet.completeness, 'complete_for_decision');
    assert.ok(result.packet.raw_bytes > 0);
    assert.ok(result.packet.raw_evidence_references.length >= 4);
    assert.equal(result.attempt.wait_registration.state, 'READY');
    assert.equal(result.attempt.wait_registration.wake.class, 'terminal-event');
    const events = readFileSync(paths(root).eventsLog, 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    const registeredIndex = events.findIndex((event) => event.type === 'WAIT_REGISTERED');
    const launchingIndex = events.findIndex((event) => event.type === 'RUNNER_LAUNCHING');
    assert.ok(registeredIndex >= 0);
    assert.ok(registeredIndex < launchingIndex);
    assert.equal(
      events.filter((event) => event.type === 'SUPERVISOR_ACTIVATION'
        && event.classification === 'terminal-event').length,
      1,
    );
    const completionEvent = events.find((event) => event.type === 'CHILD_COMPLETION');
    assert.equal(completionEvent.model_turns_used_for_polling, null);
    assert.equal(completionEvent.activation_counts.wait_induced_automatic, null);
    assert.equal(readFileSync(join(root, 'output.txt'), 'utf8'), 'ok\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('read-only acceptance records canonical zero tracked-file changes', async () => {
  const root = fixture();
  try {
    const task = createTask(root, handoff({
      task_id: 'task-read-only-clean-worktree',
      objective: 'Inspect without changing tracked files.',
      authorization: {
        may: ['inspect repository'],
        may_modify: [],
        may_not: ['modify tracked files', 'invoke a provider'],
      },
      expected_deliverable: 'Canonical tracked-file change count.',
      expected_evidence: ['tracked files changed = 0'],
      acceptance_criteria: ['tracked files changed = 0'],
      deterministic_command: [process.execPath, '-e', 'process.exit(0)'],
      verification_command: null,
      expects_changes: false,
    }));
    const decision = routeTask(root, task);
    const { attempt, claim } = createAttempt(root, task, decision);
    const result = await runAttempt(root, task, attempt, claim);
    assert.equal(result.attempt.acceptance.state, 'SATISFIED');
    assert.deepEqual(result.packet.actual_changed_artifacts, []);
    assert.ok(result.packet.important_facts.includes('tracked files changed = 0'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Runner timeout publishes a terminal wake and fails acceptance', async () => {
  const root = fixture();
  try {
    const task = createTask(root, handoff({
      task_id: 'task-timeout-fixture',
      deterministic_command: [
        process.execPath,
        '-e',
        'setTimeout(() => {}, 10000)',
      ],
      verification_command: null,
      timeout_seconds: 1,
      expects_changes: false,
      authorization: {
        may: ['wait for bounded timeout'],
        may_modify: [],
        may_not: ['invoke a provider'],
      },
    }));
    const decision = routeTask(root, task);
    const { attempt, claim } = createAttempt(root, task, decision);
    const result = await runAttempt(root, task, attempt, claim);
    assert.equal(result.attempt.child_state, 'FAILED');
    assert.equal(result.attempt.acceptance.state, 'REJECTED');
    assert.equal(result.attempt.wait_registration.state, 'READY');
    assert.equal(result.attempt.wait_registration.wake.type, 'child-timeout');
    const events = readFileSync(paths(root).eventsLog, 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(
      events.find((event) => event.type === 'CHILD_COMPLETION').terminal_type,
      'child-timeout',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('disabled Codex is ineligible and no hidden Claude fallback occurs', () => {
  const root = fixture();
  try {
    const p = paths(root);
    const policy = readJson(p.policy);
    policy.providers.codex.enabled = false;
    policy.providers.claude.enabled = false;
    policy.version += 1;
    writeJson(p.policy, policy);
    const task = createTask(root, handoff({
      route_hint: 'codex',
      deterministic_command: null,
      verification_command: null,
    }));
    assert.throws(() => routeTask(root, task), /no authorized, available, policy-permitted/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
