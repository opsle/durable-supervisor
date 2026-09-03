import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
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
import test from 'node:test';
import { readJson, sha256, writeJson } from '../src/io.js';
import {
  EVIDENCE_OUTPUT_BYTE_CEILING,
  PACKET_BYTE_CEILING,
  PACKET_CHARACTER_CEILING,
  PACKET_TOKEN_BUDGET,
  RESUME_PACKET_SCHEMA,
  generateResumePacket,
  readResumeEvidence,
  readResumePacket,
} from '../src/reconstruction.js';
import { paths } from '../src/state.js';

const sourceRoot = resolve(new URL('..', import.meta.url).pathname);
const cliPath = join(sourceRoot, 'bin', 'opsle.js');
const LIVE_OBJECTIVE_740 = 'Make Durable Supervisor reconstruction extremely cheap by deriving a deterministic compact authoritative resume packet from full durable .opsle state, enforcing a normal <=1000 estimated or exactly measured model-input-token budget and deterministic size ceiling, exposing bounded escalation and provenance, instrumenting reconstruction, updating fresh-activation procedure to read only the packet in the normal case, preserving all history and the proven Herdr/Runner/wake/routing/fencing architecture, proving clean and escalation behavior including a fresh-context no-broad-scan live proof, running focused and full verification, continuing unmerged PR #1, verifying the exact new head in a fresh detached worktree, and finishing PAUSED.';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'durable-supervisor-reconstruction-'));
  mkdirSync(join(root, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(root, '.git', 'refs', 'heads', 'main'), `${'7'.repeat(40)}\n`);
  mkdirSync(join(root, '.opsle', 'tasks'), { recursive: true });
  mkdirSync(join(root, '.opsle', 'children'), { recursive: true });
  mkdirSync(join(root, '.opsle', 'claims'), { recursive: true });
  mkdirSync(join(root, '.opsle', 'wake', 'requests'), { recursive: true });
  mkdirSync(join(root, '.opsle', 'wake', 'deliveries'), { recursive: true });
  mkdirSync(join(root, '.opsle', 'wake', 'activation-decisions'), { recursive: true });
  writeJson(join(root, '.opsle', 'supervisor.json'), {
    schema: 'opsle.durable-supervisor.supervisor/v1',
    repository: root,
    supervisor_id: 'supervisor-reconstruction-fixture',
    generation: 3,
    authority_status: 'AUTHORITATIVE',
  });
  writeJson(join(root, '.opsle', 'state.json'), {
    schema: 'opsle.durable-supervisor.state/v1',
    supervisor_state: 'ACTIVE',
    phase: 'SELF_HOSTED',
    pause: { active: false, after_current: false, reason: null, changed_at: null },
    active_task_id: null,
    active_attempt_id: null,
    latest_accepted_task_id: null,
    latest_unresolved_issue: null,
    pending_next_action: 'Select the next bounded requirement slice.',
    processed_event_ids: [],
  });
  writeJson(join(root, '.opsle', 'objective.json'), {
    schema: 'opsle.durable-supervisor.objective/v1',
    objective_id: 'objective-reconstruction-fixture',
    current_revision: 1,
    history: [{ revision: 1, objective: 'Finish the bounded reconstruction objective.' }],
  });
  writeJson(join(root, '.opsle', 'policy.json'), {
    schema: 'opsle.durable-supervisor.policy/v1',
    version: 4,
    providers: {
      codex: { enabled: true, model: 'gpt-test', reasoning_effort: 'high' },
      claude: { enabled: false, model: null, reasoning_effort: null },
    },
    review: { mode: 'off', reviewer: null },
    gearbox: { required: true },
    model_polling: { permitted: false },
    affected_verification: { authority: 'advisory_only' },
  });
  writeJson(join(root, '.opsle', 'requirements.json'), {
    schema: 'opsle.durable-supervisor.requirements/v1',
    requirements: Array.from({ length: 101 }, (_, index) => ({
      id: `DS-${String(index).padStart(3, '0')}`,
      title: `Verified reconstruction fixture requirement ${index}`,
      state: 'VERIFIED',
      evidence: ['fixture'],
    })),
  });
  writeJson(join(root, '.opsle', 'claims', 'index.json'), {
    schema: 'opsle.durable-supervisor.claim-index/v1',
    next_fence: 2,
  });
  return root;
}

