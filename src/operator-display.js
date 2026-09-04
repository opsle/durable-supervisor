const TERMINAL_CHILD_STATES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);
const ACTIONABLE_WAKE_CLASSIFICATIONS = new Set([
  'queued',
  'native-ready',
  'unsupported-topology',
  'awaiting-consumption',
]);

function words(value) {
  return String(value ?? 'unknown').replaceAll('_', ' ').replaceAll('-', ' ');
}

function title(value) {
  const text = words(value).toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function enabledLabel(value) {
  if (value === true) return 'enabled';
  if (value === false) return 'disabled';
  return 'UNKNOWN';
}

function compactText(value, maximum = 180) {
  const text = String(value);
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
}

export function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'unknown';
  if (milliseconds < 1000) return milliseconds === 0 ? '0s' : 'less than 1s';
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return remainingSeconds ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours ? `${days}d ${remainingHours}h` : `${days}d`;
}

export function formatRelativeTime(timestamp, referenceTime = Date.now()) {
  const parsed = Date.parse(timestamp);
  const reference = referenceTime instanceof Date ? referenceTime.getTime() : Number(referenceTime);
  if (!Number.isFinite(parsed) || !Number.isFinite(reference)) return 'unknown';
  const difference = reference - parsed;
  if (Math.abs(difference) < 1000) return 'just now';
  return difference > 0
    ? `${formatDuration(difference)} ago`
    : `in ${formatDuration(Math.abs(difference))}`;
}

export function abbreviateIdentifier(value, candidates = [], {
  minimum = 8,
  maximum = 18,
} = {}) {
  if (typeof value !== 'string' || value.length <= maximum) return value ?? 'unknown';
  const peers = [...new Set(candidates)]
    .filter((candidate) => typeof candidate === 'string' && candidate !== value);
  for (let length = minimum; length < maximum; length += 1) {
    const prefix = value.slice(0, length);
    if (peers.every((candidate) => !candidate.startsWith(prefix) && !prefix.startsWith(candidate))) {
      return `${prefix}…`;
    }
  }
  const prefix = value.slice(0, maximum - 1);
  return peers.every((candidate) => !candidate.startsWith(prefix) && !prefix.startsWith(candidate))
    ? `${prefix}…`
    : value;
}

function exactRunnerOwnership({ attempt, claim, runner, supervisor, processIsAlive }) {
  return runner?.schema === 'opsle.durable-supervisor.detached-runner/v1'
    && ['OWNED', 'TERMINAL'].includes(runner.status)
    && runner.task_id === attempt.task_id
    && runner.attempt_id === attempt.attempt_id
    && runner.claim_id === attempt.claim_id
    && runner.fence_generation === attempt.fence_generation
    && runner.supervisor_id === supervisor.supervisor_id
    && runner.supervisor_generation === attempt.policy_snapshot?.supervisor_generation
    && claim?.schema === 'opsle.durable-supervisor.claim/v1'
    && claim.task_id === attempt.task_id
    && claim.attempt_id === attempt.attempt_id
    && claim.claim_id === attempt.claim_id
    && claim.fence_generation === attempt.fence_generation
    && claim.owner_supervisor_id === supervisor.supervisor_id
    && claim.owner_generation === runner.supervisor_generation
    && (runner.status === 'TERMINAL'
      ? TERMINAL_CHILD_STATES.has(attempt.child_state)
      : claim.status === 'ACTIVE'
        && Number.isInteger(runner.worker_pid)
        && processIsAlive(runner.worker_pid));
}

