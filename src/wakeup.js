import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  watch,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  CODEX_RESUME_CONFIRMATION_TIMEOUT_MS,
  CODEX_RESUME_WORST_CASE_CLEANUP_TIMEOUT_MS,
} from './codex-resume-transport.js';
import {
  atomicCreateJson,
  atomicCompareAndSwapJson,
  canonicalJson,
  fileSha256,
  id,
  now,
  readJson,
  sha256,
  writeJson,
} from './io.js';
import { emit, paths, updateState } from './state.js';

const WAIT_SCHEMA = 'opsle.durable-supervisor.wait-registration/v1';
const WAKE_REQUEST_SCHEMA = 'opsle.durable-supervisor.host-wake-request/v1';
const NATIVE_WAKE_REQUEST_SCHEMA = 'opsle.durable-supervisor.native-wake-request/v2';
const DELIVERY_SCHEMA = 'opsle.durable-supervisor.host-wake-delivery/v1';
const DISPATCHER_SCHEMA = 'opsle.durable-supervisor.host-wake-dispatcher/v1';
export const CODEX_SESSION_BINDING_SCHEMA = 'opsle.durable-supervisor.codex-session-binding/v2';
export const ACTIVATION_LEASE_SCHEMA = 'opsle.durable-supervisor.activation-lease/v1';
export const ACTIVATION_DECISION_SCHEMA = 'opsle.durable-supervisor.activation-decision/v1';
export const CODEX_RESUME_HELPER_TIMEOUT_MS = (
  CODEX_RESUME_CONFIRMATION_TIMEOUT_MS
  + CODEX_RESUME_WORST_CASE_CLEANUP_TIMEOUT_MS
  + 5_000
);
export const ACTIVATION_LEASE_TTL_MS = CODEX_RESUME_HELPER_TIMEOUT_MS + 45_000;

export const TERMINAL_WAKE_TYPES = Object.freeze(new Set([
  'child-completed',
  'child-failed',
  'child-timeout',
  'child-stall',
  'intervention-required',
]));

export const INELIGIBLE_WAKE_TYPES = Object.freeze(new Set([
  'heartbeat',
  'host-wrapper-yield',
  'host-wrapper-timeout',
  'nonterminal-return',
]));

export function registerWait({ waitId, taskId, attemptId, registeredAt, deadlineAt }) {
  if (!waitId || !taskId || !attemptId || !registeredAt || !deadlineAt) {
    throw new Error('wait registration requires identity, registration time, and deadline');
  }
  return {
    schema: WAIT_SCHEMA,
    wait_id: waitId,
    task_id: taskId,
    attempt_id: attemptId,
    state: 'WAITING',
    registered_at: registeredAt,
    deadline_at: deadlineAt,
    seen_event_ids: [],
    human_interactions: [],
    wake: null,
  };
}

export function applyWakeEvent(wait, event) {
  if (wait?.schema !== WAIT_SCHEMA) throw new Error('unsupported wait registration');
  if (!event?.event_id || !event?.type || !event?.wait_id) {
    throw new Error('wake event requires event_id, type, and wait_id');
  }
  if (wait.seen_event_ids.includes(event.event_id)) return wait;
  const seen = [...wait.seen_event_ids, event.event_id];
  if (event.wait_id !== wait.wait_id || wait.state !== 'WAITING') {
    return { ...wait, seen_event_ids: seen };
  }
  if (INELIGIBLE_WAKE_TYPES.has(event.type)) {
    return { ...wait, seen_event_ids: seen };
  }
  if (event.type === 'human-interaction') {
    return {
      ...wait,
      seen_event_ids: seen,
      human_interactions: [...wait.human_interactions, {
        event_id: event.event_id,
        class: 'human',
        automatic: false,
      }],
    };
  }
  if (!TERMINAL_WAKE_TYPES.has(event.type)) {
    return { ...wait, seen_event_ids: seen };
  }
  return {
    ...wait,
    state: 'READY',
    seen_event_ids: seen,
    wake: {
      event_id: event.event_id,
      type: event.type,
      class: 'terminal-event',
      automatic: true,
    },
  };
}

export function terminalWakeType({ timedOut, stalled = false, exitCode }) {
  if (stalled) return 'child-stall';
  if (timedOut) return 'child-timeout';
  return exitCode === 0 ? 'child-completed' : 'child-failed';
}

function wakePaths(root) {
  const base = join(paths(root).opsle, 'wake');
  return {
    base,
    requests: join(base, 'requests'),
    deliveries: join(base, 'deliveries'),
    busy: join(base, 'busy.json'),
    dispatcher: join(base, 'dispatcher.json'),
    dispatcherLock: join(base, 'dispatcher.lock'),
    sessionBinding: join(base, 'codex-session-binding.json'),
    activationLease: join(base, 'activation-lease.json'),
    activationDecisions: join(base, 'activation-decisions'),
  };
}

function directories(root) {
  const value = wakePaths(root);
  for (const directory of [value.base, value.requests, value.deliveries, value.activationDecisions]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  return value;
}

function removeIfPresent(path) {
  try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function requestPath(root, eventId) {
  return join(directories(root).requests, `${eventId}.json`);
}

function receiptPath(root, eventId) {
  return join(directories(root).deliveries, `${eventId}.json`);
}

function sameProcess(left, right) {
  return left && right
    && left.pid === right.pid
    && left.start_time_ticks === right.start_time_ticks
    && left.executable === right.executable;
}

function positiveSortedProcessGroups(values, { allowEmpty = false } = {}) {
  return Array.isArray(values)
    && (allowEmpty || values.length > 0)
    && values.every((value, index) => (
      Number.isSafeInteger(value)
      && value > 0
      && (index === 0 || values[index - 1] < value)
    ));
}

export function processIdentity(pid, procRoot = '/proc') {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const processDirectory = join(procRoot, String(pid));
    const stat = readFileSync(join(processDirectory, 'stat'), 'utf8');
    const close = stat.lastIndexOf(') ');
    if (close === -1) return null;
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    const commandLine = readFileSync(join(processDirectory, 'cmdline'));
    let tty = null;
    try { tty = readlinkSync(join(processDirectory, 'fd', '0')); } catch { /* no readable stdin */ }
    return {
      pid,
      start_time_ticks: fields[19],
      executable: readlinkSync(join(processDirectory, 'exe')),
      uid: statSync(processDirectory).uid,
      tty,
      command_line_sha256: sha256(commandLine),
    };
  } catch {
    return null;
  }
}

function exactProcess(left, right) {
  return left && right
    && left.pid === right.pid
    && left.start_time_ticks === right.start_time_ticks
    && left.executable === right.executable
    && left.uid === right.uid
    && left.tty === right.tty
    && left.command_line_sha256 === right.command_line_sha256;
}

function validProcessIdentity(value) {
  return Number.isSafeInteger(value?.pid)
    && value.pid > 0
    && /^\d+$/.test(value.start_time_ticks ?? '')
    && typeof value.executable === 'string'
    && value.executable.startsWith('/')
    && Number.isSafeInteger(value.uid)
    && value.uid >= 0
    && (value.tty === null || (typeof value.tty === 'string' && value.tty.startsWith('/')))
    && /^[a-f0-9]{64}$/.test(value.command_line_sha256 ?? '');
}

function rolloutSessionMeta(path) {
  const bytes = readFileSync(path);
  const lines = bytes.toString('utf8').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index]) continue;
    let record;
    try { record = JSON.parse(lines[index]); } catch { continue; }
    if (record?.type !== 'session_meta') continue;
    const payload = record.payload ?? {};
    const sessionId = payload.id ?? payload.session_id ?? null;
    return {
      record,
      session_id: sessionId,
      repository: payload.cwd ? realpathSync(payload.cwd) : null,
      line_number: index + 1,
      line_sha256: sha256(Buffer.from(`${lines[index]}${index < lines.length - 1 ? '\n' : ''}`)),
      payload_sha256: sha256(canonicalJson(payload)),
    };
  }
  throw new Error(`rollout has no session_meta record: ${path}`);
}

function sessionCandidates(sessionsRoot, sessionId) {
  const matches = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          if (rolloutSessionMeta(path).session_id === sessionId) matches.push(realpathSync(path));
        } catch {
          // A malformed or unrelated rollout is not a candidate for this ID.
        }
      }
    }
  };
  walk(sessionsRoot);
  return matches.sort();
}

