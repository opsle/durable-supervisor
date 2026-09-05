import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { canonicalJson, now, readJson, sha256, writeJson } from './io.js';
import { paths } from './state.js';
import {
  assertReleaseFence,
  createReleaseFence,
  processStartIdentity,
} from './runtime-release.js';
import { classifyQueuedWake, deliverWake } from './wakeup.js';
import { validateRepositoryMapping } from './opsled-registry.js';
import { sameProcessIdentity } from './host-lock.js';

export const OPSLED_WAKE_RESULT_SCHEMA = 'opsle.durable-supervisor.opsled-wake-result/v1';
export const OPSLED_WAKE_TRANSPORT_SCHEMA = 'opsle.durable-supervisor.opsled-wake-transport/v1';
const DEFAULT_WAKE_WORKER = fileURLToPath(new URL('../bin/opsled-wake-worker.js', import.meta.url));

export function assertOpsledRepositoryAccess(mapping, releaseFence, {
  processIdentity = processStartIdentity(),
} = {}) {
  validateRepositoryMapping(mapping, mapping.repository_id);
  assertReleaseFence(releaseFence, { role: 'opsled-worker', processIdentity });
  return true;
}

function requestFiles(root) {
  const directory = join(paths(root).opsle, 'wake', 'requests');
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => join(directory, name));
}

export function repositoryBindingDependencies(mapping, overrides = {}) {
  return {
    ...overrides,
    environment: overrides.environment ?? (() => ({})),
    sessionsRoot: overrides.sessionsRoot ?? (() => mapping.herdr?.sessions_root_realpath ?? null),
    expectedHerdr: overrides.expectedHerdr ?? {
      workspace_id: mapping.herdr?.workspace_id ?? null,
    },
  };
}

export function canonicalOpsledEnvironment(mapping) {
  const accountHome = userInfo().homedir;
  return {
    HOME: accountHome,
    PATH: [
      join(accountHome, '.npm-global', 'bin'),
      join(accountHome, '.local', 'bin'),
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
    ].join(':'),
    CODEX_HOME: dirname(mapping.herdr.sessions_root_realpath),
    LANG: 'C.UTF-8',
    TERM: 'xterm-256color',
  };
}

export function dispatchRepositoryWakes(mapping, {
  releaseFence,
  processIdentity,
  serviceIdentity,
  nativeTransport = null,
  bindingDependencies = {},
  deliver = deliverWake,
} = {}) {
  assertOpsledRepositoryAccess(mapping, releaseFence, { processIdentity });
  if (typeof serviceIdentity?.service_id !== 'string'
      || !Number.isSafeInteger(serviceIdentity?.generation)) {
    throw new Error('opsled wake dispatch requires current service identity');
  }
  const root = mapping.repository_realpath;
  const results = [];
  for (const path of requestFiles(root)) {
    let request;
    try {
      request = readJson(path);
      results.push(deliver(root, request.event_id, {
        nativeTransport,
        bindingDependencies: repositoryBindingDependencies(mapping, bindingDependencies),
        expectedQueueVersion: request.queue_version,
        activationOwner: {
          schema: 'opsle.durable-supervisor.opsled-wake-owner/v1',
          kind: 'opsled',
          service_id: serviceIdentity.service_id,
          service_generation: serviceIdentity.generation,
          release_fence: releaseFence,
          process: processIdentity,
        },
      }));
    } catch (error) {
      results.push({
        classification: error.classification ?? 'error',
        reason: error.message,
        event_id: request?.event_id ?? null,
        delivered: false,
      });
    }
  }
  return {
    schema: OPSLED_WAKE_RESULT_SCHEMA,
    repository_id: mapping.repository_id,
    repository_realpath: root,
    scanned: results.length,
    delivered: results.filter((item) => item.delivered === true).length,
    results,
  };
}

export function wakeTransportPath(mapping, eventId) {
  return join(mapping.host_state_path, 'wake-transports', `${eventId}.json`);
}

