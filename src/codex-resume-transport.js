import { spawn, spawnSync } from 'node:child_process';
import {
  accessSync,
  constants,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  watch,
} from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { canonicalJson, sha256 } from './io.js';

const BUSY_PATTERN = /already.*(?:running|busy)|active turn|turn.*in progress|session.*busy/i;
const REJECTION_PATTERN = /session.*(?:not found|invalid|rejected)|(?:invalid|unknown).*session/i;
const rolloutLineHashes = new WeakMap();
const MAX_CAPTURE_BYTES = 64 * 1024;

export const CODEX_RESUME_CONFIRMATION_TIMEOUT_MS = 120_000;
export const CODEX_RESUME_CLEANUP_TIMEOUT_MS = 5_000;
export const CODEX_RESUME_WORST_CASE_CLEANUP_TIMEOUT_MS = (
  CODEX_RESUME_CLEANUP_TIMEOUT_MS * 2
);

export function canonicalResumeArgv(sessionId, message) {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId ?? '') || typeof message !== 'string' || !message) {
    throw new Error('plain Codex resume requires a session UUID and message');
  }
  return ['codex', 'resume', sessionId, message];
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function detachedResumeLauncher(argv) {
  const command = argv.map(shellQuote).join(' ');
  return {
    command: '/bin/sh',
    args: [
      '-c',
      'tail -f /dev/null | TERM=xterm-256color script -qefc "$1" /dev/null',
      'opsle-codex-resume',
      command,
    ],
  };
}

function messageText(payload) {
  if (!Array.isArray(payload?.content)) return null;
  return payload.content.map((item) => item?.text ?? '').join('');
}

function itemMessageText(item) {
  if (!Array.isArray(item?.content)) return null;
  return item.content.map((part) => part?.text ?? '').join('');
}

export function rolloutAcceptance(records, {
  sessionId,
  message,
  baselineOrdinal,
}) {
  const after = records.filter((record) => (
    Number.isSafeInteger(record?.ordinal) && record.ordinal > baselineOrdinal
  ));
  const accepted = after.filter((record) => (
    record.type === 'response_item'
    && record.payload?.type === 'message'
    && record.payload?.role === 'user'
    && messageText(record.payload) === message
  ));
  const began = after.filter((record) => (
    record.type === 'event_msg'
    && record.payload?.type === 'item_completed'
    && record.payload?.thread_id === sessionId
    && record.payload?.item?.type === 'UserMessage'
    && itemMessageText(record.payload.item) === message
    && typeof record.payload?.turn_id === 'string'
    && Number.isSafeInteger(record.payload?.started_at_ms)
  ));
  if (accepted.length > 1 || began.length > 1) {
    return { classification: 'ambiguous', reason: 'duplicate-rollout-acceptance-evidence' };
  }
  if (accepted.length !== 1 || began.length !== 1) return null;
  const acceptedTurn = accepted[0].payload?.internal_chat_message_metadata_passthrough?.turn_id;
  if (typeof acceptedTurn !== 'string' || acceptedTurn !== began[0].payload.turn_id) {
    return { classification: 'ambiguous', reason: 'rollout-turn-identity-mismatch' };
  }
  return {
    classification: 'confirmed',
    accepted_ordinal: accepted[0].ordinal,
    accepted_record_sha256: rolloutLineHashes.get(accepted[0])
      ?? sha256(JSON.stringify(accepted[0])),
    turn_began_ordinal: began[0].ordinal,
    turn_began_record_sha256: rolloutLineHashes.get(began[0])
      ?? sha256(JSON.stringify(began[0])),
    turn_id: began[0].payload.turn_id,
    turn_started_at_ms: began[0].payload.started_at_ms,
  };
}

export function rolloutRecords(path) {
  const bytes = readFileSync(path);
  const records = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    const line = bytes.subarray(start, index + 1);
    start = index + 1;
    if (line.length === 1) continue;
    const record = JSON.parse(line.toString('utf8'));
    rolloutLineHashes.set(record, sha256(line));
    records.push(record);
  }
  return records;
}

