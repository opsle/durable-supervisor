import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  appendEvent,
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
  routeTask,
} from './pipeline.js';
import { runAttempt } from './runner.js';
import { activationSummary } from './activation-telemetry.js';
import { applyWakeEvent } from './wakeup.js';

function usage() {
  return `usage: opsle COMMAND

commands:
  init
  status [--json] [--watch [--iterations N] [--interval-ms MS]]
  validate
  recover
  cutover --first-task TASK_ID
  pause [--after-current] [--reason TEXT]
  resume
  objective show
  objective set --text TEXT
  policy status
  policy enable PROVIDER
  policy disable PROVIDER
  policy review MODE [--reviewer PROVIDER]
  models status|enable|disable [PROVIDER]
  task create --input FILE
  task run TASK_ID
  task evaluate TASK_ID --accept|--reject --rationale TEXT
  task show TASK_ID
  requirements [--json]
  evidence show ATTEMPT_ID
  events consume EVENT_ID
  telemetry import-activation-profile --input FILE
  supervisor session-name|start|attach|is-alive
`;
}

function valueAfter(args, flag, fallback = null) {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : args[index + 1];
}

function print(value) {
  process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
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

function displayValue(value) {
  if (value == null) return 'unknown';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
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
  const matrix = readJson(paths(root).requirements);
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
  const previous = objective.history.find((item) => item.revision === objective.current_revision);
  if (!previous) throw new Error(`current objective revision is missing: ${objective.current_revision}`);
  if (previous.objective === objectiveText) throw new Error('objective is unchanged');

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
    specification_sha256: fileSha256(p.specification),
    changed_by: actor,
    effective_at: now(),
  };
  objective.history.push(revision);
  objective.current_revision = revision.revision;
  writeJson(p.objective, objective);
  if (!state.active_task_id) {
    updateState(root, {
      phase: state.phase === 'COMPLETE' ? 'SELF_HOSTED' : state.phase,
      pending_next_action: `Establish bounded work for objective revision ${revision.revision}.`,
    });
  }
  const event = emit(root, 'OBJECTIVE_CHANGED', {
    actor,
    objective_id: objective.objective_id,
    prior_revision: previous.revision,
    objective_revision: revision.revision,
    reconciliation,
  });
  return { objective, reconciliation, event_id: event.event_id };
}