export function deriveDisplayState({
  supervisor,
  state,
  objective = undefined,
  requirements = null,
  task,
  attempt,
  claim = null,
  runner = null,
  wakeAttention = null,
  sessionBinding = null,
  processIsAlive = () => false,
}) {
  const reasons = [];
  const hasObjective = Number.isSafeInteger(objective?.current_revision)
    && objective.current_revision > 0
    && objective.history?.some((item) => item.revision === objective.current_revision);
  const neutralInitialized = objective !== undefined
    && state?.phase === 'INITIALIZED'
    && !hasObjective
    && !state?.active_task_id
    && !state?.active_attempt_id;
  if (supervisor?.authority_status !== 'AUTHORITATIVE') {
    reasons.push(`supervisor authority is ${supervisor?.authority_status ?? 'UNKNOWN'}`);
  }
  if (state?.latest_unresolved_issue != null) {
    reasons.push(typeof state.latest_unresolved_issue === 'string'
      ? state.latest_unresolved_issue
      : (state.latest_unresolved_issue.reason ?? JSON.stringify(state.latest_unresolved_issue)));
  }
  if (wakeAttention?.actionable_count > 0) {
    reasons.push(`${wakeAttention.actionable_count} current wake request(s) require attention`);
  }
  if (sessionBinding && sessionBinding.valid !== true && !neutralInitialized) {
    reasons.push(`authoritative Herdr binding is not current: ${(sessionBinding.reasons ?? []).join(', ') || sessionBinding.classification}`);
  }
  if (neutralInitialized) reasons.push('objective required');
  if ((state?.active_task_id == null) !== (state?.active_attempt_id == null)) {
    reasons.push('active task and attempt authority are contradictory');
  }
  if (state?.supervisor_state === 'PAUSED' && state?.pause?.active !== true) {
    reasons.push('paused state lacks active pause authority');
  }
  if (state?.pause?.after_current === true && !state?.active_attempt_id) {
    reasons.push('pause-after-current lacks active work');
  }
  if (objective !== undefined && state?.phase === 'INITIALIZED' && hasObjective) {
    reasons.push('initialized phase contradicts a current objective');
  }
  if (objective !== undefined && state?.phase !== 'INITIALIZED' && !hasObjective) {
    reasons.push('active lifecycle lacks a current objective');
  }
  const openRequirements = requirements?.requirements?.filter((item) => ![
    'VERIFIED',
    'DEFERRED_WITH_JUSTIFICATION',
    'NOT_APPLICABLE_WITH_JUSTIFICATION',
  ].includes(item.state)).length ?? 0;
  if (state?.phase === 'COMPLETE' && openRequirements > 0) {
    reasons.push('complete phase retains open requirements');
  }

  let child = { label: 'NONE', reason: null, attention: false };
  if (state?.active_task_id && !task) {
    child = { label: 'UNKNOWN', reason: 'active task record is missing', attention: true };
  } else if (task && !attempt && state?.active_attempt_id) {
    child = { label: 'UNKNOWN', reason: 'active attempt record is missing', attention: true };
  } else if (task && !attempt) {
    child = { label: 'PENDING', reason: null, attention: false };
  } else if (attempt) {
    if (attempt.child_state === 'UNKNOWN' || attempt.child_state === 'UNCERTAIN') {
      child = {
        label: attempt.child_state,
        reason: attempt.runner_reconciliation?.worker_failure
          ?? 'durable evidence does not prove a current child outcome',
        attention: true,
      };
    } else if (['LAUNCHING', 'RUNNING'].includes(attempt.child_state)) {
      const detachedOwned = exactRunnerOwnership({
        attempt, claim, runner, supervisor, processIsAlive,
      });
      const foregroundOwned = !runner
        && Number.isInteger(attempt.pid)
        && processIsAlive(attempt.pid);
      child = detachedOwned || foregroundOwned
        ? { label: attempt.child_state, reason: null, attention: false }
        : {
          label: 'UNKNOWN',
          reason: 'running state lacks current exact Runner or foreground process ownership',
          attention: true,
        };
    } else if (TERMINAL_CHILD_STATES.has(attempt.child_state)) {
      const awaiting = task?.state === 'AWAITING_SUPERVISOR' && !attempt.supervisor_evaluation;
      child = awaiting
        ? { label: 'NEEDS REVIEW', reason: 'terminal child awaits supervisor evaluation', attention: true }
        : {
          label: attempt.child_state,
          reason: attempt.child_state === 'COMPLETED' ? null : `child ended ${attempt.child_state.toLowerCase()}`,
          attention: attempt.child_state !== 'COMPLETED',
        };
    } else {
      child = {
        label: attempt.child_state ?? 'UNKNOWN',
        reason: attempt.child_state ? null : 'child state is absent',
        attention: !attempt.child_state,
      };
    }
  }
  if (child.reason) reasons.push(child.reason);

  let supervisorLabel;
  if (neutralInitialized && supervisor?.authority_status === 'AUTHORITATIVE') {
    supervisorLabel = 'INITIALIZED';
  } else if (reasons.length > 0 || child.attention) {
    supervisorLabel = 'ATTENTION';
  } else if (state?.pause?.active && !(state.pause.after_current && task)) {
    supervisorLabel = 'PAUSED';
  } else if (state?.phase === 'COMPLETE' && !task && hasObjective) {
    supervisorLabel = 'COMPLETE';
  } else if (!hasObjective && !task) {
    supervisorLabel = 'INITIALIZED';
  } else if (task) {
    supervisorLabel = 'ACTIVE';
  } else {
    supervisorLabel = 'IDLE';
  }

  return {
    supervisor: supervisorLabel,
    child,
    attention: reasons.length > 0 || child.attention,
    reasons: [...new Set(reasons)],
  };
}