function highestOrdinal(records) {
  return records.reduce((highest, record) => (
    Number.isSafeInteger(record?.ordinal) ? Math.max(highest, record.ordinal) : highest
  ), -1);
}

export function boundRolloutActivity(path) {
  const records = rolloutRecords(path);
  const lifecycle = records.filter((record) => (
    record?.type === 'event_msg'
    && ['task_started', 'task_complete'].includes(record?.payload?.type)
    && Number.isSafeInteger(record?.ordinal)
  ));
  const latest = lifecycle.at(-1) ?? null;
  return {
    classification: latest?.payload?.type === 'task_started' ? 'busy' : 'not-known-busy',
    latest_ordinal: latest?.ordinal ?? highestOrdinal(records),
    latest_type: latest?.payload?.type ?? null,
    turn_id: typeof latest?.payload?.turn_id === 'string' ? latest.payload.turn_id : null,
  };
}

export function rolloutConfirmation(path, options) {
  return rolloutAcceptance(rolloutRecords(path), options);
}

function resolvedExecutable(command, env = process.env) {
  const candidates = command.includes('/')
    ? [resolve(command)]
    : String(env.PATH ?? '').split(delimiter).filter(Boolean).map((entry) => join(entry, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Continue through the exact PATH search order.
    }
  }
  return null;
}

export function codexExecutableEvidence(command = 'codex', env = process.env) {
  const executable = resolvedExecutable(command, env);
  if (!executable) return { requested: command, resolved: null, version: null, version_error: 'not-found-on-path' };
  const version = spawnSync(executable, ['--version'], {
    encoding: 'utf8',
    env,
    timeout: 5_000,
    maxBuffer: 16 * 1024,
  });
  return {
    requested: command,
    resolved: executable,
    version: version.status === 0 ? version.stdout.trim() : null,
    version_error: version.status === 0
      ? null
      : (version.error?.message ?? version.stderr?.trim() ?? `exit-${version.status}`),
  };
}

export function sanitizedEnvironmentEvidence(env = process.env) {
  const entries = Object.entries(env ?? {}).sort(([left], [right]) => left.localeCompare(right));
  const selected = Object.fromEntries(entries.filter(([key]) => (
    ['PATH', 'TERM', 'LANG', 'LC_ALL', 'SHELL'].includes(key)
  )));
  return {
    fingerprint_sha256: sha256(canonicalJson(entries)),
    key_names: entries.map(([key]) => key),
    selected,
  };
}

function publicProcessIdentity(row) {
  if (!row || !Number.isSafeInteger(row.pid) || row.pid <= 0) return null;
  return {
    pid: row.pid,
    process_group: positiveProcessGroup(row.pgrp) ? row.pgrp : null,
    start_time_ticks: row.start_time_ticks ?? null,
    executable: row.executable ?? null,
    command_line_sha256: Array.isArray(row.command_line)
      ? sha256(canonicalJson(row.command_line))
      : null,
  };
}

function processRows(procRoot = '/proc') {
  const rows = [];
  for (const name of readdirSync(procRoot)) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(join(procRoot, name, 'stat'), 'utf8');
      const close = stat.lastIndexOf(') ');
      if (close < 0) continue;
      const fields = stat.slice(close + 2).trim().split(/\s+/);
      rows.push({
        pid: Number(name),
        pgrp: Number(fields[2]),
        start_time_ticks: fields[19],
        executable: readlinkSync(join(procRoot, name, 'exe')),
        command_line: readFileSync(join(procRoot, name, 'cmdline')).toString('utf8').split('\0').filter(Boolean),
      });
    } catch {
      // Processes may exit during the read-only scan.
    }
  }
  return rows;
}

function hostProcessIdentity(pid, procRoot = '/proc') {
  return processRows(procRoot).find((row) => row.pid === pid) ?? null;
}

