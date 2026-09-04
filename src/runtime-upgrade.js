import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { now, readJson, writeJson } from './io.js';
import { sameProcessIdentity } from './host-lock.js';
import { acquireUpgradeLock, readRegistry, registryPaths } from './opsled-registry.js';
import { validateOpsledRunnerRecord } from './opsled-runner.js';
import { validateWakeTransportRecord } from './opsled-wake.js';
import {
  loadRuntimeRelease,
  processStartIdentity,
  releaseConflictMessage,
  releaseIdentity,
  runtimePackageRoot,
} from './runtime-release.js';

export const RUNTIME_CURRENT_SCHEMA = 'opsle.durable-supervisor.runtime-current/v1';
export const RUNTIME_UPGRADE_STATUS_SCHEMA = 'opsle.durable-supervisor.runtime-upgrade-status/v1';

function classifiedError(classification, message) {
  const error = new Error(`${classification}: ${message}`);
  error.code = classification;
  error.classification = classification;
  return error;
}

export function runtimeHostPaths(hostRoot) {
  const runtime = join(registryPaths(hostRoot).root, 'runtime');
  return {
    runtime,
    releases: join(runtime, 'releases'),
    current: join(runtime, 'current.json'),
    status: join(runtime, 'upgrade-status.json'),
  };
}

function releaseSummary(release, releaseRoot) {
  return {
    runtime_release_id: release.runtime_release_id,
    version: release.version,
    source_revision: release.source_revision,
    packaged_artifact_sha256: release.packaged_artifact_sha256,
    runtime_epoch: release.runtime_epoch,
    release_root: realpathSync(releaseRoot),
  };
}

function sameRelease(left, right) {
  return left != null && right != null
    && left.runtime_release_id === right.runtime_release_id
    && left.packaged_artifact_sha256 === right.packaged_artifact_sha256
    && left.runtime_epoch === right.runtime_epoch;
}

export function readCurrentRuntime(hostRoot) {
  const path = runtimeHostPaths(hostRoot).current;
  if (!existsSync(path)) return null;
  let current;
  try { current = readJson(path); } catch (error) {
    throw classifiedError('CORRUPT', `managed runtime pointer is unreadable: ${error.message}`);
  }
  if (current?.schema !== RUNTIME_CURRENT_SCHEMA
      || typeof current.release_root !== 'string'
      || !/^[a-f0-9]{64}$/.test(current.packaged_artifact_sha256 ?? '')
      || typeof current.switched_at !== 'string') {
    throw classifiedError('CORRUPT', 'managed runtime pointer is malformed');
  }
  let installed;
  let installedRoot;
  try {
    installedRoot = realpathSync(current.release_root);
    if (installedRoot !== join(runtimeHostPaths(hostRoot).releases, current.packaged_artifact_sha256)) {
      throw new Error('release root is outside its digest directory');
    }
    installed = loadRuntimeRelease({ root: installedRoot });
  } catch (error) {
    throw classifiedError('CORRUPT', `managed runtime artifact is unavailable: ${error.message}`);
  }
  if (!sameRelease(current, installed)) {
    throw classifiedError('CORRUPT', 'managed runtime pointer does not match its immutable artifact');
  }
  return current;
}

export function assertInvokingRuntimeAuthority(hostRoot, { root = runtimePackageRoot() } = {}) {
  const current = readCurrentRuntime(hostRoot);
  if (!current) return { managed: false, current: null };
  const invoking = releaseIdentity('opsled-worker', { root });
  if (realpathSync(root) !== current.release_root || !sameRelease(current, invoking)) {
    throw classifiedError('UPGRADE_REQUIRED', releaseConflictMessage(current, invoking));
  }
  return { managed: true, current };
}

export function assertRuntimeStartAllowed(hostRoot, { root = runtimePackageRoot() } = {}) {
  const paths = runtimeHostPaths(hostRoot);
  const status = existsSync(paths.status) ? readJson(paths.status) : null;
  const invoking = releaseIdentity('opsled-worker', { root });
  if (status?.status === 'RUNNING') {
    const targetMayStart = status.phase === 'SWITCHED'
      && sameRelease(status.target, invoking);
    if (!targetMayStart) throw classifiedError('BUSY', `runtime upgrade is ${status.phase}`);
  }
  if (status?.status === 'FAILED'
      && ['MIGRATING', 'MIGRATED'].includes(status.failure?.failed_phase)) {
    throw classifiedError('UPGRADE_REQUIRED', 'a failed repository migration must be resumed with its target runtime');
  }
  return assertInvokingRuntimeAuthority(hostRoot, { root });
}

function jsonFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => join(directory, name));
}

