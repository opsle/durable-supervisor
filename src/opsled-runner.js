import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicCreateJson, canonicalJson, id, now, readJson, sha256, writeJson } from './io.js';
import { paths } from './state.js';
import { launchDetachedAttempt } from './runner.js';
import {
  assertReleaseFence,
  processStartIdentity,
  releaseIdentity,
  sameReleaseIdentity,
} from './runtime-release.js';
import { assertOpsledRepositoryAccess } from './opsled-wake.js';
import {
  readHostOwnershipPointer,
  repositoryOwnershipPaths,
  validateHostOwnershipPointer,
} from './opsled-registry.js';

export const OPSLED_RUNNER_SCHEMA = 'opsle.durable-supervisor.opsled-runner/v1';
export const RUNNER_REQUEST_SCHEMA = 'opsle.durable-supervisor.runner-request/v1';
export const RUNNER_REQUEST_RESULT_SCHEMA = 'opsle.durable-supervisor.runner-request-result/v1';
const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

function hostRunnerPath(mapping, attemptId) {
  return join(mapping.host_state_path, 'runners', `${attemptId}.json`);
}

function requestResultPath(mapping, requestId) {
  return join(mapping.host_state_path, 'runner-requests', `${requestId}.json`);
}

function validateRunnerRequestResult(result, mapping, request) {
  if (result?.schema !== RUNNER_REQUEST_RESULT_SCHEMA
      || result.request_id !== request.request_id
      || result.request_sha256 !== sha256(canonicalJson(request))
      || result.repository_id !== mapping.repository_id
      || !['LAUNCHING', 'RUNNING', 'TERMINAL', 'FAILED', 'UNKNOWN', 'TIMED_OUT'].includes(result.status)
      || !Number.isSafeInteger(result.opsled_process?.pid)
      || typeof result.opsled_process?.start_time_ticks !== 'string'
      || typeof result.opsled_process?.executable !== 'string') {
    throw new Error('invalid opsled Runner request result');
  }
  return result;
}

export function validateRunnerRequest(request, mapping) {
  if (request?.schema !== RUNNER_REQUEST_SCHEMA
      || typeof request.request_id !== 'string'
      || request.repository_id !== mapping.repository_id
      || request.repository_realpath !== mapping.repository_realpath
      || typeof request.supervisor_id !== 'string'
      || typeof request.task_id !== 'string'
      || typeof request.attempt_id !== 'string'
      || typeof request.claim_id !== 'string'
      || !Number.isSafeInteger(request.fence_generation)
      || typeof request.created_at !== 'string'
      || Object.keys(request).sort().join(',') !== [
        'attempt_id', 'claim_id', 'created_at', 'fence_generation', 'repository_id',
        'repository_realpath', 'request_id', 'schema', 'supervisor_id', 'task_id',
      ].sort().join(',')) {
    throw new Error('Runner request does not belong to the registered repository');
  }
  return true;
}

export function createRunnerRequest(root, task, attempt, claim) {
  const pointer = readHostOwnershipPointer(root);
  if (!pointer) throw new Error('repository is not registered with the host opsled');
  validateHostOwnershipPointer(pointer, pointer.repository_realpath);
  const supervisor = readJson(paths(root).supervisor);
  if (task.task_id !== attempt.task_id
      || attempt.claim_id !== claim.claim_id
      || attempt.fence_generation !== claim.fence_generation
      || claim.owner_supervisor_id !== supervisor.supervisor_id) {
    throw new Error('Runner request requires one exact supervisor task/attempt/claim decision');
  }
  const request = {
    schema: RUNNER_REQUEST_SCHEMA,
    request_id: id('runner-request'),
    repository_id: pointer.repository_id,
    repository_realpath: pointer.repository_realpath,
    supervisor_id: supervisor.supervisor_id,
    task_id: task.task_id,
    attempt_id: attempt.attempt_id,
    claim_id: claim.claim_id,
    fence_generation: claim.fence_generation,
    created_at: now(),
  };
  validateRunnerRequest(request, {
    repository_id: pointer.repository_id,
    repository_realpath: pointer.repository_realpath,
  });
  const directory = repositoryOwnershipPaths(root).runnerRequests;
  const target = join(directory, `${request.request_id}.json`);
  if (!atomicCreateJson(target, request)) throw new Error('Runner request identity collision');
  return request;
}