export function resumeFrontendProcesses(sessionId, message, procRoot = '/proc') {
  return processRows(procRoot).filter((row) => {
    const resume = row.command_line.indexOf('resume');
    return resume >= 0
      && row.command_line[resume + 1] === sessionId
      && row.command_line[resume + 2] === message;
  });
}

function processGroupMembers(processGroup, procRoot = '/proc') {
  return processRows(procRoot).filter((row) => row.pgrp === processGroup);
}

function positiveProcessGroup(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function processIdentityKey(row) {
  if (!Number.isSafeInteger(row?.pid) || row.pid <= 0
      || typeof row?.start_time_ticks !== 'string' || !row.start_time_ticks) {
    return null;
  }
  return `${row.pid}:${row.start_time_ticks}`;
}

function sameHostProcess(left, right) {
  return left && right
    && left.pid === right.pid
    && left.start_time_ticks === right.start_time_ticks
    && left.executable === right.executable;
}

function sortedProcessGroups(groups) {
  return [...groups].sort((left, right) => left - right);
}

function boundedOutput(buffer, chunk) {
  const next = Buffer.concat([buffer, Buffer.from(chunk)]);
  return next.length <= 64 * 1024 ? next : next.subarray(next.length - (64 * 1024));
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer;
    const finish = (value) => {
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    child.once('exit', onExit);
    timer = setTimeout(() => finish(false), timeoutMs);
  });
}