export function validateWakeTransportRecord(record, mapping) {
  if (record?.schema !== OPSLED_WAKE_TRANSPORT_SCHEMA
      || record.repository_id !== mapping.repository_id
      || record.repository_realpath !== mapping.repository_realpath
      || typeof record.event_id !== 'string'
      || !/^[a-f0-9]{64}$/.test(record.request_sha256 ?? '')
      || !['LAUNCHED', 'RUNNING', 'DELIVERED', 'NO_DELIVERY', 'FAILED'].includes(record.status)
      || !Number.isSafeInteger(record.worker?.pid)
      || typeof record.worker?.start_time_ticks !== 'string'
      || typeof record.worker?.executable !== 'string'
      || typeof record.owner?.service_id !== 'string'
      || !Number.isSafeInteger(record.owner?.generation)
      || typeof record.owner?.launch_nonce !== 'string'
      || !Number.isSafeInteger(record.owner?.process?.pid)
      || typeof record.owner?.process?.start_time_ticks !== 'string'
      || typeof record.owner?.process?.executable !== 'string'
      || ![null, 'string'].includes(record.reason == null ? null : typeof record.reason)) {
    throw new Error('invalid opsled wake transport record');
  }
  return true;
}

export function launchWakeTransport(mapping, request, {
  releaseFence,
  processIdentity,
  serviceIdentity,
  spawnProcess = spawn,
  workerScript = DEFAULT_WAKE_WORKER,
  getProcessIdentity = processStartIdentity,
} = {}) {
  assertOpsledRepositoryAccess(mapping, releaseFence, { processIdentity });
  if (!/^event-[A-Za-z0-9_-]+$/.test(request.event_id ?? '')
      || !Number.isSafeInteger(request.queue_version)
      || request.queue_version < 1
      || request.target?.repository !== mapping.repository_realpath) {
    throw new Error('wake request does not belong to the registered repository');
  }
  if (!sameProcessIdentity(serviceIdentity?.process, processIdentity)
      || typeof serviceIdentity?.service_id !== 'string'
      || !Number.isSafeInteger(serviceIdentity?.generation)
      || typeof serviceIdentity?.launch_nonce !== 'string') {
    throw new Error('wake transport requires exact current opsled process ownership');
  }
  const target = wakeTransportPath(mapping, request.event_id);
  if (existsSync(target)) {
    const prior = readJson(target);
    validateWakeTransportRecord(prior, mapping);
    const live = getProcessIdentity(prior.worker.pid);
    if (['LAUNCHED', 'RUNNING'].includes(prior.status)
        && sameProcessIdentity(prior.worker, live)) {
      return {
        classification: 'transport-running',
        reason: prior.reason ?? 'wake-transport-worker-current',
        delivered: false,
        record: prior,
      };
    }
    if (prior.status === 'DELIVERED') {
      return {
        classification: prior.status.toLowerCase(),
        reason: 'event-already-delivered',
        delivered: true,
        record: prior,
      };
    }
  }
  const child = spawnProcess(process.execPath, [
    workerScript,
    '--home', serviceIdentity.host_root,
    '--repository', mapping.repository_id,
    '--event', request.event_id,
  ], {
    cwd: mapping.repository_realpath,
    detached: true,
    stdio: 'ignore',
    env: canonicalOpsledEnvironment(mapping),
  });
  if (!Number.isSafeInteger(child.pid)) throw new Error('wake transport worker did not receive a PID');
  const worker = getProcessIdentity(child.pid);
  if (!worker) throw new Error('wake transport worker process identity is unavailable');
  const record = {
    schema: OPSLED_WAKE_TRANSPORT_SCHEMA,
    repository_id: mapping.repository_id,
    repository_realpath: mapping.repository_realpath,
    event_id: request.event_id,
    request_sha256: sha256(canonicalJson(request)),
    owner: {
      service_id: serviceIdentity.service_id,
      generation: serviceIdentity.generation,
      launch_nonce: serviceIdentity.launch_nonce,
      process: processIdentity,
    },
    worker,
    worker_release_fence: createReleaseFence('opsled-wake-worker', worker),
    status: 'LAUNCHED',
    launched_at: now(),
    terminal_at: null,
    classification: null,
    reason: 'wake-transport-worker-launched',
    failure: null,
  };
  mkdirSync(join(mapping.host_state_path, 'wake-transports'), { recursive: true, mode: 0o700 });
  writeJson(target, record);
  child.unref?.();
  return {
    classification: 'transport-launched',
    reason: record.reason,
    delivered: false,
    record,
  };
}