function currentSession(generation = 3) {
  return {
    classification: 'bound-authoritative-herdr',
    valid: true,
    supported: true,
    binding: {
      binding_id: 'binding-current',
      codex_session_uuid: '01999999-9999-7999-8999-999999999999',
      supervisor_id: 'supervisor-reconstruction-fixture',
      supervisor_generation: generation,
      host: {
        kind: 'herdr',
        authority: 'authoritative',
        workspace_id: 'workspace-current',
        process: { pid: 4321 },
      },
    },
  };
}

function addActiveWork(root, overrides = {}) {
  const taskId = 'task-active';
  const attemptId = 'task-active-attempt-001';
  const claimId = 'claim-active';
  const task = {
    schema: 'opsle.durable-supervisor.task-handoff/v1',
    task_id: taskId,
    title: 'Implement active reconstruction work',
    state: 'QUEUED',
    attempts: [attemptId],
    parent_objective_id: 'objective-reconstruction-fixture',
    parent_objective_revision: 1,
    supervisor_id: 'supervisor-reconstruction-fixture',
    ...overrides.task,
  };
  const attempt = {
    schema: 'opsle.durable-supervisor.child-attempt/v1',
    task_id: taskId,
    attempt_id: attemptId,
    child_state: 'RUNNING',
    claim_id: claimId,
    fence_generation: 1,
    gearbox_route: 'codex',
    policy_snapshot: {
      supervisor_generation: 3,
      claim_id: claimId,
      fence_generation: 1,
      gearbox_decision: {
        decision_id: 'gearbox-active',
        selected_route: 'codex',
      },
    },
    ...overrides.attempt,
  };
  const claim = {
    schema: 'opsle.durable-supervisor.claim/v1',
    task_id: taskId,
    attempt_id: attemptId,
    claim_id: claimId,
    fence_generation: 1,
    status: 'ACTIVE',
    owner_supervisor_id: 'supervisor-reconstruction-fixture',
    owner_generation: 3,
    ...overrides.claim,
  };
  writeJson(join(root, '.opsle', 'tasks', `${taskId}.json`), task);
  writeJson(join(root, '.opsle', 'children', `${attemptId}.json`), attempt);
  writeJson(join(root, '.opsle', 'claims', `${claimId}.json`), claim);
  const index = readJson(join(root, '.opsle', 'claims', 'index.json'));
  index[`task-${taskId}`] = { ...claim, ...overrides.indexedClaim };
  writeJson(join(root, '.opsle', 'claims', 'index.json'), index);
  const state = readJson(join(root, '.opsle', 'state.json'));
  state.active_task_id = taskId;
  state.active_attempt_id = attemptId;
  writeJson(join(root, '.opsle', 'state.json'), state);
  return { taskId, attemptId, claimId };
}

function addEvaluatedWork(root, {
  taskId,
  taskState,
  decision,
  evaluatedAt,
  objectiveRevision = 1,
}) {
  const attemptId = `${taskId}-attempt-001`;
  writeJson(join(root, '.opsle', 'tasks', `${taskId}.json`), {
    schema: 'opsle.durable-supervisor.task-handoff/v1',
    task_id: taskId,
    title: `Evaluated ${taskId}`,
    state: taskState,
    attempts: [attemptId],
    parent_objective_id: 'objective-reconstruction-fixture',
    parent_objective_revision: objectiveRevision,
    supervisor_id: 'supervisor-reconstruction-fixture',
  });
  writeJson(join(root, '.opsle', 'children', `${attemptId}.json`), {
    schema: 'opsle.durable-supervisor.child-attempt/v1',
    task_id: taskId,
    attempt_id: attemptId,
    child_state: 'COMPLETED',
    supervisor_evaluation: {
      decision_id: `decision-${taskId}`,
      decision,
      evaluated_at: evaluatedAt,
      rationale: `${decision} fixture rationale`,
    },
  });
}

function generate(root, options = {}) {
  return generateResumePacket(root, {
    persist: false,
    sessionStatus: currentSession(),
    ...options,
  });
}

