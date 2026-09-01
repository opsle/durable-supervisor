import { spawn } from 'node:child_process';
import {
  readFileSync,
  readdirSync,
  readlinkSync,
  watch,
} from 'node:fs';
import { join } from 'node:path';
import { sha256 } from './io.js';

const BUSY_PATTERN = /already.*(?:running|busy)|active turn|turn.*in progress|session.*busy/i;
const rolloutLineHashes = new WeakMap();

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

function rolloutRecords(path) {
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
  confirmationTimeoutMs = CODEX_RESUME_CONFIRMATION_TIMEOUT_MS,
  cleanupTimeoutMs = CODEX_RESUME_CLEANUP_TIMEOUT_MS,
  spawnProcess = spawn,
  watchFactory = watch,
  killProcess = process.kill.bind(process),
  inspectFrontends = resumeFrontendProcesses,
  inspectProcessGroup = processGroupMembers,
  authoritativeHostProcess = null,
  inspectHostProcess = hostProcessIdentity,
  scheduleTimeout = setTimeout,
  cancelTimeout = clearTimeout,
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
  let watcher;
  let timer;
  let child;
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let settled = false;

  const result = await new Promise((resolve) => {
    const finish = (value) => {
      if (settled) return;
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
      child = spawnProcess(launcher.command, launcher.args, {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({ classification: 'rejected', reason: `resume-spawn-rejected: ${error.message}` });
      return;
    }
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
    };
    child.stdout?.on('data', (chunk) => {
      stdout = boundedOutput(stdout, chunk);
      inspectOutput();
    });
    child.stderr?.on('data', (chunk) => {
      stderr = boundedOutput(stderr, chunk);
      inspectOutput();
    });
    child.once('error', (error) => finish({
      classification: 'rejected',
      reason: `resume-spawn-rejected: ${error.message}`,
    }));
    child.once('exit', () => {
      inspect();
      if (settled) return;
      const output = `${stdout.toString('utf8')}\n${stderr.toString('utf8')}`;
      finish(BUSY_PATTERN.test(output) ? {
        classification: 'busy',
        reason: 'codex-resume-busy-before-acceptance',
      } : {
        classification: 'uncertain',
        reason: 'codex-resume-exited-without-rollout-acceptance-proof',
      });
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

  if (!child?.pid) return { ...result, argv, spawned: false };
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

  discoverFrontends();
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
  const cleanupProven = positiveProcessGroup(processGroup)
    && exited
    && processGroupMemberCount === 0
    && newFrontends.length === 0
    && invalidFrontendIdentities.size === 0
    && !frontendScanFailed
    && !processGroupScanFailed
    && !signalFailed
    && blockedGroups.size === 0
    && hostContinuity;
  return {
    ...result,
    reason: result.reason ?? (cleanupProven ? undefined : 'temporary-process-group-cleanup-unproven'),
    argv,
    launcher_argv: [launcher.command, ...launcher.args],
    spawned: true,
    process_group: processGroup,
    launcher_exit_observed: exited,
    frontend_exit_observed: exited,
    tracked_process_groups: trackedProcessGroups,
    frontend_process_groups: frontendProcessGroups,
    signaled_process_groups: sortedProcessGroups(signaledGroups),
    process_group_member_counts: groupMemberCounts,
    process_group_member_count: processGroupMemberCount,
    duplicate_frontend_count: newFrontends.length,
    invalid_frontend_identity_count: invalidFrontendIdentities.size,
    blocked_process_groups: sortedProcessGroups(blockedGroups),
    authoritative_host_process_group: authoritativeHostProcessGroup ?? null,
    authoritative_host_signaled: false,
    authoritative_host_continuity_proven: hostContinuity,
    cleanup_proven: cleanupProven,
  };
}
