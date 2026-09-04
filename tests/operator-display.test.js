import assert from 'node:assert/strict';
import test from 'node:test';
import {
  abbreviateIdentifier,
  deriveDisplayState,
  deriveSupervisorLiveness,
  formatDuration,
  formatRelativeTime,
  renderWakeStatus,
  selectWakeRecords,
} from '../src/operator-display.js';

test('human durations and relative times stay concise without hiding unknown values', () => {
  assert.equal(formatDuration(null), 'unknown');
  assert.equal(formatDuration(500), 'less than 1s');
  assert.equal(formatDuration(65_000), '1m 5s');
  assert.equal(formatDuration(7_380_000), '2h 3m');
  assert.equal(formatDuration(180_000_000), '2d 2h');
  assert.equal(formatRelativeTime('2026-09-02T11:58:55.000Z', Date.parse('2026-09-02T12:00:00.000Z')), '1m 5s ago');
  assert.equal(formatRelativeTime('2026-09-02T12:02:00.000Z', Date.parse('2026-09-02T12:00:00.000Z')), 'in 2m');
  assert.equal(formatRelativeTime('not-a-time'), 'unknown');
});

test('identifier abbreviations expand to a unique prefix and refuse ambiguous truncation', () => {
  const first = 'attempt-1234567890-aaaaaaaa';
  const second = 'attempt-1234567890-bbbbbbbb';
  assert.equal(abbreviateIdentifier(first, [first, second]), 'attempt-1234567890-aaaaaaaa');
  assert.equal(abbreviateIdentifier('supervisor-abcdef0123456789', ['supervisor-abcdef0123456789']), 'supervis…');
  assert.equal(abbreviateIdentifier('short-id', ['short-id']), 'short-id');
});

test('display state never reports a stale running child as active', () => {
  const supervisor = {
    supervisor_id: 'supervisor-one',
    authority_status: 'AUTHORITATIVE',
  };
  const state = {
    supervisor_state: 'DORMANT',
    phase: 'SELF_HOSTED',
    active_task_id: 'task-one',
    active_attempt_id: 'attempt-one',
    latest_unresolved_issue: null,
    pause: { active: false },
  };
  const task = { task_id: 'task-one', state: 'RUNNING' };
  const attempt = {
    task_id: 'task-one',
    attempt_id: 'attempt-one',
    claim_id: 'claim-one',
    fence_generation: 4,
    child_state: 'RUNNING',
    policy_snapshot: { supervisor_generation: 2 },
  };
  const claim = {
    schema: 'opsle.durable-supervisor.claim/v1',
    task_id: 'task-one',
    attempt_id: 'attempt-one',
    claim_id: 'claim-one',
    fence_generation: 4,
    owner_supervisor_id: 'supervisor-one',
    owner_generation: 2,
    status: 'ACTIVE',
  };
  const runner = {
    schema: 'opsle.durable-supervisor.detached-runner/v1',
    task_id: 'task-one',
    attempt_id: 'attempt-one',
    claim_id: 'claim-one',
    fence_generation: 4,
    supervisor_id: 'supervisor-one',
    supervisor_generation: 2,
    worker_pid: 42,
    status: 'OWNED',
  };
  const stale = deriveDisplayState({
    supervisor, state, task, attempt, claim, runner, processIsAlive: () => false,
  });
  assert.equal(stale.supervisor, 'ATTENTION');
  assert.equal(stale.child.label, 'UNKNOWN');
  assert.match(stale.reasons[0], /lacks current exact Runner/);

  const current = deriveDisplayState({
    supervisor, state, task, attempt, claim, runner, processIsAlive: (pid) => pid === 42,
  });
  assert.equal(current.supervisor, 'ACTIVE');
  assert.equal(current.child.label, 'RUNNING');
  assert.equal(current.attention, false);
});

