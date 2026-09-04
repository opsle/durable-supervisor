import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  cpSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import {
  createAttempt,
  createTask,
  routeTask,
} from '../src/pipeline.js';
import { canonicalJson, fileSha256, readJson, sha256, writeJson } from '../src/io.js';
import {
  emit,
  initialize,
  paths,
  setRequirements,
  updateState,
  validateDurableState,
} from '../src/state.js';
import {
  measureContextPacket,
  runAttempt,
  validateContextPacketMeasurement,
} from '../src/runner.js';
import { profileCodexActivations } from '../src/activation-telemetry.js';
import { WAKE_DISPATCHER_IMPLEMENTATION_SHA256 } from '../src/wakeup.js';

const sourceRoot = resolve(new URL('..', import.meta.url).pathname);
const cliPath = join(sourceRoot, 'bin', 'opsle.js');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'durable-supervisor-controls-'));
  mkdirSync(join(root, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(root, '.git', 'refs', 'heads', 'main'), `${'3'.repeat(40)}\n`);
  writeFileSync(join(root, '.git', 'config'), [
    '[core]',
    '\trepositoryformatversion = 0',
    '[remote "origin"]',
    '\turl = https://example.invalid/operator-controls-fixture.git',
    '',
  ].join('\n'));
  writeFileSync(join(root, 'README.md'), '# operator controls fixture\n');
  mkdirSync(join(root, '.opsle'));
  cpSync(join(sourceRoot, '.opsle', 'specification.md'), join(root, '.opsle', 'specification.md'));
  cpSync(join(sourceRoot, '.opsle', 'requirements.json'), join(root, '.opsle', 'requirements.json'));
  initialize(root, { actor: 'operator-controls-test' });
  return root;
}

function handoff(taskId, overrides = {}) {
  const output = `${taskId}.txt`;
  return {
    task_id: taskId,
    title: `Run deterministic ${taskId}`,
    objective: `Create ${output} without invoking a provider.`,
    scope: [output],
    authorization: {
      may: ['run a deterministic Node fixture'],
      may_modify: [output],
      may_not: ['invoke a provider', 'modify sibling repositories', 'deploy'],
    },
    required_inputs: [],
    relevant_context: [],
    expected_deliverable: `${output} containing done`,
    expected_evidence: ['process exit status', 'actual changed files'],
    acceptance_criteria: ['exit code 0', `only ${output} changed`],
    prohibited_actions: ['provider invocation', 'deployment'],
    requirement_ids: ['DS-022'],
    route_hint: 'deterministic',
    deterministic_command: [
      process.execPath,
      '-e',
      `require('fs').writeFileSync(${JSON.stringify(output)},'done\\n'); console.log('fixture output')`,
    ],
    verification_command: null,
    ...overrides,
  };
}

function runCli(root, args) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const capture = mkdtempSync(join(tmpdir(), 'durable-supervisor-cli-capture-'));
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

function satisfyFixtureRequirements(root) {
  const requirements = readJson(paths(root).requirements).requirements
    .filter((requirement) => ![
      'VERIFIED',
      'DEFERRED_WITH_JUSTIFICATION',
      'NOT_APPLICABLE_WITH_JUSTIFICATION',
    ].includes(requirement.state))
    .map((requirement) => requirement.id);
  if (requirements.length > 0) setRequirements(root, requirements, 'VERIFIED');
}

async function waitFor(check, message, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(5);
  }
  assert.fail(message);
}

