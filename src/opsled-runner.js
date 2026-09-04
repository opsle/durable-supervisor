import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { now, readJson, writeJson } from './io.js';
import { paths } from './state.js';
import { launchDetachedAttempt } from './runner.js';
import {
  assertReleaseFence,
  processStartIdentity,
  releaseIdentity,
  sameReleaseIdentity,
} from './runtime-release.js';
import { assertOpsledRepositoryAccess } from './opsled-wake.js';

export const OPSLED_RUNNER_SCHEMA = 'opsle.durable-supervisor.opsled-runner/v1';
const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

function hostRunnerPath(mapping, attemptId) {
  return join(mapping.host_state_path, 'runners', `${attemptId}.json`);
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
  if (worker.task_id !== task.task_id
      || worker.attempt_id !== attempt.attempt_id
      || worker.claim_id !== claim.claim_id
      || worker.fence_generation !== claim.fence_generation
      || worker.worker_pid !== result.worker_pid
      || !exactWorkerRelease(worker)) {
    throw new Error('detached Runner did not publish an exact opsled-owned worker identity');
  }
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
    launched_at: now(),
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
        || prior.fence_generation !== record.fence_generation) {
      throw new Error('opsled Runner host record collision');
    }
  }
  writeJson(target, record);
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