export async function runCodexResumeTransport({
  sessionId,
  message,
  rolloutPath,
  attemptEvidence = null,
  checkpointEvidence = null,
  commitConfirmation = null,
  completeCommittedDelivery = null,
  confirmationTimeoutMs = CODEX_RESUME_CONFIRMATION_TIMEOUT_MS,
  cleanupTimeoutMs = CODEX_RESUME_CLEANUP_TIMEOUT_MS,
  cwd = process.cwd(),
  env = process.env,
  spawnProcess = spawn,
  watchFactory = watch,
  killProcess = process.kill.bind(process),
  inspectFrontends = resumeFrontendProcesses,
  inspectProcessGroup = processGroupMembers,
  authoritativeHostProcess = null,
  inspectHostProcess = hostProcessIdentity,
  scheduleTimeout = setTimeout,
  cancelTimeout = clearTimeout,
  inspectExecutable = codexExecutableEvidence,
  nowMs = Date.now,
  cleanupDelay = (milliseconds) => new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  }),
}) {
  const argv = canonicalResumeArgv(sessionId, message);
  const launcher = detachedResumeLauncher(argv);
  const baselineRecords = rolloutRecords(rolloutPath);
  const baselineOrdinal = highestOrdinal(baselineRecords);
  const before = inspectFrontends(sessionId, message);
  const beforeIdentities = new Set(before.map(processIdentityKey).filter(Boolean));
  const evidence = structuredClone(attemptEvidence ?? {
    schema: 'opsle.durable-supervisor.codex-resume-transport-attempt/v1',
  });
  evidence.transport = {
    canonical_argv: argv,
    launcher_argv: [launcher.command, ...launcher.args],
    message_sha256: sha256(message),
    resolved_executable: inspectExecutable('codex', env),
    environment: sanitizedEnvironmentEvidence(env),
    cwd,
    rollout_path: rolloutPath,
    baseline_ordinal: baselineOrdinal,
    confirmation_timeout_ms: confirmationTimeoutMs,
    cleanup_timeout_ms: cleanupTimeoutMs,
  };
  evidence.process = {
    launcher: null,
    launcher_identity_absence: 'launcher-not-yet-spawned',
    frontends: [],
    frontend_identity_absence: 'frontend-not-yet-observed',
    exit_code: null,
    exit_signal: null,
  };
  evidence.output = {
    stdout: '',
    stderr: '',
    stdout_observed_bytes: 0,
    stderr_observed_bytes: 0,
    stdout_captured_bytes: 0,
    stderr_captured_bytes: 0,
    stdout_truncated: false,
    stderr_truncated: false,
    capture_limit_bytes: MAX_CAPTURE_BYTES,
  };
  evidence.timestamps = {
    evidence_initialized_at: new Date(nowMs()).toISOString(),
    spawn_requested_at: null,
    spawned_at: null,
    transport_started_at: null,
    frontend_first_observed_at: null,
    first_stdout_at: null,
    last_stdout_at: null,
    first_stderr_at: null,
    last_stderr_at: null,
    exit_at: null,
    deadline_at: new Date(nowMs() + confirmationTimeoutMs).toISOString(),
    outcome_at: null,
    confirmation_checkpointed_at: null,
    delivery_receipt_committed_at: null,
    cleanup_started_at: null,
    cleanup_completed_at: null,
  };
  evidence.rollout_confirmation = null;
  evidence.confirmation_absence = 'transport-not-yet-started';
  evidence.checkpoints = [];
  const checkpoint = (stage) => {
    evidence.checkpoints.push({ stage, at: new Date(nowMs()).toISOString() });
    try {
      checkpointEvidence?.(structuredClone(evidence));
      return true;
    } catch (error) {
      evidence.checkpoint_failure = {
        stage,
        reason: error.message,
        at: new Date(nowMs()).toISOString(),
      };
      return false;
    }
  };
  checkpoint('initialized-before-spawn');
  if (before.length > 0) {
    evidence.status = 'KNOWN_BUSY_BEFORE_SPAWN';
    evidence.process.frontends = before.map(publicProcessIdentity).filter(Boolean);
    evidence.outcome = {
      classification: 'busy',
      reason: 'matching-resume-frontend-already-exists-before-spawn',
    };
    evidence.confirmation_absence = evidence.outcome.reason;
    evidence.timestamps.outcome_at = new Date(nowMs()).toISOString();
    evidence.timestamps.cleanup_completed_at = evidence.timestamps.outcome_at;
    evidence.cleanup = {
      required: false,
      cleanup_proven: false,
      duplicate_frontend_count: before.length,
      reason: 'preexisting-matching-frontend-is-not-owned-by-this-attempt',
    };
    checkpoint('known-busy-before-spawn');
    return {
      ...evidence.outcome,
      argv,
      spawned: false,
      duplicate_frontend_count: before.length,
      cleanup_proven: false,
      transport_attempt_id: evidence.transport_attempt_id ?? null,
    };
  }
  let watcher;
  let timer;
  let child;
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let settled = false;

  const result = await new Promise((resolve) => {
    const finish = (value) => {
      if (settled) return;
      evidence.timestamps.outcome_at = new Date(nowMs()).toISOString();
      evidence.outcome = {
        classification: value.classification,
        reason: value.reason ?? null,
      };
      if (value.classification === 'confirmed') {
        evidence.status = 'CONFIRMED';
        evidence.rollout_confirmation = { ...value };
        delete evidence.rollout_confirmation.classification;
        evidence.confirmation_absence = null;
        evidence.timestamps.confirmation_checkpointed_at = new Date(nowMs()).toISOString();
        if (!checkpoint('confirmation-before-cleanup')) {
          value = {
            classification: 'uncertain',
            reason: `confirmation-checkpoint-failed: ${evidence.checkpoint_failure.reason}`,
          };
          evidence.rollout_confirmation = null;
          evidence.confirmation_absence = value.reason;
          evidence.outcome = { ...value };
        } else if (commitConfirmation) {
          try {
            const commit = commitConfirmation(structuredClone(evidence));
            if (commit?.committed !== true) {
              value = {
                classification: 'uncertain',
                reason: commit?.reason ?? 'delivery-receipt-commit-rejected',
              };
              evidence.status = 'CONFIRMATION_RECEIPT_REJECTED';
              evidence.outcome = { ...value };
            } else {
              evidence.delivery_receipt = {
                committed: true,
                path: commit.path ?? null,
                delivery_id: commit.receipt?.delivery_id ?? evidence.delivery_id ?? null,
              };
              evidence.timestamps.delivery_receipt_committed_at = new Date(nowMs()).toISOString();
              checkpoint('delivery-receipt-before-cleanup');
            }
          } catch (error) {
            value = {
              classification: 'uncertain',
              reason: `delivery-receipt-commit-failed: ${error.message}`,
            };
            evidence.status = 'CONFIRMATION_RECEIPT_REJECTED';
            evidence.outcome = { ...value };
          }
        }
      } else {
        evidence.status = 'BOUNDED_NON_DELIVERY';
        evidence.confirmation_absence = value.reason ?? 'exact-message-and-turn-began-absent';
        checkpoint('bounded-outcome-before-cleanup');
      }
      settled = true;
      cancelTimeout(timer);
      watcher?.close();
      resolve(value);
    };
    const inspect = () => {
      try {
        const evidence = rolloutAcceptance(rolloutRecords(rolloutPath), {
          sessionId,
          message,
          baselineOrdinal,
        });
        if (evidence) finish(evidence);
      } catch (error) {
        finish({ classification: 'uncertain', reason: `rollout-evidence-unreadable: ${error.message}` });
      }
    };
    watcher = watchFactory(rolloutPath, inspect);
    watcher.on?.('error', (error) => finish({
      classification: 'uncertain',
      reason: `rollout-observation-failed: ${error.message}`,
    }));
    try {
      evidence.timestamps.spawn_requested_at = new Date(nowMs()).toISOString();
      checkpoint('spawn-requested');
      child = spawnProcess(launcher.command, launcher.args, {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd,
        env,
      });
    } catch (error) {
      finish({ classification: 'rejected', reason: `resume-spawn-rejected: ${error.message}` });
      return;
    }
    evidence.timestamps.spawned_at = new Date(nowMs()).toISOString();
    evidence.timestamps.transport_started_at = evidence.timestamps.spawned_at;
    evidence.status = 'STARTED';
    const launcherIdentity = inspectHostProcess(child.pid);
    evidence.process.launcher = publicProcessIdentity(launcherIdentity) ?? {
      pid: child.pid ?? null,
      process_group: child.pid ?? null,
      start_time_ticks: null,
      executable: null,
      command_line_sha256: null,
    };
    evidence.process.launcher_identity_absence = launcherIdentity
      ? null
      : 'launcher-process-exited-before-proc-identity-scan';
    checkpoint('spawned');
    const inspectOutput = () => {
      // The rollout remains authoritative when its exact acceptance records
      // are already durable, even if frontend output also contains busy text.
      inspect();
      if (settled) return;
      const output = `${stdout.toString('utf8')}\n${stderr.toString('utf8')}`;
      if (BUSY_PATTERN.test(output)) finish({
        classification: 'busy',
        reason: 'codex-resume-busy-before-acceptance',
      });
      else if (REJECTION_PATTERN.test(output)) finish({
        classification: 'rejected',
        reason: 'codex-session-rejected-before-acceptance',
      });
    };
    child.stdout?.on('data', (chunk) => {
      stdout = boundedOutput(stdout, chunk);
      evidence.output.stdout_observed_bytes += Buffer.byteLength(chunk);
      evidence.output.stdout = stdout.toString('utf8');
      evidence.output.stdout_captured_bytes = stdout.length;
      evidence.output.stdout_truncated = evidence.output.stdout_observed_bytes > stdout.length;
      evidence.timestamps.first_stdout_at ??= new Date(nowMs()).toISOString();
      evidence.timestamps.last_stdout_at = new Date(nowMs()).toISOString();
      checkpoint('stdout');
      inspectOutput();
    });
    child.stderr?.on('data', (chunk) => {
      stderr = boundedOutput(stderr, chunk);
      evidence.output.stderr_observed_bytes += Buffer.byteLength(chunk);
      evidence.output.stderr = stderr.toString('utf8');
      evidence.output.stderr_captured_bytes = stderr.length;
      evidence.output.stderr_truncated = evidence.output.stderr_observed_bytes > stderr.length;
      evidence.timestamps.first_stderr_at ??= new Date(nowMs()).toISOString();
      evidence.timestamps.last_stderr_at = new Date(nowMs()).toISOString();
      checkpoint('stderr');
      inspectOutput();
    });
    child.once('error', (error) => finish({
      classification: 'rejected',
      reason: `resume-spawn-rejected: ${error.message}`,
    }));
    child.once('exit', (code, signal) => {
      evidence.process.exit_code = code;
      evidence.process.exit_signal = signal;
      evidence.timestamps.exit_at = new Date(nowMs()).toISOString();
      checkpoint('exit');
      inspect();
      if (settled) return;
      const output = `${stdout.toString('utf8')}\n${stderr.toString('utf8')}`;
      finish(BUSY_PATTERN.test(output)
        ? {
          classification: 'busy',
          reason: 'codex-resume-busy-before-acceptance',
        }
        : (REJECTION_PATTERN.test(output)
          ? {
            classification: 'rejected',
            reason: 'codex-session-rejected-before-acceptance',
          }
          : {
            classification: 'uncertain',
            reason: 'codex-resume-exited-without-rollout-acceptance-proof',
          }));
    });
    timer = scheduleTimeout(() => {
      // fs.watch notifications may be coalesced before both records are
      // complete. Re-read exact file state at the already-bounded deadline so
      // durable acceptance evidence cannot be hidden by a lost later callback.
      inspect();
      if (!settled) finish({
        classification: 'uncertain',
        reason: 'rollout-confirmation-deadline-reached-after-spawn',
      });
    }, confirmationTimeoutMs);
    inspect();
  });

  if (!child?.pid) {
    evidence.cleanup = { required: false, cleanup_proven: true, frontend_remnants: 0 };
    evidence.timestamps.cleanup_completed_at = new Date(nowMs()).toISOString();
    checkpoint('no-process-cleanup-required');
    return {
      ...result,
      argv,
      spawned: false,
      transport_attempt_id: evidence.transport_attempt_id ?? null,
    };
  }
  const processGroup = child.pid;
  const trackedGroups = new Set();
  const frontendGroups = new Set();
  const signaledGroups = new Set();
  const termSignaledGroups = new Set();
  const killSignaledGroups = new Set();
  const blockedGroups = new Set();
  const invalidFrontendIdentities = new Set();
  let frontendScanFailed = false;
  let processGroupScanFailed = false;
  let signalFailed = false;
  if (positiveProcessGroup(processGroup)) trackedGroups.add(processGroup);

  const hostBeforeCleanup = authoritativeHostProcess
    ? inspectHostProcess(authoritativeHostProcess.pid)
    : null;
  const authoritativeHostProcessGroup = hostBeforeCleanup?.pgrp;
  const hostContinuityBeforeCleanup = !authoritativeHostProcess || (
    sameHostProcess(hostBeforeCleanup, authoritativeHostProcess)
    && positiveProcessGroup(authoritativeHostProcessGroup)
  );

  const discoverFrontends = () => {
    let rows;
    try {
      rows = inspectFrontends(sessionId, message);
    } catch {
      frontendScanFailed = true;
      return [];
    }
    return rows.filter((row) => {
      const identity = processIdentityKey(row);
      if (identity && beforeIdentities.has(identity)) return false;
      if (!identity || !positiveProcessGroup(row?.pgrp)) {
        invalidFrontendIdentities.add(JSON.stringify([
          row?.pid ?? null,
          row?.start_time_ticks ?? null,
          row?.pgrp ?? null,
        ]));
        return true;
      }
      frontendGroups.add(row.pgrp);
      trackedGroups.add(row.pgrp);
      const publicIdentity = publicProcessIdentity(row);
      evidence.timestamps.frontend_first_observed_at ??= new Date(nowMs()).toISOString();
      if (publicIdentity && !evidence.process.frontends.some((current) => (
        current.pid === publicIdentity.pid
        && current.start_time_ticks === publicIdentity.start_time_ticks
      ))) evidence.process.frontends.push(publicIdentity);
      if (publicIdentity) evidence.process.frontend_identity_absence = null;
      return true;
    });
  };

  const inspectTrackedGroups = () => sortedProcessGroups(trackedGroups).map((group) => {
    try {
      return { process_group: group, members: inspectProcessGroup(group) };
    } catch {
      processGroupScanFailed = true;
      return { process_group: group, members: null };
    }
  });

  const signalGroup = (group, signal) => {
    if (!hostContinuityBeforeCleanup) {
      blockedGroups.add(group);
      return;
    }
    let members;
    try {
      members = inspectProcessGroup(group);
    } catch {
      processGroupScanFailed = true;
      blockedGroups.add(group);
      return;
    }
    if (authoritativeHostProcess && (
      group === authoritativeHostProcessGroup
      || members.some((member) => member.pid === authoritativeHostProcess.pid)
    )) {
      blockedGroups.add(group);
      return;
    }
    try {
      killProcess(-group, signal);
      signaledGroups.add(group);
      (signal === 'SIGTERM' ? termSignaledGroups : killSignaledGroups).add(group);
    } catch (error) {
      if (error.code !== 'ESRCH') signalFailed = true;
    }
  };

  evidence.timestamps.cleanup_started_at = new Date(nowMs()).toISOString();
  discoverFrontends();
  checkpoint('cleanup-started');
  for (const group of sortedProcessGroups(trackedGroups)) signalGroup(group, 'SIGTERM');
  let exited = await waitForExit(child, cleanupTimeoutMs);

  let newFrontends = [];
  let groupEvidence = [];
  const cleanupDeadline = Date.now() + cleanupTimeoutMs;
  do {
    newFrontends = discoverFrontends();
    for (const group of sortedProcessGroups(trackedGroups)) {
      if (!termSignaledGroups.has(group)) signalGroup(group, 'SIGTERM');
    }
    groupEvidence = inspectTrackedGroups();
    exited = exited || child.exitCode != null || child.signalCode != null;
    const allGroupsEmpty = groupEvidence.every((entry) => entry.members?.length === 0);
    if (exited && allGroupsEmpty && newFrontends.length === 0) break;
    for (const entry of groupEvidence) {
      if ((entry.members?.length ?? 0) > 0 || (entry.process_group === processGroup && !exited)) {
        if (!killSignaledGroups.has(entry.process_group)) {
          signalGroup(entry.process_group, 'SIGKILL');
        }
      }
    }
    if (Date.now() >= cleanupDeadline) break;
    await cleanupDelay(Math.min(25, Math.max(1, cleanupDeadline - Date.now())));
  } while (true);

  // One final exact scan is authoritative for both duplicate absence and every
  // tracked process group being empty after the last escalation.
  newFrontends = discoverFrontends();
  let exactFrontendRemnants = [];
  try {
    exactFrontendRemnants = inspectFrontends(sessionId, message);
  } catch {
    frontendScanFailed = true;
  }
  groupEvidence = inspectTrackedGroups();
  exited = exited || child.exitCode != null || child.signalCode != null;
  const currentHost = authoritativeHostProcess
    ? inspectHostProcess(authoritativeHostProcess.pid)
    : null;
  const hostContinuity = !authoritativeHostProcess || (
    hostContinuityBeforeCleanup
    && sameHostProcess(currentHost, authoritativeHostProcess)
    && currentHost.pgrp === authoritativeHostProcessGroup
  );
  const groupMemberCounts = groupEvidence.map((entry) => ({
    process_group: entry.process_group,
    member_count: entry.members?.length ?? -1,
  }));
  const processGroupMemberCount = groupMemberCounts.some((entry) => entry.member_count < 0)
    ? -1
    : groupMemberCounts.reduce((total, entry) => total + entry.member_count, 0);
  const trackedProcessGroups = sortedProcessGroups(trackedGroups);
  const frontendProcessGroups = sortedProcessGroups(frontendGroups);
  const frontendExitObserved = exactFrontendRemnants.length === 0
    && groupEvidence.filter((entry) => frontendGroups.has(entry.process_group))
      .every((entry) => entry.members?.length === 0);
  const cleanupProven = positiveProcessGroup(processGroup)
    && exited
    && frontendExitObserved
    && processGroupMemberCount === 0
    && exactFrontendRemnants.length === 0
    && invalidFrontendIdentities.size === 0
    && !frontendScanFailed
    && !processGroupScanFailed
    && !signalFailed
    && blockedGroups.size === 0
    && hostContinuity;
  evidence.cleanup = {
    process_group: processGroup,
    launcher_exit_observed: exited,
    frontend_exit_observed: frontendExitObserved,
    tracked_process_groups: trackedProcessGroups,
    frontend_process_groups: frontendProcessGroups,
    signaled_process_groups: sortedProcessGroups(signaledGroups),
    process_group_member_counts: groupMemberCounts,
    process_group_member_count: processGroupMemberCount,
    duplicate_frontend_count: exactFrontendRemnants.length,
    invalid_frontend_identity_count: invalidFrontendIdentities.size,
    blocked_process_groups: sortedProcessGroups(blockedGroups),
    authoritative_host_process_group: authoritativeHostProcessGroup ?? null,
    authoritative_host_signaled: false,
    authoritative_host_continuity_proven: hostContinuity,
    cleanup_proven: cleanupProven,
  };
  if (evidence.process.frontends.length === 0) {
    evidence.process.frontend_identity_absence = 'no-matching-frontend-observed-before-cleanup';
  }
  evidence.status = cleanupProven
    ? (result.classification === 'confirmed' ? 'CONFIRMED_AND_CLEANED' : 'NON_DELIVERY_AND_CLEANED')
    : 'CLEANUP_UNPROVEN';
  evidence.timestamps.cleanup_completed_at = new Date(nowMs()).toISOString();
  checkpoint('cleanup-completed');
  if (evidence.delivery_receipt?.committed && completeCommittedDelivery) {
    try {
      const completion = completeCommittedDelivery(structuredClone(evidence));
      evidence.delivery_receipt.cleanup_updated = completion?.updated === true
        || completion?.duplicate === true;
      evidence.delivery_receipt.cleanup_status = completion?.receipt
        ?.temporary_frontend?.cleanup_status ?? null;
      checkpoint('delivery-receipt-cleanup-updated');
    } catch (error) {
      evidence.delivery_receipt.cleanup_updated = false;
      evidence.delivery_receipt.cleanup_update_failure = error.message;
      evidence.status = 'DELIVERED_CLEANUP_INTERVENTION_REQUIRED';
      checkpoint('delivery-receipt-cleanup-update-failed');
    }
  }
  return {
    ...result,
    reason: result.reason ?? (cleanupProven ? undefined : 'temporary-process-group-cleanup-unproven'),
    argv,
    launcher_argv: [launcher.command, ...launcher.args],
    spawned: true,
    process_group: processGroup,
    launcher_exit_observed: exited,
    frontend_exit_observed: frontendExitObserved,
    tracked_process_groups: trackedProcessGroups,
    frontend_process_groups: frontendProcessGroups,
    signaled_process_groups: sortedProcessGroups(signaledGroups),
    process_group_member_counts: groupMemberCounts,
    process_group_member_count: processGroupMemberCount,
    duplicate_frontend_count: exactFrontendRemnants.length,
    invalid_frontend_identity_count: invalidFrontendIdentities.size,
    blocked_process_groups: sortedProcessGroups(blockedGroups),
    authoritative_host_process_group: authoritativeHostProcessGroup ?? null,
    authoritative_host_signaled: false,
    authoritative_host_continuity_proven: hostContinuity,
    cleanup_proven: cleanupProven,
    delivery_receipt_committed: evidence.delivery_receipt?.committed === true,
    cleanup_intervention_required: evidence.delivery_receipt?.cleanup_updated === false
      || (evidence.delivery_receipt?.committed === true && !cleanupProven),
    transport_attempt_id: evidence.transport_attempt_id ?? null,
  };
}