test('Context Firewall byte measurement terminates at a legacy no-fixed-point boundary', () => {
  const legacy = {
    schema: 'opsle.durable-supervisor.context-firewall-packet/v1',
    raw_bytes: 1938,
    compact_bytes: null,
    retained_bytes: null,
    suppressed_bytes: null,
    retained_ratio: null,
    reduction_ratio: null,
    padding: 'x'.repeat(154),
  };
  const legacySizes = [];
  let legacyStable = false;
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const compactBytes = Buffer.byteLength(canonicalJson(legacy));
    const suppressedBytes = Math.max(0, legacy.raw_bytes - compactBytes);
    const retainedRatio = Number((compactBytes / legacy.raw_bytes).toFixed(6));
    const reductionRatio = Number((suppressedBytes / legacy.raw_bytes).toFixed(6));
    legacyStable = legacy.compact_bytes === compactBytes
      && legacy.retained_bytes === compactBytes
      && legacy.suppressed_bytes === suppressedBytes
      && legacy.retained_ratio === retainedRatio
      && legacy.reduction_ratio === reductionRatio;
    Object.assign(legacy, {
      compact_bytes: compactBytes,
      retained_bytes: compactBytes,
      suppressed_bytes: suppressedBytes,
      retained_ratio: retainedRatio,
      reduction_ratio: reductionRatio,
    });
    legacySizes.push(compactBytes);
    if (legacyStable) break;
  }
  assert.equal(legacyStable, false);
  assert.deepEqual(legacySizes.slice(-4), [365, 367, 365, 367]);

  const packet = {
    ...legacy,
    schema: 'opsle.durable-supervisor.context-firewall-packet/v2',
    byte_measurement: {
      schema: 'opsle.durable-supervisor.context-firewall-byte-measurement/v1',
      compact_bytes_basis: 'canonical-json-utf8-with-derived-measurement-fields-null',
      serialized_packet_bytes_basis: 'canonical-json-utf8-with-16-digit-fixed-width-self-field',
    },
    serialized_packet_bytes: null,
  };
  const first = measureContextPacket(packet);
  const second = measureContextPacket(packet);
  assert.deepEqual(first, second);
  assert.deepEqual(measureContextPacket(first), first);
  assert.equal(first.retained_bytes, first.compact_bytes);
  assert.equal(Number(first.serialized_packet_bytes), Buffer.byteLength(canonicalJson(first)));
  assert.equal(
    validateContextPacketMeasurement(first, Buffer.byteLength(canonicalJson(first))),
    true,
  );
  assert.throws(
    () => validateContextPacketMeasurement(first, Buffer.byteLength(canonicalJson(first)) + 1),
    /does not match durable packet/,
  );
  assert.throws(
    () => validateContextPacketMeasurement({
      ...first,
      compact_bytes: first.compact_bytes + 1,
    }, Buffer.byteLength(canonicalJson(first))),
    /measurement fields are internally inconsistent/,
  );
});