export function persistWakeTransportOutcome(mapping, eventId, worker, result) {
  const target = wakeTransportPath(mapping, eventId);
  const record = readJson(target);
  validateWakeTransportRecord(record, mapping);
  if (!sameProcessIdentity(record.worker, worker)) {
    throw new Error('wake transport outcome worker identity mismatch');
  }
  const missingReason = result?.delivered !== true
    && (typeof result?.reason !== 'string' || result.reason.length === 0);
  record.status = missingReason
    ? 'FAILED'
    : (result.delivered ? 'DELIVERED' : 'NO_DELIVERY');
  record.classification = result?.classification ?? null;
  record.reason = missingReason
    ? 'wake-delivery-non-delivery-reason-missing'
    : (result?.reason ?? null);
  record.failure = missingReason ? record.reason : null;
  record.terminal_at = now();
  writeJson(target, record);
  return record;
}

export function reconcileOpsledTransportNotStarted(mapping, eventId, {
  getProcessIdentity = processStartIdentity,
} = {}) {
  const root = mapping.repository_realpath;
  const target = wakeTransportPath(mapping, eventId);
  const record = readJson(target);
  validateWakeTransportRecord(record, mapping);
  if (record.status !== 'NO_DELIVERY' || record.classification !== 'queued') {
    throw new Error('opsled transport is not a receipt-free queued non-delivery');
  }
  if (sameProcessIdentity(record.worker, getProcessIdentity(record.worker.pid))) {
    throw new Error('opsled transport worker is still current');
  }
  const activationDecision = join(root, '.opsle', 'wake', 'activation-decisions', `${eventId}.json`);
  const deliveryReceipt = join(root, '.opsle', 'wake', 'deliveries', `${eventId}.json`);
  const attemptsDirectory = join(root, '.opsle', 'wake', 'transport-attempts');
  const matchingAttempts = existsSync(attemptsDirectory)
    ? readdirSync(attemptsDirectory)
      .filter((name) => name.endsWith('.json'))
      .map((name) => readJson(join(attemptsDirectory, name)))
      .filter((attempt) => attempt.event_id === eventId)
    : [];
  if (existsSync(activationDecision) || existsSync(deliveryReceipt) || matchingAttempts.length > 0) {
    throw new Error('native transport start absence is not proven');
  }
  record.classification = 'transport-not-started';
  record.reason = 'no activation decision, transport attempt, or delivery receipt exists';
  record.reconciled_at = now();
  record.reconciliation = {
    worker_current: false,
    activation_decision_exists: false,
    transport_attempt_count: 0,
    delivery_receipt_exists: false,
  };
  writeJson(target, record);
  return record;
}

export function launchRepositoryWakeTransports(mapping, options = {}) {
  assertOpsledRepositoryAccess(mapping, options.releaseFence, { processIdentity: options.processIdentity });
  const results = [];
  for (const path of requestFiles(mapping.repository_realpath)) {
    let request;
    try {
      const bytes = readFileSync(path, 'utf8');
      request = JSON.parse(bytes);
      if (bytes !== canonicalJson(request)) throw new Error('wake request is not canonical JSON');
      const lifecycle = classifyQueuedWake(mapping.repository_realpath, request);
      if (lifecycle.classification !== 'queued'
          || lifecycle.reason !== 'awaiting-supported-native-transport') {
        results.push({
          event_id: request.event_id,
          classification: lifecycle.classification,
          reason: lifecycle.reason,
          delivered: false,
        });
        continue;
      }
      results.push(launchWakeTransport(mapping, request, options));
    } catch (error) {
      results.push({
        classification: error.classification ?? 'error',
        reason: error.message,
        event_id: request?.event_id ?? null,
        delivered: false,
      });
    }
  }
  return {
    schema: OPSLED_WAKE_RESULT_SCHEMA,
    repository_id: mapping.repository_id,
    repository_realpath: mapping.repository_realpath,
    scanned: results.length,
    delivered: results.filter((item) => item.delivered === true).length,
    results,
  };
}
