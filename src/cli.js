import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import {
  dirname,
  join,
  relative,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  appendEvent,
  atomicCreateJson,
  canonicalJson,
  fileSha256,
  id,
  now,
  readJson,
  sha256,
  writeJson,
} from './io.js';
import {
  NEXT_UNSATISFIED_REQUIREMENT_ACTION,
  REVIEW_MODES,
  derivePendingNextAction,
  effectiveRequirementMatrix,
  emit,
  initialize,
  paths,
  repositoryRoot,
  setRequirements,
  updateState,
  validateDurableState,
} from './state.js';
import {
  createAttempt,
  createTask,
  discoverCapabilities,
  releaseClaim,
  routeTask,
} from './pipeline.js';
import { createRunnerRequest } from './opsled-runner.js';
import {
  loadSelectedSupervisorSkillInstructions,
  readSupervisorRoutingDecision,
  selectSupervisorRoute,
} from './supervisor-routing.js';
import { activationSummary } from './activation-telemetry.js';
import {
  deriveDisplayState,
  renderModels,
  renderPolicy,
  renderSession,
  renderSupervisorStatus,
  renderWakeStatus,
  selectWakeRecords,
} from './operator-display.js';
import {
  generateResumePacket,
  readResumeEvidence,
  readResumePacket,
} from './reconstruction.js';
import {
  adoptCodexSessionBinding,
  applyWakeEvent,
  bindCodexSession,
  consumeWakeDelivery,
  refreshCodexSessionBinding,
  unconsumedDeliveredWakes,
  wakeDeliveryConsumptionStatus,
  wakeQueueStatus,
  reconcileWakeTransportNotStarted,
  consumeReconciledTransportNotStarted,
  codexSessionBindingStatus,
} from './wakeup.js';
import {
  loadRuntimeRelease,
} from './runtime-release.js';
import { ensureDurableCompatibility } from './durable-schema.js';

function usage() {
  return `usage: opsle COMMAND

commands:
  --version
  init [--objective TEXT] [--json]
  status [--verbose|--json] [--watch [--iterations N] [--interval-ms MS]]
  validate
  recover
  resume-packet generate [--recover]
  resume-packet show
  resume-packet evidence --path RELATIVE_PATH
  reconcile runner-failure --task TASK_ID --attempt ATTEMPT_ID
    --claim CLAIM_ID --fence N --generation N
  cutover --first-task TASK_ID
  pause [--after-current] [--reason TEXT]
  resume
  objective show
  objective set --text TEXT
  policy status [--verbose|--json]
  policy enable PROVIDER
  policy disable PROVIDER
  policy review MODE [--reviewer PROVIDER]
  models status [--verbose|--json]
  models enable|disable [PROVIDER]
  task create --input FILE
  task run TASK_ID [--pause-after-current] [--json]
  task evaluate TASK_ID --accept|--reject --rationale TEXT
  task show TASK_ID
  requirements [--json]
  evidence show ATTEMPT_ID
  events consume EVENT_ID [--delivery ID --generation N]
  wake status [--verbose|--json]
  wake reconcile-transport-not-started EVENT_ID
  session bind --session UUID --rollout PATH --sessions-root PATH
    --host-pid PID --workspace-id ID --workspace-cwd PATH
    --pane-id ID --terminal-id ID
  session status [--verbose|--json]
  session adopt
  telemetry import-activation-profile --input FILE
  supervisor is-alive [--verbose|--json]
  supervisor route select --input FILE
  supervisor route show DECISION_ID
  supervisor route load-skill DECISION_ID --skill SKILL_ID
`;
}

function valueAfter(args, flag, fallback = null) {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : args[index + 1];
}