export function deriveSupervisorLiveness({ authorityStatus, herdr, tmuxAlive = false }) {
  if (authorityStatus !== 'AUTHORITATIVE') {
    return { classification: 'unknown', authority: null, reason: 'supervisor-authority-not-current' };
  }
  if (herdr?.valid === true && herdr.classification === 'bound-authoritative-herdr') {
    return { classification: 'alive', authority: 'herdr', reason: null };
  }
  if (tmuxAlive && !herdr?.reasons?.some((reason) => reason.includes('concurrent live tmux'))) {
    return { classification: 'alive', authority: 'tmux-fallback', reason: null };
  }
  return {
    classification: 'unknown',
    authority: null,
    reason: herdr?.reasons?.[0] ?? herdr?.classification ?? 'process-authority-unproven',
  };
}

function wakeTimestamp(record) {
  const candidates = [
    record?.consumption?.consumed_at,
    record?.receipt?.consumed_at,
    record?.receipt?.delivered_at,
    record?.receipt?.claimed_at,
    record?.decision?.delivered_at,
    record?.decision?.updated_at,
    record?.decision?.claimed_at,
    record?.prior_decision?.updated_at,
    record?.prior_decision?.claimed_at,
    record?.queued_at,
  ];
  return candidates.find((value) => Number.isFinite(Date.parse(value))) ?? null;
}

function latestFirst(left, right) {
  const timeDifference = (Date.parse(wakeTimestamp(right)) || -Infinity)
    - (Date.parse(wakeTimestamp(left)) || -Infinity);
  return timeDifference || String(right.event_id).localeCompare(String(left.event_id));
}

export function selectWakeRecords(requests) {
  const authoritative = requests.filter((record) => record.authoritative === true);
  const actionable = authoritative
    .filter((record) => ACTIONABLE_WAKE_CLASSIFICATIONS.has(record.classification))
    .sort(latestFirst);
  const latest = [...authoritative].sort(latestFirst)[0] ?? null;
  return {
    current: actionable[0] ?? null,
    latest,
    actionable_count: actionable.length,
    authoritative_count: authoritative.length,
  };
}

export function renderPolicy(policy, { verbose = false } = {}) {
  const providers = Object.entries(policy.providers ?? {});
  const providerText = providers.length
    ? providers.map(([name, config]) => `${title(name)} ${enabledLabel(config?.enabled)}`).join('; ')
    : 'providers unknown';
  const review = policy.review?.mode ?? 'UNKNOWN';
  const polling = policy.model_polling?.permitted === false
    ? 'prohibited'
    : (policy.model_polling?.permitted === true ? 'permitted' : 'UNKNOWN');
  const lines = [`Policy: ${providerText}; review ${words(review)}; Context Firewall mandatory; model polling ${polling}`];
  if (verbose) {
    lines.push(`Version: ${policy.version ?? 'unknown'}`);
    for (const [name, config] of providers) {
      lines.push(`${title(name)}: enabled=${config?.enabled ?? 'UNKNOWN'} model=${config?.model ?? 'unknown'} reasoning=${config?.reasoning_effort ?? 'unknown'}`);
    }
    lines.push(`Reviewer: ${policy.review?.reviewer ?? 'none'}`);
    lines.push(`Affected verification: ${words(policy.affected_verification?.authority)}`);
    lines.push('Context Firewall: mandatory');
    lines.push(`Changed: ${policy.changed_at ?? 'unknown'} by ${policy.changed_by ?? 'unknown'}`);
  }
  return lines.join('\n');
}

