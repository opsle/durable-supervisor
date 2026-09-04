import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { id, now, readJson, writeJson } from './io.js';
import { acquireHostLock, sameProcessIdentity } from './host-lock.js';
import {
  assertReleaseFence,
  createReleaseFence,
  loadRuntimeRelease,
  processStartIdentity,
  releaseConflictMessage,
  releaseIdentity,
} from './runtime-release.js';
import {
  readRegistry,
  registryPaths,
  validateRepositoryMapping,
} from './opsled-registry.js';
import { dispatchRepositoryWakes } from './opsled-wake.js';
import { listOpsledRunners } from './opsled-runner.js';

export const OPSLED_SERVICE_SCHEMA = 'opsle.durable-supervisor.opsled-service/v1';
export const OPSLED_REPOSITORY_STATUS_SCHEMA = 'opsle.durable-supervisor.opsled-repository-status/v1';
const DEFAULT_WORKER = fileURLToPath(new URL('../bin/opsled-worker.js', import.meta.url));

export function defaultOpsledHome(environment = process.env) {
  if (environment.OPSLED_HOME?.trim()) return resolve(environment.OPSLED_HOME.trim());
  const stateHome = environment.XDG_STATE_HOME?.trim()
    ? resolve(environment.XDG_STATE_HOME.trim())
    : join(homedir(), '.local', 'state');
  return join(stateHome, 'opsled');
}

function classifiedError(classification, message) {
  const error = new Error(`${classification}: ${message}`);
  error.code = classification;
  error.classification = classification;
  return error;
}

function readService(hostRoot) {
  const path = registryPaths(hostRoot).service;
  if (!existsSync(path)) return null;
  const record = readJson(path);
  if (record.schema !== OPSLED_SERVICE_SCHEMA
      || typeof record.service_id !== 'string'
      || !Number.isSafeInteger(record.generation) || record.generation < 1
      || !['LAUNCHED', 'OWNED', 'STOPPED', 'FAILED'].includes(record.status)) {
    throw classifiedError('CORRUPT', 'invalid opsled service record');
  }
  return record;
}

function currentService(record, getProcessIdentity = processStartIdentity) {
  const processIdentity = getProcessIdentity(record?.process?.pid);
  if (!sameProcessIdentity(record?.process, processIdentity)) return { current: false, reason: 'process-absent-or-reused' };
  try {
    assertReleaseFence(record.release_fence, {
      role: 'opsled-worker',
      processIdentity,
    });
  } catch {
    return { current: false, reason: 'runtime-release-fence-mismatch', live: true };
  }
  return {
    current: ['LAUNCHED', 'OWNED'].includes(record.status),
    reason: ['LAUNCHED', 'OWNED'].includes(record.status) ? null : `service-${record.status.toLowerCase()}`,
    live: true,
    processIdentity,
  };
}

export function assertCurrentOpsledService(hostRoot, expected, {
  processIdentity = processStartIdentity(),
} = {}) {
  const record = readService(hostRoot);
  if (!record
      || record.service_id !== expected.service_id
      || record.generation !== expected.generation
      || record.launch_nonce !== expected.launch_nonce
      || !sameProcessIdentity(record.process, processIdentity)) {
    throw new Error('opsled service identity was superseded');
  }
  assertReleaseFence(record.release_fence, { role: 'opsled-worker', processIdentity });
  return record;
}