function tmuxPaneIdentity(sessionName, paneId, run = spawnSync) {
  const format = '#{session_name}\t#{pane_id}\t#{pane_pid}\t#{pane_tty}';
  const result = run('tmux', ['display-message', '-p', '-t', paneId, format], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  const [session, pane, panePid, paneTty] = result.stdout.trim().split('\t');
  if (session !== sessionName || pane !== paneId || !/^%\d+$/.test(pane)) return null;
  return {
    session_name: session,
    pane_id: pane,
    pane_pid: Number(panePid),
    pane_tty: paneTty,
  };
}

function installedCodexVersion(run = spawnSync) {
  const result = run('codex', ['--version'], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n')[0] || null;
}

function legacyTmuxAuthority(sessionName, run = spawnSync) {
  if (typeof sessionName !== 'string' || !sessionName) return false;
  const result = run('tmux', [
    'display-message', '-p', '-t', sessionName, '#{session_name}',
  ], { encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim() === sessionName;
}

function bindingDependencies(overrides = {}) {
  return {
    realpath: overrides.realpath ?? realpathSync,
    stat: overrides.stat ?? statSync,
    processIdentity: overrides.processIdentity ?? processIdentity,
    rolloutMeta: overrides.rolloutMeta ?? rolloutSessionMeta,
    sessionCandidates: overrides.sessionCandidates ?? sessionCandidates,
    codexVersion: overrides.codexVersion ?? installedCodexVersion,
    uid: overrides.uid ?? (() => process.getuid?.() ?? null),
    legacyTmuxAuthority: overrides.legacyTmuxAuthority ?? legacyTmuxAuthority,
  };
}

function validateSessionBindingShape(binding) {
  if (binding?.schema !== CODEX_SESSION_BINDING_SCHEMA) throw new Error('unsupported Codex session binding');
  if (typeof binding.repository_realpath !== 'string'
      || typeof binding.supervisor_id !== 'string'
      || !Number.isSafeInteger(binding.supervisor_generation)
      || !/^[0-9a-f-]{36}$/i.test(binding.codex_session_uuid ?? '')
      || typeof binding.rollout?.realpath !== 'string'
      || !/^[a-f0-9]{64}$/.test(binding.rollout?.session_meta_line_sha256 ?? '')
      || !/^[a-f0-9]{64}$/.test(binding.rollout?.session_meta_payload_sha256 ?? '')
      || !Number.isSafeInteger(binding.rollout?.device)
      || !Number.isSafeInteger(binding.rollout?.inode)
      || typeof binding.sessions_root_realpath !== 'string'
      || typeof binding.codex_cli_version !== 'string'
      || !Number.isSafeInteger(binding.uid)
      || typeof binding.binding_id !== 'string'
      || binding.host?.kind !== 'herdr'
      || binding.host?.authority !== 'authoritative'
      || !validProcessIdentity(binding.host?.process)
      || typeof binding.host?.workspace_id !== 'string'
      || binding.host?.workspace_cwd !== binding.repository_realpath
      || typeof binding.host?.pane_id !== 'string'
      || typeof binding.host?.terminal_id !== 'string'
      || typeof binding.authority_fence?.legacy_tmux_session !== 'string') {
    throw new Error('incomplete Codex session binding');
  }
  if (binding.native_wake?.supported !== true
      || binding.native_wake?.transport !== 'plain-codex-resume'
      || binding.native_wake?.confirmation !== 'bound-rollout-exact-message-and-turn-began') {
    throw new Error('Herdr binding requires canonical plain Codex resume transport');
  }
  return binding;
}

export function createCodexSessionBinding(root, {
  sessionId,
  rolloutPath,
  sessionsRoot,
  hostPid,
  workspaceId,
  workspaceCwd,
  paneId,
  terminalId,
  legacyTmuxSession = null,
}, dependencyOverrides = {}) {
  const deps = bindingDependencies(dependencyOverrides);
  const p = paths(root);
  const supervisor = readJson(p.supervisor);
  const repositoryRealpath = deps.realpath(root);
  const rolloutRealpath = deps.realpath(rolloutPath);
  const sessionsRootRealpath = deps.realpath(sessionsRoot);
  const rollout = deps.stat(rolloutRealpath);
  const meta = deps.rolloutMeta(rolloutRealpath);
  const hostProcess = deps.processIdentity(Number(hostPid));
  const cliVersion = deps.codexVersion();
  const uid = deps.uid();
  const fencedTmuxSession = legacyTmuxSession ?? supervisor.session_id;
  if (!hostProcess || !cliVersion || !Number.isSafeInteger(uid)) {
    throw new Error('session binding probes did not produce exact Herdr process, CLI, and UID facts');
  }
  if (meta.session_id !== sessionId || meta.repository !== repositoryRealpath) {
    throw new Error('rollout session_meta does not match the explicit session and repository');
  }
  if (hostProcess.uid !== uid) {
    throw new Error('Herdr Codex process UID does not match the binding owner');
  }
  const candidates = deps.sessionCandidates(sessionsRootRealpath, sessionId);
  if (candidates.length !== 1 || candidates[0] !== rolloutRealpath) {
    throw new Error(`Codex session binding requires one exact rollout candidate; observed ${candidates.length}`);
  }
  if (workspaceCwd !== repositoryRealpath) {
    throw new Error('Herdr workspace CWD must equal the repository realpath');
  }
  if (deps.legacyTmuxAuthority(fencedTmuxSession)) {
    throw new Error('old tmux supervisor authority is still live');
  }
  const oldPath = wakePaths(root).sessionBinding;
  const supersedes = existsSync(oldPath) ? fileSha256(oldPath) : null;
  return validateSessionBindingShape({
    schema: CODEX_SESSION_BINDING_SCHEMA,
    binding_id: id('codex-session-binding'),
    repository_realpath: repositoryRealpath,
    supervisor_id: supervisor.supervisor_id,
    supervisor_generation: supervisor.generation,
    codex_session_uuid: sessionId,
    rollout: {
      realpath: rolloutRealpath,
      device: rollout.dev,
      inode: rollout.ino,
      bound_size_bytes: rollout.size,
      session_meta_line: meta.line_number,
      session_meta_session_id: meta.session_id,
      session_meta_repository_realpath: meta.repository,
      session_meta_line_sha256: meta.line_sha256,
      session_meta_payload_sha256: meta.payload_sha256,
    },
    sessions_root_realpath: sessionsRootRealpath,
    codex_cli_version: cliVersion,
    uid,
    host: {
      kind: 'herdr',
      authority: 'authoritative',
      workspace_id: workspaceId,
      workspace_cwd: workspaceCwd,
      pane_id: paneId,
      terminal_id: terminalId,
      process: hostProcess,
    },
    authority_fence: {
      legacy_tmux_session: fencedTmuxSession,
      legacy_tmux_absent_at_bind: true,
    },
    native_wake: {
      supported: true,
      transport: 'plain-codex-resume',
      confirmation: 'bound-rollout-exact-message-and-turn-began',
      reason: null,
    },
    supersedes_binding_sha256: supersedes,
    bound_at: now(),
  });
}

export function codexSessionBindingStatus(root, {
  binding = null,
  ignoreSupersession = false,
  dependencies = {},
} = {}) {
  const deps = bindingDependencies(dependencies);
  const record = binding ?? readOptional(wakePaths(root).sessionBinding);
  if (!record) return { classification: 'unbound', valid: false, supported: false, reasons: ['session-binding-missing'] };
  try { validateSessionBindingShape(record); } catch (error) {
    return { classification: 'stale', valid: false, supported: false, reasons: ['binding-schema-invalid'], error: error.message };
  }
  const reasons = [];
  const supervisor = readJson(paths(root).supervisor);
  let repositoryRealpath = null;
  try { repositoryRealpath = deps.realpath(root); } catch { reasons.push('repository-realpath-unavailable'); }
  if (record.repository_realpath !== repositoryRealpath) reasons.push('repository-mismatch');
  if (record.supervisor_id !== supervisor.supervisor_id) reasons.push('supervisor-identity-mismatch');
  if (record.supervisor_generation !== supervisor.generation) reasons.push('supervisor-generation-stale');
  if (deps.codexVersion() !== record.codex_cli_version) reasons.push('codex-cli-version-mismatch');
  if (deps.uid() !== record.uid) reasons.push('uid-mismatch');
  if (!exactProcess(record.host.process, deps.processIdentity(record.host.process.pid))) {
    reasons.push('herdr-host-process-dead-or-reused');
  }
  if (deps.legacyTmuxAuthority(record.authority_fence.legacy_tmux_session)) {
    reasons.push('old-tmux-authority-live');
  }
  let rolloutRealpath = null;
  try { rolloutRealpath = deps.realpath(record.rollout.realpath); } catch { reasons.push('rollout-missing'); }
  if (rolloutRealpath && rolloutRealpath !== record.rollout.realpath) reasons.push('rollout-realpath-mismatch');
  if (rolloutRealpath) {
    try {
      const stats = deps.stat(rolloutRealpath);
      if (stats.dev !== record.rollout.device || stats.ino !== record.rollout.inode) reasons.push('rollout-file-replaced');
      if (stats.size < record.rollout.bound_size_bytes) reasons.push('rollout-truncated');
      const meta = deps.rolloutMeta(rolloutRealpath);
      if (meta.session_id !== record.codex_session_uuid
          || meta.session_id !== record.rollout.session_meta_session_id
          || meta.repository !== record.repository_realpath
          || meta.line_sha256 !== record.rollout.session_meta_line_sha256
          || meta.payload_sha256 !== record.rollout.session_meta_payload_sha256) {
        reasons.push('rollout-session-meta-mismatch');
      }
    } catch (error) {
      reasons.push('rollout-metadata-unreadable');
    }
  }
  try {
    const candidates = deps.sessionCandidates(record.sessions_root_realpath, record.codex_session_uuid);
    if (candidates.length !== 1) reasons.push('duplicate-or-missing-rollout-candidate');
    else if (candidates[0] !== record.rollout.realpath) reasons.push('rollout-candidate-identity-mismatch');
  } catch {
    reasons.push('rollout-candidate-scan-failed');
  }
  if (!ignoreSupersession && binding && existsSync(wakePaths(root).sessionBinding)) {
    const current = readOptional(wakePaths(root).sessionBinding);
    if (current?.binding_id !== record.binding_id) reasons.push('session-binding-superseded');
  }
  if (reasons.length) return { classification: 'stale', valid: false, supported: false, reasons, binding: record };
  return {
    classification: 'bound-authoritative-herdr',
    valid: true,
    supported: record.native_wake.supported,
    reason: record.native_wake.reason,
    binding: record,
  };
}

export function bindCodexSession(root, input, options = {}) {
  const binding = createCodexSessionBinding(root, input, options.dependencies);
  const status = codexSessionBindingStatus(root, {
    binding,
    ignoreSupersession: true,
    dependencies: options.dependencies,
  });
  if (!status.valid) throw new Error(`Codex session binding validation failed: ${status.reasons.join(', ')}`);
  writeJson(directories(root).sessionBinding, binding);
  return status;
}

export function adoptCodexSessionBinding(root, { dependencies = {} } = {}) {
  const path = directories(root).sessionBinding;
  const binding = readJson(path);
  const status = codexSessionBindingStatus(root, { binding, dependencies });
  if (!status.valid) throw new Error(`stale Codex session binding must be replaced: ${status.reasons.join(', ')}`);
  const supervisor = readJson(paths(root).supervisor);
  if (binding.supervisor_generation === supervisor.generation) return { adopted: false, binding, status };
  throw new Error('generation drift requires a fresh authoritative Herdr session binding');
}

function activationDecisionPath(root, eventId) {
  return join(wakePaths(root).activationDecisions, `${eventId}.json`);
}

function leaseOwner(dispatcher) {
  return {
    dispatcher_id: dispatcher?.dispatcher_id ?? 'explicit-provider-free-dispatcher',
    dispatcher_generation: dispatcher?.dispatcher_generation ?? 1,
    process: dispatcher?.process ?? processIdentity(process.pid),
  };
}

function leaseExpired(lease, nowMs) {
  const expiry = Date.parse(lease?.expires_at ?? '');
  return !Number.isFinite(expiry) || expiry <= nowMs;
}

export function acquireActivationLease(root, eventId, {
  dispatcher = null,
  ttlMs = ACTIVATION_LEASE_TTL_MS,
  nowMs = Date.now(),
  getProcessIdentity = processIdentity,
} = {}) {
  if (typeof eventId !== 'string' || !eventId) throw new Error('activation lease requires event identity');
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error('activation lease requires positive TTL');
  const wake = directories(root);
  const supervisor = readJson(paths(root).supervisor);
  if (dispatcher && !dispatcherFence(root, dispatcher).current) {
    return { acquired: false, classification: 'stale-dispatcher', reason: 'dispatcher-fence-no-longer-current' };
  }
  const owner = leaseOwner(dispatcher);
  if (!owner.process || !sameProcess(owner.process, getProcessIdentity(owner.process.pid))) {
    return { acquired: false, classification: 'stale-dispatcher', reason: 'activation-owner-process-dead-or-reused' };
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = readOptional(wake.activationLease);
    if (current?.schema === ACTIVATION_LEASE_SCHEMA
        && current.status === 'OWNED'
        && current.supervisor_id === supervisor.supervisor_id
        && current.supervisor_generation === supervisor.generation
        && !leaseExpired(current, nowMs)) {
      if (current.event_id === eventId
          && current.owner.dispatcher_id === owner.dispatcher_id
          && current.owner.dispatcher_generation === owner.dispatcher_generation
          && sameProcess(current.owner.process, owner.process)) {
        return { acquired: true, duplicate: true, lease: current };
      }
      return { acquired: false, classification: 'busy', reason: 'another-activation-lease-is-current', lease: current };
    }
    const next = {
      schema: ACTIVATION_LEASE_SCHEMA,
      lease_id: id('activation-lease'),
      event_id: eventId,
      supervisor_id: supervisor.supervisor_id,
      supervisor_generation: supervisor.generation,
      fencing_token: (Number(current?.fencing_token) || 0) + 1,
      owner,
      status: 'OWNED',
      acquired_at: new Date(nowMs).toISOString(),
      expires_at: new Date(nowMs + ttlMs).toISOString(),
      released_at: null,
    };
    const expected = current ? sha256(canonicalJson(current)) : null;
    const cas = atomicCompareAndSwapJson(wake.activationLease, expected, next);
    if (cas.swapped) {
      return {
        acquired: true,
        duplicate: false,
        takeover: Boolean(current),
        lease: next,
      };
    }
    if (cas.reason !== 'cas-content-changed') {
      return { acquired: false, classification: 'busy', reason: cas.reason };
    }
  }
  return { acquired: false, classification: 'busy', reason: 'activation-lease-cas-raced' };
}

export function releaseActivationLease(root, lease, { nowMs = Date.now() } = {}) {
  const path = directories(root).activationLease;
  const current = readOptional(path);
  if (!current) return { released: false, reason: 'activation-lease-missing' };
  if (current.lease_id !== lease?.lease_id
      || current.fencing_token !== lease?.fencing_token
      || current.supervisor_id !== lease?.supervisor_id
      || current.supervisor_generation !== lease?.supervisor_generation) {
    return { released: false, reason: 'activation-lease-fence-mismatch', lease: current };
  }
  if (current.status === 'RELEASED') return { released: true, duplicate: true, lease: current };
  const expected = sha256(canonicalJson(current));
  current.status = 'RELEASED';
  current.released_at = new Date(nowMs).toISOString();
  const cas = atomicCompareAndSwapJson(path, expected, current);
  return cas.swapped
    ? { released: true, duplicate: false, lease: current }
    : { released: false, reason: cas.reason };
}

export function decisionFenceCurrent(root, lease, { nowMs = Date.now() } = {}) {
  const supervisor = readJson(paths(root).supervisor);
  const current = readOptional(directories(root).activationLease);
  return Number.isFinite(nowMs)
    && current?.schema === ACTIVATION_LEASE_SCHEMA
    && current.status === 'OWNED'
    && current.expires_at === lease?.expires_at
    && !leaseExpired(current, nowMs)
    && current.lease_id === lease?.lease_id
    && current.fencing_token === lease?.fencing_token
    && current.event_id === lease?.event_id
    && current.supervisor_id === lease?.supervisor_id
    && current.supervisor_generation === lease?.supervisor_generation
    && current.supervisor_id === supervisor.supervisor_id
    && current.supervisor_generation === supervisor.generation
    && current.owner?.dispatcher_id === lease?.owner?.dispatcher_id
    && current.owner?.dispatcher_generation === lease?.owner?.dispatcher_generation
    && sameProcess(current.owner?.process, lease?.owner?.process);
}

export function claimActivationDecision(root, eventId, lease, {
  message = null,
  nowMs = Date.now(),
} = {}) {
  if (!decisionFenceCurrent(root, lease, { nowMs })) {
    return { claimed: false, classification: 'stale-generation', reason: 'activation-lease-fence-no-longer-current' };
  }
  const request = readJson(requestPath(root, eventId));
  const supervisor = readJson(paths(root).supervisor);
  if (request.target.supervisor_id !== supervisor.supervisor_id
      || request.target.supervisor_generation !== supervisor.generation) {
    return { claimed: false, classification: 'obsolete', reason: 'wake-target-generation-is-stale' };
  }
  const decision = {
    schema: ACTIVATION_DECISION_SCHEMA,
    decision_id: id('activation-decision'),
    event_id: eventId,
    supervisor_id: supervisor.supervisor_id,
    supervisor_generation: supervisor.generation,
    lease_id: lease.lease_id,
    fencing_token: lease.fencing_token,
    message_sha256: sha256(message ?? constructWakeMessage(eventId, supervisor.generation)),
    status: 'CLAIMED',
    claimed_at: now(),
    delivered_at: null,
    failure: null,
  };
  const path = activationDecisionPath(root, eventId);
  if (atomicCreateJson(path, decision)) return { claimed: true, duplicate: false, decision };
  const current = readJson(path);
  if (current.status === 'BUSY' && decisionFenceCurrent(root, lease)) {
    const expected = sha256(canonicalJson(current));
    decision.prior_attempts = [
      ...(Array.isArray(current.prior_attempts) ? current.prior_attempts : []),
      {
        decision_id: current.decision_id,
        lease_id: current.lease_id,
        fencing_token: current.fencing_token,
        status: current.status,
        claimed_at: current.claimed_at,
        failure: current.failure,
      },
    ];
    const cas = atomicCompareAndSwapJson(path, expected, decision);
    if (cas.swapped) return { claimed: true, duplicate: false, retry: true, decision };
  }
  return {
    claimed: false,
    duplicate: true,
    classification: 'duplicate',
    reason: 'activation-decision-already-exists',
    decision: readJson(path),
  };
}

function updateActivationDecision(root, decision, status, failure = null) {
  const path = activationDecisionPath(root, decision.event_id);
  const current = readJson(path);
  if (current.decision_id !== decision.decision_id
      || current.lease_id !== decision.lease_id
      || current.fencing_token !== decision.fencing_token
      || current.status !== 'CLAIMED') {
    return { updated: false, reason: 'activation-decision-fence-mismatch', decision: current };
  }
  const expected = sha256(canonicalJson(current));
  current.status = status;
  current.delivered_at = status === 'DELIVERED' ? now() : null;
  current.failure = failure;
  const cas = atomicCompareAndSwapJson(path, expected, current);
  return cas.swapped
    ? { updated: true, decision: current }
    : { updated: false, reason: cas.reason };
}

export function constructWakeMessage(eventId, generation) {
  if (typeof eventId !== 'string' || !eventId || !Number.isSafeInteger(generation) || generation <= 0) {
    throw new Error('wake message requires event ID and positive supervisor generation');
  }
  return `OPSLE_WAKE v1 event=${eventId} gen=${generation}; read durable state.`;
}

export function classifyQueuedWake(root, request, supervisor = readJson(paths(root).supervisor)) {
  if (![WAKE_REQUEST_SCHEMA, NATIVE_WAKE_REQUEST_SCHEMA].includes(request?.schema)) {
    return { classification: 'queued', reason: 'invalid-wake-request' };
  }
  if (request.target?.supervisor_id !== supervisor.supervisor_id
      || request.target?.supervisor_generation !== supervisor.generation) {
    return { classification: 'obsolete', reason: 'wake-target-generation-is-stale' };
  }
  const state = readJson(paths(root).state);
  if (state.processed_event_ids?.includes(request.event_id)) {
    return { classification: 'obsolete', reason: 'wake-event-already-consumed' };
  }
  const taskPath = join(paths(root).tasks, `${request.task_id}.json`);
  const attemptPath = join(paths(root).attempts, `${request.attempt_id}.json`);
  const task = existsSync(taskPath) ? readJson(taskPath) : null;
  const attempt = existsSync(attemptPath) ? readJson(attemptPath) : null;
  if (['ACCEPTED', 'REJECTED'].includes(task?.state) || attempt?.supervisor_evaluation) {
    return { classification: 'obsolete', reason: 'task-already-terminal-and-evaluated' };
  }
  if (existsSync(activationDecisionPath(root, request.event_id))) {
    const decision = readJson(activationDecisionPath(root, request.event_id));
    if (decision.status === 'BUSY') {
      return {
        classification: 'queued',
        reason: 'awaiting-supported-native-transport',
        prior_decision: decision,
      };
    }
    return {
      classification: decision.status === 'DELIVERED' ? 'duplicate' : 'queued',
      reason: `activation-decision-${decision.status.toLowerCase()}`,
      decision,
    };
  }
  return { classification: 'queued', reason: 'awaiting-supported-native-transport' };
}

export function enqueueTerminalWake(root, completionEvent, { hostBinding = null } = {}) {
  if (completionEvent?.type !== 'CHILD_COMPLETION'
      || !TERMINAL_WAKE_TYPES.has(completionEvent.terminal_type)) {
    throw new Error('only durable terminal child events are eligible for host wake delivery');
  }
  const supervisor = readJson(paths(root).supervisor);
  if (hostBinding) throw new Error('new wake requests cannot bind a terminal host transport');
  const request = {
    schema: NATIVE_WAKE_REQUEST_SCHEMA,
    event_id: completionEvent.event_id,
    event_type: completionEvent.type,
    terminal_type: completionEvent.terminal_type,
    task_id: completionEvent.task_id,
    attempt_id: completionEvent.attempt_id,
    wait_id: completionEvent.wait_id,
    target: {
      supervisor_id: supervisor.supervisor_id,
      supervisor_generation: supervisor.generation,
    },
    queue_version: 1,
    queued_at: now(),
    adoptions: [],
  };
  const path = requestPath(root, completionEvent.event_id);
  if (!atomicCreateJson(path, request)) return readJson(path);
  emit(root, 'HOST_WAKE_QUEUED', {
    source_event_id: completionEvent.event_id,
    task_id: completionEvent.task_id,
    attempt_id: completionEvent.attempt_id,
    terminal_type: completionEvent.terminal_type,
    target_supervisor_generation: supervisor.generation,
  });
  return request;
}

function sameDispatcher(left, right) {
  return left && right
    && left.dispatcher_id === right.dispatcher_id
    && left.dispatcher_generation === right.dispatcher_generation
    && left.supervisor_id === right.supervisor_id
    && left.supervisor_generation === right.supervisor_generation
    && sameProcess(left.process, right.process);
}

function dispatcherFence(root, expected) {
  if (!expected) return { current: true, record: null };
  const record = readOptional(directories(root).dispatcher);
  const supervisor = readJson(paths(root).supervisor);
  if (record?.schema !== DISPATCHER_SCHEMA
      || record.status !== 'OWNED'
      || !sameDispatcher(record, expected)
      || record.supervisor_id !== supervisor.supervisor_id
      || record.supervisor_generation !== supervisor.generation) {
    return { current: false, record };
  }
  return { current: true, record };
}

export function classifyWakeDelivery({
  request,
  supervisor,
  busy,
  evidence,
  dispatcher = null,
  binding = request?.target?.host_binding ?? null,
}) {
  if (![WAKE_REQUEST_SCHEMA, NATIVE_WAKE_REQUEST_SCHEMA].includes(request?.schema)) {
    return { classification: 'queued', reason: 'invalid-wake-request' };
  }
  if (!Number.isSafeInteger(request.queue_version) || request.queue_version < 1) {
    return { classification: 'queued', reason: 'invalid-queue-version' };
  }
  if (request.target.supervisor_id !== supervisor.supervisor_id
      || request.target.supervisor_generation !== supervisor.generation) {
    return { classification: 'stale-generation', reason: 'wake-target-does-not-match-current-supervisor' };
  }
  if (binding && (binding.supervisor_id !== request.target.supervisor_id
      || binding.supervisor_generation !== request.target.supervisor_generation)) {
    return { classification: 'stale-generation', reason: 'wake-host-binding-generation-mismatch' };
  }
  if (dispatcher && (dispatcher.supervisor_id !== supervisor.supervisor_id
      || dispatcher.supervisor_generation !== supervisor.generation)) {
    return { classification: 'stale-generation', reason: 'dispatcher-supervisor-generation-mismatch' };
  }
  if (busy) return { classification: 'busy', reason: 'active-delivery-or-supervisor-busy-marker' };
  if (binding && evidence?.host_kind && evidence.host_kind !== binding.host) {
    return { classification: 'unavailable', reason: 'stale-or-mismatched-host-adapter' };
  }
  if (binding?.authority === 'candidate-only' || evidence?.delivery_authorized === false) {
    return {
      classification: 'candidate-only',
      reason: evidence?.reason ?? 'host-adapter-does-not-authorize-prompt-delivery',
    };
  }
  if (!evidence?.available || !evidence.session_alive || evidence.pane_dead) {
    return { classification: 'unavailable', reason: evidence?.reason ?? 'tmux-unavailable' };
  }
  if (evidence.attached_clients?.length) {
    return { classification: 'human-interacting', reason: 'tmux-client-attached' };
  }
  const tmuxSession = binding?.host === 'tmux' ? binding.session_id : request.target.tmux_session;
  if (tmuxSession !== evidence.session_name
      || typeof evidence.pane_id !== 'string'
      || !Number.isSafeInteger(evidence.pane_pid)) {
    return { classification: 'unavailable', reason: 'tmux-session-or-pane-identity-mismatch' };
  }
  if (!evidence.codex_process) {
    return { classification: 'unavailable', reason: 'authoritative-codex-process-unavailable' };
  }
  if (evidence.prompt_state === 'busy') {
    return { classification: 'busy', reason: evidence.reason ?? 'codex-busy' };
  }
  if (evidence.prompt_state === 'human-composer' || evidence.composer_text) {
    return { classification: 'human-interacting', reason: 'nonempty-human-composer' };
  }
  if (evidence.prompt_state !== 'idle'
      || evidence.prompt_idle !== true
      || evidence.composer_empty !== true
      || evidence.composer_text !== ''
      || !/^[a-f0-9]{64}$/.test(evidence.capture_sha256 ?? '')) {
    return { classification: 'ambiguous-composer', reason: evidence.reason ?? 'empty-codex-composer-not-directly-observed' };
  }
  return { classification: 'prompt-idle', reason: 'current-generation-live-codex-empty-composer-and-idle-prompt' };
}

function readOptional(path) {
  return existsSync(path) ? readJson(path) : null;
}

export function plainCodexResumeTransport({
  run = spawnSync,
  helper = fileURLToPath(new URL('../bin/opsle-codex-resume.js', import.meta.url)),
} = {}) {
  return {
    kind: 'plain-codex-resume',
    resume({ session_id: sessionId, message, binding }) {
      const result = run(process.execPath, [
        helper,
        '--session', sessionId,
        '--message', message,
        '--rollout', binding.rollout.realpath,
        '--host-pid', String(binding.host.process.pid),
        '--host-start', binding.host.process.start_time_ticks,
        '--host-executable', binding.host.process.executable,
      ], {
        encoding: 'utf8',
        maxBuffer: 256 * 1024,
        timeout: CODEX_RESUME_HELPER_TIMEOUT_MS,
      });
      if (result.error) {
        return {
          classification: 'uncertain',
          reason: `resume-helper-outcome-uncertain: ${result.error.message}`,
        };
      }
      try {
        const parsed = JSON.parse(result.stdout.trim());
        if (!parsed || typeof parsed.classification !== 'string') throw new Error('missing classification');
        return parsed;
      } catch (error) {
        return {
          classification: 'uncertain',
          reason: `resume-helper-result-invalid: ${error.message}`,
        };
      }
    },
  };
}

function validateDeliveryFence(root, eventId, expected, dispatcher) {
  const request = readJson(requestPath(root, eventId));
  const supervisor = readJson(paths(root).supervisor);
  if (supervisor.supervisor_id !== expected.supervisorId
      || supervisor.generation !== expected.supervisorGeneration) {
    return { current: false, reason: 'supervisor-delivery-fence-changed' };
  }
  if (request.target.supervisor_id !== supervisor.supervisor_id
      || request.target.supervisor_generation !== supervisor.generation) {
    return { current: false, reason: 'wake-target-does-not-match-current-supervisor' };
  }
  if (request.queue_version !== expected.queueVersion) {
    return { current: false, reason: 'wake-queue-version-changed' };
  }
  if (sha256(canonicalJson(request)) !== expected.requestSha256) {
    return { current: false, reason: 'wake-request-changed' };
  }
  if (request.target.host_binding
      && (request.target.host_binding.supervisor_id !== supervisor.supervisor_id
        || request.target.host_binding.supervisor_generation !== supervisor.generation)) {
    return { current: false, reason: 'wake-host-binding-generation-mismatch' };
  }
  const dispatcherDecision = dispatcherFence(root, dispatcher);
  if (!dispatcherDecision.current) {
    return { current: false, reason: 'dispatcher-fence-no-longer-current' };
  }
  return { current: true, request, supervisor };
}

export function deliverWake(root, eventId, {
  nativeTransport = null,
  bindingDependencies = {},
  dispatcher = null,
  expectedQueueVersion = null,
  getActivationNowMs = Date.now,
} = {}) {
  const wake = directories(root);
  const request = readJson(requestPath(root, eventId));
  const queueVersion = expectedQueueVersion ?? request.queue_version;
  const deliveryFence = {
    queueVersion,
    requestSha256: sha256(canonicalJson(request)),
    supervisorId: request.target.supervisor_id,
    supervisorGeneration: request.target.supervisor_generation,
  };
  const existingPath = receiptPath(root, eventId);
  if (existsSync(existingPath)) {
    let existing;
    try { existing = readJson(existingPath); } catch {
      return { classification: 'queued', reason: 'crash-uncertain-invalid-delivery-receipt', replayed: false };
    }
    if (existing.status === 'DELIVERED' || existing.status === 'CONSUMED') {
      return { classification: 'duplicate', reason: 'event-already-delivered', receipt: existing };
    }
    return { classification: 'queued', reason: 'crash-uncertain-delivery-claim', receipt: existing, replayed: false };
  }
  const supervisor = readJson(paths(root).supervisor);
  const lifecycle = classifyQueuedWake(root, request, supervisor);
  if (lifecycle.classification !== 'queued'
      || lifecycle.reason !== 'awaiting-supported-native-transport') {
    return { ...lifecycle, event_id: eventId, delivered: false };
  }
  const bindingStatus = codexSessionBindingStatus(root, { dependencies: bindingDependencies });
  if (!bindingStatus.valid) {
    return {
      classification: 'queued',
      reason: bindingStatus.classification === 'unbound'
        ? 'codex-session-unbound'
        : 'codex-session-binding-stale',
      binding_status: bindingStatus,
      event_id: eventId,
      delivered: false,
    };
  }
  if (!bindingStatus.supported) {
    return {
      classification: 'unsupported-topology',
      reason: bindingStatus.reason,
      binding_status: bindingStatus,
      event_id: eventId,
      delivered: false,
    };
  }
  const transport = nativeTransport ?? plainCodexResumeTransport();
  if (transport?.kind !== bindingStatus.binding.native_wake.transport
      || typeof transport.resume !== 'function') {
    return {
      classification: 'queued',
      reason: 'proven-native-transport-adapter-unavailable',
      event_id: eventId,
      delivered: false,
    };
  }
  const currentDispatcher = dispatcher ? dispatcherFence(root, dispatcher) : { current: true };
  if (!currentDispatcher.current) {
    return { classification: 'stale-generation', reason: 'dispatcher-fence-no-longer-current', delivered: false };
  }
  const fence = validateDeliveryFence(root, eventId, deliveryFence, dispatcher);
  if (!fence.current) {
    return { classification: 'stale-generation', reason: fence.reason, event_id: eventId, delivered: false };
  }
  const leaseResult = acquireActivationLease(root, eventId, {
    dispatcher,
    nowMs: getActivationNowMs(),
  });
  if (!leaseResult.acquired) {
    return {
      classification: leaseResult.classification ?? 'queued',
      reason: leaseResult.reason,
      event_id: eventId,
      delivered: false,
    };
  }
  const lease = leaseResult.lease;
  const message = constructWakeMessage(eventId, supervisor.generation);
  const claim = claimActivationDecision(root, eventId, lease, {
    message,
    nowMs: getActivationNowMs(),
  });
  if (!claim.claimed) {
    releaseActivationLease(root, lease);
    return {
      classification: claim.classification ?? 'duplicate',
      reason: claim.reason,
      decision: claim.decision,
      event_id: eventId,
      delivered: false,
    };
  }
  if (!decisionFenceCurrent(root, lease, { nowMs: getActivationNowMs() })) {
    updateActivationDecision(root, claim.decision, 'UNCERTAIN', 'activation lease changed before native transport');
    releaseActivationLease(root, lease);
    return { classification: 'stale-generation', reason: 'activation-lease-fence-no-longer-current', delivered: false };
  }
  const receipt = {
    schema: DELIVERY_SCHEMA,
    delivery_id: id('delivery'),
    event_id: eventId,
    queue_version: queueVersion,
    supervisor_id: supervisor.supervisor_id,
    supervisor_generation: supervisor.generation,
    dispatcher_id: dispatcher?.dispatcher_id ?? null,
    dispatcher_generation: dispatcher?.dispatcher_generation ?? null,
    dispatcher_process: dispatcher?.process ?? lease.owner.process,
    activation_lease_id: lease.lease_id,
    activation_fencing_token: lease.fencing_token,
    activation_decision_id: claim.decision.decision_id,
    codex_session_binding_sha256: fileSha256(wake.sessionBinding),
    host_kind: 'herdr',
    native_transport: bindingStatus.binding.native_wake.transport,
    codex_session_uuid: bindingStatus.binding.codex_session_uuid,
    message_sha256: sha256(message),
    status: 'CLAIMED',
    claimed_at: now(),
    delivered_at: null,
    consumed_at: null,
    failure: null,
  };
  const finalFence = validateDeliveryFence(root, eventId, deliveryFence, dispatcher);
  const finalLeaseFenceCurrent = decisionFenceCurrent(root, lease, {
    nowMs: getActivationNowMs(),
  });
  if (!finalFence.current || !finalLeaseFenceCurrent) {
    const reason = finalFence.current
      ? 'activation lease changed before native transport'
      : 'delivery fence changed before native transport';
    updateActivationDecision(root, claim.decision, 'UNCERTAIN', reason);
    releaseActivationLease(root, lease);
    return {
      classification: 'stale-generation',
      reason: finalFence.current ? 'activation-lease-fence-no-longer-current' : finalFence.reason,
      delivered: false,
    };
  }
  try {
    const committed = transport.resume({
      session_id: bindingStatus.binding.codex_session_uuid,
      event_id: eventId,
      generation: supervisor.generation,
      message,
      binding: bindingStatus.binding,
    });
    if (['busy', 'rejected'].includes(committed?.classification)) {
      updateActivationDecision(root, claim.decision, 'BUSY', committed.reason);
      releaseActivationLease(root, lease);
      emit(root, 'HOST_WAKE_DEFERRED', {
        source_event_id: eventId,
        classification: committed.classification,
        reason: committed.reason,
      });
      return {
        classification: committed.classification,
        reason: committed.reason,
        delivered: false,
        replayed: false,
      };
    }
    const confirmationComplete = Number.isSafeInteger(committed?.accepted_ordinal)
      && /^[a-f0-9]{64}$/.test(committed?.accepted_record_sha256 ?? '')
      && Number.isSafeInteger(committed?.turn_began_ordinal)
      && /^[a-f0-9]{64}$/.test(committed?.turn_began_record_sha256 ?? '')
      && typeof committed?.turn_id === 'string'
      && Number.isSafeInteger(committed?.turn_started_at_ms)
      && canonicalJson(committed?.argv) === canonicalJson([
        'codex', 'resume', bindingStatus.binding.codex_session_uuid, message,
      ])
      && Number.isSafeInteger(committed?.process_group)
      && committed.process_group > 0
      && committed?.launcher_exit_observed === true
      && committed?.frontend_exit_observed === true
      && positiveSortedProcessGroups(committed?.tracked_process_groups)
      && committed.tracked_process_groups.includes(committed.process_group)
      && positiveSortedProcessGroups(committed?.frontend_process_groups, { allowEmpty: true })
      && committed.frontend_process_groups.every((group) => (
        committed.tracked_process_groups.includes(group)
      ))
      && positiveSortedProcessGroups(committed?.signaled_process_groups, { allowEmpty: true })
      && committed.signaled_process_groups.every((group) => (
        committed.tracked_process_groups.includes(group)
      ))
      && Array.isArray(committed?.process_group_member_counts)
      && committed.process_group_member_counts.length === committed.tracked_process_groups.length
      && committed.process_group_member_counts.every((entry, index) => (
        entry?.process_group === committed.tracked_process_groups[index]
        && entry?.member_count === 0
      ))
      && committed?.process_group_member_count === 0
      && committed?.duplicate_frontend_count === 0
      && committed?.invalid_frontend_identity_count === 0
      && Array.isArray(committed?.blocked_process_groups)
      && committed.blocked_process_groups.length === 0
      && Number.isSafeInteger(committed?.authoritative_host_process_group)
      && committed.authoritative_host_process_group > 0
      && !committed.tracked_process_groups.includes(committed.authoritative_host_process_group)
      && committed?.authoritative_host_signaled === false;
    if (committed?.classification !== 'confirmed'
        || committed.cleanup_proven !== true
        || committed.authoritative_host_continuity_proven !== true
        || !confirmationComplete) {
      updateActivationDecision(root, claim.decision, 'UNCERTAIN', committed?.reason ?? 'native transport confirmation or cleanup unproven');
      releaseActivationLease(root, lease);
      return {
        classification: 'uncertain',
        reason: committed?.reason ?? 'native-transport-confirmation-or-cleanup-unproven',
        delivered: false,
        replayed: false,
      };
    }
    receipt.rollout_confirmation = {
      accepted_ordinal: committed.accepted_ordinal,
      accepted_record_sha256: committed.accepted_record_sha256,
      turn_began_ordinal: committed.turn_began_ordinal,
      turn_began_record_sha256: committed.turn_began_record_sha256,
      turn_id: committed.turn_id,
      turn_started_at_ms: committed.turn_started_at_ms,
    };
    receipt.temporary_frontend = {
      argv: committed.argv,
      process_group: committed.process_group,
      launcher_exit_observed: committed.launcher_exit_observed,
      frontend_exit_observed: committed.frontend_exit_observed,
      tracked_process_groups: committed.tracked_process_groups,
      frontend_process_groups: committed.frontend_process_groups,
      signaled_process_groups: committed.signaled_process_groups,
      process_group_member_counts: committed.process_group_member_counts,
      process_group_member_count: committed.process_group_member_count,
      duplicate_frontend_count: committed.duplicate_frontend_count,
      invalid_frontend_identity_count: committed.invalid_frontend_identity_count,
      authoritative_host_process_group: committed.authoritative_host_process_group,
      authoritative_host_signaled: committed.authoritative_host_signaled,
      cleanup_proven: committed.cleanup_proven,
      authoritative_host_continuity_proven: committed.authoritative_host_continuity_proven,
    };
    const postTransportFence = validateDeliveryFence(
      root,
      eventId,
      deliveryFence,
      dispatcher,
    );
    const leaseFenceCurrent = decisionFenceCurrent(root, lease, {
      nowMs: getActivationNowMs(),
    });
    if (!postTransportFence.current || !leaseFenceCurrent) {
      const reason = postTransportFence.current
        ? 'activation-lease-fence-changed-after-native-transport'
        : `${postTransportFence.reason}-after-native-transport`;
      updateActivationDecision(root, claim.decision, 'UNCERTAIN', reason);
      releaseActivationLease(root, lease);
      return {
        classification: 'uncertain',
        reason,
        delivered: false,
        replayed: false,
      };
    }
  } catch (error) {
    updateActivationDecision(root, claim.decision, 'UNCERTAIN', error.message);
    releaseActivationLease(root, lease);
    emit(root, 'HOST_WAKE_DELIVERY_UNCERTAIN', {
      source_event_id: eventId,
      delivery_id: receipt.delivery_id,
      reason: error.message,
    });
    return { classification: 'queued', reason: 'crash-uncertain-delivery', receipt, delivered: false, replayed: false };
  }
  const deliveredDecision = updateActivationDecision(root, claim.decision, 'DELIVERED');
  if (!deliveredDecision.updated) {
    releaseActivationLease(root, lease);
    return {
      classification: 'uncertain',
      reason: deliveredDecision.reason ?? 'activation-decision-fence-changed-before-delivery',
      delivered: false,
      replayed: false,
    };
  }
  receipt.status = 'DELIVERED';
  receipt.delivered_at = now();
  if (!atomicCreateJson(existingPath, receipt)) {
    releaseActivationLease(root, lease);
    return { classification: 'duplicate', reason: 'event-already-delivered', receipt: readJson(existingPath), delivered: false };
  }
  releaseActivationLease(root, lease);
  const state = readJson(paths(root).state);
  if (!state.pause?.active || state.pause.after_current) updateState(root, { supervisor_state: 'ACTIVE' });
  const attemptPath = join(paths(root).attempts, `${request.attempt_id}.json`);
  if (existsSync(attemptPath)) {
    const attempt = readJson(attemptPath);
    if (attempt.telemetry?.activation_counts) {
      attempt.telemetry.activation_counts = {
        evidence: 'durable-host-delivery',
        total_automatic: 1,
        terminal_event: 1,
        human: attempt.telemetry.activation_counts.human,
        wait_induced_automatic: 0,
      };
      writeJson(attemptPath, attempt);
    }
  }
  emit(root, 'SUPERVISOR_ACTIVATION', {
    classification: 'terminal-event',
    automatic: true,
    cause_event_id: eventId,
    task_id: request.task_id,
    attempt_id: request.attempt_id,
    wait_id: request.wait_id,
    delivery_id: receipt.delivery_id,
  });
  emit(root, 'SUPERVISOR_REACTIVATED', {
    cause_event_id: eventId,
    task_id: request.task_id,
    attempt_id: request.attempt_id,
    classification: 'terminal-event',
    delivery_id: receipt.delivery_id,
    resulting_state: state.pause?.active && !state.pause.after_current ? 'PAUSED' : 'ACTIVE',
  });
  emit(root, 'HOST_WAKE_DELIVERED', {
    source_event_id: eventId,
    delivery_id: receipt.delivery_id,
    queue_version: queueVersion,
    native_transport: receipt.native_transport,
    codex_session_uuid: receipt.codex_session_uuid,
  });
  return { classification: 'native-delivered', reason: 'supported-native-session-transport', receipt, delivered: true };
}

export function consumeWakeDelivery(root, eventId, { deliveryId, generation }) {
  const request = readOptional(requestPath(root, eventId));
  if (!request) return null;
  const receipt = readJson(receiptPath(root, eventId));
  const supervisor = readJson(paths(root).supervisor);
  const wake = directories(root);
  if (receipt.status === 'CONSUMED') {
    const busy = readOptional(wake.busy);
    if (busy?.delivery_id === receipt.delivery_id) removeIfPresent(wake.busy);
    return { duplicate: true, receipt };
  }
  if (receipt.status !== 'DELIVERED') throw new Error('wake delivery is not durably delivered');
  if (receipt.delivery_id !== deliveryId) throw new Error('wake delivery identity mismatch');
  if (Number(generation) !== receipt.supervisor_generation
      || receipt.supervisor_generation !== supervisor.generation
      || request.target.supervisor_generation !== supervisor.generation) {
    throw new Error('stale supervisor generation cannot consume wake event');
  }
  receipt.status = 'CONSUMED';
  receipt.consumed_at = now();
  writeJson(receiptPath(root, eventId), receipt);
  const busy = readOptional(wake.busy);
  if (busy?.delivery_id === receipt.delivery_id) removeIfPresent(wake.busy);
  return { duplicate: false, receipt };
}

export function wakeQueueStatus(root, {
  bindingDependencies = {},
  getProcessIdentity = processIdentity,
} = {}) {
  const wake = directories(root);
  const supervisor = readJson(paths(root).supervisor);
  const busy = readOptional(wake.busy);
  const dispatcher = readOptional(wake.dispatcher);
  const dispatcherCurrent = dispatcher?.schema === DISPATCHER_SCHEMA
    && ['LAUNCHED', 'OWNED'].includes(dispatcher.status)
    && dispatcher.supervisor_id === supervisor.supervisor_id
    && dispatcher.supervisor_generation === supervisor.generation
    && sameProcess(dispatcher.process, getProcessIdentity(dispatcher.process?.pid));
  const bindingStatus = codexSessionBindingStatus(root, { dependencies: bindingDependencies });
  const requests = readdirSync(wake.requests).filter((name) => name.endsWith('.json')).sort().map((name) => {
    const request = readJson(join(wake.requests, name));
    const receipt = readOptional(receiptPath(root, request.event_id));
    if (receipt) {
      return {
        event_id: request.event_id,
        terminal_type: request.terminal_type,
        classification: ['DELIVERED', 'CONSUMED'].includes(receipt.status) ? 'duplicate' : 'queued',
        reason: receipt.status,
        receipt,
      };
    }
    const lifecycle = classifyQueuedWake(root, request, supervisor);
    if (lifecycle.classification !== 'queued'
        || lifecycle.reason !== 'awaiting-supported-native-transport') {
      return {
        event_id: request.event_id,
        terminal_type: request.terminal_type,
        ...lifecycle,
      };
    }
    return {
      event_id: request.event_id,
      terminal_type: request.terminal_type,
      classification: !bindingStatus.valid
        ? 'queued'
        : (bindingStatus.supported ? 'native-ready' : 'unsupported-topology'),
      reason: !bindingStatus.valid
        ? (bindingStatus.classification === 'unbound' ? 'codex-session-unbound' : 'codex-session-binding-stale')
        : (bindingStatus.reason ?? 'supported-native-session-transport'),
      binding_status: bindingStatus,
    };
  });
  return {
    supervisor_generation: supervisor.generation,
    dispatcher: dispatcher ? { ...dispatcher, current: dispatcherCurrent } : null,
    session_binding: bindingStatus,
    busy,
    requests,
  };
}

export function adoptQueuedWakes(root) {
  // Wake requests are immutable historical evidence. Generation advancement
  // makes old requests obsolete; it never rewrites or adopts their bytes.
  directories(root);
  return [];
}

export function drainWakeQueue(root, options = {}) {
  const wake = directories(root);
  return readdirSync(wake.requests).filter((name) => name.endsWith('.json')).sort()
    .map((name) => {
      const request = readJson(join(wake.requests, name));
      return deliverWake(root, request.event_id, {
        ...options,
        expectedQueueVersion: request.queue_version,
      });
    });
}

function dispatcherIsCurrent(record, supervisor, getProcessIdentity, statuses = ['LAUNCHED', 'OWNED']) {
  return record?.schema === DISPATCHER_SCHEMA
    && statuses.includes(record.status)
    && record.supervisor_id === supervisor.supervisor_id
    && record.supervisor_generation === supervisor.generation
    && sameProcess(record.process, getProcessIdentity(record.process?.pid));
}

function acquireDispatcherLaunchLock(path, getProcessIdentity) {
  const attempt = () => {
    const owner = processIdentity(process.pid);
    if (atomicCreateJson(path, { owner, acquired_at: now() })) return true;
    let lock = null;
    try { lock = readJson(path); } catch { return false; }
    if (lock.owner && !sameProcess(lock.owner, getProcessIdentity(lock.owner.pid))) {
      removeIfPresent(path);
      return attempt();
    }
    return false;
  };
  return attempt();
}

export function ensureWakeDispatcher(root, {
  spawnProcess = spawn,
  getProcessIdentity = processIdentity,
  dispatcherScript = fileURLToPath(new URL('../bin/opsle-wake-delivery.js', import.meta.url)),
} = {}) {
  const wake = directories(root);
  const supervisor = readJson(paths(root).supervisor);
  let existing = readOptional(wake.dispatcher);
  if (dispatcherIsCurrent(existing, supervisor, getProcessIdentity)) {
    return { started: false, reason: 'current-dispatcher-already-live', dispatcher: existing };
  }
  const lock = acquireDispatcherLaunchLock(wake.dispatcherLock, getProcessIdentity);
  if (!lock) {
    return { started: false, reason: 'dispatcher-launch-already-in-progress', dispatcher: existing };
  }
  try {
    existing = readOptional(wake.dispatcher);
    if (dispatcherIsCurrent(existing, supervisor, getProcessIdentity)) {
      return { started: false, reason: 'current-dispatcher-already-live', dispatcher: existing };
    }
    const record = {
      schema: DISPATCHER_SCHEMA,
      dispatcher_id: id('wake-dispatcher'),
      dispatcher_generation: (Number(existing?.dispatcher_generation) || 0) + 1,
      supervisor_id: supervisor.supervisor_id,
      supervisor_generation: supervisor.generation,
      queue_generation: supervisor.generation,
      launch_nonce: id('wake-dispatcher-launch'),
      process: null,
      status: 'LAUNCHING',
      launched_at: now(),
      owned_at: null,
      last_observed_at: null,
      last_result: null,
      failure: null,
    };
    writeJson(wake.dispatcher, record);
    try {
      const child = spawnProcess(process.execPath, [
        dispatcherScript,
        '--root', root,
        '--dispatcher', record.dispatcher_id,
        '--dispatcher-generation', String(record.dispatcher_generation),
        '--launch-nonce', record.launch_nonce,
      ], { cwd: root, detached: true, stdio: 'ignore' });
      if (!Number.isSafeInteger(child.pid)) throw new Error('dispatcher did not receive a process ID');
      record.process = getProcessIdentity(child.pid);
      if (!record.process) throw new Error('dispatcher process-start identity was unavailable');
      record.status = 'LAUNCHED';
      writeJson(wake.dispatcher, record);
      child.unref?.();
      emit(root, 'HOST_WAKE_DISPATCHER_LAUNCHED', {
        dispatcher_id: record.dispatcher_id,
        dispatcher_generation: record.dispatcher_generation,
        dispatcher_pid: record.process.pid,
        dispatcher_start_time_ticks: record.process.start_time_ticks,
        target_supervisor_generation: record.supervisor_generation,
      });
      return { started: true, reason: 'dispatcher-launched', dispatcher: record };
    } catch (error) {
      record.status = 'FAILED';
      record.failure = error.message;
      writeJson(wake.dispatcher, record);
      return { started: false, reason: 'dispatcher-launch-failed', dispatcher: record };
    }
  } finally {
    removeIfPresent(wake.dispatcherLock);
  }
}

export function registerWakeObservation(root, { watchFactory = watch } = {}) {
  const wake = directories(root);
  const watchers = [];
  let settled = false;
  let resolveSignal;
  const signal = new Promise((resolve) => { resolveSignal = resolve; });
  const finish = (value) => {
    if (settled) return;
    settled = true;
    for (const watcher of watchers.splice(0)) watcher.close();
    resolveSignal(value);
  };
  const binding = readOptional(wake.sessionBinding);
  const observedDirectories = [...new Set([
    wake.base,
    wake.requests,
    binding?.rollout?.realpath ? dirname(binding.rollout.realpath) : null,
  ].filter(Boolean))];
  for (const directory of observedDirectories) {
    if (settled) break;
    try {
      const watcher = watchFactory(directory, () => finish({ type: 'filesystem-event', directory }));
      watcher.on?.('error', (error) => finish({ type: 'watch-error', error: error.message }));
      if (settled) watcher.close();
      else watchers.push(watcher);
    } catch (error) {
      finish({ type: 'watch-error', error: error.message });
    }
  }
  return {
    wait: () => signal,
    close: () => finish({ type: 'observation-closed' }),
  };
}

function boundRolloutState(root, { statFile = statSync } = {}) {
  const binding = readOptional(directories(root).sessionBinding);
  if (typeof binding?.rollout?.realpath !== 'string') return null;
  try {
    const stats = statFile(binding.rollout.realpath);
    return {
      path: binding.rollout.realpath,
      device: stats.dev,
      inode: stats.ino,
      size_bytes: stats.size,
    };
  } catch {
    return null;
  }
}

export function registerBoundRolloutOpportunity(root, baseline, {
  watchFactory = watch,
  state = boundRolloutState,
} = {}) {
  let settled = false;
  let watcher;
  let resolveSignal;
  const signal = new Promise((resolve) => { resolveSignal = resolve; });
  const finish = (value) => {
    if (settled) return;
    settled = true;
    watcher?.close();
    resolveSignal(value);
  };
  const inspect = () => {
    const current = state(root);
    if (current
        && current.path === baseline?.path
        && current.device === baseline.device
        && current.inode === baseline.inode
        && current.size_bytes > baseline.size_bytes) {
      finish({
        type: 'bound-rollout-state-change',
        path: current.path,
        previous_size_bytes: baseline.size_bytes,
        size_bytes: current.size_bytes,
      });
    }
  };
  if (!baseline) {
    finish({ type: 'bound-rollout-unavailable' });
  } else {
    try {
      watcher = watchFactory(dirname(baseline.path), (_event, filename) => {
        if (filename == null || String(filename) === baseline.path.split('/').at(-1)) inspect();
      });
      watcher.on?.('error', (error) => finish({ type: 'watch-error', error: error.message }));
      if (settled) watcher.close();
      // Close the baseline-to-subscription race, including a change made by
      // watchFactory while the watcher is being registered.
      else inspect();
    } catch (error) {
      finish({ type: 'watch-error', error: error.message });
    }
  }
  return {
    wait: () => signal,
    close: () => finish({ type: 'observation-closed' }),
  };
}

export function waitForWakeSignal(root, options = {}) {
  const observation = registerWakeObservation(root, options);
  return observation.wait().finally(() => observation.close());
}

function receiptFreeRequests(root) {
  const wake = directories(root);
  return readdirSync(wake.requests).filter((name) => name.endsWith('.json')).sort()
    .map((name) => readJson(join(wake.requests, name)))
    .filter((request) => !existsSync(receiptPath(root, request.event_id)));
}

export async function runWakeDispatcher(root, {
  dispatcherId,
  dispatcherGeneration,
  launchNonce,
  pid = process.pid,
  nativeTransport = null,
  bindingDependencies = {},
  getProcessIdentity = processIdentity,
  registerObservation = registerWakeObservation,
  observeBoundRollout = registerBoundRolloutOpportunity,
  readBoundRolloutState = boundRolloutState,
  delay = sleep,
  handshakeTimeoutMs = 5000,
  maxCycles = Number.POSITIVE_INFINITY,
} = {}) {
  const wake = directories(root);
  const processRecord = getProcessIdentity(pid);
  if (!processRecord) throw new Error('dispatcher cannot establish its process-start identity');
  let record;
  const handshakeDeadline = Date.now() + handshakeTimeoutMs;
  while (Date.now() <= handshakeDeadline) {
    record = readJson(wake.dispatcher);
    if (record.dispatcher_id !== dispatcherId
        || record.dispatcher_generation !== dispatcherGeneration
        || record.launch_nonce !== launchNonce) {
      return { status: 'STALE', reason: 'dispatcher-launch-fence-mismatch' };
    }
    if (sameProcess(record.process, processRecord)) break;
    await delay(10);
  }
  const supervisor = readJson(paths(root).supervisor);
  if (record.schema !== DISPATCHER_SCHEMA
      || record.status !== 'LAUNCHED'
      || record.dispatcher_id !== dispatcherId
      || record.dispatcher_generation !== dispatcherGeneration
      || record.launch_nonce !== launchNonce
      || !sameProcess(record.process, processRecord)
      || record.supervisor_id !== supervisor.supervisor_id
      || record.supervisor_generation !== supervisor.generation) {
    return { status: 'STALE', reason: 'dispatcher-launch-fence-mismatch' };
  }
  record.status = 'OWNED';
  record.owned_at = now();
  writeJson(wake.dispatcher, record);
  emit(root, 'HOST_WAKE_DISPATCHER_OWNED', {
    dispatcher_id: record.dispatcher_id,
    dispatcher_generation: record.dispatcher_generation,
    dispatcher_pid: record.process.pid,
    dispatcher_start_time_ticks: record.process.start_time_ticks,
    supervisor_generation: record.supervisor_generation,
  });

  for (let cycle = 0; cycle < maxCycles; cycle += 1) {
    let current;
    try { current = readJson(wake.dispatcher); } catch {
      return { status: 'RETIRED', reason: 'dispatcher-state-unavailable' };
    }
    const currentSupervisor = readJson(paths(root).supervisor);
    if (!dispatcherIsCurrent(current, currentSupervisor, getProcessIdentity, ['OWNED'])
        || !sameDispatcher(current, record)) {
      return { status: 'RETIRED', reason: 'dispatcher-superseded-or-generation-changed' };
    }
    // Establish observation before the receipt-free scan. An event created
    // after registration is either present in this scan or wakes the already
    // registered observation, so there is no queue-check/subscription gap.
    const observation = registerObservation(root);
    let queued;
    try {
      queued = receiptFreeRequests(root);
    } catch (error) {
      observation.close();
      throw error;
    }
    if (queued.length === 0) {
      current.last_observed_at = now();
      current.last_result = { classification: 'idle', queued: 0 };
      writeJson(wake.dispatcher, current);
      if (cycle + 1 >= maxCycles) {
        observation.close();
        return { status: 'OWNED', reason: 'test-cycle-limit', results: [] };
      }
      try { await observation.wait(); } finally { observation.close(); }
      continue;
    }
    // Capture the exact bound-rollout state while the pre-scan observation is
    // still open, then subscribe before delivery. The watcher's immediate
    // check closes the baseline-to-subscription race without observing Opsle's
    // own wake-file writes.
    const rolloutBaseline = readBoundRolloutState(root);
    const opportunity = observeBoundRollout(root, rolloutBaseline);
    observation.close();
    const results = queued.map((request) => deliverWake(root, request.event_id, {
      nativeTransport,
      bindingDependencies,
      dispatcher: record,
      expectedQueueVersion: request.queue_version,
    }));
    current.last_observed_at = now();
    current.last_result = {
      classification: 'drain',
      queued: queued.length,
      results: results.map((result) => ({
        event_id: result.event_id ?? result.receipt?.event_id ?? null,
        classification: result.classification,
        reason: result.reason,
        delivered: result.delivered === true,
      })),
    };
    if (sameDispatcher(readOptional(wake.dispatcher), current)) writeJson(wake.dispatcher, current);
    if (results.some((result) => result.classification === 'stale-generation')) {
      opportunity.close();
      return { status: 'RETIRED', reason: 'dispatcher-delivery-fence-changed', results };
    }
    if (cycle + 1 >= maxCycles) {
      opportunity.close();
      return { status: 'OWNED', reason: 'test-cycle-limit', results };
    }
    if (results.some((result) => result.delivered)) {
      opportunity.close();
      continue;
    }
    if (results.some((result) => (
      result.classification === 'uncertain'
      || result.reason?.includes('uncertain')
    ))) {
      opportunity.close();
      return { status: 'OWNED', reason: 'delivery-not-replayable', results };
    }
    if (results.some((result) => result.classification === 'busy')) {
      let signal;
      try { signal = await opportunity.wait(); } finally { opportunity.close(); }
      if (signal.type !== 'bound-rollout-state-change') {
        return { status: 'OWNED', reason: 'bound-rollout-observation-unavailable', results };
      }
      continue;
    }
    opportunity.close();
    const nextObservation = registerObservation(root);
    try { await nextObservation.wait(); } finally { nextObservation.close(); }
  }
  return { status: 'OWNED', reason: 'dispatcher-loop-ended' };
}
