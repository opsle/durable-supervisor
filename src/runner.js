import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { canonicalJson, id, now, readJson, sha256, writeJson } from './io.js';
import { emit, paths, updateState } from './state.js';
import { releaseClaim } from './pipeline.js';
import { applyWakeEvent, registerWait, terminalWakeType } from './wakeup.js';

const CONTEXT_PACKET_SCHEMA = 'opsle.durable-supervisor.context-firewall-packet/v2';
const BYTE_MEASUREMENT = Object.freeze({
  schema: 'opsle.durable-supervisor.context-firewall-byte-measurement/v1',
  compact_bytes_basis: 'canonical-json-utf8-with-derived-measurement-fields-null',
  serialized_packet_bytes_basis: 'canonical-json-utf8-with-16-digit-fixed-width-self-field',
});
const SERIALIZED_PACKET_BYTES_WIDTH = 16;
const TERMINATION_GRACE_MS = 1000;
const DERIVED_MEASUREMENT_FIELDS = [
  'compact_bytes',
  'retained_bytes',
  'suppressed_bytes',
  'retained_ratio',
  'reduction_ratio',
  'serialized_packet_bytes',
];

function snapshotFiles(root) {
  const ignored = new Set(['.git', 'node_modules', 'coverage', 'graphify-out']);
  const result = {};
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const path = join(directory, entry.name);
      const rel = relative(root, path);
      if (rel.startsWith('.opsle/')) {
        const protectedAuthority = new Set([
          '.opsle/specification.md',
          '.opsle/requirements.json',
          '.opsle/objective.json',
          '.opsle/policy.json',
          '.opsle/supervisor.json',
        ]);
        if (!protectedAuthority.has(rel)) continue;
      }
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) result[rel] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  }
  walk(root);
  return result;
}

function changedFiles(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((path) => before[path] !== after[path])
    .sort();
}

function matchesAuthorized(path, patterns) {
  return patterns.some((pattern) => {
    if (pattern.endsWith('/**')) return path.startsWith(pattern.slice(0, -3));
    return path === pattern || path.startsWith(`${pattern}/`);
  });
}

function childPrompt(task, attempt) {
  return [
    'You are a bounded implementation child, not the repository supervisor.',
    'The structured handoff below is authoritative. Do only this task.',
    'Do not change .opsle policy, objective, claims, supervisor identity, or sibling repositories.',
    'Do not deploy, merge, create a PR, launch another AI provider, or broaden scope.',
    'Inspect current repository state first and preserve existing work.',
    'Return a concise final report with changed files, verification, and unresolved issues.',
    '',
    JSON.stringify({
      schema: task.schema,
      task_id: task.task_id,
      attempt_id: attempt.attempt_id,
      objective: task.objective,
      scope: task.scope,
      authorization: task.authorization,
      required_inputs: task.required_inputs,
      relevant_context: task.relevant_context,
      expected_deliverable: task.expected_deliverable,
      expected_evidence: task.expected_evidence,
      acceptance_criteria: task.acceptance_criteria,
      prohibited_actions: task.prohibited_actions,
      operator_policy_constraints: task.operator_policy_constraints,
      claim: { claim_id: attempt.claim_id, fence_generation: attempt.fence_generation },
      policy_snapshot: attempt.policy_snapshot,
    }, null, 2),
  ].join('\n');
}

function runProcess({ command, args, cwd, stdoutPath, stderrPath, timeoutSeconds, onStart, onHeartbeat }) {
  return new Promise((resolvePromise) => {
    const stdout = createWriteStream(stdoutPath, { flags: 'wx', mode: 0o600 });
    const stderr = createWriteStream(stderrPath, { flags: 'wx', mode: 0o600 });
    const started = Date.now();
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.pipe(stdout, { end: false });
    child.stderr?.pipe(stderr, { end: false });
    if (Number.isInteger(child.pid)) onStart(child.pid);
    const heartbeat = Number.isInteger(child.pid)
      ? setInterval(() => onHeartbeat(child.pid), 2000)
      : null;
    let timedOut = false;
    let killEscalation = null;
    let settled = false;
    const finish = ({ code, signal, spawnError = null }) => {
      if (settled) return;
      settled = true;
      if (heartbeat) clearInterval(heartbeat);
      clearTimeout(timeout);
      if (killEscalation) clearTimeout(killEscalation);
      let pendingStreams = 2;
      const streamFinished = () => {
        pendingStreams -= 1;
        if (pendingStreams === 0) resolvePromise({
          code,
          signal,
          duration_ms: Date.now() - started,
          timed_out: timedOut,
          spawn_error: spawnError,
        });
      };
      stdout.end(streamFinished);
      stderr.end(streamFinished);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killEscalation = setTimeout(() => child.kill('SIGKILL'), TERMINATION_GRACE_MS);
    }, timeoutSeconds * 1000);
    child.once('error', (error) => finish({
      code: null,
      signal: null,
      spawnError: error.message,
    }));
    child.once('close', (code, signal) => finish({ code, signal }));
  });
}