function validateRequestAuthority(mapping, request, { requireActive = true } = {}) {
  validateRunnerRequest(request, mapping);
  const pointer = readJson(mapping.ownership_pointer_path);
  validateHostOwnershipPointer(pointer, mapping.repository_realpath);
  if (pointer.repository_id !== mapping.repository_id
      || pointer.opsled_root !== dirname(dirname(mapping.host_state_path))
      || canonicalJson(pointer.herdr) !== canonicalJson(mapping.herdr)) {
    throw new Error('Runner request host ownership pointer does not match opsled registry');
  }
  const repository = paths(mapping.repository_realpath);
  const state = readJson(repository.state);
  const supervisor = readJson(repository.supervisor);
  const task = readJson(join(repository.tasks, `${request.task_id}.json`));
  const attempt = readJson(join(repository.attempts, `${request.attempt_id}.json`));
  const claim = readJson(join(repository.claims, `${request.claim_id}.json`));
  if (supervisor.supervisor_id !== request.supervisor_id
      || task.task_id !== request.task_id
      || !task.attempts.includes(request.attempt_id)
      || attempt.task_id !== request.task_id
      || attempt.claim_id !== request.claim_id
      || attempt.fence_generation !== request.fence_generation
      || claim.task_id !== request.task_id
      || claim.attempt_id !== request.attempt_id
      || claim.claim_id !== request.claim_id
      || claim.fence_generation !== request.fence_generation
      || (requireActive && (state.active_task_id !== request.task_id
        || state.active_attempt_id !== request.attempt_id
        || (state.pause?.active === true && state.pause.after_current !== true)
        || claim.status !== 'ACTIVE'))) {
    throw new Error('Runner request authority changed before opsled execution');
  }
  return { task, attempt, claim };
}

function publishOpsledRunnerRecord(mapping, task, attempt, claim, worker, {
  releaseFence,
  serviceIdentity = null,
  launchedAt = now(),
} = {}) {
  if (worker.task_id !== task.task_id
      || worker.attempt_id !== attempt.attempt_id
      || worker.claim_id !== claim.claim_id
      || worker.fence_generation !== claim.fence_generation
      || !exactWorkerRelease(worker)) {
    throw new Error('detached Runner did not publish an exact opsled-owned worker identity');
  }
  const repositoryWorkerPath = join(
    paths(mapping.repository_realpath).opsle,
    'workers',
    `${attempt.attempt_id}.json`,
  );
  const record = {
    schema: OPSLED_RUNNER_SCHEMA,
    repository_id: mapping.repository_id,
    repository_realpath: mapping.repository_realpath,
    host_state_path: mapping.host_state_path,
    task_id: task.task_id,
    attempt_id: attempt.attempt_id,
    claim_id: claim.claim_id,
    fence_generation: claim.fence_generation,
    service_identity: serviceIdentity,
    owner_release: {
      runtime_release_id: releaseFence.runtime_release_id,
      packaged_artifact_sha256: releaseFence.packaged_artifact_sha256,
      runtime_epoch: releaseFence.runtime_epoch,
    },
    worker: { ...worker.release_fence.helper_process },
    worker_release_fence: worker.release_fence,
    repository_worker_path: repositoryWorkerPath,
    status: worker.status,
    launched_at: launchedAt,
    last_heartbeat_at: null,
    terminal_at: null,
    raw_result_references: [],
    completion_handoff: null,
    failure: null,
  };
  validateOpsledRunnerRecord(record, mapping);
  const target = hostRunnerPath(mapping, attempt.attempt_id);
  mkdirSync(join(mapping.host_state_path, 'runners'), { recursive: true, mode: 0o700 });
  if (existsSync(target)) {
    const prior = readJson(target);
    validateOpsledRunnerRecord(prior, mapping);
    if (prior.task_id !== record.task_id
        || prior.claim_id !== record.claim_id
        || prior.fence_generation !== record.fence_generation
        || canonicalJson(prior.worker) !== canonicalJson(record.worker)) {
      throw new Error('opsled Runner host record collision');
    }
    return prior;
  }
  writeJson(target, record);
  return record;
}