export async function startOpsled(hostRoot = defaultOpsledHome(), {
  spawnProcess = spawn,
  workerScript = DEFAULT_WORKER,
  getProcessIdentity = processStartIdentity,
  handshakeTimeoutMs = 5000,
  intervalMs = 1000,
} = {}) {
  loadRuntimeRelease();
  const launcherFence = createReleaseFence('opsled');
  assertReleaseFence(launcherFence, { role: 'opsled' });
  const host = registryPaths(hostRoot);
  mkdirSync(host.root, { recursive: true, mode: 0o700 });
  const lock = acquireHostLock(host.serviceLock);
  let child = null;
  try {
    const prior = readService(hostRoot);
    const priorStatus = currentService(prior, getProcessIdentity);
    if (priorStatus.current) return { started: false, reason: 'current-opsled-already-live', service: prior };
    if (priorStatus.live && priorStatus.reason === 'runtime-release-fence-mismatch') {
      throw classifiedError('UPGRADE_REQUIRED', releaseConflictMessage(
        prior?.release_fence ?? prior?.expected_release,
        releaseIdentity('opsled-worker'),
      ));
    }
    const record = {
      schema: OPSLED_SERVICE_SCHEMA,
      service_id: id('opsled'),
      generation: (Number(prior?.generation) || 0) + 1,
      launch_nonce: id('opsled-launch'),
      expected_release: releaseIdentity('opsled-worker'),
      release_fence: null,
      process: null,
      status: 'LAUNCHED',
      launched_at: now(),
      owned_at: null,
      stopped_at: null,
      heartbeat_at: null,
      interval_ms: intervalMs,
      last_cycle: null,
      failure: null,
    };
    child = spawnProcess(process.execPath, [
      workerScript,
      '--home', host.root,
      '--service', record.service_id,
      '--generation', String(record.generation),
      '--launch-nonce', record.launch_nonce,
      '--interval-ms', String(intervalMs),
    ], { cwd: fileURLToPath(new URL('..', import.meta.url)), detached: true, stdio: 'ignore' });
    if (!Number.isSafeInteger(child.pid)) throw new Error('opsled worker did not receive a PID');
    const workerIdentity = getProcessIdentity(child.pid);
    if (!workerIdentity) throw new Error('opsled worker process-start identity is unavailable');
    record.process = workerIdentity;
    record.release_fence = createReleaseFence('opsled-worker', workerIdentity);
    writeJson(host.service, record);
    child.unref?.();
    const deadline = Date.now() + handshakeTimeoutMs;
    while (Date.now() <= deadline) {
      const current = readService(hostRoot);
      if (current?.service_id !== record.service_id || current.generation !== record.generation) {
        throw new Error('opsled worker launch was superseded');
      }
      if (current.status === 'OWNED') return { started: true, reason: 'opsled-launched', service: current };
      if (current.status === 'FAILED') throw new Error(current.failure ?? 'opsled worker failed during ownership handshake');
      if (!sameProcessIdentity(workerIdentity, getProcessIdentity(child.pid))) {
        throw new Error('opsled worker exited before durable ownership');
      }
      await sleep(20);
    }
    throw new Error('opsled worker did not establish durable ownership before deadline');
  } finally {
    lock.release();
  }
}

function repositoryStatusPath(mapping) {
  return join(mapping.host_state_path, 'status.json');
}

export async function processOpsledRepository(mapping, {
  releaseFence,
  processIdentity,
  serviceIdentity,
  nativeTransport = null,
  bindingDependencies = {},
} = {}) {
  validateRepositoryMapping(mapping, mapping.repository_id);
  const wake = dispatchRepositoryWakes(mapping, {
    releaseFence,
    processIdentity,
    serviceIdentity,
    nativeTransport,
    bindingDependencies,
  });
  let runners = [];
  try {
    runners = listOpsledRunners(mapping, { releaseFence, processIdentity });
  } catch (error) {
    if (!/ENOENT/.test(error.message)) throw error;
  }
  const status = {
    schema: OPSLED_REPOSITORY_STATUS_SCHEMA,
    repository_id: mapping.repository_id,
    repository_realpath: mapping.repository_realpath,
    service_identity: serviceIdentity,
    status: 'OK',
    observed_at: now(),
    wake: {
      scanned: wake.scanned,
      delivered: wake.delivered,
      classifications: wake.results.map((item) => item.classification),
    },
    runners: runners.map((runner) => ({
      task_id: runner.task_id,
      attempt_id: runner.attempt_id,
      status: runner.status,
      worker: runner.worker,
    })),
    error: null,
  };
  mkdirSync(mapping.host_state_path, { recursive: true, mode: 0o700 });
  writeJson(repositoryStatusPath(mapping), status);
  return status;
}