test('objective show/set preserves prior revisions and active-work redirect pauses for reconciliation', async () => {
  const root = fixture();
  try {
    const p = paths(root);
    const original = structuredClone(readJson(p.objective));
    const firstSet = await runCli(root, ['objective', 'set', '--text', 'First revised fixture objective.']);
    assert.equal(firstSet.code, 0, firstSet.stderr);

    const revised = readJson(p.objective);
    assert.equal(revised.current_revision, 2);
    assert.equal(revised.history.length, 2);
    assert.deepEqual(revised.history[0], original.history[0]);
    assert.equal(revised.history[1].objective, 'First revised fixture objective.');
    assert.equal(revised.history[1].changed_by, 'operator-cli');
    assert.equal(eventLines(root).filter((event) => event.type === 'OBJECTIVE_CHANGED').length, 1);

    const eventsBeforeShow = readFileSync(p.eventsLog, 'utf8');
    const shown = await runCli(root, ['objective', 'show']);
    assert.equal(shown.code, 0, shown.stderr);
    assert.ok(shown.stdout, JSON.stringify(shown));
    assert.deepEqual(JSON.parse(shown.stdout), revised);
    assert.equal(readFileSync(p.eventsLog, 'utf8'), eventsBeforeShow);

    const task = createTask(root, handoff('task-objective-redirect'));
    const decision = routeTask(root, task);
    createAttempt(root, task, decision);
    const secondSet = await runCli(root, ['objective', 'set', '--text', 'Second revised fixture objective.']);
    assert.equal(secondSet.code, 0, secondSet.stderr);

    const redirected = readJson(p.objective);
    const state = readJson(p.state);
    assert.equal(redirected.current_revision, 3);
    assert.deepEqual(redirected.history.slice(0, 2), revised.history);
    assert.equal(state.supervisor_state, 'PAUSED');
    assert.equal(state.pause.active, true);
    assert.equal(state.pause.after_current, false);
    assert.equal(state.latest_unresolved_issue.required, true);
    assert.equal(state.latest_unresolved_issue.task_id, task.task_id);
    assert.match(state.pending_next_action, /Reconcile task-objective-redirect/);
    const event = eventLines(root).filter((item) => item.type === 'OBJECTIVE_CHANGED').at(-1);
    assert.equal(event.objective_revision, 3);
    assert.equal(event.reconciliation.required, true);
    assert.deepEqual(validateDurableState(root), { valid: true, errors: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('terminal next action is derived, validated, and reopened by objective revision', async () => {
  const root = fixture();
  try {
    const p = paths(root);
    satisfyFixtureRequirements(root);
    updateState(root, {
      phase: 'COMPLETE',
      pending_next_action: 'Select the next unsatisfied requirement slice.',
    });
    assert.deepEqual(validateDurableState(root), {
      valid: false,
      errors: ['complete state with no unsatisfied requirements must not have a pending next action'],
    });

    const historical = emit(root, 'LEGACY_TERMINAL_STATE_OBSERVED', {
      pending_next_action: 'Select the next unsatisfied requirement slice.',
    });
    updateState(root, { pending_next_action: null });
    assert.deepEqual(validateDurableState(root), { valid: true, errors: [] });

    const revised = await runCli(root, [
      'objective',
      'set',
      '--text',
      'Perform bounded work after the completed fixture objective.',
    ]);
    assert.equal(revised.code, 0, revised.stderr);
    const state = readJson(p.state);
    assert.equal(state.phase, 'SELF_HOSTED');
    assert.equal(state.pending_next_action, 'Establish bounded work for objective revision 2.');
    assert.equal(readJson(join(p.events, `${historical.event_id}.json`)).pending_next_action,
      'Select the next unsatisfied requirement slice.');
    assert.deepEqual(validateDurableState(root), { valid: true, errors: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('accepted task cannot recreate an automatic next action after terminal completion', async () => {
  const root = fixture();
  try {
    const p = paths(root);
    satisfyFixtureRequirements(root);
    updateState(root, { phase: 'COMPLETE', pending_next_action: null });
    const task = createTask(root, handoff('task-terminal-acceptance', { requirement_ids: [] }));
    const decision = routeTask(root, task);
    const { attempt, claim } = createAttempt(root, task, decision);
    const completed = await runAttempt(root, task, attempt, claim);
    assert.equal(completed.packet.completeness, 'complete_for_decision');

    const evaluated = await runCli(root, [
      'task',
      'evaluate',
      task.task_id,
      '--accept',
      '--rationale',
      'terminal fixture evidence is complete',
    ]);
    assert.equal(evaluated.code, 0, evaluated.stderr);
    assert.equal(readJson(p.state).pending_next_action, null);
    const status = await runCli(root, ['status']);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /^Next: none$/m);
    assert.deepEqual(validateDurableState(root), { valid: true, errors: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('task evaluation fails closed until its delivered terminal wake is explicitly consumed', async () => {
  const root = fixture();
  try {
    const p = paths(root);
    const task = createTask(root, handoff('task-consume-before-evaluate', { requirement_ids: [] }));
    const decision = routeTask(root, task);
    const { attempt, claim } = createAttempt(root, task, decision);
    const completed = await runAttempt(root, task, attempt, claim);
    const eventId = completed.completion_event.event_id;
    const supervisor = readJson(p.supervisor);
    const deliveryId = 'delivery-consume-before-evaluate';
    const sessionId = '01a05952-e1fa-71e2-adea-df7e3f7d99ce';
    const bindingPath = join(p.opsle, 'wake', 'codex-session-binding.json');
    writeJson(bindingPath, {
      schema: 'opsle.durable-supervisor.codex-session-binding/v3',
      state: 'CURRENT',
      binding_id: 'binding-consume-before-evaluate',
      binding_revision: 1,
      repository_realpath: root,
      supervisor_id: supervisor.supervisor_id,
      supervisor_generation: supervisor.generation,
      codex_session_uuid: sessionId,
      codex_thread_uuid: sessionId,
      rollout: {
        realpath: join(root, 'rollout.jsonl'), device: 1, inode: 1,
        bound_size_bytes: 1, session_meta_line: 1,
        session_meta_session_id: sessionId,
        session_meta_repository_realpath: root,
        session_meta_line_sha256: 'a'.repeat(64),
        session_meta_payload_sha256: 'b'.repeat(64),
      },
      sessions_root_realpath: root,
      codex_cli_version: 'codex-cli fixture',
      uid: 1000,
      host: {
        kind: 'herdr', authority: 'authoritative', workspace_id: 'workspace-fixture',
        workspace_cwd: root, pane_id: 'pane-fixture', terminal_id: 'terminal-fixture',
        process: {
          pid: 700, start_time_ticks: '7000', executable: '/opt/codex', uid: 1000,
          tty: '/dev/pts/7', command_line_sha256: 'c'.repeat(64),
        },
      },
      authority_fence: { legacy_tmux_session: null },
      native_wake: {
        supported: true, transport: 'plain-codex-resume',
        confirmation: 'bound-rollout-exact-message-and-turn-began', reason: null,
      },
      supersedes_binding_sha256: null,
      bound_at: '2026-09-03T00:00:00.000Z',
    });
    const messageSha256 = sha256(`wake:${eventId}`);
    const activation = {
      schema: 'opsle.durable-supervisor.activation-decision/v1',
      decision_id: 'activation-consume-before-evaluate',
      event_id: eventId,
      supervisor_id: supervisor.supervisor_id,
      supervisor_generation: supervisor.generation,
      lease_id: 'lease-consume-before-evaluate',
      fencing_token: 1,
      message_sha256: messageSha256,
      transport_attempt_id: 'transport-consume-before-evaluate',
      delivery_id: deliveryId,
      status: 'DELIVERED',
    };
    writeJson(join(p.opsle, 'wake', 'activation-decisions', `${eventId}.json`), activation);
    writeJson(join(p.opsle, 'wake', 'requests', `${eventId}.json`), {
      schema: 'opsle.durable-supervisor.native-wake-request/v2',
      event_id: eventId,
      terminal_type: completed.completion_event.terminal_type,
      task_id: task.task_id,
      attempt_id: attempt.attempt_id,
      target: {
        repository: root,
        supervisor_id: supervisor.supervisor_id,
        supervisor_generation: supervisor.generation,
      },
      queue_version: 1,
    });
    writeJson(join(p.opsle, 'wake', 'deliveries', `${eventId}.json`), {
      schema: 'opsle.durable-supervisor.host-wake-delivery/v1',
      repository: root,
      delivery_id: deliveryId,
      event_id: eventId,
      queue_version: 1,
      supervisor_id: supervisor.supervisor_id,
      supervisor_generation: supervisor.generation,
      dispatcher_id: null,
      dispatcher_generation: null,
      dispatcher_implementation_sha256: WAKE_DISPATCHER_IMPLEMENTATION_SHA256,
      activation_lease_id: activation.lease_id,
      activation_fencing_token: activation.fencing_token,
      activation_decision_id: activation.decision_id,
      codex_session_binding_sha256: fileSha256(bindingPath),
      host_kind: 'herdr',
      native_transport: 'plain-codex-resume',
      codex_session_uuid: sessionId,
      message_sha256: messageSha256,
      transport_attempt_id: activation.transport_attempt_id,
      status: 'DELIVERED',
      delivered_at: '2026-09-03T00:00:00.000Z',
    });

    const blocked = await runCli(root, [
      'task', 'evaluate', task.task_id,
      '--accept', '--rationale', 'must not bypass consumption',
    ]);
    assert.equal(blocked.code, 1);
    assert.match(blocked.stderr, /delivered terminal wake must be consumed/);

    const consumed = await runCli(root, [
      'events', 'consume', eventId,
      '--delivery', deliveryId,
      '--generation', String(supervisor.generation),
    ]);
    assert.equal(consumed.code, 0, consumed.stderr);
    const evaluated = await runCli(root, [
      'task', 'evaluate', task.task_id,
      '--accept', '--rationale', 'delivery consumption is now durable',
    ]);
    assert.equal(evaluated.code, 0, evaluated.stderr);
    assert.equal(readJson(join(p.tasks, `${task.task_id}.json`)).state, 'ACCEPTED');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pause after current evaluates and terminalizes the task before PAUSED blocks the next launch', async () => {
  const root = fixture();
  try {
    const p = paths(root);
    const delayed = handoff('task-delayed-child', {
      deterministic_command: [
        process.execPath,
        '-e',
        "setTimeout(() => { require('fs').writeFileSync('task-delayed-child.txt','done\\n'); console.log('finished'); }, 400)",
      ],
    });
    const task = createTask(root, delayed);
    const decision = routeTask(root, task);
    const { attempt, claim } = createAttempt(root, task, decision);
    const running = runAttempt(root, task, attempt, claim);
    const attemptPath = join(p.attempts, `${attempt.attempt_id}.json`);
    await waitFor(
      () => readJson(attemptPath).child_state === 'RUNNING',
      'fixture child did not enter RUNNING',
    );

    const paused = await runCli(root, ['pause', '--after-current', '--reason', 'finish this fixture only']);
    assert.equal(paused.code, 0, paused.stderr);
    const during = readJson(p.state);
    assert.equal(during.pause.active, true);
    assert.equal(during.pause.after_current, true);
    assert.equal(readJson(attemptPath).child_state, 'RUNNING');
    assert.equal(eventLines(root).filter((event) => (
      event.type === 'SUPERVISOR_ACTIVATION'
      && event.classification === 'human'
      && event.interaction === 'pause'
    )).length, 1);

    const completed = await running;
    assert.equal(completed.attempt.child_state, 'COMPLETED');
    assert.equal(readFileSync(join(root, 'task-delayed-child.txt'), 'utf8'), 'done\n');
    const after = readJson(p.state);
    assert.equal(after.supervisor_state, 'ACTIVE');
    assert.equal(after.pause.active, true);
    assert.equal(after.pause.after_current, true);
    assert.equal(readJson(join(p.tasks, `${task.task_id}.json`)).state, 'AWAITING_SUPERVISOR');
    assert.equal(eventLines(root).filter((event) => event.type === 'PAUSE_AFTER_CURRENT_APPLIED').length, 0);

    const evaluated = await runCli(root, [
      'task', 'evaluate', task.task_id,
      '--accept', '--rationale', 'fixture evidence satisfies the bounded task',
    ]);
    assert.equal(evaluated.code, 0, evaluated.stderr);
    const terminal = readJson(p.state);
    assert.equal(readJson(join(p.tasks, `${task.task_id}.json`)).state, 'ACCEPTED');
    assert.equal(terminal.supervisor_state, 'PAUSED');
    assert.equal(terminal.pause.active, true);
    assert.equal(terminal.pause.after_current, false);
    assert.ok(terminal.pause.applied_at);
    const ordered = eventLines(root).map((event) => event.type);
    assert.ok(ordered.lastIndexOf('CHILD_COMPLETION') < ordered.lastIndexOf('SUPERVISOR_DECISION'));
    assert.ok(ordered.lastIndexOf('SUPERVISOR_DECISION') < ordered.lastIndexOf('PAUSE_AFTER_CURRENT_APPLIED'));

    const next = createTask(root, handoff('task-must-not-launch'));
    const blocked = await runCli(root, ['task', 'run', next.task_id]);
    assert.equal(blocked.code, 1);
    assert.ok(blocked.stderr, JSON.stringify(blocked));
    assert.match(blocked.stderr, /automatic progression is paused/);
    assert.deepEqual(readJson(join(p.tasks, `${next.task_id}.json`)).attempts, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pause after current is also applied only after an explicit rejection', async () => {
  const root = fixture();
  try {
    const p = paths(root);
    const task = createTask(root, handoff('task-rejected-before-pause', {
      deterministic_command: [
        process.execPath,
        '-e',
        "setTimeout(() => require('fs').writeFileSync('task-rejected-before-pause.txt','done\\n'), 200)",
      ],
    }));
    const route = routeTask(root, task);
    const { attempt, claim } = createAttempt(root, task, route);
    const running = runAttempt(root, task, attempt, claim);
    const attemptPath = join(p.attempts, `${attempt.attempt_id}.json`);
    await waitFor(() => readJson(attemptPath).child_state === 'RUNNING', 'rejection fixture did not run');
    assert.equal((await runCli(root, [
      'pause', '--after-current', '--reason', 'reject then pause',
    ])).code, 0);
    await running;
    assert.equal(readJson(p.state).pause.after_current, true);
    const evaluated = await runCli(root, [
      'task', 'evaluate', task.task_id,
      '--reject', '--rationale', 'fixture rejection',
    ]);
    assert.equal(evaluated.code, 0, evaluated.stderr);
    assert.equal(readJson(join(p.tasks, `${task.task_id}.json`)).state, 'REJECTED');
    const state = readJson(p.state);
    assert.equal(state.supervisor_state, 'PAUSED');
    assert.equal(state.pause.after_current, false);
    const ordered = eventLines(root).map((event) => event.type);
    assert.ok(ordered.lastIndexOf('SUPERVISOR_DECISION') < ordered.lastIndexOf('PAUSE_AFTER_CURRENT_APPLIED'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('bounded status watch is read-only and measured telemetry uses durable facts or unknowns', async () => {
  const root = fixture();
  try {
    const p = paths(root);
    const task = createTask(root, handoff('task-telemetry'));
    const decision = routeTask(root, task);
    const { attempt, claim } = createAttempt(root, task, decision);
    const completed = await runAttempt(root, task, attempt, claim);

    const packetPath = join(root, completed.attempt.compact_packet);
    assert.equal(completed.packet.completeness, 'complete_for_decision');
    assert.equal(completed.packet.schema, 'opsle.durable-supervisor.context-firewall-packet/v2');
    assert.equal(Number(completed.packet.serialized_packet_bytes), statSync(packetPath).size);
    assert.equal(validateContextPacketMeasurement(completed.packet, statSync(packetPath).size), true);
    assert.equal(
      completed.packet.raw_bytes,
      completed.packet.raw_evidence_references.reduce((sum, item) => sum + item.bytes, 0),
    );
    assert.equal(
      completed.packet.raw_output_bytes,
      completed.packet.raw_evidence_references
        .filter((item) => item.path.endsWith('/stdout.jsonl') || item.path.endsWith('/stderr.log'))
        .reduce((sum, item) => sum + item.bytes, 0),
    );

    const status = await runCli(root, ['status', '--json']);
    assert.equal(status.code, 0, status.stderr);
    assert.ok(status.stdout, JSON.stringify(status));
    const value = JSON.parse(status.stdout);
    assert.equal(value.active_work.route, 'deterministic');
    assert.equal(value.active_work.telemetry.execution_duration_ms, completed.attempt.telemetry.execution_duration_ms);
    assert.equal(value.active_work.telemetry.raw_output_bytes, completed.packet.raw_output_bytes);
    assert.equal(value.active_work.telemetry.raw_evidence_bytes, completed.packet.raw_bytes);
    assert.equal(
      value.active_work.telemetry.compact_packet_bytes,
      Number(completed.packet.serialized_packet_bytes),
    );
    assert.equal(value.active_work.telemetry.output_tokens, null);
    assert.equal(value.active_work.telemetry.cost, null);
    assert.equal(value.telemetry.measured_completion_count, 1);
    assert.equal(value.telemetry.unmeasured_completion_count, 0);
    assert.deepEqual(value.telemetry.activations, {
      evidence: 'partial-local-events',
      total_automatic: null,
      terminal_event: 1,
      human: null,
      wait_induced_automatic: null,
    });
    assert.equal(value.telemetry.model_polling_turns, null);
    assert.equal(value.telemetry.legacy_polling_field_trusted, false);

    const profile = profileCodexActivations([
      {
        timestamp: completed.attempt.started_at,
        type: 'response_item',
        payload: {
          type: 'custom_tool_call_output',
          output: [{ text: JSON.stringify({ session_id: 11 }) }],
        },
      },
      {
        timestamp: completed.attempt.completed_at,
        type: 'response_item',
        payload: { type: 'custom_tool_call' },
      },
    ], {
      start: completed.attempt.started_at,
      end: completed.attempt.completed_at,
      taskId: task.task_id,
      attemptId: completed.attempt.attempt_id,
      trajectoryEvidence: { path: '/fixture/trajectory.jsonl', sha256: 'a'.repeat(64) },
    });
    const profilePath = join(root, 'activation-profile.json');
    writeFileSync(profilePath, canonicalJson(profile));
    const imported = await runCli(root, [
      'telemetry',
      'import-activation-profile',
      '--input',
      profilePath,
    ]);
    assert.equal(imported.code, 0, imported.stderr);
    assert.equal(JSON.parse(imported.stdout).duplicate, false);
    const duplicate = await runCli(root, [
      'telemetry',
      'import-activation-profile',
      '--input',
      profilePath,
    ]);
    assert.equal(duplicate.code, 0, duplicate.stderr);
    assert.equal(JSON.parse(duplicate.stdout).duplicate, true);
    const profiledStatus = await runCli(root, ['status', '--json']);
    assert.deepEqual(JSON.parse(profiledStatus.stdout).telemetry.activations, {
      evidence: 'trajectory-profiled',
      total_automatic: 1,
      terminal_event: 0,
      human: 0,
      wait_induced_automatic: 1,
    });

    const eventsBeforeWatch = readFileSync(p.eventsLog, 'utf8');
    const watch = await runCli(root, [
      'status',
      '--watch',
      '--iterations',
      '2',
      '--interval-ms',
      '1',
      '--verbose',
    ]);
    assert.equal(watch.code, 0, watch.stderr);
    assert.equal((watch.stdout.match(/STATUS SNAPSHOT/g) ?? []).length, 2);
    assert.match(watch.stdout, /Output tokens: unknown/);
    assert.match(watch.stdout, /Cost: unknown/);
    assert.equal(readFileSync(p.eventsLog, 'utf8'), eventsBeforeWatch);
    assert.equal(readJson(join(p.tasks, `${task.task_id}.json`)).attempts.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('operator status commands separate concise, verbose, and JSON output', async () => {
  const root = fixture();
  try {
    const concise = await runCli(root, ['status']);
    assert.equal(concise.code, 0, concise.stderr);
    assert.ok(concise.stdout.trim().split('\n').length <= 10, concise.stdout);
    assert.match(concise.stdout, /^Supervisor: ATTENTION/m);
    assert.match(concise.stdout, /Herdr (snapshot unavailable|discovery requires)/);
    assert.doesNotMatch(concise.stdout, /Repository:|Tmux fallback:/);
    assert.doesNotMatch(concise.stdout, /^\s*\{/);

    const verbose = await runCli(root, ['status', '--verbose']);
    assert.equal(verbose.code, 0, verbose.stderr);
    assert.match(verbose.stdout, /SUPERVISOR DIAGNOSTICS/);
    assert.match(verbose.stdout, new RegExp(`Repository: ${root.replaceAll('/', '\\/')}`));
    assert.match(verbose.stdout, /Tmux fallback: .*unavailable/);

    const structured = await runCli(root, ['status', '--json']);
    assert.equal(structured.code, 0, structured.stderr);
    const statusValue = JSON.parse(structured.stdout);
    assert.equal(statusValue.supervisor.repository, root);
    assert.equal(statusValue.operator_state.supervisor, 'ATTENTION');
    assert.equal(statusValue.session_binding.classification, 'unbound');

    const policy = readJson(paths(root).policy);
    const policyHuman = await runCli(root, ['policy', 'status']);
    assert.equal(policyHuman.code, 0, policyHuman.stderr);
    assert.match(policyHuman.stdout, /^Policy: /);
    assert.deepEqual(JSON.parse((await runCli(root, ['policy', 'status', '--json'])).stdout), policy);

    const modelsHuman = await runCli(root, ['models', 'status']);
    assert.equal(modelsHuman.code, 0, modelsHuman.stderr);
    assert.match(modelsHuman.stdout, /^Models: /);
    assert.deepEqual(
      JSON.parse((await runCli(root, ['models', 'status', '--json'])).stdout),
      policy.providers,
    );

    const wakeHuman = await runCli(root, ['wake', 'status']);
    assert.equal(wakeHuman.code, 0, wakeHuman.stderr);
    assert.match(wakeHuman.stdout, /^Wake: clear/m);
    const wakeJson = JSON.parse((await runCli(root, ['wake', 'status', '--json'])).stdout);
    assert.ok(Array.isArray(wakeJson.requests));
    assert.deepEqual(wakeJson.status_summary, {
      current_event_id: null,
      latest_authoritative_event_id: null,
      actionable_count: 0,
      authoritative_count: 0,
    });

    const sessionHuman = await runCli(root, ['session', 'status']);
    assert.equal(sessionHuman.code, 0, sessionHuman.stderr);
    assert.match(sessionHuman.stdout, /^Herdr session: UNBOUND/m);

    const liveness = await runCli(root, ['supervisor', 'is-alive']);
    assert.equal(liveness.code, 1);
    assert.match(liveness.stdout, /^Supervisor: UNKNOWN/m);
    const livenessJson = await runCli(root, ['supervisor', 'is-alive', '--json']);
    assert.equal(livenessJson.code, 1);
    assert.equal(JSON.parse(livenessJson.stdout).classification, 'unknown');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
