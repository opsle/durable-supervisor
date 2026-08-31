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
import { canonicalJson, readJson } from '../src/io.js';
import {
  emit,
  initialize,
  paths,
  updateState,
  validateDurableState,
} from '../src/state.js';
import {
  measureContextPacket,
  runAttempt,
  validateContextPacketMeasurement,
} from '../src/runner.js';

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
    assert.match(status.stdout, /^next: none$/m);
    assert.deepEqual(validateDurableState(root), { valid: true, errors: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pause after current lets the running child finish, then blocks the next launch', async () => {
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

    const completed = await running;
    assert.equal(completed.attempt.child_state, 'COMPLETED');
    assert.equal(readFileSync(join(root, 'task-delayed-child.txt'), 'utf8'), 'done\n');
    const after = readJson(p.state);
    assert.equal(after.supervisor_state, 'PAUSED');
    assert.equal(after.pause.active, true);
    assert.equal(after.pause.after_current, false);
    assert.ok(after.pause.applied_at);
    assert.equal(eventLines(root).filter((event) => event.type === 'PAUSE_AFTER_CURRENT_APPLIED').length, 1);

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

    const eventsBeforeWatch = readFileSync(p.eventsLog, 'utf8');
    const watch = await runCli(root, [
      'status',
      '--watch',
      '--iterations',
      '2',
      '--interval-ms',
      '1',
    ]);
    assert.equal(watch.code, 0, watch.stderr);
    assert.equal((watch.stdout.match(/STATUS SNAPSHOT/g) ?? []).length, 2);
    assert.match(watch.stdout, /output tokens: unknown/);
    assert.match(watch.stdout, /cost: unknown/);
    assert.equal(readFileSync(p.eventsLog, 'utf8'), eventsBeforeWatch);
    assert.equal(readJson(join(p.tasks, `${task.task_id}.json`)).attempts.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
