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
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { canonicalJson, id, now, readJson, sha256, writeJson } from './io.js';
import { emit, paths, updateState } from './state.js';
import { releaseClaim, validateTaskCommands } from './pipeline.js';
import {
  applyWakeEvent,
  enqueueTerminalWake,
  ensureWakeDispatcher,
  registerWait,
  terminalWakeType,
} from './wakeup.js';

const CONTEXT_PACKET_SCHEMA = 'opsle.durable-supervisor.context-firewall-packet/v2';
const BYTE_MEASUREMENT = Object.freeze({
  schema: 'opsle.durable-supervisor.context-firewall-byte-measurement/v1',
  compact_bytes_basis: 'canonical-json-utf8-with-derived-measurement-fields-null',
  serialized_packet_bytes_basis: 'canonical-json-utf8-with-16-digit-fixed-width-self-field',
});
const SERIALIZED_PACKET_BYTES_WIDTH = 16;
const TERMINATION_GRACE_MS = 1000;
const ELIGIBLE_DETACHED_REACTIVATION_EVENTS = Object.freeze([
  'child-completed',
  'child-failed',
  'child-timeout',
  'child-stall',
  'intervention-required',
]);
const DERIVED_MEASUREMENT_FIELDS = [
  'compact_bytes',
  'retained_bytes',
  'suppressed_bytes',
  'retained_ratio',
  'reduction_ratio',
  'serialized_packet_bytes',
];

export function detachedDormancyContract() {
  return {
    schema: 'opsle.durable-supervisor.detached-dormancy/v1',
    supervisor_action: 'END_TURN_IMMEDIATELY',
    supervisor_state: 'DORMANT',
    monitoring_owner: 'RUNNER_ONLY',
    runner_owned_monitoring: ['child', 'status', 'heartbeat', 'watch'],
    prohibited_automatic_supervisor_checks: ['child', 'status', 'heartbeat', 'watch', 'wait'],
    eligible_automatic_reactivation: {
      event_types: [...ELIGIBLE_DETACHED_REACTIVATION_EVENTS],
      queue: 'durable-wake-queue',
      transport: 'plain-codex-resume',
    },
  };
}

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