function runCli(root, args, environment = {}) {
  const capture = mkdtempSync(join(tmpdir(), 'durable-supervisor-reconstruction-cli-'));
  const stdoutPath = join(capture, 'stdout.log');
  const stderrPath = join(capture, 'stderr.log');
  const stdout = openSync(stdoutPath, 'w');
  const stderr = openSync(stderrPath, 'w');
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'NODE_TEST_CONTEXT'));
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: root,
    env: { ...env, ...environment },
    stdio: ['ignore', stdout, stderr],
  });
  closeSync(stdout);
  closeSync(stderr);
  return {
    status: result.status,
    stdout: readFileSync(stdoutPath, 'utf8'),
    stderr: readFileSync(stderrPath, 'utf8'),
  };
}

test('clean packet is complete, authoritative, and within every deterministic budget', () => {
  const root = fixture();
  const { packet, serialized, telemetry } = generate(root);
  assert.equal(packet.schema, RESUME_PACKET_SCHEMA);
  assert.equal(packet.classification, 'complete_for_resume');
  assert.equal(packet.complete_for_resume, true);
  assert.equal(packet.repository, root);
  assert.deepEqual(packet.supervisor, {
    id: 'supervisor-reconstruction-fixture',
    generation: 3,
    authority: 'AUTHORITATIVE',
    state: 'ACTIVE',
    phase: 'SELF_HOSTED',
  });
  assert.equal(packet.herdr.status, 'current');
  assert.equal(packet.session_binding.classification, 'bound-authoritative-herdr');
  assert.equal(packet.objective.revision, 1);
  assert.equal(packet.policy.model_polling_permitted, false);
  assert.equal(packet.pause.active, false);
  assert.equal(packet.active_work, null);
  assert.equal(packet.unresolved, null);
  assert.equal(packet.next_action, 'Evaluate objective completion from the authoritative requirement state.');
  assert.ok(Buffer.byteLength(serialized) <= PACKET_BYTE_CEILING);
  assert.ok([...serialized].length <= PACKET_CHARACTER_CEILING);
  assert.ok(packet.budget.estimated_tokens <= PACKET_TOKEN_BUDGET);
  assert.ok(packet.budget.estimated_tokens >= 300 && packet.budget.estimated_tokens <= 700);
  assert.match(packet.budget.method, /ceil\(UTF-8_bytes\/4\)/);
  assert.ok(telemetry.durable_state_bytes_considered > packet.budget.packet_bytes);
  assert.equal(packet.evidence.authoritative.count, 6);
  assert.match(packet.evidence.authoritative.manifest_sha256, /^[a-f0-9]{64}$/);
  assert.equal(telemetry.escalation, false);
});

test('active and paused relationships are represented without inferred terminal state', () => {
  const root = fixture();
  addActiveWork(root);
  const active = generate(root).packet;
  assert.equal(active.classification, 'complete_for_resume');
  assert.deepEqual(active.active_work, {
    task_id: 'task-active',
    title: 'Implement active reconstruction work',
    task_state: 'QUEUED',
    attempt_id: 'task-active-attempt-001',
    child_state: 'RUNNING',
    claim_id: 'claim-active',
    claim_status: 'ACTIVE',
    fence_generation: 1,
    route: 'codex',
  });
  assert.equal(active.latest_relevant_decision.decision_id, 'gearbox-active');

  const state = readJson(join(root, '.opsle', 'state.json'));
  state.supervisor_state = 'DORMANT';
  state.pause = { active: true, after_current: true, reason: 'pause after current', changed_at: 'fixed' };
  writeJson(join(root, '.opsle', 'state.json'), state);
  const paused = generate(root).packet;
  assert.equal(paused.classification, 'complete_for_resume');
  assert.equal(paused.pause.after_current, true);
  assert.equal(paused.supervisor.state, 'DORMANT');
});