export function renderModels(policy, { verbose = false } = {}) {
  const providers = Object.entries(policy.providers ?? {});
  if (!verbose) {
    return `Models: ${providers.length
      ? providers.map(([name, config]) => `${title(name)} ${enabledLabel(config?.enabled)}`).join('; ')
      : 'UNKNOWN'}`;
  }
  return [
    'MODELS',
    ...providers.map(([name, config]) => (
      `${title(name)}: ${enabledLabel(config?.enabled).toUpperCase()}; model=${config?.model ?? 'unknown'}; reasoning=${config?.reasoning_effort ?? 'unknown'}`
    )),
  ].join('\n');
}

export function renderSession(status, { verbose = false, identifiers = [] } = {}) {
  const label = status.valid === true
    ? 'CURRENT'
    : (status.classification === 'unbound' ? 'UNBOUND' : 'UNKNOWN');
  const session = status.binding?.codex_session_uuid;
  const reasons = status.reasons?.length ? status.reasons.map(words).join(', ') : status.reason;
  const lines = [
    `Herdr session: ${label}${session ? ` — ${abbreviateIdentifier(session, identifiers)}` : ''}${reasons ? ` — ${reasons}` : ''}`,
  ];
  if (verbose && status.binding) {
    lines.push(`Classification: ${status.classification}`);
    lines.push(`Session ID: ${session}`);
    lines.push(`Binding ID: ${status.binding.binding_id}`);
    lines.push(`Host PID: ${status.binding.host?.process?.pid ?? 'unknown'}`);
    lines.push(`Workspace: ${status.binding.host?.workspace_id ?? 'unknown'}`);
    lines.push(`Pane: ${status.binding.host?.pane_id ?? 'unknown'}`);
    lines.push(`Rollout: ${status.binding.rollout?.realpath ?? 'unknown'}`);
    lines.push(`Bound: ${status.binding.bound_at ?? 'unknown'}`);
  }
  return lines.join('\n');
}