export async function runOpsledCycle(hostRoot, service, {
  processIdentity = processStartIdentity(),
  processRepository = processOpsledRepository,
  repositoryOptions = {},
} = {}) {
  const current = assertCurrentOpsledService(hostRoot, service, { processIdentity });
  const registry = readRegistry(hostRoot);
  const mappings = Object.values(registry.repositories).filter((mapping) => mapping.enabled);
  const outcomes = await Promise.all(mappings.map((mapping) => Promise.resolve().then(async () => {
    try {
      const value = await processRepository(mapping, {
        ...repositoryOptions,
        releaseFence: current.release_fence,
        processIdentity,
        serviceIdentity: {
          service_id: current.service_id,
          generation: current.generation,
        },
      });
      return { repository_id: mapping.repository_id, status: 'OK', value };
    } catch (error) {
      const value = {
        schema: OPSLED_REPOSITORY_STATUS_SCHEMA,
        repository_id: mapping.repository_id,
        repository_realpath: mapping.repository_realpath,
        service_identity: { service_id: current.service_id, generation: current.generation },
        status: error.classification === 'UPGRADE_REQUIRED' ? 'UPGRADE_REQUIRED' : 'ERROR',
        observed_at: now(),
        wake: null,
        runners: [],
        error: error.message,
      };
      mkdirSync(mapping.host_state_path, { recursive: true, mode: 0o700 });
      writeJson(repositoryStatusPath(mapping), value);
      return { repository_id: mapping.repository_id, status: value.status, error: error.message };
    }
  })));
  return {
    started_at: now(),
    repository_count: mappings.length,
    ok: outcomes.filter((item) => item.status === 'OK').length,
    failed: outcomes.filter((item) => item.status !== 'OK').length,
    outcomes,
  };
}

export async function runOpsledService(hostRoot, identity, {
  intervalMs = 1000,
  maxCycles = Number.POSITIVE_INFINITY,
  processIdentity = processStartIdentity(),
  processRepository = processOpsledRepository,
  delay = sleep,
  shouldStop = () => false,
} = {}) {
  loadRuntimeRelease();
  let service = assertCurrentOpsledService(hostRoot, identity, { processIdentity });
  if (service.status !== 'LAUNCHED') {
    return { status: 'STALE', reason: 'opsled-service-not-launchable' };
  }
  service.status = 'OWNED';
  service.owned_at = now();
  service.heartbeat_at = now();
  writeJson(registryPaths(hostRoot).service, service);
  for (let cycle = 0; cycle < maxCycles; cycle += 1) {
    if (shouldStop()) return { status: 'STOP_REQUESTED', reason: 'signal' };
    try {
      service = assertCurrentOpsledService(hostRoot, identity, { processIdentity });
      const result = await runOpsledCycle(hostRoot, service, {
        processIdentity,
        processRepository,
      });
      service = assertCurrentOpsledService(hostRoot, identity, { processIdentity });
      service.heartbeat_at = now();
      service.last_cycle = result;
      service.failure = null;
      writeJson(registryPaths(hostRoot).service, service);
    } catch (error) {
      try {
        service = assertCurrentOpsledService(hostRoot, identity, { processIdentity });
      } catch {
        return { status: 'RETIRED', reason: 'opsled-service-superseded' };
      }
      service.heartbeat_at = now();
      service.failure = error.message;
      writeJson(registryPaths(hostRoot).service, service);
    }
    if (shouldStop()) return { status: 'STOP_REQUESTED', reason: 'signal' };
    if (cycle + 1 < maxCycles) await delay(intervalMs);
  }
  return { status: 'OWNED', reason: 'cycle-limit', cycles: maxCycles };
}

function readRepositoryOperationalStatus(mapping) {
  const path = repositoryStatusPath(mapping);
  if (!existsSync(path)) return null;
  const status = readJson(path);
  if (status.schema !== OPSLED_REPOSITORY_STATUS_SCHEMA
      || status.repository_id !== mapping.repository_id
      || status.repository_realpath !== mapping.repository_realpath) {
    throw classifiedError('CORRUPT', `invalid opsled repository status for ${mapping.repository_realpath}`);
  }
  return status;
}