export function inventoryManagedRuntime(hostRoot, {
  getProcessIdentity = processStartIdentity,
} = {}) {
  const host = registryPaths(hostRoot);
  const registry = readRegistry(hostRoot);
  const processes = [];
  const repositories = [];
  if (existsSync(host.service)) {
    try {
      const service = readJson(host.service);
      if (!Number.isSafeInteger(service.process?.pid)
          || typeof service.process?.start_time_ticks !== 'string'
          || typeof service.process?.executable !== 'string'
          || typeof service.release_fence?.packaged_artifact_sha256 !== 'string') {
        throw new Error('invalid opsled service process or release identity');
      }
      processes.push({ kind: 'opsled', repository_id: null, process: service.process, release: service.release_fence });
    } catch (error) {
      throw classifiedError('CORRUPT', `opsled service inventory failed: ${error.message}`);
    }
  }
  for (const mapping of Object.values(registry.repositories)) {
    const repository = { repository_id: mapping.repository_id, repository_realpath: mapping.repository_realpath, errors: [] };
    for (const [kind, directory] of [
      ['runner', join(mapping.host_state_path, 'runners')],
      ['wake-transport', join(mapping.host_state_path, 'wake-transports')],
    ]) {
      try {
        for (const path of jsonFiles(directory)) {
          const record = readJson(path);
          if (kind === 'runner') validateOpsledRunnerRecord(record, mapping);
          else validateWakeTransportRecord(record, mapping);
          const processIdentity = record.worker;
          if (!Number.isSafeInteger(processIdentity?.pid)
              || typeof processIdentity.start_time_ticks !== 'string'
              || typeof processIdentity.executable !== 'string') {
            throw new Error(`invalid ${kind} process identity at ${path}`);
          }
          processes.push({
            kind,
            repository_id: mapping.repository_id,
            process: processIdentity,
            release: record.worker_release_fence,
          });
        }
      } catch (error) {
        repository.errors.push(`${kind}: ${error.message}`);
      }
    }
    repositories.push(repository);
  }
  for (const entry of processes) {
    entry.live = sameProcessIdentity(entry.process, getProcessIdentity(entry.process?.pid));
  }
  return {
    observed_at: now(),
    repositories,
    processes,
    failures: repositories.filter((repository) => repository.errors.length > 0),
  };
}