function prepareAttemptLaunch(root, task, attempt, mode, {
  pauseAfterCurrent = null,
} = {}) {
  const p = paths(root);
  const attemptPath = join(p.attempts, `${attempt.attempt_id}.json`);
  if (attempt.wait_registration || attempt.child_state !== 'QUEUED') {
    throw new Error(`attempt is not launchable: ${attempt.attempt_id} ${attempt.child_state}`);
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
  const detached = mode.startsWith('detached');
  if (detached) {
    attempt.wait_registration.detached_dormancy = detachedDormancyContract();
  }
  attempt.child_state = 'LAUNCHING';
  writeJson(attemptPath, attempt);
  emit(root, 'WAIT_REGISTERED', {
    task_id: task.task_id,
    attempt_id: attempt.attempt_id,
    wait_id: attempt.wait_registration.wait_id,
    deadline_at: waitDeadlineAt,
    eligible_automatic_wakes: [...ELIGIBLE_DETACHED_REACTIVATION_EVENTS],
    ...(detached ? {
      detached_dormancy: attempt.wait_registration.detached_dormancy,
    } : {}),
  });
  const armedPause = pauseAfterCurrent ? {
    active: true,
    after_current: true,
    reason: pauseAfterCurrent.reason,
    changed_at: now(),
  } : null;
  updateState(root, {
    supervisor_state: 'DORMANT',
    ...(armedPause ? { pause: armedPause } : {}),
  });
  const pauseEvent = armedPause ? emit(root, 'SUPERVISOR_PAUSED', {
    actor: pauseAfterCurrent.actor,
    source: 'task-run',
    after_current: true,
    requested_after_current: true,
    active_attempt_id: attempt.attempt_id,
    reason: armedPause.reason,
  }) : null;
  emit(root, 'RUNNER_LAUNCHING', {
    task_id: task.task_id,
    attempt_id: attempt.attempt_id,
    route: attempt.gearbox_route,
    launch_mode: mode,
  });
  return {
    attempt,
    pause_after_current: armedPause ? {
      armed: true,
      reason: armedPause.reason,
      event_id: pauseEvent.event_id,
    } : null,
  };
}

function workerDirectory(root) {
  const directory = join(paths(root).opsle, 'workers');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function workerPath(root, attemptId) {
  return join(workerDirectory(root), `${attemptId}.json`);
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function persistDetachedWorkerFailure(root, record, message) {
  const p = paths(root);
  if (record) {
    const failureMessage = record.status === 'FAILED' && record.failure
      ? record.failure
      : message;
    record.status = 'FAILED';
    record.failure = failureMessage;
    record.terminal_at ??= now();
    writeJson(workerPath(root, record.attempt_id), record);
    const attemptPath = join(p.attempts, `${record.attempt_id}.json`);
    if (existsSync(attemptPath)) {
      const attempt = readJson(attemptPath);
      if (!['COMPLETED', 'FAILED'].includes(attempt.child_state)) {
        attempt.child_state = 'UNKNOWN';
      }
      attempt.runner_failure ??= {
        schema: 'opsle.durable-supervisor.runner-failure/v1',
        runner_outcome: 'FAILED',
        child_outcome: attempt.child_state === 'UNKNOWN' ? 'UNKNOWN' : attempt.child_state,
        failure: failureMessage,
        worker_terminal_at: record.terminal_at,
        recorded_at: now(),
      };
      let intervention = record.intervention_event_id
        && existsSync(join(p.events, `${record.intervention_event_id}.json`))
        ? readJson(join(p.events, `${record.intervention_event_id}.json`))
        : null;
      if (!intervention) {
        intervention = emit(root, 'INTERVENTION_REQUIRED', {
          task_id: record.task_id,
          attempt_id: record.attempt_id,
          wait_id: record.attempt_id,
          terminal_type: 'intervention-required',
          runner_outcome: 'FAILED',
          child_outcome: attempt.runner_failure.child_outcome,
          reason: failureMessage,
        });
        record.intervention_event_id = intervention.event_id;
        writeJson(workerPath(root, record.attempt_id), record);
      }
      if (attempt.wait_registration) {
        attempt.wait_registration = applyWakeEvent(attempt.wait_registration, {
          event_id: intervention.event_id,
          wait_id: record.attempt_id,
          type: 'intervention-required',
        });
      }
      writeJson(attemptPath, attempt);
      updateState(root, {
        supervisor_state: 'PAUSED',
        pause: {
          active: true,
          after_current: false,
          reason: 'Detached Runner failed before terminal lifecycle publication.',
          changed_at: now(),
        },
        latest_unresolved_issue: {
          attempt_id: record.attempt_id,
          runner_outcome: 'FAILED',
          child_outcome: attempt.runner_failure.child_outcome,
          reason: failureMessage,
        },
      });
    }
  }
  return new Error(message);
}

export async function launchDetachedAttempt(root, task, attempt, claim, {
  handshakeTimeoutMs = 5000,
  workerScript = fileURLToPath(new URL('../bin/opsle-runner-worker.js', import.meta.url)),
  pauseAfterCurrent = null,
} = {}) {
  const prepared = prepareAttemptLaunch(root, task, attempt, 'detached', {
    pauseAfterCurrent,
  });
  const supervisor = readJson(paths(root).supervisor);
  const launchNonce = id('runner-launch');
  const recordPath = workerPath(root, attempt.attempt_id);
  const record = {
    schema: 'opsle.durable-supervisor.detached-runner/v1',
    task_id: task.task_id,
    attempt_id: attempt.attempt_id,
    claim_id: claim.claim_id,
    fence_generation: claim.fence_generation,
    supervisor_id: supervisor.supervisor_id,
    supervisor_generation: supervisor.generation,
    launch_nonce: launchNonce,
    launcher_pid: process.pid,
    worker_pid: null,
    status: 'SPAWNING',
    launched_at: now(),
    owned_at: null,
    terminal_at: null,
    failure: null,
  };
  writeJson(recordPath, record);
  let worker;
  try {
    worker = spawn(process.execPath, [
      workerScript,
      '--root', root,
      '--attempt', attempt.attempt_id,
      '--launch-nonce', launchNonce,
    ], { cwd: root, detached: true, stdio: 'ignore' });
    if (!Number.isInteger(worker.pid)) throw new Error('detached Runner did not receive a worker PID');
    record.worker_pid = worker.pid;
    record.status = 'LAUNCHED';
    writeJson(recordPath, record);
    worker.unref();
  } catch (error) {
    record.status = 'FAILED';
    record.failure = error.message;
    writeJson(recordPath, record);
    attempt.child_state = 'UNKNOWN';
    writeJson(join(paths(root).attempts, `${attempt.attempt_id}.json`), attempt);
    updateState(root, {
      supervisor_state: 'PAUSED',
      pause: { active: true, after_current: false, reason: 'Detached Runner launch failed.', changed_at: now() },
      latest_unresolved_issue: { attempt_id: attempt.attempt_id, reason: error.message },
    });
    throw error;
  }
  const deadline = Date.now() + handshakeTimeoutMs;
  while (Date.now() <= deadline) {
    const current = readJson(recordPath);
    if (['OWNED', 'TERMINAL'].includes(current.status)) {
      if (current.dormancy_contract?.supervisor_action !== 'END_TURN_IMMEDIATELY'
          || current.dormancy_contract?.monitoring_owner !== 'RUNNER_ONLY') {
        throw new Error('detached Runner ownership lacks the durable dormancy contract');
      }
      return {
        launch_mode: 'detached',
        action: 'END_TURN_IMMEDIATELY',
        task_id: task.task_id,
        attempt_id: attempt.attempt_id,
        child_state: readJson(join(paths(root).attempts, `${attempt.attempt_id}.json`)).child_state,
        worker_pid: current.worker_pid,
        ownership: current.status,
        monitoring_owner: 'RUNNER_ONLY',
        dormancy_contract: current.dormancy_contract,
        pause_after_current: prepared.pause_after_current,
      };
    }
    if (current.status === 'FAILED' || !processAlive(worker.pid)) {
      throw new Error(current.failure ?? 'detached Runner exited before durable ownership');
    }
    await sleep(20);
  }
  throw new Error('detached Runner did not establish durable ownership before handshake deadline');
}

export async function runDetachedWorker(root, attemptId, launchNonce, {
  runAttemptImpl = runAttempt,
  runAttemptOptions = {},
} = {}) {
  const p = paths(root);
  const recordPath = workerPath(root, attemptId);
  const deadline = Date.now() + 5000;
  let record;
  while (Date.now() <= deadline) {
    record = readJson(recordPath);
    if (record.worker_pid === process.pid) break;
    await sleep(10);
  }
  if (!record || record.worker_pid !== process.pid || record.launch_nonce !== launchNonce) {
    throw persistDetachedWorkerFailure(
      root,
      record,
      'detached Runner launch identity did not match durable record',
    );
  }
  const supervisor = readJson(p.supervisor);
  if (record.supervisor_id !== supervisor.supervisor_id
      || record.supervisor_generation !== supervisor.generation) {
    throw persistDetachedWorkerFailure(
      root,
      record,
      'detached Runner supervisor generation changed before ownership',
    );
  }
  const attemptPath = join(p.attempts, `${attemptId}.json`);
  const attempt = readJson(attemptPath);
  const task = readJson(join(p.tasks, `${attempt.task_id}.json`));
  const claim = readJson(join(p.claims, `${attempt.claim_id}.json`));
  if (claim.status !== 'ACTIVE'
      || claim.fence_generation !== attempt.fence_generation
      || claim.claim_id !== record.claim_id) {
    throw persistDetachedWorkerFailure(
      root,
      record,
      'detached Runner claim fence is not active and exact',
    );
  }
  record.status = 'OWNED';
  record.owned_at = now();
  record.dormancy_contract = attempt.wait_registration?.detached_dormancy;
  if (record.dormancy_contract?.supervisor_action !== 'END_TURN_IMMEDIATELY') {
    throw persistDetachedWorkerFailure(
      root,
      record,
      'detached Runner attempt lacks the durable dormancy contract',
    );
  }
  writeJson(recordPath, record);
  emit(root, 'DETACHED_RUNNER_OWNED', {
    task_id: task.task_id,
    attempt_id: attemptId,
    worker_pid: process.pid,
    claim_id: claim.claim_id,
    fence_generation: claim.fence_generation,
    supervisor_generation: record.supervisor_generation,
    supervisor_action: record.dormancy_contract.supervisor_action,
    monitoring_owner: record.dormancy_contract.monitoring_owner,
  });
  try {
    const result = await runAttemptImpl(root, task, attempt, claim, {
      prepared: true,
      detached: true,
      ...runAttemptOptions,
    });
    record.status = 'TERMINAL';
    record.terminal_at = now();
    writeJson(recordPath, record);
    return result;
  } catch (error) {
    throw persistDetachedWorkerFailure(root, record, error.message);
  }
}

export async function runAttempt(root, task, attempt, claim, {
  prepared = false,
  detached = false,
  failureInjection = null,
} = {}) {
  const p = paths(root);
  const attemptPath = join(p.attempts, `${attempt.attempt_id}.json`);
  validateTaskCommands(task);
  if (!prepared) prepareAttemptLaunch(root, task, attempt, detached ? 'detached-worker' : 'foreground-wait');
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
  const executionPath = join(rawDirectory, 'execution.json');
  const executionEvidence = {
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
    provider_process_terminated_at: now(),
    verification: null,
    post_processing_status: 'PENDING',
    recorded_at: now(),
  };
  writeJson(executionPath, executionEvidence);
  if (failureInjection === 'verification') {
    throw new Error('injected Runner failure before verification');
  }
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
  executionEvidence.verification = verification ? {
      command: task.verification_command,
      exit_code: verification.code,
      signal: verification.signal,
      duration_ms: verification.duration_ms,
      timed_out: verification.timed_out,
      spawn_error: verification.spawn_error,
    } : null;
  executionEvidence.post_processing_status = 'VERIFICATION_RECORDED';
  writeJson(executionPath, executionEvidence);
  if (failureInjection === 'reduction') {
    throw new Error('injected Runner failure before Context Firewall reduction');
  }
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
    activation_counts: detached ? {
      evidence: 'detached-runner-no-wait-cell',
      total_automatic: null,
      terminal_event: null,
      human: null,
      wait_induced_automatic: 0,
    } : {
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
  if (failureInjection === 'terminal-publication') {
    throw new Error('injected Runner failure before terminal event publication');
  }
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
    wait_mechanism: detached
      ? 'detached Runner worker OS close event; no initiating supervisor wait cell'
      : 'foreground compatibility Runner OS close event with registered terminal wake',
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
  const pauseAfterCurrentPending = pauseActive && currentState.pause.after_current === true;
  updateState(root, {
    supervisor_state: pauseAfterCurrentPending
      ? (detached ? 'DORMANT' : 'ACTIVE')
      : (pauseActive ? 'PAUSED' : (detached ? 'DORMANT' : 'ACTIVE')),
    pause: currentState.pause,
  });
  let wakeRequest = null;
  let wakeDispatcher = null;
  if (detached) {
    wakeRequest = enqueueTerminalWake(root, completionEvent);
    try {
      wakeDispatcher = ensureWakeDispatcher(root);
    } catch (error) {
      wakeDispatcher = { started: false, reason: 'dispatcher-start-error', error: error.message };
    }
  } else {
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
      resulting_state: pauseAfterCurrentPending ? 'ACTIVE' : (pauseActive ? 'PAUSED' : 'ACTIVE'),
    });
  }
  return {
    attempt,
    packet,
    completion,
    completion_event: completionEvent,
    wake_request: wakeRequest,
    wake_dispatcher: wakeDispatcher,
  };
}