function print(value) {
  process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function versionInfo({ run = spawnSync } = {}) {
  const packageManifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const release = loadRuntimeRelease();
  const source = run('git', ['-C', packageRoot, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' });
  const sourceRevision = source.status === 0 ? source.stdout.trim() : null;
  const sourceStatus = sourceRevision
    ? run('git', [
      '-C', packageRoot, 'status', '--porcelain', '--untracked-files=all',
      '--', '.', ':(exclude).opsle', ':(exclude)graphify-out',
    ], { encoding: 'utf8' })
    : null;
  const sourceDirty = sourceStatus?.status === 0 ? sourceStatus.stdout.trim().length > 0 : null;
  const buildRevision = process.env.OPSLE_BUILD_REVISION?.trim() || null;
  return {
    name: packageManifest.name,
    version: release.version,
    runtime_release_id: release.runtime_release_id,
    packaged_artifact_sha256: release.packaged_artifact_sha256,
    runtime_epoch: release.runtime_epoch,
    source_revision: sourceRevision,
    source_dirty: sourceDirty,
    build_revision: buildRevision,
  };
}

function renderVersion(value) {
  const provenance = [
    value.source_revision ? `source ${value.source_revision}${value.source_dirty ? ' (dirty worktree)' : ''}` : null,
    value.build_revision ? `build ${value.build_revision}` : null,
  ].filter(Boolean).join('; ');
  return `opsle ${value.version}\nrelease ${value.runtime_release_id}\nartifact ${value.packaged_artifact_sha256}${provenance ? `\n${provenance}` : ''}`;
}

function outputMode(args) {
  const json = args.includes('--json');
  const verbose = args.includes('--verbose');
  if (json && verbose) throw new Error('choose only one of --verbose or --json');
  return { json, verbose };
}

function integerOption(args, flag, fallback, { minimum = 1, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = valueAfter(args, flag);
  if (raw == null) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${flag} requires an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${flag} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

export function sessionCommand(root, subcommand, args, { dependencies = {} } = {}) {
  if (subcommand === 'status') return refreshCodexSessionBinding(root, {
    dependencies,
    allowEnvironmentMismatch: true,
  });
  if (subcommand === 'adopt') return adoptCodexSessionBinding(root, { dependencies });
  if (subcommand !== 'bind') throw new Error('session requires bind, status, or adopt');
  const required = [
    '--session', '--rollout', '--sessions-root', '--host-pid',
    '--workspace-id', '--workspace-cwd', '--pane-id', '--terminal-id',
  ];
  for (const flag of required) {
    if (!valueAfter(args, flag)) throw new Error(`session bind requires ${flag}`);
  }
  return bindCodexSession(root, {
    sessionId: valueAfter(args, '--session'),
    rolloutPath: valueAfter(args, '--rollout'),
    sessionsRoot: valueAfter(args, '--sessions-root'),
    hostPid: integerOption(args, '--host-pid', null),
    workspaceId: valueAfter(args, '--workspace-id'),
    workspaceCwd: valueAfter(args, '--workspace-cwd'),
    paneId: valueAfter(args, '--pane-id'),
    terminalId: valueAfter(args, '--terminal-id'),
  }, { dependencies });
}

function attemptForState(root, state) {
  if (!state.active_attempt_id) return null;
  const path = join(paths(root).attempts, `${state.active_attempt_id}.json`);
  return existsSync(path) ? readJson(path) : null;
}

function recordHumanActivation(root, interaction) {
  const state = readJson(paths(root).state);
  const attempt = attemptForState(root, state);
  if (!['LAUNCHING', 'RUNNING'].includes(attempt?.child_state)) return null;
  return emit(root, 'SUPERVISOR_ACTIVATION', {
    classification: 'human',
    automatic: false,
    interaction,
    task_id: attempt.task_id,
    attempt_id: attempt.attempt_id,
    wait_id: attempt.attempt_id,
  });
}

function measuredElapsedMs(attempt) {
  if (!attempt) return null;
  if (Number.isFinite(attempt.telemetry?.execution_duration_ms)) {
    return attempt.telemetry.execution_duration_ms;
  }
  if (!attempt.started_at) return null;
  const started = Date.parse(attempt.started_at);
  return Number.isFinite(started) ? Math.max(0, Date.now() - started) : null;
}

function updatePolicy(root, mutate, actor = 'operator-cli') {
  const p = paths(root);
  const policy = readJson(p.policy);
  const before = JSON.parse(JSON.stringify(policy));
  mutate(policy);
  policy.version += 1;
  policy.changed_at = now();
  policy.changed_by = actor;
  writeJson(p.policy, policy);
  emit(root, 'POLICY_CHANGED', {
    actor,
    prior_version: before.version,
    policy_version: policy.version,
    prior: before,
    current: policy,
  });
  return policy;
}

function requirementsSummary(root, json) {
  const matrix = effectiveRequirementMatrix(root);
  if (!matrix) {
    return json ? { mode: 'objective_driven', requirements: null } : 'Requirements: none (objective-driven repository)';
  }
  if (json) return matrix;
  const counts = Object.fromEntries(matrix.allowed_states.map((state) => [state, 0]));
  for (const requirement of matrix.requirements) counts[requirement.state] += 1;
  const pending = matrix.requirements
    .filter((item) => !['VERIFIED', 'DEFERRED_WITH_JUSTIFICATION', 'NOT_APPLICABLE_WITH_JUSTIFICATION'].includes(item.state))
    .map((item) => `${item.id} ${item.state} ${item.title}`);
  return [
    ...Object.entries(counts).filter(([, count]) => count > 0).map(([state, count]) => `${state}: ${count}`),
    '',
    ...pending,
  ].join('\n');
}

function setObjective(root, text, actor = 'operator-cli') {
  const objectiveText = text?.trim();
  if (!objectiveText) throw new Error('objective set requires nonempty --text TEXT');
  const p = paths(root);
  const objective = readJson(p.objective);
  const previous = objective.current_revision === 0
    ? null
    : objective.history.find((item) => item.revision === objective.current_revision);
  if (objective.current_revision !== 0 && !previous) {
    throw new Error(`current objective revision is missing: ${objective.current_revision}`);
  }
  if (previous?.objective === objectiveText) throw new Error('objective is unchanged');

  const state = readJson(p.state);
  const attempt = attemptForState(root, state);
  const childRunning = ['LAUNCHING', 'RUNNING'].includes(attempt?.child_state);
  let reconciliation = {
    required: false,
    classification: 'no_active_work',
    action: 'continue_under_new_objective',
  };
  if (state.active_task_id) {
    reconciliation = {
      required: true,
      classification: childRunning ? 'active_child_must_finish_before_reconciliation' : 'active_work_requires_reconciliation',
      action: childRunning ? 'pause_after_current_child' : 'pause_before_future_progression',
      task_id: state.active_task_id,
      attempt_id: state.active_attempt_id,
      prior_objective_revision: objective.current_revision,
    };
    updateState(root, {
      supervisor_state: childRunning ? state.supervisor_state : 'PAUSED',
      pause: {
        active: true,
        after_current: childRunning,
        reason: `Objective revision ${objective.current_revision + 1} requires active-work reconciliation.`,
        changed_at: now(),
      },
      latest_unresolved_issue: reconciliation,
      pending_next_action: `Reconcile ${state.active_task_id} against objective revision ${objective.current_revision + 1}.`,
    });
  }

  const revision = {
    revision: objective.current_revision + 1,
    objective: objectiveText,
    ...(existsSync(p.specification) ? { specification_sha256: fileSha256(p.specification) } : {}),
    changed_by: actor,
    effective_at: now(),
  };
  objective.history.push(revision);
  objective.current_revision = revision.revision;
  writeJson(p.objective, objective);
  if (!state.active_task_id) {
    const requirementDriven = Boolean(effectiveRequirementMatrix(root, { state }));
    updateState(root, {
      phase: state.phase === 'COMPLETE'
        ? (requirementDriven ? 'SELF_HOSTED' : 'ACTIVE')
        : (state.phase === 'INITIALIZED' ? 'ACTIVE' : state.phase),
      pending_next_action: `Establish bounded work for objective revision ${revision.revision}.`,
    });
  }
  const event = emit(root, 'OBJECTIVE_CHANGED', {
    actor,
    objective_id: objective.objective_id,
    prior_revision: previous?.revision ?? null,
    objective_revision: revision.revision,
    reconciliation,
  });
  return { objective, reconciliation, event_id: event.event_id };
}

function lifecycleWakeAttention(root, supervisor, state) {
  const base = join(paths(root).opsle, 'wake');
  const requests = join(base, 'requests');
  if (!existsSync(requests)) return { actionable_count: 0, authoritative_count: 0 };
  const records = readdirSync(requests).filter((name) => name.endsWith('.json')).sort().map((name) => {
    const request = readJson(join(requests, name));
    const receiptPath = join(base, 'deliveries', `${request.event_id}.json`);
    const receipt = existsSync(receiptPath) ? readJson(receiptPath) : null;
    const consumption = receipt ? wakeDeliveryConsumptionStatus(root, request.event_id) : null;
    const decisionPath = join(base, 'activation-decisions', `${request.event_id}.json`);
    const decision = existsSync(decisionPath) ? readJson(decisionPath) : null;
    const taskPath = request.task_id ? join(paths(root).tasks, `${request.task_id}.json`) : null;
    const attemptPath = request.attempt_id ? join(paths(root).attempts, `${request.attempt_id}.json`) : null;
    const task = taskPath && existsSync(taskPath) ? readJson(taskPath) : null;
    const attempt = attemptPath && existsSync(attemptPath) ? readJson(attemptPath) : null;
    const authoritative = request.target?.repository === supervisor.repository
      && request.target?.supervisor_id === supervisor.supervisor_id
      && request.target?.supervisor_generation === supervisor.generation;
    const awaitingConsumption = consumption?.delivered === true && consumption.consumed !== true;
    const historicallyEvaluated = ['ACCEPTED', 'REJECTED'].includes(task?.state)
      || Boolean(attempt?.supervisor_evaluation);
    const resolved = consumption?.consumed === true
      || historicallyEvaluated
      || (!awaitingConsumption && state.processed_event_ids?.includes(request.event_id));
    return {
      ...request,
      authoritative,
      classification: resolved ? 'duplicate' : (awaitingConsumption ? 'awaiting-consumption' : 'queued'),
      reason: resolved ? 'resolved' : (awaitingConsumption ? 'delivered-terminal-wake-unconsumed' : 'current-generation-request'),
    };
  });
  return selectWakeRecords(records);
}

function status(root, { json = false, verbose = false, referenceTime = Date.now() } = {}) {
  const p = paths(root);
  const supervisor = readJson(p.supervisor);
  const state = readJson(p.state);
  const objective = readJson(p.objective);
  const policy = readJson(p.policy);
  const matrix = effectiveRequirementMatrix(root, { state });
  const task = state.active_task_id && existsSync(join(p.tasks, `${state.active_task_id}.json`))
    ? readJson(join(p.tasks, `${state.active_task_id}.json`)) : null;
  const attempt = state.active_attempt_id && existsSync(join(p.attempts, `${state.active_attempt_id}.json`))
    ? readJson(join(p.attempts, `${state.active_attempt_id}.json`)) : null;
  const claim = attempt?.claim_id && existsSync(join(p.claims, `${attempt.claim_id}.json`))
    ? readJson(join(p.claims, `${attempt.claim_id}.json`)) : null;
  const runnerPath = attempt?.attempt_id
    ? join(p.opsle, 'workers', `${attempt.attempt_id}.json`)
    : null;
  const runner = runnerPath && existsSync(runnerPath) ? readJson(runnerPath) : null;
  const sessionBinding = codexSessionBindingStatus(root);
  const selectedWake = lifecycleWakeAttention(root, supervisor, state);
  const operatorState = deriveDisplayState({
    supervisor,
    state,
    objective,
    requirements: matrix,
    task,
    attempt,
    claim,
    runner,
    wakeAttention: selectedWake,
    sessionBinding,
    processIsAlive: processAlive,
  });
  const counts = {};
  for (const requirement of matrix?.requirements ?? []) counts[requirement.state] = (counts[requirement.state] ?? 0) + 1;
  const events = existsSync(p.eventsLog)
    ? readFileSync(p.eventsLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  const completionEvents = events.filter((item) => item.type === 'CHILD_COMPLETION');
  const measuredCompletions = completionEvents.filter((item) => Number.isFinite(item.execution_duration_ms));
  const activations = activationSummary(events);
  const telemetry = {
    activations,
    legacy_supervisor_reactivation_events: events
      .filter((item) => item.type === 'SUPERVISOR_REACTIVATED').length,
    children: readdirSync(p.attempts).filter((name) => name.endsWith('.json')).length,
    deterministic_routes: events.filter((item) => item.type === 'GEARBOX_ROUTED' && item.route === 'deterministic').length,
    model_routes: events.filter((item) => item.type === 'GEARBOX_ROUTED' && item.route === 'codex').length,
    policy_changes: events.filter((item) => item.type === 'POLICY_CHANGED').length,
    recovery_count: events.filter((item) => item.type === 'SUPERVISOR_RECOVERED').length,
    model_polling_turns: null,
    legacy_polling_field_trusted: false,
    measured_completion_count: measuredCompletions.length,
    unmeasured_completion_count: completionEvents.length - measuredCompletions.length,
    measured_child_execution_duration_ms: measuredCompletions.length
      ? measuredCompletions.reduce((sum, item) => sum + item.execution_duration_ms, 0) : null,
    measured_raw_output_bytes: measuredCompletions.length
      ? measuredCompletions.reduce((sum, item) => sum + item.raw_output_bytes, 0) : null,
    measured_raw_evidence_bytes: measuredCompletions.length
      ? measuredCompletions.reduce((sum, item) => sum + item.raw_evidence_bytes, 0) : null,
    measured_compact_packet_bytes: measuredCompletions.length
      ? measuredCompletions.reduce((sum, item) => sum + item.compact_packet_bytes, 0) : null,
    output_tokens: null,
    cost: null,
  };
  const attemptTelemetry = attempt?.telemetry ?? {};
  const value = {
    supervisor: {
      repository: root,
      identity: supervisor.supervisor_id,
      generation: supervisor.generation,
      authority_status: supervisor.authority_status,
      state: state.supervisor_state,
      phase: state.phase,
      pause: state.pause,
    },
    objective: objective.history.find((item) => item.revision === objective.current_revision) ?? null,
    session_binding: sessionBinding,
    wake: selectedWake,
    operator_state: operatorState,
    active_work: task ? {
      task_id: task.task_id,
      description: task.title,
      state: task.state,
      attempt_id: attempt?.attempt_id ?? null,
      route: attempt?.gearbox_route ?? null,
      provider: attempt?.provider ?? null,
      pid: attempt?.pid ?? null,
      claim_id: attempt?.claim_id ?? null,
      child_state: attempt?.child_state ?? null,
      start_time: attempt?.started_at ?? null,
      last_heartbeat: attempt?.heartbeat_at ?? null,
      completion: attempt?.completed_at ?? null,
      elapsed_ms: measuredElapsedMs(attempt),
      telemetry: {
        execution_duration_ms: attemptTelemetry.execution_duration_ms ?? null,
        verification_duration_ms: attemptTelemetry.verification_duration_ms ?? null,
        raw_output_bytes: attemptTelemetry.raw_output_bytes ?? null,
        raw_evidence_bytes: attemptTelemetry.raw_evidence_bytes ?? null,
        compact_packet_bytes: attemptTelemetry.compact_packet_bytes ?? null,
        retained_bytes: attemptTelemetry.retained_bytes ?? null,
        suppressed_bytes: attemptTelemetry.suppressed_bytes ?? null,
        retained_ratio: attemptTelemetry.retained_ratio ?? null,
        reduction_ratio: attemptTelemetry.reduction_ratio ?? null,
        output_tokens: null,
        cost: null,
      },
    } : null,
    policy: {
      version: policy.version,
      providers: Object.fromEntries(Object.entries(policy.providers).map(([name, value]) => [name, value.enabled])),
      review_mode: policy.review.mode,
      reviewer: policy.review.reviewer,
      affected_verification: policy.affected_verification.authority,
      model_polling_permitted: policy.model_polling.permitted,
    },
    progress: {
      requirements: counts,
      latest_accepted_task: state.latest_accepted_task_id,
      latest_unresolved_issue: state.latest_unresolved_issue,
      pending_next_action: derivePendingNextAction(state, matrix),
    },
    telemetry,
  };
  if (json) return value;
  return renderSupervisorStatus(value, { verbose, referenceTime });
}

async function watchStatus(root, args) {
  const intervalMs = integerOption(args, '--interval-ms', 1000, { maximum: 3_600_000 });
  const iterations = integerOption(args, '--iterations', Number.POSITIVE_INFINITY, { maximum: 1_000_000 });
  const { json, verbose } = outputMode(args);
  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    if (json) print(JSON.stringify(status(root, { json: true })));
    else {
      if (iteration > 1) print('');
      print(`STATUS SNAPSHOT ${iteration}`);
      print(status(root, { verbose }));
    }
    if (iteration < iterations) await sleep(intervalMs);
  }
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function exactAttemptClaimOwner({ state, task, attempt, claim, index, supervisor }) {
  const indexed = index?.[`task-${state.active_task_id}`];
  return task?.task_id === state.active_task_id
    && task.supervisor_id === supervisor.supervisor_id
    && task.attempts?.filter((value) => value === state.active_attempt_id).length === 1
    && attempt?.schema === 'opsle.durable-supervisor.child-attempt/v1'
    && attempt.task_id === state.active_task_id
    && attempt.attempt_id === state.active_attempt_id
    && claim?.schema === 'opsle.durable-supervisor.claim/v1'
    && claim.status === 'ACTIVE'
    && claim.task_id === attempt.task_id
    && claim.attempt_id === attempt.attempt_id
    && claim.claim_id === attempt.claim_id
    && claim.fence_generation === attempt.fence_generation
    && claim.owner_supervisor_id === supervisor.supervisor_id
    && claim.owner_generation === attempt.policy_snapshot?.supervisor_generation
    && indexed?.schema === claim.schema
    && indexed.task_id === claim.task_id
    && indexed.attempt_id === claim.attempt_id
    && indexed.claim_id === claim.claim_id
    && indexed.fence_generation === claim.fence_generation
    && indexed.owner_supervisor_id === claim.owner_supervisor_id
    && indexed.owner_generation === claim.owner_generation
    && indexed.status === claim.status;
}

function exactDetachedRunnerOwner({ state, task, attempt, claim, index, runner, supervisor, isProcessAlive }) {
  return exactAttemptClaimOwner({ state, task, attempt, claim, index, supervisor })
    && runner?.schema === 'opsle.durable-supervisor.detached-runner/v1'
    && runner.status === 'OWNED'
    && runner.task_id === attempt.task_id
    && runner.attempt_id === attempt.attempt_id
    && runner.claim_id === attempt.claim_id
    && runner.fence_generation === attempt.fence_generation
    && runner.supervisor_id === supervisor.supervisor_id
    && runner.supervisor_generation === attempt.policy_snapshot?.supervisor_generation
    && claim.owner_generation === runner.supervisor_generation
    && Number.isInteger(runner.worker_pid)
    && isProcessAlive(runner.worker_pid);
}

function positiveInteger(value, field) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${field} must be a positive integer`);
  return parsed;
}

export function reconcileRunnerFailure(root, {
  taskId,
  attemptId,
  claimId,
  fenceGeneration,
  supervisorGeneration,
  isProcessAlive = processAlive,
  releaseClaimImpl = releaseClaim,
}) {
  if (!taskId || !attemptId || !claimId) {
    throw new Error('runner failure reconciliation requires exact task, attempt, and claim IDs');
  }
  const expectedFence = positiveInteger(fenceGeneration, 'fence generation');
  const expectedGeneration = positiveInteger(supervisorGeneration, 'supervisor generation');
  const p = paths(root);
  const supervisor = readJson(p.supervisor);
  if (supervisor.generation !== expectedGeneration) throw new Error('stale supervisor generation');

  const taskPath = join(p.tasks, `${taskId}.json`);
  const attemptPath = join(p.attempts, `${attemptId}.json`);
  const workerPath = join(p.opsle, 'workers', `${attemptId}.json`);
  const claimPath = join(p.claims, `${claimId}.json`);
  for (const [label, path] of [
    ['task', taskPath],
    ['attempt', attemptPath],
    ['worker', workerPath],
    ['claim', claimPath],
  ]) {
    if (!existsSync(path)) throw new Error(`missing exact ${label} record`);
  }
  const task = readJson(taskPath);
  const attempt = readJson(attemptPath);
  const worker = readJson(workerPath);
  const claim = readJson(claimPath);
  const index = readJson(join(p.claims, 'index.json'));
  const indexedClaim = index[`task-${taskId}`];
  const completionEvents = existsSync(p.eventsLog)
    ? readFileSync(p.eventsLog, 'utf8').trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === 'CHILD_COMPLETION' && event.attempt_id === attemptId)
    : [];
  const executionPath = join(p.raw, attemptId, 'execution.json');

  const exactIdentity = task.task_id === taskId
    && task.state === 'REJECTED'
    && task.attempts.filter((value) => value === attemptId).length === 1
    && attempt.schema === 'opsle.durable-supervisor.child-attempt/v1'
    && attempt.task_id === taskId
    && attempt.attempt_id === attemptId
    && attempt.claim_id === claimId
    && attempt.fence_generation === expectedFence
    && worker.schema === 'opsle.durable-supervisor.detached-runner/v1'
    && worker.status === 'FAILED'
    && worker.task_id === taskId
    && worker.attempt_id === attemptId
    && worker.claim_id === claimId
    && worker.fence_generation === expectedFence
    && worker.supervisor_id === supervisor.supervisor_id
    && worker.supervisor_generation === attempt.policy_snapshot?.supervisor_generation
    && claim.schema === 'opsle.durable-supervisor.claim/v1'
    && ['ACTIVE', 'FAILED'].includes(claim.status)
    && claim.task_id === taskId
    && claim.attempt_id === attemptId
    && claim.claim_id === claimId
    && claim.fence_generation === expectedFence
    && claim.owner_supervisor_id === supervisor.supervisor_id
    && claim.owner_generation === worker.supervisor_generation
    && indexedClaim?.task_id === taskId
    && indexedClaim?.attempt_id === attemptId
    && indexedClaim?.claim_id === claimId
    && indexedClaim?.fence_generation === expectedFence;
  if (!exactIdentity) throw new Error('runner failure reconciliation identity or fence is ambiguous');
  if (attempt.child_state !== 'UNKNOWN'
      || attempt.exit_code != null
      || attempt.compact_packet != null
      || attempt.completion_handoff != null
      || attempt.acceptance != null
      || existsSync(executionPath)
      || completionEvents.length !== 0) {
    throw new Error('child outcome is not exactly unknown and evidence-free');
  }
  if (!Number.isSafeInteger(worker.worker_pid)
      || !Number.isSafeInteger(attempt.pid)
      || isProcessAlive(worker.worker_pid)
      || isProcessAlive(attempt.pid)) {
    throw new Error('exact detached Runner and child process death is not proven');
  }
  if (typeof worker.failure !== 'string' || worker.failure.length === 0 || !worker.terminal_at) {
    throw new Error('worker record is not exact terminal FAILED evidence');
  }

  const workerRecordSha256 = sha256(readFileSync(workerPath));
  const existing = attempt.runner_reconciliation;
  if (existing && (existing.schema !== 'opsle.durable-supervisor.runner-failure-reconciliation/v1'
      || existing.status !== 'COMMITTED'
      || existing.runner_outcome !== 'FAILED'
      || existing.child_outcome !== 'UNKNOWN'
      || existing.claim_release_intent !== 'FAILED'
      || existing.claim_id !== claimId
      || existing.worker_record_sha256 !== workerRecordSha256
      || existing.fence_generation !== expectedFence
      || existing.reconciled_by_supervisor_id !== supervisor.supervisor_id)) {
    throw new Error('existing runner reconciliation is ambiguous');
  }
  if (!existing && (claim.status !== 'ACTIVE' || indexedClaim.status !== 'ACTIVE')) {
    throw new Error('exact active claim is required before reconciliation commit');
  }
  if (!existing) {
    attempt.runner_reconciliation = {
      schema: 'opsle.durable-supervisor.runner-failure-reconciliation/v1',
      status: 'COMMITTED',
      runner_outcome: 'FAILED',
      child_outcome: 'UNKNOWN',
      claim_release_intent: 'FAILED',
      claim_id: claimId,
      fence_generation: expectedFence,
      worker_record_sha256: workerRecordSha256,
      worker_terminal_at: worker.terminal_at,
      worker_failure: worker.failure,
      reconciled_by_supervisor_id: supervisor.supervisor_id,
      reconciled_at_generation: expectedGeneration,
      committed_at: now(),
    };
    writeJson(attemptPath, attempt);
  }

  const released = releaseClaimImpl(root, claim, 'FAILED');
  return {
    reconciliation: existing ? 'ALREADY_COMMITTED' : 'COMMITTED',
    task_id: taskId,
    attempt_id: attemptId,
    runner_outcome: 'FAILED',
    child_outcome: 'UNKNOWN',
    claim_id: claimId,
    fence_generation: expectedFence,
    claim_status: released.status,
    relaunched: false,
  };
}

export function recover(root, {
  isProcessAlive = processAlive,
} = {}) {
  const p = paths(root);
  const supervisor = readJson(p.supervisor);
  const state = readJson(p.state);
  const requirements = effectiveRequirementMatrix(root, { state });
  let stateChanged = false;
  let reconciliation = { classification: 'no_active_work', action: 'none' };
  if (state.active_attempt_id) {
    const attemptPath = join(p.attempts, `${state.active_attempt_id}.json`);
    if (existsSync(attemptPath)) {
      const attempt = readJson(attemptPath);
      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(attempt.child_state)) {
        reconciliation = { classification: `known_${attempt.child_state.toLowerCase()}`, action: 'do_not_relaunch' };
      } else if (attempt.child_state === 'UNKNOWN') {
        reconciliation = attempt.runner_reconciliation?.status === 'COMMITTED'
          && attempt.runner_reconciliation.runner_outcome === 'FAILED'
          && attempt.runner_reconciliation.child_outcome === 'UNKNOWN'
          ? {
            classification: 'known_runner_failed_child_unknown',
            action: 'do_not_relaunch',
            pid: attempt.pid,
            claim_status: readJson(join(p.claims, `${attempt.claim_id}.json`)).status,
          }
          : {
            classification: 'unknown_unreconciled',
            action: 'remain_paused_and_reconcile',
            pid: attempt.pid,
          };
      } else {
        const runnerPath = join(p.opsle, 'workers', `${attempt.attempt_id}.json`);
        const runner = existsSync(runnerPath) ? readJson(runnerPath) : null;
        const claimPath = attempt.claim_id
          ? join(p.claims, `${attempt.claim_id}.json`)
          : null;
        const claim = claimPath && existsSync(claimPath) ? readJson(claimPath) : null;
        const taskPath = state.active_task_id
          ? join(p.tasks, `${state.active_task_id}.json`)
          : null;
        const task = taskPath && existsSync(taskPath) ? readJson(taskPath) : null;
        const indexPath = join(p.claims, 'index.json');
        const index = existsSync(indexPath) ? readJson(indexPath) : null;
        const detachedOwned = exactDetachedRunnerOwner({
          state,
          task,
          attempt,
          claim,
          index,
          runner,
          supervisor,
          isProcessAlive,
        });
        if (detachedOwned) reconciliation = {
          classification: 'known_running',
          action: 'preserve_claim_and_wait',
          pid: attempt.pid,
          runner_pid: runner?.worker_pid ?? null,
          lifecycle_owner: 'detached-runner-worker',
        };
        else {
          attempt.child_state = 'UNKNOWN';
          const intervention = emit(root, 'INTERVENTION_REQUIRED', {
            task_id: attempt.task_id,
            attempt_id: attempt.attempt_id,
            wait_id: attempt.attempt_id,
            reason: 'exact detached Runner owner is absent without terminal evidence',
          });
          if (attempt.wait_registration) {
            attempt.wait_registration = applyWakeEvent(attempt.wait_registration, {
              event_id: intervention.event_id,
              wait_id: attempt.attempt_id,
              type: 'intervention-required',
            });
          }
          writeJson(attemptPath, attempt);
          reconciliation = { classification: 'unknown_unreconciled', action: 'pause_and_reconcile', pid: attempt.pid };
          state.supervisor_state = 'PAUSED';
          state.pause = { active: true, after_current: false, reason: 'Recovery ambiguity: prior child process is absent without terminal evidence.', changed_at: now() };
          state.latest_unresolved_issue = reconciliation;
          stateChanged = true;
        }
      }
    }
  }
  const pendingNextAction = derivePendingNextAction(
    state,
    requirements,
  );
  if (pendingNextAction !== state.pending_next_action) {
    state.pending_next_action = pendingNextAction;
    stateChanged = true;
  }
  if (stateChanged) writeJson(p.state, state);
  supervisor.generation += 1;
  supervisor.recovered_at = now();
  writeJson(p.supervisor, supervisor);
  emit(root, 'SUPERVISOR_RECOVERED', { reconciliation });
  return {
    supervisor,
    state: readJson(p.state),
    reconciliation,
  };
}

export function evaluateTask(root, taskId, accept, rationale, {
  afterEvaluationCommit = null,
} = {}) {
  const p = paths(root);
  // Authority is preflighted before decision, task, attempt, requirement, or
  // lifecycle evidence can be mutated.
  effectiveRequirementMatrix(root);
  const taskPath = join(p.tasks, `${taskId}.json`);
  const task = readJson(taskPath);
  const attemptId = task.attempts.at(-1);
  if (!attemptId) throw new Error('task has no attempt');
  const attemptPath = join(p.attempts, `${attemptId}.json`);
  const attempt = readJson(attemptPath);
  const unconsumed = unconsumedDeliveredWakes(root, taskId, attemptId);
  if (unconsumed.length > 0) {
    throw new Error(`delivered terminal wake must be consumed before evaluation: ${unconsumed.join(', ')}`);
  }
  if (attempt.supervisor_evaluation) return { idempotent: true, task, attempt };
  const evaluationPath = join(p.attempts, 'supervisor-evaluations', `${attemptId}.json`);
  if (existsSync(evaluationPath)) {
    return {
      idempotent: true,
      decision: readJson(evaluationPath),
      task: readJson(taskPath),
      attempt: readJson(attemptPath),
    };
  }
  if (accept && attempt.acceptance?.state !== 'SATISFIED') {
    throw new Error('supervisor cannot accept a task rejected by the Acceptance gate without a durable correction');
  }
  const decision = {
    schema: 'opsle.durable-supervisor.decision/v1',
    decision_id: id('decision'),
    question: `Should ${taskId} advance the objective?`,
    decision: accept ? 'ACCEPT' : 'REJECT',
    rationale,
    evidence_references: [attempt.compact_packet, attempt.completion_handoff],
    time: now(),
    supervisor_generation: readJson(p.supervisor).generation,
    task_id: taskId,
    objective_id: task.parent_objective_id,
  };
  // This immutable record is the evaluation commit boundary. It is durable
  // before any mutable projection, so concurrent or interrupted evaluators can
  // preserve the first decision without appending or applying it again.
  if (!atomicCreateJson(evaluationPath, decision)) {
    return {
      idempotent: true,
      decision: readJson(evaluationPath),
      task: readJson(taskPath),
      attempt: readJson(attemptPath),
    };
  }
  afterEvaluationCommit?.(decision);
  appendEvent(p.decisionsLog, decision);
  attempt.supervisor_evaluation = {
    decision_id: decision.decision_id,
    decision: decision.decision,
    rationale,
    evaluated_at: decision.time,
  };
  writeJson(attemptPath, attempt);
  task.state = accept ? 'ACCEPTED' : 'REJECTED';
  writeJson(taskPath, task);
  if (accept) setRequirements(root, task.requirement_ids, 'IMPLEMENTED', [attempt.compact_packet, attempt.completion_handoff]);
  const currentState = readJson(p.state);
  const applyPauseAfterCurrent = currentState.pause?.active === true
    && currentState.pause.after_current === true;
  const nextState = {
    ...currentState,
    active_task_id: null,
    active_attempt_id: null,
    pending_next_action: accept
      ? NEXT_UNSATISFIED_REQUIREMENT_ACTION
      : `Create corrective work for ${taskId}.`,
  };
  emit(root, 'SUPERVISOR_DECISION', {
    task_id: taskId,
    attempt_id: attemptId,
    decision_id: decision.decision_id,
    decision: decision.decision,
  });
  updateState(root, {
    supervisor_state: applyPauseAfterCurrent ? 'PAUSED' : currentState.supervisor_state,
    pause: applyPauseAfterCurrent ? {
      ...currentState.pause,
      after_current: false,
      applied_at: now(),
    } : currentState.pause,
    active_task_id: nextState.active_task_id,
    active_attempt_id: nextState.active_attempt_id,
    latest_accepted_task_id: accept ? taskId : currentState.latest_accepted_task_id,
    latest_unresolved_issue: accept ? null : `Supervisor rejected ${taskId}: ${rationale}`,
    pending_next_action: accept
      ? derivePendingNextAction(
        nextState,
        effectiveRequirementMatrix(root, { state: nextState }),
      )
      : nextState.pending_next_action,
  });
  if (applyPauseAfterCurrent) {
    emit(root, 'PAUSE_AFTER_CURRENT_APPLIED', {
      task_id: taskId,
      attempt_id: attemptId,
      decision_id: decision.decision_id,
      terminal_task_state: task.state,
      reason: currentState.pause.reason,
    });
  }
  return { decision, task, attempt };
}

export function consumeEvent(root, eventId, { deliveryId = null, generation = null } = {}) {
  const p = paths(root);
  const state = readJson(p.state);
  state.processed_event_ids ??= [];
  if (state.processed_event_ids.includes(eventId)) {
    const wake = deliveryId == null
      ? wakeDeliveryConsumptionStatus(root, eventId)
      : consumeWakeDelivery(root, eventId, { deliveryId, generation });
    return { event_id: eventId, duplicate: true, action: 'ignored', wake_delivery: wake };
  }
  const event = readJson(join(p.events, `${eventId}.json`));
  const deliveryStatus = wakeDeliveryConsumptionStatus(root, eventId);
  const wake = deliveryStatus.delivered
    ? consumeWakeDelivery(root, eventId, { deliveryId, generation })
    : consumeReconciledTransportNotStarted(root, eventId, { generation });
  state.processed_event_ids.push(eventId);
  writeJson(p.state, state);
  emit(root, 'EVENT_CONSUMED', {
    source_event_id: eventId,
    source_event_type: event.type,
    delivery_id: wake?.receipt?.delivery_id ?? null,
    consumption_id: wake?.consumption?.consumption_id ?? null,
  });
  return { event_id: eventId, duplicate: false, action: 'recorded', wake_delivery: wake };
}

function importActivationProfile(root, profile) {
  if (profile.schema !== 'opsle.durable-supervisor.activation-profile/v1') {
    throw new Error('unsupported activation profile schema');
  }
  if (!profile.task_id || !profile.attempt_id
      || !/^[a-f0-9]{64}$/.test(profile.trajectory_evidence?.sha256 ?? '')) {
    throw new Error('activation profile requires task, attempt, and trajectory evidence identity');
  }
  const classifications = ['terminal-event', 'human', 'wait-induced-automatic'];
  if (!Array.isArray(profile.activations)
      || profile.activations.some((item) => !classifications.includes(item.classification))) {
    throw new Error('activation profile contains invalid activation records');
  }
  const observed = {
    terminal_event: profile.activations
      .filter((item) => item.classification === 'terminal-event').length,
    human: profile.activations
      .filter((item) => item.classification === 'human').length,
    wait_induced_automatic: profile.activations
      .filter((item) => item.classification === 'wait-induced-automatic').length,
  };
  observed.total_automatic = observed.terminal_event + observed.wait_induced_automatic;
  for (const [name, count] of Object.entries(observed)) {
    if (profile.counts?.[name] !== count) {
      throw new Error(`activation profile count mismatch: ${name}`);
    }
  }
  const attemptPath = join(paths(root).attempts, `${profile.attempt_id}.json`);
  const durableAttempt = existsSync(attemptPath) ? readJson(attemptPath) : null;
  if (!durableAttempt || durableAttempt.task_id !== profile.task_id) {
    throw new Error('activation profile does not identify a durable attempt');
  }
  if (profile.interval?.start !== durableAttempt.started_at
      || profile.interval?.end !== durableAttempt.completed_at) {
    throw new Error('activation profile interval does not match the durable child interval');
  }
  const profileSha256 = sha256(canonicalJson(profile));
  const existing = readFileSync(paths(root).eventsLog, 'utf8')
    .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    .find((event) => event.type === 'ACTIVATION_PROFILED'
      && event.profile_sha256 === profileSha256);
  if (existing) return { duplicate: true, profile_event_id: existing.event_id };
  const profileEvent = emit(root, 'ACTIVATION_PROFILED', {
    task_id: profile.task_id,
    attempt_id: profile.attempt_id,
    interval: profile.interval,
    counts: profile.counts,
    trajectory_evidence: profile.trajectory_evidence,
    profile_sha256: profileSha256,
  });
  const activationEventIds = profile.activations.map((activation) => emit(
    root,
    'SUPERVISOR_ACTIVATION',
    {
      classification: activation.classification,
      automatic: activation.automatic,
      task_id: profile.task_id,
      attempt_id: profile.attempt_id,
      cause_timestamp: activation.cause_timestamp,
      activation_timestamp: activation.activation_timestamp,
      source_profile_event_id: profileEvent.event_id,
    },
  ).event_id);
  return {
    duplicate: false,
    profile_event_id: profileEvent.event_id,
    activation_event_ids: activationEventIds,
  };
}

export async function main(args) {
  loadRuntimeRelease();
  if (args.length === 0 || args[0] === 'help' || args[0] === '--help') {
    print(usage());
    return;
  }
  if (args[0] === '--version' || args[0] === '-V' || args[0] === 'version') {
    print(renderVersion(versionInfo()));
    return;
  }
  const root = repositoryRoot();
  const [command, subcommand, ...rest] = args;
  if (command === 'init') {
    const result = initialize(root, { objectiveText: valueAfter(args, '--objective') });
    print(args.includes('--json')
      ? result
      : `Initialized Durable Supervisor for ${root} (requirements ${result.bootstrap.requirements.mode}); next: ${result.state.pending_next_action}`);
    return;
  }
  if (!existsSync(paths(root).supervisor)) throw new Error('run opsle init first');
  if (!(command === 'resume-packet' && ['show', 'evidence'].includes(subcommand))) {
    ensureDurableCompatibility(root);
  }
  if (command === 'status') {
    const mode = outputMode(args);
    if (args.includes('--watch')) await watchStatus(root, args);
    else print(status(root, mode));
    return;
  }
  if (command === 'validate') {
    const result = validateDurableState(root);
    print(result);
    if (!result.valid) process.exitCode = 1;
    return;
  }
  if (command === 'recover') {
    print(recover(root));
    return;
  }
  if (command === 'resume-packet') {
    if (subcommand === 'generate') {
      if (rest.includes('--recover')) recover(root);
      const result = generateResumePacket(root);
      process.stdout.write(result.serialized);
    } else if (subcommand === 'show') {
      process.stdout.write(canonicalJson(readResumePacket(root)));
    } else if (subcommand === 'evidence') {
      const path = valueAfter(rest, '--path');
      if (!path) throw new Error('resume-packet evidence requires --path RELATIVE_PATH');
      print(readResumeEvidence(root, path));
    } else {
      throw new Error('resume-packet requires generate, show, or evidence');
    }
    return;
  }
  if (command === 'reconcile' && subcommand === 'runner-failure') {
    print(reconcileRunnerFailure(root, {
      taskId: valueAfter(rest, '--task'),
      attemptId: valueAfter(rest, '--attempt'),
      claimId: valueAfter(rest, '--claim'),
      fenceGeneration: valueAfter(rest, '--fence'),
      supervisorGeneration: valueAfter(rest, '--generation'),
    }));
    return;
  }
  if (command === 'cutover') {
    const taskId = valueAfter(args, '--first-task');
    if (!taskId) throw new Error('cutover requires --first-task TASK_ID');
    const p = paths(root);
    const state = readJson(p.state);
    const requirements = effectiveRequirementMatrix(root, { state });
    if (!requirements) throw new Error('cutover requires effective requirements authority');
    if (state.phase !== 'BOOTSTRAP') throw new Error(`cutover already occurred: ${state.phase}`);
    updateState(root, { phase: 'SELF_HOSTED', pending_next_action: `Run first post-cutover task ${taskId}.` });
    const event = emit(root, 'BOOTSTRAP_CUTOVER', {
      first_post_cutover_task_id: taskId,
      minimum_substrate: ['state', 'identity', 'policy', 'discovery', 'gearbox', 'authorization', 'handoff', 'claims', 'runner', 'events', 'context_firewall', 'acceptance', 'recovery'],
      remaining_requirements: requirements.requirements.filter((item) => item.state !== 'VERIFIED').map((item) => item.id),
      rationale: 'The minimum end-to-end path is locally implemented and deterministically validated; remaining work can now be delegated safely.',
    });
    print(event);
    return;
  }
  if (command === 'pause') {
    recordHumanActivation(root, 'pause');
    const afterCurrent = args.includes('--after-current');
    const reason = valueAfter(args, '--reason', 'operator requested pause');
    const current = readJson(paths(root).state);
    const attempt = attemptForState(root, current);
    const childRunning = ['LAUNCHING', 'RUNNING'].includes(attempt?.child_state);
    updateState(root, {
      supervisor_state: afterCurrent && childRunning ? current.supervisor_state : 'PAUSED',
      pause: { active: true, after_current: afterCurrent && childRunning, reason, changed_at: now() },
    });
    emit(root, 'SUPERVISOR_PAUSED', {
      actor: 'operator-cli',
      after_current: afterCurrent && childRunning,
      requested_after_current: afterCurrent,
      active_attempt_id: childRunning ? attempt.attempt_id : null,
      reason,
    });
    print(status(root));
    return;
  }
  if (command === 'resume') {
    recordHumanActivation(root, 'resume');
    updateState(root, { supervisor_state: 'ACTIVE', pause: { active: false, after_current: false, reason: null, changed_at: now() } });
    emit(root, 'SUPERVISOR_RESUMED', { actor: 'operator-cli' });
    print(status(root));
    return;
  }
  if (command === 'objective') {
    if (subcommand === 'show') print(readJson(paths(root).objective));
    else if (subcommand === 'set') {
      recordHumanActivation(root, 'objective-set');
      print(setObjective(root, valueAfter(rest, '--text')));
    }
    else throw new Error('objective requires show or set --text TEXT');
    return;
  }
  if (command === 'models') {
    if (subcommand === 'status') {
      const mode = outputMode(rest);
      const policy = readJson(paths(root).policy);
      print(mode.json ? policy.providers : renderModels(policy, mode));
    }
    else if (['enable', 'disable'].includes(subcommand)) {
      args = ['policy', subcommand, rest[0]];
      return main(args);
    } else throw new Error('models requires status, enable, or disable');
    return;
  }
  if (command === 'policy') {
    if (subcommand === 'status') {
      const mode = outputMode(rest);
      const policy = readJson(paths(root).policy);
      print(mode.json ? policy : renderPolicy(policy, mode));
    }
    else if (['enable', 'disable'].includes(subcommand)) {
      recordHumanActivation(root, `policy-${subcommand}`);
      const provider = rest[0];
      const policy = readJson(paths(root).policy);
      if (!policy.providers[provider]) throw new Error(`unknown provider: ${provider}`);
      print(updatePolicy(root, (next) => { next.providers[provider].enabled = subcommand === 'enable'; }));
    } else if (subcommand === 'review') {
      recordHumanActivation(root, 'policy-review');
      const mode = rest[0];
      if (!REVIEW_MODES.has(mode)) throw new Error(`invalid review mode: ${mode}`);
      const reviewer = valueAfter(rest, '--reviewer');
      print(updatePolicy(root, (next) => {
        if (reviewer && !next.providers[reviewer]?.enabled) throw new Error(`reviewer provider is disabled: ${reviewer}`);
        next.review = { mode, reviewer: mode === 'off' ? null : reviewer };
      }));
    } else throw new Error('unknown policy command');
    return;
  }
  if (command === 'task') {
    if (subcommand === 'create') {
      const input = valueAfter(rest, '--input');
      if (!input) throw new Error('task create requires --input FILE');
      print(createTask(root, readJson(input)));
    } else if (subcommand === 'show') {
      print(readJson(join(paths(root).tasks, `${rest[0]}.json`)));
    } else if (subcommand === 'run') {
      const state = readJson(paths(root).state);
      if (state.pause.active) throw new Error('automatic progression is paused');
      const pauseAfterCurrent = rest.includes('--pause-after-current');
      const task = readJson(join(paths(root).tasks, `${rest[0]}.json`));
      const gearbox = routeTask(root, task);
      emit(root, 'GEARBOX_ROUTED', { task_id: task.task_id, decision_id: gearbox.decision_id, route: gearbox.selected_route, rationale: gearbox.rationale });
      const { attempt, claim } = createAttempt(root, task, gearbox);
      if (pauseAfterCurrent) {
          const reason = valueAfter(rest, '--reason', 'task run requested pause after current');
          updateState(root, {
            pause: { active: true, after_current: true, reason, changed_at: now() },
          });
          emit(root, 'PAUSE_AFTER_CURRENT_REQUESTED', {
            actor: 'operator-cli',
            task_id: task.task_id,
            attempt_id: attempt.attempt_id,
            reason,
          });
      }
      const request = createRunnerRequest(root, task, attempt, claim);
      const queued = {
          launch_mode: 'opsled-request',
          action: 'REQUEST_SUBMITTED',
          task_id: task.task_id,
          attempt_id: attempt.attempt_id,
          request_id: request.request_id,
          child_state: attempt.child_state,
          monitoring_owner: 'OPSLED',
          pause_after_current: pauseAfterCurrent,
      };
      print(rest.includes('--json') ? queued : [
        `Runner request ${request.request_id} queued for ${task.task_id}.`,
        'Opsled owns launch and supervision.',
      ].join('\n'));
    } else if (subcommand === 'evaluate') {
      const taskId = rest[0];
      const accept = rest.includes('--accept');
      const reject = rest.includes('--reject');
      if (accept === reject) throw new Error('choose exactly one of --accept or --reject');
      const rationale = valueAfter(rest, '--rationale');
      if (!rationale) throw new Error('evaluation requires --rationale');
      print(evaluateTask(root, taskId, accept, rationale));
    } else throw new Error('unknown task command');
    return;
  }
  if (command === 'requirements') {
    print(requirementsSummary(root, args.includes('--json')));
    return;
  }
  if (command === 'evidence' && subcommand === 'show') {
    const attemptId = rest[0];
    const attempt = readJson(join(paths(root).attempts, `${attemptId}.json`));
    print({ attempt, packet: readJson(join(root, attempt.compact_packet)), completion: readJson(join(root, attempt.completion_handoff)) });
    return;
  }
  if (command === 'events' && subcommand === 'consume') {
    print(consumeEvent(root, rest[0], {
      deliveryId: valueAfter(rest, '--delivery'),
      generation: valueAfter(rest, '--generation'),
    }));
    return;
  }
  if (command === 'wake') {
    if (subcommand === 'status') {
      const mode = outputMode(rest);
      const wake = wakeQueueStatus(root);
      const selected = selectWakeRecords(wake.requests);
      wake.status_summary = {
        current_event_id: selected.current?.event_id ?? null,
        latest_authoritative_event_id: selected.latest?.event_id ?? null,
        actionable_count: selected.actionable_count,
        authoritative_count: selected.authoritative_count,
      };
      print(mode.json ? wake : renderWakeStatus(wake, mode));
    } else if (subcommand === 'reconcile-transport-not-started') {
      if (!rest[0]) throw new Error('wake reconciliation requires event ID');
      print(reconcileWakeTransportNotStarted(root, rest[0]));
    } else throw new Error('wake requires status or reconcile-transport-not-started');
    return;
  }
  if (command === 'session') {
    const result = sessionCommand(root, subcommand, rest);
    if (subcommand === 'status') {
      const mode = outputMode(rest);
      print(mode.json ? result : renderSession(result, mode));
    } else print(result);
    return;
  }
  if (command === 'telemetry') {
    if (subcommand !== 'import-activation-profile') {
      throw new Error('telemetry requires import-activation-profile --input FILE');
    }
    const input = valueAfter(rest, '--input');
    if (!input) throw new Error('telemetry import requires --input FILE');
    print(importActivationProfile(root, readJson(input)));
    return;
  }
  if (command === 'supervisor') {
    if (subcommand === 'route') {
      const action = rest[0];
      if (action === 'select') {
        const input = valueAfter(rest, '--input');
        if (!input) throw new Error('supervisor route select requires --input FILE');
        const decision = selectSupervisorRoute(root, readJson(input));
        emit(root, 'SUPERVISOR_GEARBOX_ROUTED', {
          decision_id: decision.decision_id,
          task_id: decision.subject.task_id,
          objective_id: decision.subject.objective_id,
          route: decision.selected_route.execution_route,
          selected_tool: decision.selected_route.selected_tool,
          selected_skill: decision.selected_skill,
        });
        print(decision);
      } else if (action === 'show') {
        print(readSupervisorRoutingDecision(root, rest[1]));
      } else if (action === 'load-skill') {
        const skill = valueAfter(rest, '--skill');
        if (!rest[1] || !skill) {
          throw new Error('supervisor route load-skill requires DECISION_ID --skill SKILL_ID');
        }
        print(loadSelectedSupervisorSkillInstructions(root, rest[1], skill));
      } else {
        throw new Error('supervisor route requires select, show, or load-skill');
      }
      return;
    }
    if (subcommand === 'is-alive') {
      const mode = outputMode(rest);
      const supervisor = readJson(paths(root).supervisor);
      const herdr = codexSessionBindingStatus(root);
      const alive = supervisor.authority_status === 'AUTHORITATIVE'
        && herdr.valid === true
        && herdr.classification === 'bound-authoritative-herdr';
      const classification = alive ? 'alive' : 'unknown';
      const authority = alive ? 'herdr' : null;
      const result = {
        classification,
        authority,
        supervisor_id: supervisor.supervisor_id,
        supervisor_generation: supervisor.generation,
        herdr,
        reason: alive ? null : (herdr.reasons?.[0] ?? herdr.classification),
      };
      if (mode.json) print(result);
      else if (mode.verbose) {
        print([
          `Supervisor: ${classification.toUpperCase()}${authority ? ` — ${authority}` : ' — current process authority is unproven'}`,
          renderSession(herdr, { verbose: true }),
          `Identity: ${supervisor.supervisor_id}`,
          `Generation: ${supervisor.generation}`,
        ].join('\n'));
      } else {
        print(classification === 'alive'
          ? 'Supervisor: ALIVE — authoritative Herdr session is current'
          : `Supervisor: UNKNOWN — ${herdr.reasons?.join(', ') || herdr.classification}`);
      }
      if (classification !== 'alive') process.exitCode = 1;
    } else throw new Error('unknown supervisor command');
    return;
  }
  throw new Error(`unknown command: ${command}\n${usage()}`);
}