function status(root, json = false) {
  const p = paths(root);
  const supervisor = readJson(p.supervisor);
  const state = readJson(p.state);
  const objective = readJson(p.objective);
  const policy = readJson(p.policy);
  const matrix = readJson(p.requirements);
  const task = state.active_task_id && existsSync(join(p.tasks, `${state.active_task_id}.json`))
    ? readJson(join(p.tasks, `${state.active_task_id}.json`)) : null;
  const attempt = state.active_attempt_id && existsSync(join(p.attempts, `${state.active_attempt_id}.json`))
    ? readJson(join(p.attempts, `${state.active_attempt_id}.json`)) : null;
  const counts = {};
  for (const requirement of matrix.requirements) counts[requirement.state] = (counts[requirement.state] ?? 0) + 1;
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
      tmux_session: supervisor.session_id,
      tmux_alive: supervisor.session_id ? tmuxAlive(supervisor.session_id) : false,
    },
    objective: objective.history.find((item) => item.revision === objective.current_revision),
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
      pending_next_action: state.pending_next_action,
    },
    telemetry,
  };
  if (json) return value;
  const active = value.active_work;
  return [
    'SUPERVISOR',
    `repository: ${root}`,
    `identity: ${supervisor.supervisor_id}`,
    `generation: ${supervisor.generation}`,
    `state: ${state.supervisor_state}`,
    `phase: ${state.phase}`,
    `pause: ${state.pause.active}`,
    `tmux: ${supervisor.session_id ?? 'none'} (${value.supervisor.tmux_alive ? 'alive' : 'not running'})`,
    `objective revision: ${objective.current_revision}`,
    `objective: ${value.objective?.objective ?? 'unknown'}`,
    '',
    'ACTIVE WORK',
    active ? [
      `task: ${active.task_id} ${active.description}`,
      `task state: ${active.state}`,
      `attempt: ${active.attempt_id}`,
      `route: ${active.route}`,
      `provider: ${displayValue(active.provider)}`,
      `child: ${active.child_state}`,
      `pid: ${displayValue(active.pid)}`,
      `claim: ${active.claim_id}`,
      `start: ${displayValue(active.start_time)}`,
      `elapsed ms: ${displayValue(active.elapsed_ms)}`,
      `heartbeat: ${displayValue(active.last_heartbeat)}`,
      `completion: ${displayValue(active.completion)}`,
      `execution duration ms: ${displayValue(active.telemetry.execution_duration_ms)}`,
      `raw output bytes: ${displayValue(active.telemetry.raw_output_bytes)}`,
      `raw evidence bytes: ${displayValue(active.telemetry.raw_evidence_bytes)}`,
      `compact packet bytes: ${displayValue(active.telemetry.compact_packet_bytes)}`,
      `retained bytes: ${displayValue(active.telemetry.retained_bytes)}`,
      `suppressed bytes: ${displayValue(active.telemetry.suppressed_bytes)}`,
      `reduction ratio: ${displayValue(active.telemetry.reduction_ratio)}`,
      'output tokens: unknown',
      'cost: unknown',
    ].join('\n') : 'none',
    '',
    'POLICY',
    `providers: ${Object.entries(value.policy.providers).map(([name, enabled]) => `${name}=${enabled ? 'enabled' : 'disabled'}`).join(' ')}`,
    `review: ${value.policy.review_mode}`,
    `affected verification: ${value.policy.affected_verification}`,
    '',
    'PROGRESS',
    `requirements: ${Object.entries(counts).map(([name, count]) => `${name}=${count}`).join(' ')}`,
    `latest accepted task: ${state.latest_accepted_task_id ?? 'none'}`,
    `unresolved: ${state.latest_unresolved_issue == null ? 'none' : displayValue(state.latest_unresolved_issue)}`,
    `next: ${state.pending_next_action ?? 'none'}`,
    '',
    'MEASUREMENT',
    `children: ${telemetry.children}`,
    `routes: deterministic=${telemetry.deterministic_routes} model=${telemetry.model_routes}`,
    `automatic activations: ${displayValue(activations.total_automatic)}`,
    `terminal-event activations: ${displayValue(activations.terminal_event)}`,
    `human activations: ${displayValue(activations.human)}`,
    `wait-induced activations: ${displayValue(activations.wait_induced_automatic)}`,
    `activation evidence: ${activations.evidence}`,
    'legacy model polling field: untrusted',
    `measured child duration ms: ${displayValue(telemetry.measured_child_execution_duration_ms)}`,
    `measured raw output bytes: ${displayValue(telemetry.measured_raw_output_bytes)}`,
    `measured raw evidence bytes: ${displayValue(telemetry.measured_raw_evidence_bytes)}`,
    `measured compact packet bytes: ${displayValue(telemetry.measured_compact_packet_bytes)}`,
    `unmeasured completions: ${telemetry.unmeasured_completion_count}`,
    'output tokens: unknown',
    'cost: unknown',
  ].join('\n');
}

async function watchStatus(root, args) {
  const intervalMs = integerOption(args, '--interval-ms', 1000, { maximum: 3_600_000 });
  const iterations = integerOption(args, '--iterations', Number.POSITIVE_INFINITY, { maximum: 1_000_000 });
  const json = args.includes('--json');
  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    if (json) print(JSON.stringify(status(root, true)));
    else {
      if (iteration > 1) print('');
      print(`STATUS SNAPSHOT ${iteration}`);
      print(status(root));
    }
    if (iteration < iterations) await sleep(intervalMs);
  }
}