export function renderSupervisorStatus(value, {
  verbose = false,
  referenceTime = Date.now(),
} = {}) {
  const active = value.active_work;
  const identifiers = [
    value.supervisor.identity,
    active?.task_id,
    active?.attempt_id,
    active?.claim_id,
  ].filter(Boolean);
  const lifecycle = value.objective
    ? `${title(value.supervisor.phase)} — objective r${value.objective.revision}`
    : `${title(value.supervisor.phase)} — no objective set`;
  const pause = value.supervisor.pause?.active
    ? `${value.supervisor.pause.after_current ? 'after current work' : 'active'}${value.supervisor.pause.reason ? ` — ${compactText(value.supervisor.pause.reason)}` : ''}`
    : 'clear';
  const sessionLabel = value.session_binding.valid === true
    ? `current — workspace ${value.session_binding.binding.host.workspace_id}, pane ${value.session_binding.binding.host.pane_id}`
    : `${value.session_binding.classification === 'stale' ? 'unknown' : words(value.session_binding.classification)}${value.session_binding.reasons?.length ? ` — ${value.session_binding.reasons.map(words).join(', ')}` : ''}`;
  const wakeCurrent = value.wake?.current ?? null;
  const wake = wakeCurrent
    ? `${title(wakeCurrent.classification)} — ${words(wakeCurrent.terminal_type)} for ${abbreviateIdentifier(wakeCurrent.task_id, identifiers)}`
    : 'clear';
  let next = value.progress.pending_next_action ?? 'none';
  if (active && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(active.child_state)) {
    next = `Evaluate ${abbreviateIdentifier(active.task_id, identifiers)}.`;
  } else if (active) {
    next = 'Await the current Runner result.';
  } else if (value.supervisor.pause?.active) {
    next = 'Await operator direction.';
  }
  const lines = [
    `Lifecycle: ${lifecycle}`,
    `Pause: ${pause}`,
  ];
  if (!active) {
    lines.push('Work: none');
  } else {
    const taskId = abbreviateIdentifier(active.task_id, identifiers);
    const attemptId = abbreviateIdentifier(active.attempt_id, identifiers);
    const timing = ['LAUNCHING', 'RUNNING'].includes(value.operator_state.child.label)
      ? ` for ${formatDuration(active.elapsed_ms)}`
      : (active.completion ? ` ${formatRelativeTime(active.completion, referenceTime)}` : '');
    lines.push(`Work: ${title(value.operator_state.child.label)} — ${active.description} [${taskId}]${timing}; attempt ${attemptId}`);
  }
  lines.push(`Wake: ${wake}`);
  lines.push(`Herdr: ${sessionLabel}`);
  lines.push(`Next: ${compactText(next)}`);

  const requirementEntries = Object.entries(value.progress.requirements);

  if (verbose) {
    lines.push('');
    lines.push('SUPERVISOR DIAGNOSTICS');
    lines.push(`Repository: ${value.supervisor.repository}`);
    lines.push(`Identity: ${value.supervisor.identity}`);
    lines.push(`Generation: ${value.supervisor.generation}`);
    lines.push(`Durable state: ${value.supervisor.state}`);
    lines.push(`Phase: ${value.supervisor.phase}`);
    lines.push(`Pause: ${JSON.stringify(value.supervisor.pause)}`);
    lines.push(`Attention: ${value.operator_state.attention ? value.operator_state.reasons.join('; ') : 'none'}`);
    lines.push(`Herdr classification: ${value.session_binding.classification}`);
    lines.push(`Herdr session ID: ${value.session_binding.binding?.codex_session_uuid ?? 'none'}`);
    lines.push(`Herdr reasons: ${(value.session_binding.reasons ?? []).join(', ') || 'none'}`);
    lines.push(`Tmux fallback: ${value.supervisor.tmux_session ?? 'not configured'} (${value.supervisor.tmux_alive ? 'available' : 'unavailable'})`);
    lines.push(`Objective: ${value.objective?.objective ?? 'unknown'}`);
    if (active) {
      lines.push('');
      lines.push('WORK DIAGNOSTICS');
      lines.push(`Task ID: ${active.task_id}`);
      lines.push(`Task durable state: ${active.state}`);
      lines.push(`Attempt ID: ${active.attempt_id}`);
      lines.push(`Claim ID: ${active.claim_id ?? 'none'}`);
      lines.push(`Route: ${active.route ?? 'unknown'}`);
      lines.push(`Provider: ${active.provider == null ? 'unknown' : JSON.stringify(active.provider)}`);
      lines.push(`Child durable state: ${active.child_state ?? 'unknown'}`);
      lines.push(`PID: ${active.pid ?? 'unknown'}`);
      lines.push(`Started: ${active.start_time ?? 'unknown'}`);
      lines.push(`Last heartbeat: ${active.last_heartbeat ?? 'unknown'}`);
      lines.push(`Completed: ${active.completion ?? 'none'}`);
      lines.push(`Elapsed: ${formatDuration(active.elapsed_ms)} (${active.elapsed_ms ?? 'unknown'} ms)`);
      for (const [name, measurement] of Object.entries(active.telemetry)) {
        lines.push(`${words(name)}: ${measurement ?? 'unknown'}`);
      }
    }
    lines.push('');
    lines.push('PROGRESS DIAGNOSTICS');
    lines.push(`Requirements: ${requirementEntries.map(([name, count]) => `${name}=${count}`).join(' ')}`);
    lines.push(`Latest accepted task: ${value.progress.latest_accepted_task ?? 'none'}`);
    lines.push(`Unresolved: ${value.progress.latest_unresolved_issue == null ? 'none' : JSON.stringify(value.progress.latest_unresolved_issue)}`);
    lines.push('');
    lines.push('MEASUREMENT');
    lines.push(`Children: ${value.telemetry.children}`);
    lines.push(`Routes: deterministic=${value.telemetry.deterministic_routes} model=${value.telemetry.model_routes}`);
    lines.push(`Automatic activations: ${value.telemetry.activations.total_automatic ?? 'unknown'}`);
    lines.push(`Terminal-event activations: ${value.telemetry.activations.terminal_event ?? 'unknown'}`);
    lines.push(`Human activations: ${value.telemetry.activations.human ?? 'unknown'}`);
    lines.push(`Wait-induced activations: ${value.telemetry.activations.wait_induced_automatic ?? 'unknown'}`);
    lines.push(`Activation evidence: ${value.telemetry.activations.evidence}`);
    lines.push('Legacy model polling field: untrusted');
    lines.push(`Measured child duration: ${formatDuration(value.telemetry.measured_child_execution_duration_ms)}`);
    lines.push(`Measured raw output bytes: ${value.telemetry.measured_raw_output_bytes ?? 'unknown'}`);
    lines.push(`Measured raw evidence bytes: ${value.telemetry.measured_raw_evidence_bytes ?? 'unknown'}`);
    lines.push(`Measured compact packet bytes: ${value.telemetry.measured_compact_packet_bytes ?? 'unknown'}`);
    lines.push(`Unmeasured completions: ${value.telemetry.unmeasured_completion_count}`);
    lines.push('Output tokens: unknown');
    lines.push('Cost: unknown');
  }
  return lines.join('\n');
}