function installRelease(hostRoot, sourceRoot, release) {
  const paths = runtimeHostPaths(hostRoot);
  mkdirSync(paths.releases, { recursive: true, mode: 0o700 });
  const destination = join(paths.releases, release.packaged_artifact_sha256);
  if (existsSync(destination)) {
    const installed = loadRuntimeRelease({ root: destination });
    if (!sameRelease(installed, release)) throw classifiedError('CORRUPT', 'runtime digest directory collision');
    return realpathSync(destination);
  }
  const temporary = `${destination}.installing-${process.pid}`;
  rmSync(temporary, { recursive: true, force: true });
  mkdirSync(temporary, { recursive: true, mode: 0o700 });
  try {
    for (const entry of release.artifact.files) {
      const source = join(sourceRoot, entry.path);
      const target = join(temporary, entry.path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      copyFileSync(source, target);
      chmodSync(target, (statSync(source).mode & 0o111) === 0 ? 0o444 : 0o555);
    }
    loadRuntimeRelease({ root: temporary });
    renameSync(temporary, destination);
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  return realpathSync(destination);
}

function semverCore(version) {
  return version.split(/[+-]/, 1)[0].split('.').map(Number);
}

function compareVersions(left, right) {
  const a = semverCore(left);
  const b = semverCore(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

async function stopCurrentService(hostRoot, service, {
  signal = process.kill,
  getProcessIdentity = processStartIdentity,
  timeoutMs = 10000,
} = {}) {
  if (!service?.live) return;
  signal(service.process.pid, 'SIGTERM');
  const deadline = Date.now() + timeoutMs;
  while (sameProcessIdentity(service.process, getProcessIdentity(service.process.pid))) {
    if (Date.now() >= deadline) throw classifiedError('BUSY', 'current opsled did not stop before the upgrade deadline');
    await sleep(20);
  }
}

function assertQuiescentInventory(inventory) {
  if (inventory.failures.length > 0) {
    throw classifiedError('CORRUPT', 'one or more repository process inventories are unreadable');
  }
  const transients = inventory.processes.filter((entry) => entry.kind !== 'opsled' && entry.live);
  if (transients.length > 0) {
    throw classifiedError('BUSY', `${transients.length} transient managed process(es) are still live`);
  }
}

async function migrateRepositoriesWithTarget(releaseRoot, registry) {
  const moduleUrl = pathToFileURL(join(releaseRoot, 'src', 'durable-schema.js'));
  moduleUrl.searchParams.set('artifact', releaseRoot.split('/').at(-1));
  const targetSchema = await import(moduleUrl.href);
  if (typeof targetSchema.ensureDurableCompatibility !== 'function') {
    throw classifiedError('UPGRADE_REQUIRED', 'target runtime has no durable migration entrypoint');
  }
  const results = [];
  for (const mapping of Object.values(registry.repositories)) {
    try {
      const compatibility = targetSchema.ensureDurableCompatibility(mapping.repository_realpath);
      results.push({ repository_id: mapping.repository_id, status: 'OK', compatibility });
    } catch (error) {
      results.push({
        repository_id: mapping.repository_id,
        status: error.classification ?? 'CORRUPT',
        error: error.message,
      });
    }
  }
  return results;
}

function defaultStartTarget(releaseRoot) {
  const result = spawnSync(process.execPath, [join(releaseRoot, 'bin', 'opsled.js'), 'start'], {
    cwd: releaseRoot,
    env: {
      HOME: userInfo().homedir,
      PATH: '/usr/local/bin:/usr/bin:/bin',
      LANG: 'C.UTF-8',
    },
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'target opsled failed to start');
  return result.stdout.trim();
}

export async function upgradeHostRuntime(hostRoot, sourcePath, {
  getProcessIdentity = processStartIdentity,
  signal = process.kill,
  stopTimeoutMs = 10000,
  startTarget = defaultStartTarget,
} = {}) {
  const sourceRoot = realpathSync(resolve(sourcePath));
  const target = loadRuntimeRelease({ root: sourceRoot });
  const owner = processStartIdentity();
  const paths = runtimeHostPaths(hostRoot);
  mkdirSync(paths.runtime, { recursive: true, mode: 0o700 });
  const lock = acquireUpgradeLock(hostRoot);
  let status = {
    schema: RUNTIME_UPGRADE_STATUS_SCHEMA,
    owner_process: owner,
    target: releaseSummary(target, sourceRoot),
    phase: 'LOCKED',
    status: 'RUNNING',
    inventory: null,
    repositories: [],
    failure: null,
    started_at: now(),
    updated_at: now(),
    completed_at: null,
  };
  const persist = (phase) => {
    status.phase = phase;
    status.updated_at = now();
    writeJson(paths.status, status);
  };
  persist('LOCKED');
  let releaseRoot;
  try {
    const prior = readCurrentRuntime(hostRoot);
    if (prior && compareVersions(target.version, prior.version) < 0) {
      throw classifiedError('UPGRADE_REQUIRED', `runtime downgrade from ${prior.version} to ${target.version} is unsupported`);
    }
    releaseRoot = installRelease(hostRoot, sourceRoot, target);
    status.target = releaseSummary(target, releaseRoot);
    persist('INSTALLED');
    const initialInventory = inventoryManagedRuntime(hostRoot, { getProcessIdentity });
    assertQuiescentInventory(initialInventory);
    const service = initialInventory.processes.find((entry) => entry.kind === 'opsled');
    await stopCurrentService(hostRoot, service, { signal, getProcessIdentity, timeoutMs: stopTimeoutMs });
    persist('STOPPED');
    status.inventory = inventoryManagedRuntime(hostRoot, { getProcessIdentity });
    persist('INVENTORIED');
    assertQuiescentInventory(status.inventory);
    const registry = readRegistry(hostRoot);
    persist('MIGRATING');
    status.repositories = await migrateRepositoriesWithTarget(releaseRoot, registry);
    persist('MIGRATED');
    const failed = status.repositories.filter((repository) => repository.status !== 'OK');
    if (failed.length > 0) {
      throw classifiedError('CORRUPT', `${failed.length} repository migration(s) failed`);
    }
    const current = {
      schema: RUNTIME_CURRENT_SCHEMA,
      ...releaseSummary(target, releaseRoot),
      switched_at: now(),
    };
    writeJson(paths.current, current);
    persist('SWITCHED');
  } catch (error) {
    const failedPhase = status.phase;
    status.status = 'FAILED';
    status.failure = {
      classification: error.classification ?? 'ERROR',
      message: error.message,
      failed_phase: failedPhase,
      at: now(),
    };
    try { persist('FAILED'); } finally { lock.release(); }
    throw error;
  }
  try {
    await startTarget(releaseRoot, registryPaths(hostRoot).root);
    status.status = 'COMPLETED';
    status.completed_at = now();
    persist('COMPLETED');
    return status;
  } catch (error) {
    const failedPhase = status.phase;
    status.status = 'FAILED';
    status.failure = {
      classification: error.classification ?? 'ERROR',
      message: error.message,
      failed_phase: failedPhase,
      at: now(),
    };
    persist('FAILED');
    throw error;
  } finally {
    lock.release();
  }
}

export function runtimeUpgradeStatus(hostRoot) {
  const paths = runtimeHostPaths(hostRoot);
  const current = readCurrentRuntime(hostRoot);
  const status = existsSync(paths.status) ? readJson(paths.status) : null;
  return { current, status, inventory: inventoryManagedRuntime(hostRoot) };
}