function tmuxName(root) {
  return `opsle-${basename(root).replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

function tmuxAlive(name) {
  return spawnSync('tmux', ['has-session', '-t', name]).status === 0;
}

function recover(root) {
  const p = paths(root);
  const supervisor = readJson(p.supervisor);
  const state = readJson(p.state);
  let stateChanged = false;
  let reconciliation = { classification: 'no_active_work', action: 'none' };
  if (state.active_attempt_id) {
    const attemptPath = join(p.attempts, `${state.active_attempt_id}.json`);
    if (existsSync(attemptPath)) {
      const attempt = readJson(attemptPath);
      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(attempt.child_state)) {
        reconciliation = { classification: `known_${attempt.child_state.toLowerCase()}`, action: 'do_not_relaunch' };
      } else if (attempt.child_state === 'UNKNOWN') {
        reconciliation = {
          classification: 'unknown_unreconciled',
          action: 'remain_paused_and_reconcile',
          pid: attempt.pid,
        };
      } else if (attempt.pid) {
        let alive = true;
        try { process.kill(attempt.pid, 0); } catch { alive = false; }
        if (alive) reconciliation = { classification: 'known_running', action: 'preserve_claim_and_wait', pid: attempt.pid };
        else {
          attempt.child_state = 'UNKNOWN';
          const intervention = emit(root, 'INTERVENTION_REQUIRED', {
            task_id: attempt.task_id,
            attempt_id: attempt.attempt_id,
            wait_id: attempt.attempt_id,
            reason: 'active child PID is absent without terminal evidence',
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
  const pendingNextAction = derivePendingNextAction(state, readJson(p.requirements));
  if (pendingNextAction !== state.pending_next_action) {
    state.pending_next_action = pendingNextAction;
    stateChanged = true;
  }
  if (stateChanged) writeJson(p.state, state);
  supervisor.generation += 1;
  supervisor.recovered_at = now();
  writeJson(p.supervisor, supervisor);
  emit(root, 'SUPERVISOR_RECOVERED', { reconciliation });
  return { supervisor, state: readJson(p.state), reconciliation };
}

function evaluateTask(root, taskId, accept, rationale) {
  const p = paths(root);
  const taskPath = join(p.tasks, `${taskId}.json`);
  const task = readJson(taskPath);
  const attemptId = task.attempts.at(-1);
  if (!attemptId) throw new Error('task has no attempt');
  const attemptPath = join(p.attempts, `${attemptId}.json`);
  const attempt = readJson(attemptPath);
  if (attempt.supervisor_evaluation) return { idempotent: true, task, attempt };
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
  const nextState = {
    ...currentState,
    active_task_id: null,
    active_attempt_id: null,
    pending_next_action: accept
      ? NEXT_UNSATISFIED_REQUIREMENT_ACTION
      : `Create corrective work for ${taskId}.`,
  };
  updateState(root, {
    active_task_id: nextState.active_task_id,
    active_attempt_id: nextState.active_attempt_id,
    latest_accepted_task_id: accept ? taskId : currentState.latest_accepted_task_id,
    latest_unresolved_issue: accept ? null : `Supervisor rejected ${taskId}: ${rationale}`,
    pending_next_action: accept
      ? derivePendingNextAction(nextState, readJson(p.requirements))
      : nextState.pending_next_action,
  });
  emit(root, 'SUPERVISOR_DECISION', { task_id: taskId, attempt_id: attemptId, decision_id: decision.decision_id, decision: decision.decision });
  return { decision, task, attempt };
}

function consumeEvent(root, eventId) {
  const p = paths(root);
  const state = readJson(p.state);
  state.processed_event_ids ??= [];
  if (state.processed_event_ids.includes(eventId)) return { event_id: eventId, duplicate: true, action: 'ignored' };
  const event = readJson(join(p.events, `${eventId}.json`));
  state.processed_event_ids.push(eventId);
  writeJson(p.state, state);
  emit(root, 'EVENT_CONSUMED', { source_event_id: eventId, source_event_type: event.type });
  return { event_id: eventId, duplicate: false, action: 'recorded' };
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
  if (args.length === 0 || args[0] === 'help' || args[0] === '--help') {
    print(usage());
    return;
  }
  const root = repositoryRoot();
  const [command, subcommand, ...rest] = args;
  if (command === 'init') {
    print(initialize(root));
    return;
  }
  if (!existsSync(paths(root).supervisor)) throw new Error('run opsle init first');
  if (command === 'status') {
    if (args.includes('--watch')) await watchStatus(root, args);
    else print(status(root, args.includes('--json')));
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
  if (command === 'cutover') {
    const taskId = valueAfter(args, '--first-task');
    if (!taskId) throw new Error('cutover requires --first-task TASK_ID');
    const p = paths(root);
    const state = readJson(p.state);
    if (state.phase !== 'BOOTSTRAP') throw new Error(`cutover already occurred: ${state.phase}`);
    updateState(root, { phase: 'SELF_HOSTED', pending_next_action: `Run first post-cutover task ${taskId}.` });
    const event = emit(root, 'BOOTSTRAP_CUTOVER', {
      first_post_cutover_task_id: taskId,
      minimum_substrate: ['state', 'identity', 'policy', 'discovery', 'gearbox', 'authorization', 'handoff', 'claims', 'runner', 'events', 'context_firewall', 'acceptance', 'recovery'],
      remaining_requirements: readJson(p.requirements).requirements.filter((item) => item.state !== 'VERIFIED').map((item) => item.id),
      rationale: 'The minimum end-to-end path is locally implemented and deterministically validated; remaining work can now be delegated safely.',
    });
    setRequirements(root, ['DS-005', 'DS-090', 'DS-091'], 'IMPLEMENTED', [relative(root, join(p.events, `${event.event_id}.json`))]);
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
    if (subcommand === 'status') print(readJson(paths(root).policy).providers);
    else if (['enable', 'disable'].includes(subcommand)) {
      args = ['policy', subcommand, rest[0]];
      return main(args);
    } else throw new Error('models requires status, enable, or disable');
    return;
  }
  if (command === 'policy') {
    if (subcommand === 'status') print(readJson(paths(root).policy));
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
      const task = readJson(join(paths(root).tasks, `${rest[0]}.json`));
      const gearbox = routeTask(root, task);
      emit(root, 'GEARBOX_ROUTED', { task_id: task.task_id, decision_id: gearbox.decision_id, route: gearbox.selected_route, rationale: gearbox.rationale });
      const { attempt, claim } = createAttempt(root, task, gearbox);
      const result = await runAttempt(root, task, attempt, claim);
      print({
        task_id: task.task_id,
        attempt_id: result.attempt.attempt_id,
        child_state: result.attempt.child_state,
        acceptance: result.attempt.acceptance,
        compact_packet: result.attempt.compact_packet,
        completion_handoff: result.attempt.completion_handoff,
        completion_event_id: result.completion_event.event_id,
      });
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
    print(consumeEvent(root, rest[0]));
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
    const name = tmuxName(root);
    if (subcommand === 'session-name') print(name);
    else if (subcommand === 'is-alive') {
      const alive = tmuxAlive(name);
      print(alive ? 'alive' : 'not-running');
      if (!alive) process.exitCode = 1;
    } else if (subcommand === 'start') {
      if (tmuxAlive(name)) throw new Error(`tmux session already exists: ${name}`);
      const supervisor = readJson(paths(root).supervisor);
      const prompt = 'Read AGENTS.md and .opsle authoritative state. Run ./bin/opsle.js status and ./bin/opsle.js validate, reconcile ownership, then remain the interactive repository supervisor. Do not create a second supervisor identity.';
      const policy = readJson(paths(root).policy);
      const codex = policy.providers.codex;
      if (!codex.enabled) throw new Error('Codex provider is disabled by operator policy');
      const result = spawnSync('tmux', [
        'new-session', '-d', '-s', name, '-c', root,
        'codex', '-C', root, '--model', codex.model,
        '-c', `model_reasoning_effort="${codex.reasoning_effort}"`, prompt,
      ], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr.trim() || 'tmux start failed');
      supervisor.session_id = name;
      writeJson(paths(root).supervisor, supervisor);
      emit(root, 'CONTROLLED_SESSION_HANDOFF', { actor: 'operator-cli', tmux_session: name, authority_identity: supervisor.supervisor_id });
      print(name);
    } else if (subcommand === 'attach') {
      if (!tmuxAlive(name)) throw new Error(`tmux session not running: ${name}`);
      const result = spawnSync('tmux', ['attach-session', '-t', name], { stdio: 'inherit' });
      process.exitCode = result.status ?? 1;
    } else throw new Error('unknown supervisor command');
    return;
  }
  throw new Error(`unknown command: ${command}\n${usage()}`);
}