test('next action is derived for terminal evaluation, detached Runner monitoring, and PAUSED state', () => {
  const terminalRoot = fixture();
  const terminal = addActiveWork(terminalRoot, {
    task: { state: 'AWAITING_SUPERVISOR' },
    attempt: { child_state: 'COMPLETED' },
    claim: { status: 'RELEASED' },
  });
  const terminalState = readJson(join(terminalRoot, '.opsle', 'state.json'));
  terminalState.pending_next_action = 'Establish bounded work for stale objective text.';
  writeJson(join(terminalRoot, '.opsle', 'state.json'), terminalState);
  const awaiting = generate(terminalRoot).packet;
  assert.equal(awaiting.classification, 'complete_for_resume');
  assert.equal(awaiting.next_action, `Perform bounded supervisor evaluation of ${terminal.taskId}.`);

  const detachedRoot = fixture();
  const detached = addActiveWork(detachedRoot, {
    attempt: {
      wait_registration: {
        detached_dormancy: { monitoring_owner: 'RUNNER_ONLY' },
      },
    },
  });
  const detachedPacket = generate(detachedRoot).packet;
  assert.equal(
    detachedPacket.next_action,
    `No supervisor monitoring action; Runner exclusively monitors detached task ${detached.taskId}.`,
  );

  const pausedRoot = fixture();
  const pausedState = readJson(join(pausedRoot, '.opsle', 'state.json'));
  pausedState.supervisor_state = 'PAUSED';
  pausedState.pause = { active: true, after_current: false, reason: 'operator pause', changed_at: 'fixed' };
  pausedState.pending_next_action = 'This stale automatic action must not survive.';
  writeJson(join(pausedRoot, '.opsle', 'state.json'), pausedState);
  const paused = generate(pausedRoot).packet;
  assert.equal(paused.classification, 'complete_for_resume');
  assert.equal(paused.next_action, 'No automatic action while PAUSED; operator must explicitly resume.');
});

test('objective completion and terminal task state are validated', () => {
  const root = fixture();
  const state = readJson(join(root, '.opsle', 'state.json'));
  state.phase = 'COMPLETE';
  state.pending_next_action = null;
  writeJson(join(root, '.opsle', 'state.json'), state);
  assert.equal(generate(root).packet.objective.complete, true);

  addActiveWork(root, { task: { state: 'ACCEPTED' } });
  const contradictory = generate(root).packet;
  assert.equal(contradictory.classification, 'contradictory');
  assert.ok(contradictory.issues.includes('terminal-task-remains-active'));
});

test('uncertain wake attention requires bounded exact escalation evidence', () => {
  const root = fixture();
  const eventId = 'event-uncertain';
  writeJson(join(root, '.opsle', 'wake', 'requests', `${eventId}.json`), {
    schema: 'opsle.durable-supervisor.host-wake-request/v1',
    event_id: eventId,
    terminal_type: 'child-completed',
    target: {
      supervisor_id: 'supervisor-reconstruction-fixture',
      supervisor_generation: 3,
    },
  });
  writeJson(join(root, '.opsle', 'wake', 'activation-decisions', `${eventId}.json`), {
    schema: 'opsle.durable-supervisor.activation-decision/v1',
    event_id: eventId,
    status: 'UNCERTAIN',
    failure: 'confirmation-boundary-uncertain',
  });
  const { packet } = generate(root);
  assert.equal(packet.classification, 'requires_escalation');
  assert.equal(packet.wake_attention.uncertain, 1);
  assert.equal(packet.wake_attention.items[0].event_id, eventId);
  assert.deepEqual(packet.evidence.escalation.map((item) => item.path), [
    `.opsle/wake/activation-decisions/${eventId}.json`,
  ]);
  assert.equal(packet.next_action, 'Perform bounded reconciliation of the selected current-generation wake evidence.');
  assert.ok(packet.evidence.escalation.length <= 8);
});

test('receipt-free current-generation queued wake requires its exact request evidence', () => {
  const root = fixture();
  const eventId = 'event-queued';
  writeJson(join(root, '.opsle', 'wake', 'requests', `${eventId}.json`), {
    schema: 'opsle.durable-supervisor.host-wake-request/v1',
    event_id: eventId,
    terminal_type: 'intervention-required',
    target: {
      supervisor_id: 'supervisor-reconstruction-fixture',
      supervisor_generation: 3,
    },
  });
  const { packet } = generate(root);
  assert.equal(packet.classification, 'requires_escalation');
  assert.equal(packet.wake_attention.queued, 1);
  assert.ok(packet.issues.includes('queued-wake-activation'));
  assert.deepEqual(packet.evidence.escalation.map((item) => ({
    path: item.path,
    selector: item.selector,
  })), [{
    path: `.opsle/wake/requests/${eventId}.json`,
    selector: 'wake_request',
  }]);
});