function measurementProjection(packet) {
  const projection = structuredClone(packet);
  for (const field of DERIVED_MEASUREMENT_FIELDS) projection[field] = null;
  return projection;
}

export function measureContextPacket(packet) {
  if (packet.schema !== CONTEXT_PACKET_SCHEMA) {
    throw new Error(`unsupported Context Firewall packet measurement schema: ${packet.schema}`);
  }
  if (canonicalJson(packet.byte_measurement) !== canonicalJson(BYTE_MEASUREMENT)) {
    throw new Error('unsupported Context Firewall packet byte measurement basis');
  }
  if (!Number.isSafeInteger(packet.raw_bytes) || packet.raw_bytes < 0) {
    throw new Error('Context Firewall raw byte measurement must be a non-negative safe integer');
  }
  const measured = structuredClone(packet);
  const compactBytes = Buffer.byteLength(canonicalJson(measurementProjection(measured)));
  const suppressedBytes = Math.max(0, measured.raw_bytes - compactBytes);
  Object.assign(measured, {
    compact_bytes: compactBytes,
    retained_bytes: compactBytes,
    suppressed_bytes: suppressedBytes,
    retained_ratio: measured.raw_bytes === 0
      ? null
      : Number((compactBytes / measured.raw_bytes).toFixed(6)),
    reduction_ratio: measured.raw_bytes === 0
      ? null
      : Number((suppressedBytes / measured.raw_bytes).toFixed(6)),
    serialized_packet_bytes: '0'.repeat(SERIALIZED_PACKET_BYTES_WIDTH),
  });
  const serializedBytes = Buffer.byteLength(canonicalJson(measured));
  if (!Number.isSafeInteger(serializedBytes)
      || String(serializedBytes).length > SERIALIZED_PACKET_BYTES_WIDTH) {
    throw new Error('Context Firewall serialized packet byte measurement exceeds its fixed-width encoding');
  }
  measured.serialized_packet_bytes = String(serializedBytes)
    .padStart(SERIALIZED_PACKET_BYTES_WIDTH, '0');
  if (Buffer.byteLength(canonicalJson(measured)) !== serializedBytes) {
    throw new Error('Context Firewall serialized packet byte measurement is internally inconsistent');
  }
  return measured;
}

export function validateContextPacketMeasurement(packet, serializedBytes) {
  const expected = measureContextPacket(packet);
  if (canonicalJson(expected) !== canonicalJson(packet)) {
    throw new Error('Context Firewall packet measurement fields are internally inconsistent');
  }
  if (Number(packet.serialized_packet_bytes) !== serializedBytes) {
    throw new Error('Context Firewall serialized packet byte measurement does not match durable packet');
  }
  return true;
}

function contextPacket({ task, attempt, result, verification, changed, unexpected, rawRefs, lastMessagePath }) {
  const rawBytes = rawRefs.reduce((total, item) => total + item.bytes, 0);
  const rawOutputBytes = rawRefs
    .filter((item) => item.path.endsWith('/stdout.jsonl') || item.path.endsWith('/stderr.log'))
    .reduce((total, item) => total + item.bytes, 0);
  const claimedOutcome = existsSync(lastMessagePath)
    ? readFileSync(lastMessagePath, 'utf8').trim().slice(0, 4000)
    : '';
  const importantFacts = [
    `execution exit code ${result.code}`,
    `execution timed out ${result.timed_out}`,
    `${changed.length} files changed`,
    `${unexpected.length} unexpected files changed`,
    verification ? `verification exit code ${verification.code}` : 'verification not requested',
  ];
  const completeness = result.code === 0
    && unexpected.length === 0
    && (!verification || verification.code === 0)
    ? 'complete_for_decision'
    : 'requires_escalation';
  const base = {
    schema: CONTEXT_PACKET_SCHEMA,
    task_id: task.task_id,
    attempt_id: attempt.attempt_id,
    completeness,
    execution_status: result.code === 0 ? 'completed' : 'failed',
    claimed_outcome: claimedOutcome,
    important_facts: importantFacts,
    actual_changed_artifacts: changed,
    unexpected_changed_artifacts: unexpected,
    verification: verification ? {
      command: task.verification_command,
      exit_code: verification.code,
      duration_ms: verification.duration_ms,
    } : null,
    raw_evidence_references: rawRefs,
    raw_bytes: rawBytes,
    raw_output_bytes: rawOutputBytes,
    compact_bytes: null,
    retained_bytes: null,
    suppressed_bytes: null,
    retained_ratio: null,
    reduction_ratio: null,
    serialized_packet_bytes: null,
    byte_measurement: BYTE_MEASUREMENT,
    source_sha256: sha256(rawRefs.map((item) => `${item.path}:${item.sha256}`).join('\n')),
  };
  return measureContextPacket(base);
}