export async function executeRunnerRequest(mapping, request, {
  releaseFence,
  processIdentity,
  serviceIdentity = null,
  launch = launchDetachedAttempt,
  launchOptions = {},
} = {}) {
  assertOpsledRepositoryAccess(mapping, releaseFence, { processIdentity });
  const target = requestResultPath(mapping, request.request_id);
  mkdirSync(join(mapping.host_state_path, 'runner-requests'), { recursive: true, mode: 0o700 });
  if (existsSync(target)) {
    const existing = validateRunnerRequestResult(readJson(target), mapping, request);
    if (existing.status === 'LAUNCHING'
        && !existsSync(hostRunnerPath(mapping, request.attempt_id))) {
      const repositoryWorkerPath = join(
        paths(mapping.repository_realpath).opsle,
        'workers',
        `${request.attempt_id}.json`,
      );
      if (existsSync(repositoryWorkerPath)) {
        try {
          const { task, attempt, claim } = validateRequestAuthority(mapping, request, {
            requireActive: false,
          });
          const worker = readJson(repositoryWorkerPath);
          const adopted = publishOpsledRunnerRecord(mapping, task, attempt, claim, worker, {
            releaseFence,
            serviceIdentity,
            launchedAt: existing.launched_at ?? now(),
          });
          existing.launched_at = adopted.launched_at;
        } catch (error) {
          existing.status = 'FAILED';
          existing.failure = `published Runner recovery failed: ${error.message}`;
          existing.terminal_at = now();
          writeJson(target, existing);
          return existing;
        }
      }
    }
    if (['LAUNCHING', 'RUNNING'].includes(existing.status)
        && existsSync(hostRunnerPath(mapping, request.attempt_id))) {
      const supervised = superviseOpsledRunner(mapping, request.attempt_id, {
        releaseFence,
        processIdentity,
      });
      existing.status = supervised.status === 'OWNED' ? 'RUNNING' : supervised.status;
      existing.runner_process = supervised.worker;
      existing.terminal_at = supervised.terminal_at;
      existing.failure = supervised.failure;
      writeJson(target, existing);
    } else if (existing.status === 'LAUNCHING') {
      existing.status = 'FAILED';
      existing.failure = 'opsled stopped before exact Runner launch publication';
      existing.terminal_at = now();
      writeJson(target, existing);
    }
    return existing;
  }
  const { task, attempt, claim } = validateRequestAuthority(mapping, request);
  const requestSha256 = sha256(canonicalJson(request));
  const prepared = {
    schema: RUNNER_REQUEST_RESULT_SCHEMA,
    request_id: request.request_id,
    request_sha256: requestSha256,
    repository_id: mapping.repository_id,
    status: 'LAUNCHING',
    opsled_process: processIdentity,
    runner_process: null,
    launched_at: null,
    terminal_at: null,
    failure: null,
  };
  if (!atomicCreateJson(target, prepared)) return readJson(target);
  try {
    const launched = await launchOpsledRunner(mapping, task, attempt, claim, {
      releaseFence,
      processIdentity,
      serviceIdentity,
      launch,
      launchOptions,
    });
    prepared.status = 'RUNNING';
    prepared.runner_process = launched.opsled_runner.worker;
    prepared.launched_at = now();
    writeJson(target, prepared);
  } catch (error) {
    prepared.status = 'FAILED';
    prepared.failure = error.message;
    prepared.terminal_at = now();
    writeJson(target, prepared);
  }
  return validateRunnerRequestResult(prepared, mapping, request);
}

export async function processRunnerRequests(mapping, options = {}) {
  assertOpsledRepositoryAccess(mapping, options.releaseFence, { processIdentity: options.processIdentity });
  const directory = repositoryOwnershipPaths(mapping.repository_realpath).runnerRequests;
  if (!existsSync(directory)) return [];
  const results = [];
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.json')).sort()) {
    const bytes = readFileSync(join(directory, file), 'utf8');
    const request = JSON.parse(bytes);
    if (bytes !== canonicalJson(request)) throw new Error(`Runner request is not canonical JSON: ${file}`);
    validateRunnerRequest(request, mapping);
    if (file !== `${request.request_id}.json`) throw new Error(`Runner request filename mismatch: ${file}`);
    results.push(await executeRunnerRequest(mapping, request, options));
  }
  return results;
}

function exactWorkerRelease(worker) {
  const expected = releaseIdentity('runner-worker');
  return sameReleaseIdentity(worker?.release_fence, expected)
    && worker.release_fence?.helper_process?.pid === worker.worker_pid
    && typeof worker.release_fence?.helper_process?.start_time_ticks === 'string'
    && typeof worker.release_fence?.helper_process?.executable === 'string';
}

export function validateOpsledRunnerRecord(record, mapping) {
  if (record?.schema !== OPSLED_RUNNER_SCHEMA
      || record.repository_id !== mapping.repository_id
      || record.repository_realpath !== mapping.repository_realpath
      || record.host_state_path !== mapping.host_state_path
      || typeof record.task_id !== 'string'
      || typeof record.attempt_id !== 'string'
      || typeof record.claim_id !== 'string'
      || !Number.isSafeInteger(record.fence_generation)
      || !Number.isSafeInteger(record.worker?.pid)
      || typeof record.worker?.start_time_ticks !== 'string'
      || typeof record.worker?.executable !== 'string') {
    throw new Error('opsled Runner repository/PID/fence identity mismatch');
  }
  return true;
}