test('wake reconstruction selects one current event and reports omitted attention within budget', () => {
  const root = fixture();
  for (let index = 0; index < 5; index += 1) {
    const eventId = `event-bounded-${index}`;
    writeJson(join(root, '.opsle', 'wake', 'requests', `${eventId}.json`), {
      schema: 'opsle.durable-supervisor.host-wake-request/v1',
      event_id: eventId,
      terminal_type: 'intervention-required',
      queued_at: `2026-09-03T00:00:0${index}.000Z`,
      target: {
        supervisor_id: 'supervisor-reconstruction-fixture',
        supervisor_generation: 3,
      },
    });
  }
  const { packet, serialized } = generate(root);
  assert.equal(packet.wake_attention.attention_count, 5);
  assert.equal(packet.wake_attention.selected_count, 1);
  assert.equal(packet.wake_attention.omitted_count, 4);
  assert.equal(packet.wake_attention.items[0].event_id, 'event-bounded-4');
  assert.ok(Buffer.byteLength(serialized) <= PACKET_BYTE_CEILING);
  assert.equal(packet.evidence.escalation.length, 1);
});

test('historically evaluated delivery without consumption is inert without rewriting evidence', () => {
  const root = fixture();
  addActiveWork(root);
  const statePath = join(root, '.opsle', 'state.json');
  const taskPath = join(root, '.opsle', 'tasks', 'task-active.json');
  const attemptPath = join(root, '.opsle', 'children', 'task-active-attempt-001.json');
  const state = readJson(statePath);
  state.active_task_id = null;
  state.active_attempt_id = null;
  state.latest_accepted_task_id = 'task-active';
  writeJson(statePath, state);
  const task = readJson(taskPath);
  task.state = 'ACCEPTED';
  writeJson(taskPath, task);
  const attempt = readJson(attemptPath);
  attempt.supervisor_evaluation = {
    decision_id: 'decision-historical',
    decision: 'ACCEPT',
    rationale: 'historical pre-consumption enforcement',
    evaluated_at: '2026-09-02T00:00:00.000Z',
  };
  writeJson(attemptPath, attempt);
  const eventId = 'event-historical-delivered';
  writeJson(join(root, '.opsle', 'wake', 'requests', `${eventId}.json`), {
    schema: 'opsle.durable-supervisor.native-wake-request/v2',
    event_id: eventId,
    task_id: 'task-active',
    attempt_id: 'task-active-attempt-001',
    terminal_type: 'child-completed',
    target: {
      supervisor_id: 'supervisor-reconstruction-fixture',
      supervisor_generation: 3,
    },
  });
  const deliveryPath = join(root, '.opsle', 'wake', 'deliveries', `${eventId}.json`);
  writeJson(deliveryPath, {
    schema: 'opsle.durable-supervisor.host-wake-delivery/v1',
    delivery_id: 'delivery-historical',
    event_id: eventId,
    supervisor_id: 'supervisor-reconstruction-fixture',
    supervisor_generation: 3,
    status: 'DELIVERED',
    consumed_at: null,
  });
  const before = readFileSync(deliveryPath);
  const packet = generate(root).packet;
  assert.equal(packet.wake_attention.attention_count, 0);
  assert.deepEqual(readFileSync(deliveryPath), before);
  assert.equal(existsSync(join(
    root, '.opsle', 'wake', 'consumptions', `${eventId}.json`,
  )), false);
});

test('claim and fence contradictions are explicit and never cleaned by inference', () => {
  const root = fixture();
  addActiveWork(root, { indexedClaim: { fence_generation: 99 } });
  const { packet } = generate(root);
  assert.equal(packet.classification, 'contradictory');
  assert.ok(packet.issues.includes('active-claim-fence-relationship-contradictory'));
  assert.equal(packet.active_work.fence_generation, 1);
  assert.ok(packet.evidence.escalation.some((item) => item.selector === 'task-task-active'));
});