function rawReference(path, root) {
  const bytes = statSync(path).size;
  return { path: relative(root, path), bytes, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') };
}

export async function runAttempt(root, task, attempt, claim) {
  const p = paths(root);
  const attemptPath = join(p.attempts, `${attempt.attempt_id}.json`);
  const rawDirectory = join(p.raw, attempt.attempt_id);
  mkdirSync(rawDirectory, { recursive: true, mode: 0o700 });
  const stdoutPath = join(rawDirectory, 'stdout.jsonl');
  const stderrPath = join(rawDirectory, 'stderr.log');
  const lastMessagePath = join(rawDirectory, 'last-message.txt');
  const before = snapshotFiles(root);
  const policy = attempt.policy_snapshot;
  let command;
  let args;
  if (attempt.gearbox_route === 'codex') {
    command = attempt.policy_snapshot.gearbox_decision.discovery.commands.codex.path;
    args = [
      'exec',
      '--model', policy.model,
      '-c', `model_reasoning_effort="${policy.reasoning_effort}"`,
      '-c', 'approval_policy="never"',
      '--sandbox', 'workspace-write',
      '--cd', root,
      '--json',
      '--color', 'never',
      '--output-last-message', lastMessagePath,
      childPrompt(task, attempt),
    ];
  } else {
    [command, ...args] = task.deterministic_command;
  }
  const waitRegisteredAt = now();
  const processWindows = task.verification_command ? 2 : 1;
  const waitDeadlineAt = new Date(
    Date.parse(waitRegisteredAt)
      + (task.timeout_seconds * processWindows * 1000)
      + (TERMINATION_GRACE_MS * processWindows),
  ).toISOString();
  attempt.wait_registration = registerWait({
    waitId: attempt.attempt_id,
    taskId: task.task_id,
    attemptId: attempt.attempt_id,
    registeredAt: waitRegisteredAt,
    deadlineAt: waitDeadlineAt,
  });
  attempt.child_state = 'LAUNCHING';
  writeJson(attemptPath, attempt);
  emit(root, 'WAIT_REGISTERED', {
    task_id: task.task_id,
    attempt_id: attempt.attempt_id,
    wait_id: attempt.wait_registration.wait_id,
    deadline_at: waitDeadlineAt,
    eligible_automatic_wakes: [
      'child-completed',
      'child-failed',
      'child-timeout',
      'child-stall',
      'intervention-required',
    ],
  });
  updateState(root, { supervisor_state: 'DORMANT' });
  emit(root, 'RUNNER_LAUNCHING', { task_id: task.task_id, attempt_id: attempt.attempt_id, route: attempt.gearbox_route });
  const result = await runProcess({
    command,
    args,
    cwd: root,
    stdoutPath,
    stderrPath,
    timeoutSeconds: task.timeout_seconds,
    onStart(pid) {
      attempt.child_state = 'RUNNING';
      attempt.pid = pid;
      attempt.started_at = now();
      attempt.heartbeat_at = now();
      writeJson(attemptPath, attempt);
      claim.pid = pid;
      claim.heartbeat_at = attempt.heartbeat_at;
      writeJson(join(p.claims, `${claim.claim_id}.json`), claim);
      emit(root, 'CHILD_STARTED', { task_id: task.task_id, attempt_id: attempt.attempt_id, pid, wait_owner: 'runner-os' });
    },
    onHeartbeat(pid) {
      attempt.heartbeat_at = now();
      writeJson(attemptPath, attempt);
      claim.pid = pid;
      claim.heartbeat_at = attempt.heartbeat_at;
      writeJson(join(p.claims, `${claim.claim_id}.json`), claim);
    },
  });
  let verification = null;
  if (task.verification_command) {
    const verifyStdout = join(rawDirectory, 'verification.stdout.log');
    const verifyStderr = join(rawDirectory, 'verification.stderr.log');
    verification = await runProcess({
      command: task.verification_command[0],
      args: task.verification_command.slice(1),
      cwd: root,
      stdoutPath: verifyStdout,
      stderrPath: verifyStderr,
      timeoutSeconds: task.timeout_seconds,
      onStart() {},
      onHeartbeat() {},
    });
  }
  const executionPath = join(rawDirectory, 'execution.json');
  writeJson(executionPath, {
    schema: 'opsle.durable-supervisor.execution-evidence/v1',
    task_id: task.task_id,
    attempt_id: attempt.attempt_id,
    execution: {
      command: attempt.gearbox_route === 'deterministic' ? task.deterministic_command : ['codex', 'exec'],
      exit_code: result.code,
      signal: result.signal,
      duration_ms: result.duration_ms,
      timed_out: result.timed_out,
      spawn_error: result.spawn_error,
    },
    verification: verification ? {
      command: task.verification_command,
      exit_code: verification.code,
      signal: verification.signal,
      duration_ms: verification.duration_ms,
      timed_out: verification.timed_out,
      spawn_error: verification.spawn_error,
    } : null,
    recorded_at: now(),
  });
  const after = snapshotFiles(root);
  const changed = changedFiles(before, after);
  const unexpected = changed.filter((path) => !matchesAuthorized(path, task.authorization.may_modify));
  const rawFiles = [stdoutPath, stderrPath, lastMessagePath, executionPath];
  if (verification) rawFiles.push(join(rawDirectory, 'verification.stdout.log'), join(rawDirectory, 'verification.stderr.log'));
  const rawRefs = rawFiles.filter(existsSync).map((path) => rawReference(path, root));
  const packet = contextPacket({ task, attempt, result, verification, changed, unexpected, rawRefs, lastMessagePath });
  const packetPath = join(p.compact, `${attempt.attempt_id}.json`);
  writeJson(packetPath, packet);
  validateContextPacketMeasurement(packet, statSync(packetPath).size);
  const executionSucceeded = result.code === 0 && !result.timed_out;
  const changeExpectationSatisfied = task.expects_changes ? changed.length > 0 : changed.length === 0;
  const acceptanceSatisfied = packet.completeness === 'complete_for_decision'
    && executionSucceeded
    && unexpected.length === 0
    && (!task.verification_command || verification?.code === 0)
    && changeExpectationSatisfied;
  const completion = {
    schema: 'opsle.durable-supervisor.completion-handoff/v1',
    task_id: task.task_id,
    attempt_id: attempt.attempt_id,
    execution_status: executionSucceeded ? 'COMPLETED' : 'FAILED',
    claimed_outcome: packet.claimed_outcome,
    actual_changed_artifacts: changed,
    verification_performed: Boolean(verification),
    verification_result: verification ? { exit_code: verification.code, command: task.verification_command } : null,
    decision_relevant_findings: packet.important_facts,
    unresolved_issues: acceptanceSatisfied ? [] : ['Acceptance criteria lack sufficient deterministic evidence.'],
    warnings: unexpected.map((path) => `unexpected changed file: ${path}`),
    provenance: { source_sha256: packet.source_sha256, completed_at: now() },
    raw_evidence_references: rawRefs,
    compact_evidence_reference: relative(root, packetPath),
    policy_snapshot: attempt.policy_snapshot,
    claim: { claim_id: claim.claim_id, fence_generation: claim.fence_generation },
    evidence_distinction: {
      child_claim: packet.claimed_outcome,
      deterministic_observations: packet.important_facts,
      unknowns: packet.completeness === 'complete_for_decision' ? [] : ['packet requires bounded evidence escalation'],
    },
  };
  const completionPath = join(p.compact, `${attempt.attempt_id}.completion.json`);
  writeJson(completionPath, completion);
  attempt.child_state = executionSucceeded ? 'COMPLETED' : 'FAILED';
  attempt.completed_at = now();
  attempt.exit_code = result.code;
  attempt.raw_evidence = rawRefs;
  attempt.compact_packet = relative(root, packetPath);
  attempt.completion_handoff = relative(root, completionPath);
  attempt.telemetry = {
    execution_duration_ms: result.duration_ms,
    verification_duration_ms: verification?.duration_ms ?? null,
    raw_output_bytes: packet.raw_output_bytes,
    raw_evidence_bytes: packet.raw_bytes,
    compact_packet_bytes: Number(packet.serialized_packet_bytes),
    retained_bytes: packet.retained_bytes,
    suppressed_bytes: packet.suppressed_bytes,
    retained_ratio: packet.retained_ratio,
    reduction_ratio: packet.reduction_ratio,
    output_tokens: null,
    cost: null,
    activation_counts: {
      evidence: 'partial-local-events',
      total_automatic: null,
      terminal_event: 1,
      human: null,
      wait_induced_automatic: null,
    },
  };
  attempt.acceptance = {
    state: acceptanceSatisfied ? 'SATISFIED' : 'REJECTED',
    rationale: acceptanceSatisfied
      ? 'Predeclared exit, verification, changed-artifact, authorization, and packet-completeness criteria are satisfied.'
      : 'One or more predeclared deterministic acceptance criteria are not satisfied.',
    evaluated_at: now(),
    supervisor_decision_required: true,
  };
  writeJson(attemptPath, attempt);
  releaseClaim(root, claim, executionSucceeded ? 'COMPLETED' : 'FAILED');
  task.state = 'AWAITING_SUPERVISOR';
  writeJson(join(p.tasks, `${task.task_id}.json`), task);
  const wakeType = terminalWakeType({
    timedOut: result.timed_out,
    exitCode: result.code,
  });
  const completionEvent = emit(root, 'CHILD_COMPLETION', {
    task_id: task.task_id,
    attempt_id: attempt.attempt_id,
    wait_id: attempt.attempt_id,
    child_state: attempt.child_state,
    completion_handoff: attempt.completion_handoff,
    route: attempt.gearbox_route,
    provider: attempt.provider,
    execution_duration_ms: attempt.telemetry.execution_duration_ms,
    verification_duration_ms: attempt.telemetry.verification_duration_ms,
    raw_output_bytes: attempt.telemetry.raw_output_bytes,
    raw_evidence_bytes: attempt.telemetry.raw_evidence_bytes,
    compact_packet_bytes: attempt.telemetry.compact_packet_bytes,
    retained_bytes: attempt.telemetry.retained_bytes,
    suppressed_bytes: attempt.telemetry.suppressed_bytes,
    retained_ratio: attempt.telemetry.retained_ratio,
    reduction_ratio: attempt.telemetry.reduction_ratio,
    output_tokens: null,
    cost: null,
    terminal_type: wakeType,
    model_turns_used_for_polling: null,
    activation_counts: attempt.telemetry.activation_counts,
    wait_mechanism: 'runner OS close event with registered terminal wake',
  });
  attempt.wait_registration = applyWakeEvent(attempt.wait_registration, {
    event_id: completionEvent.event_id,
    wait_id: attempt.attempt_id,
    type: wakeType,
  });
  if (attempt.wait_registration.state !== 'READY') {
    throw new Error('terminal child event did not make the registered wait ready');
  }
  writeJson(attemptPath, attempt);
  const currentState = readJson(p.state);
  const pauseActive = currentState.pause?.active === true;
  const appliedAfterCurrent = pauseActive && currentState.pause.after_current === true;
  updateState(root, {
    supervisor_state: pauseActive ? 'PAUSED' : 'ACTIVE',
    pause: appliedAfterCurrent
      ? { ...currentState.pause, after_current: false, applied_at: now() }
      : currentState.pause,
  });
  if (appliedAfterCurrent) {
    emit(root, 'PAUSE_AFTER_CURRENT_APPLIED', {
      task_id: task.task_id,
      attempt_id: attempt.attempt_id,
      reason: currentState.pause.reason,
    });
  }
  emit(root, 'SUPERVISOR_ACTIVATION', {
    classification: 'terminal-event',
    automatic: true,
    cause_event_id: completionEvent.event_id,
    task_id: task.task_id,
    attempt_id: attempt.attempt_id,
    wait_id: attempt.attempt_id,
  });
  emit(root, 'SUPERVISOR_REACTIVATED', {
    cause_event_id: completionEvent.event_id,
    task_id: task.task_id,
    attempt_id: attempt.attempt_id,
    classification: 'terminal-event',
    resulting_state: pauseActive ? 'PAUSED' : 'ACTIVE',
  });
  return { attempt, packet, completion, completion_event: completionEvent };
}