export function opsledStatus(hostRoot = defaultOpsledHome(), {
  verbose = false,
  getProcessIdentity = processStartIdentity,
} = {}) {
  loadRuntimeRelease();
  const operationFence = createReleaseFence('opsled');
  assertReleaseFence(operationFence, { role: 'opsled' });
  const release = loadRuntimeRelease();
  const service = readService(hostRoot);
  const serviceState = currentService(service, getProcessIdentity);
  const registry = readRegistry(hostRoot);
  const repositories = Object.values(registry.repositories).map((mapping) => {
    let operational = null;
    let error = null;
    try { operational = readRepositoryOperationalStatus(mapping); } catch (caught) { error = caught.message; }
    return {
      repository_id: mapping.repository_id,
      name: basename(mapping.repository_realpath),
      repository_realpath: mapping.repository_realpath,
      status: error ? 'ERROR' : (operational?.status ?? 'PENDING'),
      wake: operational?.wake ?? null,
      runners: operational?.runners ?? [],
      observed_at: operational?.observed_at ?? null,
      error: error ?? operational?.error ?? null,
      ...(verbose ? { mapping, operational } : {}),
    };
  });
  return {
    schema: 'opsle.durable-supervisor.opsled-status/v1',
    opsled: {
      status: serviceState.current ? 'RUNNING' : (service ? 'STOPPED' : 'NOT_STARTED'),
      reason: serviceState.reason,
      release_id: release.runtime_release_id,
      artifact_digest: release.packaged_artifact_sha256,
      runtime_epoch: release.runtime_epoch,
      service_id: service?.service_id ?? null,
      generation: service?.generation ?? null,
      process: service?.process ?? null,
      heartbeat_at: service?.heartbeat_at ?? null,
      failure: service?.failure ?? null,
    },
    repositories,
    registry: verbose ? registry : {
      revision: registry.revision,
      count: repositories.length,
    },
  };
}

export function renderOpsledStatus(status, { verbose = false } = {}) {
  const lines = [
    'OPSLED',
    `  ${status.opsled.status} release=${status.opsled.release_id}`,
  ];
  if (status.opsled.process) {
    lines.push(`  pid=${status.opsled.process.pid} start=${status.opsled.process.start_time_ticks} generation=${status.opsled.generation}`);
  }
  if (status.opsled.reason) lines.push(`  reason=${status.opsled.reason}`);
  if (verbose) {
    lines.push(`  artifact=${status.opsled.artifact_digest}`);
    lines.push(`  epoch=${status.opsled.runtime_epoch}`);
    if (status.opsled.failure) lines.push(`  failure=${status.opsled.failure}`);
  }
  lines.push('REPOSITORIES');
  if (status.repositories.length === 0) lines.push('  none');
  for (const repository of status.repositories) {
    const wake = repository.wake
      ? ` wake=${repository.wake.delivered}/${repository.wake.scanned}`
      : '';
    const runners = repository.runners.length > 0
      ? ` runners=${repository.runners.map((runner) => runner.status).join(',')}`
      : '';
    lines.push(`  ${repository.name} ${repository.status}${wake}${runners}`);
    if (verbose) {
      lines.push(`    path=${repository.repository_realpath}`);
      lines.push(`    id=${repository.repository_id}`);
      if (repository.error) lines.push(`    error=${repository.error}`);
    }
  }
  return lines.join('\n');
}

export function stopOpsled(hostRoot = defaultOpsledHome(), {
  getProcessIdentity = processStartIdentity,
  signal = process.kill,
} = {}) {
  loadRuntimeRelease();
  const operationFence = createReleaseFence('opsled');
  assertReleaseFence(operationFence, { role: 'opsled' });
  const service = readService(hostRoot);
  if (!service) return { stopped: false, reason: 'opsled-not-started' };
  const current = currentService(service, getProcessIdentity);
  if (!current.current) return { stopped: false, reason: current.reason };
  signal(service.process.pid, 'SIGTERM');
  return { stopped: true, service_id: service.service_id, generation: service.generation };
}