test('stale Herdr/session binding escalates only its exact bounded record', () => {
  const root = fixture();
  const bindingPath = join(root, '.opsle', 'wake', 'codex-session-binding.json');
  const binding = {
    schema: 'opsle.durable-supervisor.codex-session-binding/v2',
    binding_id: 'binding-stale',
    codex_session_uuid: '01888888-8888-7888-8888-888888888888',
    supervisor_generation: 2,
    host: { kind: 'herdr', authority: 'authoritative', process: { pid: 111 } },
  };
  writeJson(bindingPath, binding);
  const stale = {
    classification: 'stale',
    valid: false,
    supported: false,
    reasons: ['herdr-host-process-dead-or-reused', 'supervisor-generation-stale'],
    binding,
  };
  const generated = generateResumePacket(root, { sessionStatus: stale });
  assert.equal(generated.packet.classification, 'requires_escalation');
  assert.equal(generated.packet.herdr.status, 'stale');
  assert.deepEqual(generated.packet.evidence.escalation.map((item) => item.path), [
    '.opsle/wake/codex-session-binding.json',
  ]);
  assert.equal(
    generated.packet.next_action,
    'Operator must perform bounded reconciliation of the authoritative Herdr/Codex session binding before automatic work resumes.',
  );
  const selected = readResumeEvidence(root, '.opsle/wake/codex-session-binding.json');
  assert.equal(selected.evidence.binding_id, 'binding-stale');
  assert.ok(selected.selected_bytes <= EVIDENCE_OUTPUT_BYTE_CEILING);
});

test('unbound Herdr/session authority fails closed with an explicit operator action', () => {
  const root = fixture();
  const { packet } = generateResumePacket(root, {
    persist: false,
    sessionStatus: {
      classification: 'unbound',
      valid: false,
      supported: true,
      reasons: ['binding-missing'],
      binding: null,
    },
  });
  assert.equal(packet.classification, 'requires_escalation');
  assert.equal(packet.complete_for_resume, false);
  assert.equal(packet.herdr.status, 'unbound');
  assert.ok(packet.issues.includes('codex-session-binding-unbound'));
  assert.equal(
    packet.next_action,
    'Operator must perform bounded reconciliation of the authoritative Herdr/Codex session binding before automatic work resumes.',
  );
});

test('latest rejected supervisor decision for the current objective outranks older acceptance', () => {
  const root = fixture();
  addEvaluatedWork(root, {
    taskId: 'task-old-accepted',
    taskState: 'ACCEPTED',
    decision: 'ACCEPT',
    evaluatedAt: '2026-09-02T10:00:00.000Z',
    objectiveRevision: 0,
  });
  addEvaluatedWork(root, {
    taskId: 'task-current-rejected',
    taskState: 'REJECTED',
    decision: 'REJECT',
    evaluatedAt: '2026-09-02T11:00:00.000Z',
  });
  const state = readJson(join(root, '.opsle', 'state.json'));
  state.latest_accepted_task_id = 'task-old-accepted';
  state.latest_unresolved_issue = 'Supervisor rejected task-current-rejected: bounded correction required.';
  state.pending_next_action = 'Stale accepted-task action.';
  writeJson(join(root, '.opsle', 'state.json'), state);

  const { packet } = generate(root);
  assert.equal(packet.classification, 'requires_escalation');
  assert.deepEqual(packet.latest_relevant_decision, {
    kind: 'supervisor_evaluation',
    decision_id: 'decision-task-current-rejected',
    decision: 'REJECT',
    task_id: 'task-current-rejected',
    evaluated_at: '2026-09-02T11:00:00.000Z',
  });
  assert.equal(packet.next_action, 'Perform bounded reconciliation using only the selected escalation evidence.');
});