export async function launchOpsledRunner(mapping, task, attempt, claim, {
  releaseFence,
  processIdentity,
  serviceIdentity = null,
  launch = launchDetachedAttempt,
  launchOptions = {},
} = {}) {
  assertOpsledRepositoryAccess(mapping, releaseFence, { processIdentity });
  if (task.task_id !== attempt.task_id
      || attempt.claim_id !== claim.claim_id
      || attempt.fence_generation !== claim.fence_generation) {
    throw new Error('opsled Runner task/attempt/claim fence mismatch');
  }
  const result = await launch(
    mapping.repository_realpath,
    task,
    attempt,
    claim,
    launchOptions,
  );
  const repositoryWorkerPath = join(
    paths(mapping.repository_realpath).opsle,
    'workers',
    `${attempt.attempt_id}.json`,
  );
  const worker = readJson(repositoryWorkerPath);
  if (worker.worker_pid !== result.worker_pid) {
    throw new Error('detached Runner did not publish an exact opsled-owned worker identity');
  }
  const record = publishOpsledRunnerRecord(mapping, task, attempt, claim, worker, {
    releaseFence,
    serviceIdentity,
  });
  return { ...result, opsled_runner: record };
}

export function superviseOpsledRunner(mapping, attemptId, {
  releaseFence,
  processIdentity,
  getProcessIdentity = processStartIdentity,
  referenceTime = Date.now(),
} = {}) {
  assertOpsledRepositoryAccess(mapping, releaseFence, { processIdentity });
  const recordPath = hostRunnerPath(mapping, attemptId);
  const record = readJson(recordPath);
  validateOpsledRunnerRecord(record, mapping);
  const worker = readJson(record.repository_worker_path);
  if (worker.task_id !== record.task_id
      || worker.attempt_id !== record.attempt_id
      || worker.claim_id !== record.claim_id
      || worker.fence_generation !== record.fence_generation
      || worker.worker_pid !== record.worker.pid
      || worker.release_fence?.helper_process?.pid !== record.worker.pid
      || worker.release_fence?.helper_process?.start_time_ticks !== record.worker.start_time_ticks
      || worker.release_fence?.helper_process?.executable !== record.worker.executable
      || !sameReleaseIdentity(worker.release_fence, releaseIdentity('runner-worker'))) {
    throw new Error('cross-repository or stale detached Runner fence rejected');
  }
  const attempt = readJson(join(paths(mapping.repository_realpath).attempts, `${attemptId}.json`));
  if (attempt.task_id !== record.task_id
      || attempt.claim_id !== record.claim_id
      || attempt.fence_generation !== record.fence_generation) {
    throw new Error('repository attempt no longer matches opsled Runner fence');
  }
  const liveIdentity = getProcessIdentity(record.worker.pid);
  const workerLive = liveIdentity != null
    && liveIdentity.pid === record.worker.pid
    && liveIdentity.start_time_ticks === record.worker.start_time_ticks
    && liveIdentity.executable === record.worker.executable;
  if (workerLive) {
    assertReleaseFence(record.worker_release_fence, {
      role: 'runner-worker',
      processIdentity: liveIdentity,
    });
  }
  const terminal = TERMINAL.has(attempt.child_state) && worker.status === 'TERMINAL';
  const deadline = Date.parse(attempt.wait_registration?.deadline_at ?? '');
  const timedOut = !terminal && Number.isFinite(deadline) && referenceTime > deadline;
  record.status = terminal
    ? 'TERMINAL'
    : (worker.status === 'FAILED'
      ? 'FAILED'
      : (timedOut ? 'TIMED_OUT' : (workerLive ? worker.status : 'UNKNOWN')));
  record.last_heartbeat_at = attempt.heartbeat_at ?? worker.owned_at ?? null;
  record.failure = worker.failure ?? (record.status === 'UNKNOWN'
    ? 'detached Runner process is absent without exact terminal publication'
    : (timedOut ? 'detached Runner exceeded its registered deadline' : null));
  if (terminal) {
    record.terminal_at = worker.terminal_at ?? attempt.completed_at ?? now();
    record.raw_result_references = attempt.raw_evidence ?? [];
    record.completion_handoff = attempt.completion_handoff ?? null;
  }
  writeJson(recordPath, record);
  return record;
}

export function listOpsledRunners(mapping, {
  releaseFence,
  processIdentity,
} = {}) {
  assertOpsledRepositoryAccess(mapping, releaseFence, { processIdentity });
  const activeAttempt = readJson(paths(mapping.repository_realpath).state).active_attempt_id;
  if (!activeAttempt || !existsSync(hostRunnerPath(mapping, activeAttempt))) return [];
  return [superviseOpsledRunner(mapping, activeAttempt, { releaseFence, processIdentity })];
}