test('lifecycle labels derive INITIALIZED, ACTIVE, IDLE, PAUSED, COMPLETE, and ATTENTION', () => {
  const supervisor = { authority_status: 'AUTHORITATIVE' };
  const emptyObjective = { current_revision: 0, history: [] };
  const objective = { current_revision: 1, history: [{ revision: 1, objective: 'Ship it.' }] };
  const base = {
    supervisor_state: 'ACTIVE',
    phase: 'ACTIVE',
    active_task_id: null,
    active_attempt_id: null,
    latest_unresolved_issue: null,
    pause: { active: false, after_current: false },
  };
  const derive = (state, options = {}) => deriveDisplayState({
    supervisor,
    state,
    objective: options.objective ?? objective,
    task: options.task ?? null,
    attempt: options.attempt ?? null,
  }).supervisor;

  assert.equal(derive({ ...base, phase: 'INITIALIZED' }, { objective: emptyObjective }), 'INITIALIZED');
  assert.equal(derive(base), 'IDLE');
  assert.equal(derive({ ...base, active_task_id: 'task-1', active_attempt_id: 'attempt-1' }, {
    task: { task_id: 'task-1', state: 'QUEUED' },
    attempt: { attempt_id: 'attempt-1', task_id: 'task-1', child_state: 'QUEUED' },
  }), 'ACTIVE');
  assert.equal(derive({
    ...base,
    supervisor_state: 'PAUSED',
    pause: { active: true, after_current: false },
  }), 'PAUSED');
  assert.equal(derive({ ...base, phase: 'COMPLETE' }), 'COMPLETE');
  assert.equal(derive({ ...base, latest_unresolved_issue: 'needs reconciliation' }), 'ATTENTION');
  assert.equal(derive(base, { objective }), 'IDLE');
  assert.equal(deriveDisplayState({
    supervisor,
    state: base,
    objective,
    task: null,
    attempt: null,
    wakeAttention: { actionable_count: 1 },
  }).supervisor, 'ATTENTION');
});

test('authoritative Herdr liveness does not depend on tmux', () => {
  assert.deepEqual(deriveSupervisorLiveness({
    authorityStatus: 'AUTHORITATIVE',
    herdr: { valid: true, classification: 'bound-authoritative-herdr' },
    tmuxAlive: false,
  }), { classification: 'alive', authority: 'herdr', reason: null });
  assert.deepEqual(deriveSupervisorLiveness({
    authorityStatus: 'AUTHORITATIVE',
    herdr: { valid: false, classification: 'stale', reasons: ['rollout-missing'] },
    tmuxAlive: false,
  }), { classification: 'unknown', authority: null, reason: 'rollout-missing' });
});

test('wake selection uses current authority and timestamps rather than array position', () => {
  const requests = [
    {
      event_id: 'event-obsolete-last-in-array',
      authoritative: false,
      classification: 'queued',
      queued_at: '2026-09-02T12:05:00.000Z',
    },
    {
      event_id: 'event-current-newer',
      authoritative: true,
      classification: 'queued',
      queued_at: '2026-09-02T12:04:00.000Z',
    },
    {
      event_id: 'event-current-older',
      authoritative: true,
      classification: 'native-ready',
      queued_at: '2026-09-02T12:01:00.000Z',
    },
  ];
  const selected = selectWakeRecords(requests);
  assert.equal(selected.current.event_id, 'event-current-newer');
  assert.equal(selected.latest.event_id, 'event-current-newer');
  assert.equal(selected.actionable_count, 2);
});

test('uncertain wake state and its actionable reason are prominent', () => {
  const output = renderWakeStatus({
    supervisor_generation: 3,
    dispatcher: null,
    session_binding: { classification: 'stale', valid: false },
    requests: [{
      event_id: 'event-uncertain',
      task_id: 'task-uncertain',
      attempt_id: 'attempt-uncertain',
      terminal_type: 'child-completed',
      authoritative: true,
      classification: 'queued',
      reason: 'activation-decision-uncertain',
      queued_at: '2026-09-02T11:59:00.000Z',
      decision: { status: 'UNCERTAIN' },
    }],
  }, { referenceTime: Date.parse('2026-09-02T12:00:00.000Z') });
  assert.match(output, /^ATTENTION: wake delivery is UNCERTAIN/m);
  assert.match(output, /reason: activation decision uncertain/);
  assert.match(output, /Queued: 1m ago/);
});