test('the exact 740-character live objective is retained when the complete packet fits', () => {
  const root = fixture();
  assert.equal([...LIVE_OBJECTIVE_740].length, 740);
  const objective = readJson(join(root, '.opsle', 'objective.json'));
  objective.history[0].objective = LIVE_OBJECTIVE_740;
  writeJson(join(root, '.opsle', 'objective.json'), objective);

  const first = generate(root);
  const second = generate(root, { clock: () => 'different', timer: (() => {
    let value = 100;
    return () => { value += 7; return value; };
  })() });
  assert.equal(first.serialized, second.serialized);
  assert.equal(first.packet.classification, 'complete_for_resume');
  assert.equal(first.packet.objective.text, LIVE_OBJECTIVE_740);
  assert.equal(first.packet.objective.objective_compacted, false);
  assert.equal(first.packet.objective.source_sha256, undefined);
  assert.equal(first.packet.objective.source_reference, undefined);
  assert.ok(Buffer.byteLength(first.serialized) <= PACKET_BYTE_CEILING);
  assert.ok([...first.serialized].length <= PACKET_CHARACTER_CEILING);
  assert.ok(first.packet.budget.estimated_tokens <= PACKET_TOKEN_BUDGET);
});

test('oversize objective compaction is explicit, deterministic, and escalation-linked', () => {
  const root = fixture();
  const objective = readJson(join(root, '.opsle', 'objective.json'));
  const oversizedObjective = 'x'.repeat(200_000);
  objective.history[0].objective = oversizedObjective;
  writeJson(join(root, '.opsle', 'objective.json'), objective);
  const first = generate(root);
  const second = generate(root, { clock: () => 'different', timer: (() => {
    let value = 100;
    return () => { value += 7; return value; };
  })() });
  assert.equal(first.serialized, second.serialized);
  assert.equal(first.packet.classification, 'requires_escalation');
  assert.equal(first.packet.complete_for_resume, false);
  assert.equal(first.packet.requires_escalation, true);
  assert.ok(first.packet.issues.includes('objective-text-requires-bounded-escalation'));
  assert.equal(first.packet.objective.objective_compacted, true);
  assert.equal(first.packet.objective.source_sha256, sha256(oversizedObjective));
  assert.deepEqual(first.packet.objective.source_reference, {
    path: '.opsle/objective.json',
    selector: 'current_objective',
  });
  assert.deepEqual(first.packet.evidence.escalation.map((item) => ({
    path: item.path,
    selector: item.selector,
    reason: item.reason,
  })), [{
    path: '.opsle/objective.json',
    selector: 'current_objective',
    reason: 'objective-text-requires-bounded-escalation',
  }]);
  assert.match(first.packet.evidence.escalation[0].sha256, /^[a-f0-9]{64}$/);
  assert.ok(Buffer.byteLength(first.serialized) <= PACKET_BYTE_CEILING);
  assert.ok([...first.serialized].length <= PACKET_CHARACTER_CEILING);
  assert.ok(first.packet.budget.estimated_tokens <= PACKET_TOKEN_BUDGET);
  assert.doesNotMatch(first.serialized, /x{1000}/);
  assert.notEqual(first.telemetry.generated_at, second.telemetry.generated_at);
});