export function renderWakeStatus(value, { verbose = false, referenceTime = Date.now() } = {}) {
  const selected = selectWakeRecords(value.requests ?? []);
  const current = selected.current;
  const uncertain = current?.reason?.includes('uncertain')
    || current?.decision?.status === 'UNCERTAIN';
  const unsupported = current?.classification === 'unsupported-topology';
  const bindingProblem = current && value.session_binding?.valid !== true;
  const attention = uncertain || unsupported || bindingProblem;
  const lines = [];
  if (attention) {
    lines.push(`ATTENTION: ${uncertain ? 'wake delivery is UNCERTAIN' : title(current.reason)}`);
  }
  if (!current) {
    lines.push('Wake: clear — no current actionable requests');
  } else {
    lines.push(`Wake: ${uncertain ? 'UNCERTAIN' : title(current.classification)} — ${words(current.terminal_type)} for ${abbreviateIdentifier(current.task_id, (value.requests ?? []).map((item) => item.task_id))}`);
    lines.push(`Queued: ${formatRelativeTime(current.queued_at, referenceTime)}; reason: ${words(current.reason)}`);
  }
  lines.push(`Queue: ${selected.actionable_count} actionable; ${(value.requests ?? []).length} total`);
  lines.push(`Herdr: ${value.session_binding?.valid === true ? 'current' : words(value.session_binding?.classification)}`);
  lines.push(`Dispatcher: ${value.dispatcher?.current === true ? 'current' : (value.dispatcher ? 'not current' : 'not started')}`);
  if (verbose) {
    lines.push('');
    lines.push('WAKE DIAGNOSTICS');
    lines.push(`Supervisor generation: ${value.supervisor_generation}`);
    lines.push(`Current event: ${current?.event_id ?? 'none'}`);
    lines.push(`Latest authoritative event: ${selected.latest?.event_id ?? 'none'}`);
    if (current) {
      lines.push(`Task: ${current.task_id ?? 'unknown'}`);
      lines.push(`Attempt: ${current.attempt_id ?? 'unknown'}`);
      lines.push(`Queued at: ${current.queued_at ?? 'unknown'}`);
      lines.push(`Classification: ${current.classification}`);
      lines.push(`Reason: ${current.reason}`);
    }
    lines.push(`Session classification: ${value.session_binding?.classification ?? 'unknown'}`);
    lines.push(`Session reasons: ${(value.session_binding?.reasons ?? []).join(', ') || 'none'}`);
    lines.push(`Dispatcher ID: ${value.dispatcher?.dispatcher_id ?? 'none'}`);
    lines.push(`Dispatcher status: ${value.dispatcher?.status ?? 'not-started'}`);
    lines.push(`Dispatcher implementation current: ${value.dispatcher?.implementation_fence?.current === true ? 'yes' : 'no'}`);
    lines.push(`Dispatcher implementation expected: ${value.dispatcher?.implementation_fence?.expected_sha256 ?? 'unknown'}`);
    lines.push(`Dispatcher implementation observed: ${value.dispatcher?.implementation_fence?.observed_sha256 ?? 'unknown'}`);
  }
  return lines.join('\n');
}

export function detachedLaunchNotice(result) {
  const ids = [result.task_id, result.attempt_id];
  const pause = result.pause_after_current?.armed ? '; pause after evaluation is armed' : '';
  return `Child ${abbreviateIdentifier(result.task_id, ids)} started as ${abbreviateIdentifier(result.attempt_id, ids)}; Runner owns monitoring and the supervisor is dormant${pause}. END_TURN_IMMEDIATELY`;
}