test('complete resume packets fence every decision-relevant authority change', () => {
  const cases = [
    ['objective', (root) => {
      const objective = readJson(join(root, '.opsle', 'objective.json'));
      objective.history[0].objective = 'Changed objective authority.';
      writeJson(join(root, '.opsle', 'objective.json'), objective);
      return {};
    }],
    ['task', (root) => {
      const task = readJson(join(root, '.opsle', 'tasks', 'task-active.json'));
      task.scope = ['changed-authority'];
      writeJson(join(root, '.opsle', 'tasks', 'task-active.json'), task);
      return {};
    }],
    ['decision', (root) => {
      const path = join(root, '.opsle', 'children', 'task-active-attempt-001.json');
      const attempt = readJson(path);
      attempt.policy_snapshot.gearbox_decision.decision_id = 'gearbox-replaced';
      writeJson(path, attempt);
      return {};
    }],
    ['pause', (root) => {
      const state = readJson(join(root, '.opsle', 'state.json'));
      state.pause = { active: true, after_current: true, reason: 'new pause', changed_at: 'later' };
      writeJson(join(root, '.opsle', 'state.json'), state);
      return {};
    }],
    ['unresolved', (root) => {
      const state = readJson(join(root, '.opsle', 'state.json'));
      state.latest_unresolved_issue = 'new unresolved authority';
      writeJson(join(root, '.opsle', 'state.json'), state);
      return {};
    }],
    ['wake', (root) => {
      writeJson(join(root, '.opsle', 'wake', 'requests', 'event-new.json'), {
        schema: 'opsle.durable-supervisor.host-wake-request/v1',
        event_id: 'event-new',
        terminal_type: 'intervention-required',
        target: { supervisor_id: 'supervisor-reconstruction-fixture', supervisor_generation: 3 },
      });
      return {};
    }],
    ['session binding', () => ({ sessionStatus: {
      ...currentSession(),
      binding: { ...currentSession().binding, binding_id: 'binding-replaced' },
    } })],
    ['supervisor generation', (root) => {
      const supervisor = readJson(join(root, '.opsle', 'supervisor.json'));
      supervisor.generation = 4;
      writeJson(join(root, '.opsle', 'supervisor.json'), supervisor);
      return { sessionStatus: currentSession(4) };
    }],
  ];

  for (const [label, mutate] of cases) {
    const root = fixture();
    try {
      addActiveWork(root);
      generateResumePacket(root, { sessionStatus: currentSession() });
      assert.equal(readResumePacket(root, { sessionStatus: currentSession() }).complete_for_resume, true);
      const options = mutate(root);
      assert.throws(
        () => readResumePacket(root, { sessionStatus: currentSession(), ...options }),
        /resume packet is stale/,
        label,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('resume freshness ignores telemetry-only timestamp changes', () => {
  const root = fixture();
  try {
    addActiveWork(root);
    generateResumePacket(root, { sessionStatus: currentSession() });
    const path = join(root, '.opsle', 'children', 'task-active-attempt-001.json');
    const attempt = readJson(path);
    attempt.telemetry = { updated_at: '2099-01-01T00:00:00.000Z' };
    writeJson(path, attempt);
    assert.equal(readResumePacket(root, { sessionStatus: currentSession() }).complete_for_resume, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fresh process consumes packet only and generation never ingests broad history', () => {
  const root = fixture();
  writeFileSync(join(root, '.opsle', 'events.jsonl'), 'not-json and intentionally broad\n'.repeat(10_000));
  writeFileSync(join(root, '.opsle', 'decisions.jsonl'), 'not-json and intentionally historical\n'.repeat(10_000));
  mkdirSync(join(root, '.opsle', 'evidence', 'raw'), { recursive: true });
  writeFileSync(join(root, '.opsle', 'evidence', 'raw', 'huge.txt'), 'raw-history\n'.repeat(10_000));

  const generated = runCli(root, ['resume-packet', 'generate']);
  assert.equal(generated.status, 0, generated.stderr);
  const packetBytes = readFileSync(paths(root).resumePacket, 'utf8');
  assert.equal(generated.stdout, packetBytes);
  const telemetry = readJson(paths(root).reconstructionTelemetry);
  assert.ok(!telemetry.durable_source_files_considered.some((path) => (
    path === '.opsle/events.jsonl'
      || path === '.opsle/decisions.jsonl'
      || path.startsWith('.opsle/evidence/raw/')
      || path === '.opsle/specification.md'
  )));

  const tracePath = join(root, 'packet-read-trace.txt');
  const preloadPath = join(root, 'trace-reads.cjs');
  writeFileSync(preloadPath, [
    "const fs = require('node:fs');",
    "const { syncBuiltinESMExports } = require('node:module');",
    "const original = fs.readFileSync;",
    "fs.readFileSync = function(path, ...args) {",
    "  if (String(path).includes('/.opsle/')) fs.appendFileSync(process.env.OPSLE_TRACE_PATH, `${path}\\n`);",
    "  return original.call(this, path, ...args);",
    "};",
    'syncBuiltinESMExports();',
    '',
  ].join('\n'));
  const consumed = runCli(root, ['resume-packet', 'show'], {
    NODE_OPTIONS: `--require=${preloadPath}`,
    OPSLE_TRACE_PATH: tracePath,
  });
  assert.equal(consumed.status, 0, consumed.stderr);
  assert.equal(consumed.stdout, packetBytes);
  assert.deepEqual(readFileSync(tracePath, 'utf8').trim().split('\n'), [paths(root).resumePacket]);
});
