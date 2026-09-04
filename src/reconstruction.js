import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  canonicalJson,
  now,
  sha256,
  writeJson,
} from './io.js';
import {
  paths,
  SATISFIED_REQUIREMENT_STATES,
  effectiveRequirementMatrix,
} from './state.js';
import { refreshCodexSessionBinding } from './wakeup.js';

export const RESUME_PACKET_SCHEMA = 'opsle.durable-supervisor.resume-packet/v1';
export const RECONSTRUCTION_TELEMETRY_SCHEMA = 'opsle.durable-supervisor.reconstruction-telemetry/v1';
export const PACKET_BYTE_CEILING = 4_000;
export const PACKET_CHARACTER_CEILING = 4_000;
export const EVIDENCE_OUTPUT_BYTE_CEILING = 16_384;
export const RESUME_FRESHNESS_SCHEMA = 'opsle.durable-supervisor.resume-freshness/v1';

const ACTIVE_CHILD_STATES = new Set(['QUEUED', 'LAUNCHING', 'RUNNING']);
const TERMINAL_CHILD_STATES = new Set(['COMPLETED', 'FAILED', 'STALLED', 'CANCELLED']);
const TERMINAL_TASK_STATES = new Set(['ACCEPTED', 'REJECTED']);
const CLASSIFICATION_PRIORITY = {
  complete_for_resume: 0,
  incomplete: 1,
  requires_escalation: 2,
  contradictory: 3,
};

function relativePath(root, path) {
  return relative(root, path).split(sep).join('/');
}

function boundedText(value, maximum, onOverflow) {
  if (value == null) return null;
  const text = typeof value === 'string' ? value : canonicalJson(value).trim();
  if (text.length <= maximum) return text;
  onOverflow?.(sha256(text));
  return `${text.slice(0, Math.max(0, maximum - 17))}...[sha256:${sha256(text).slice(0, 8)}]`;
}

function issueCollector() {
  const records = new Map();
  return {
    add(code, classification = 'incomplete') {
      const prior = records.get(code);
      if (!prior || CLASSIFICATION_PRIORITY[classification] > CLASSIFICATION_PRIORITY[prior]) {
        records.set(code, classification);
      }
    },
    classification() {
      let selected = 'complete_for_resume';
      for (const value of records.values()) {
        if (CLASSIFICATION_PRIORITY[value] > CLASSIFICATION_PRIORITY[selected]) selected = value;
      }
      return selected;
    },
    codes() {
      const values = [...records.keys()].sort();
      if (values.length <= 16) return values;
      return [...values.slice(0, 15), `additional-issues:${values.length - 15}`];
    },
  };
}

function snapshotValue(value) {
  if (Array.isArray(value)) return value.map(snapshotValue);
  if (value === null || typeof value !== 'object') return value;
  const irrelevant = new Set([
    'heartbeat_at',
    'updated_at',
    'changed_at',
    'created_at',
    'effective_at',
    'inspected_at',
    'recovered_at',
    'bound_at',
    'queued_at',
    'claimed_at',
    'delivered_at',
    'consumed_at',
    'prepared_at',
    'registered_at',
    'deadline_at',
    'launch_time',
    'terminal_at',
    'last_durable_event',
    'telemetry',
    'evidence',
    'raw_evidence',
    'raw_evidence_references',
  ]);
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !irrelevant.has(key))
    .map(([key, item]) => [key, snapshotValue(item)]));
}

function sourceReader(root, issues) {
  const considered = new Map();
  function read(path, { required = true } = {}) {
    const rel = relativePath(root, path);
    if (!existsSync(path)) {
      if (required) issues.add(`missing:${rel}`, 'incomplete');
      return null;
    }
    let raw;
    try {
      raw = readFileSync(path);
      const value = JSON.parse(raw.toString('utf8'));
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
      considered.set(path, {
        bytes: raw.length,
        sha256: sha256(raw),
        snapshot_sha256: sha256(canonicalJson(snapshotValue(value))),
        path: rel,
      });
      return value;
    } catch {
      issues.add(`invalid-json:${rel}`, 'contradictory');
      return null;
    }
  }
  function track(path) {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path);
    let snapshotSha256 = sha256(raw);
    try { snapshotSha256 = sha256(canonicalJson(snapshotValue(JSON.parse(raw.toString('utf8'))))); } catch { /* Raw fence. */ }
    considered.set(path, {
      bytes: raw.length,
      sha256: sha256(raw),
      snapshot_sha256: snapshotSha256,
      path: relativePath(root, path),
    });
    return raw;
  }
  function verifyUnchanged() {
    for (const [path, record] of considered) {
      if (!existsSync(path)) {
        throw new Error(`authoritative state changed during reconstruction: ${record.path}`);
      }
      const raw = readFileSync(path);
      let currentSha256 = sha256(raw);
      try { currentSha256 = sha256(canonicalJson(snapshotValue(JSON.parse(raw.toString('utf8'))))); } catch { /* Raw fence. */ }
      if (currentSha256 !== record.snapshot_sha256) {
        throw new Error(`authoritative state changed during reconstruction: ${record.path}`);
      }
    }
  }
  function authorityFingerprint() {
    const manifest = [...considered.values()]
      .map(({ path, snapshot_sha256: authoritySha256 }) => ({ path, authority_sha256: authoritySha256 }))
      .sort((left, right) => left.path.localeCompare(right.path));
    return sha256(canonicalJson(manifest));
  }
  return { read, track, verifyUnchanged, authorityFingerprint, considered };
}

function evidenceCollector(root, reader) {
  const authoritative = new Set();
  const escalation = new Map();
  return {
    authoritative(path) {
      if (path) authoritative.add(relativePath(root, path));
    },
    escalation(path, selector, reason) {
      if (!path) return;
      const rel = relativePath(root, path);
      let selectedSha256 = null;
      if (existsSync(path)) {
        try {
          const selected = selectedEvidence(JSON.parse(readFileSync(path, 'utf8')), selector);
          selectedSha256 = sha256(canonicalJson(selected));
        } catch { /* The issue already records unreadable evidence. */ }
      }
      const key = `${rel}\0${selector}\0${reason}`;
      escalation.set(key, {
        path: rel,
        selector,
        reason,
        sha256: selectedSha256,
      });
    },
    value() {
      const authoritativeEntries = [...authoritative].sort().map((path) => {
        const tracked = [...reader.considered.values()].find((item) => item.path === path);
        return { path, sha256: tracked?.snapshot_sha256 ?? null };
      });
      return {
        authoritative: {
          count: authoritativeEntries.length,
          manifest_sha256: sha256(canonicalJson(authoritativeEntries)),
        },
        escalation: [...escalation.values()]
          .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)))
          .slice(0, 8),
      };
    },
  };
}

function compactSessionStatus(status) {
  const binding = status?.binding;
  return {
    classification: status?.classification ?? 'unknown',
    valid: status?.valid === true,
    supported: status?.supported === true,
    binding_revision: binding?.binding_revision ?? status?.binding_revision ?? null,
    codex_session_uuid: binding?.codex_session_uuid ?? null,
    supervisor_generation: binding?.supervisor_generation ?? null,
    reasons: [...new Set(status?.reasons ?? [])].sort(),
  };
}

function compactHerdr(status) {
  const binding = status?.binding;
  return {
    authority: binding?.host?.authority ?? 'none',
    kind: binding?.host?.kind ?? null,
    status: status?.valid === true ? 'current' : (binding ? 'stale' : 'unbound'),
    workspace_id: binding?.host?.workspace_id ?? null,
    host_pid: binding?.host?.process?.pid ?? null,
  };
}

function freshnessValue(packet) {
  const {
    budget: _budget,
    evidence: _evidence,
    freshness: _freshness,
    ...decisionRelevant
  } = packet;
  return decisionRelevant;
}

function applyFreshness(packet, authorityFingerprint, ephemeralAuthority = null) {
  packet.freshness = {
    schema: RESUME_FRESHNESS_SCHEMA,
    authority_sha256: sha256(canonicalJson({
      packet: freshnessValue(packet),
      sources: authorityFingerprint,
      ephemeral: ephemeralAuthority,
    })),
  };
  return packet;
}

function summarizeWake(root, reader, supervisor, state, injectedStatus = null) {
  if (injectedStatus) return injectedStatus;
  const base = join(paths(root).opsle, 'wake');
  const requestsDirectory = join(base, 'requests');
  if (!existsSync(requestsDirectory)) return { attention_count: 0, queued: 0, uncertain: 0, items: [] };
  const items = [];
  for (const name of readdirSync(requestsDirectory).filter((value) => value.endsWith('.json')).sort()) {
    const requestPath = join(requestsDirectory, name);
    const request = reader.read(requestPath, { required: false });
    if (!request) continue;
    const validSchema = [
      'opsle.durable-supervisor.host-wake-request/v1',
      'opsle.durable-supervisor.native-wake-request/v2',
    ].includes(request.schema);
    if (request.target?.supervisor_id !== supervisor?.supervisor_id
        || request.target?.supervisor_generation !== supervisor?.generation) continue;
    const deliveryPath = join(base, 'deliveries', `${request.event_id}.json`);
    const delivery = reader.read(deliveryPath, { required: false });
    if (delivery && ['DELIVERED', 'CONSUMED'].includes(delivery.status)) {
      const consumptionPath = join(base, 'consumptions', `${request.event_id}.json`);
      const consumption = reader.read(consumptionPath, { required: false });
      const consumed = delivery.status === 'CONSUMED'
        || (consumption?.schema === 'opsle.durable-supervisor.wake-consumption/v1'
          && consumption.event_id === request.event_id
          && consumption.delivery_id === delivery.delivery_id
          && consumption.supervisor_id === delivery.supervisor_id
          && consumption.supervisor_generation === delivery.supervisor_generation);
      if (consumed) continue;
      const historicalTask = request.task_id
        ? reader.read(join(paths(root).tasks, `${request.task_id}.json`), { required: false })
        : null;
      const historicalAttempt = request.attempt_id
        ? reader.read(join(paths(root).attempts, `${request.attempt_id}.json`), { required: false })
        : null;
      if (TERMINAL_TASK_STATES.has(historicalTask?.state)
          || historicalAttempt?.supervisor_evaluation) continue;
      items.push({
        event_id: request.event_id,
        task_id: request.task_id ?? null,
        attempt_id: request.attempt_id ?? null,
        queued_at: request.queued_at ?? null,
        terminal_type: request.terminal_type ?? null,
        classification: 'awaiting-consumption',
        reason: 'delivered-terminal-wake-unconsumed',
        request_path: requestPath,
        decision_path: null,
      });
      continue;
    }
    if (state?.processed_event_ids?.includes(request.event_id)) continue;
    if (request.task_id && request.attempt_id) {
      const task = reader.read(join(paths(root).tasks, `${request.task_id}.json`), { required: false });
      const attempt = reader.read(join(paths(root).attempts, `${request.attempt_id}.json`), { required: false });
      if (TERMINAL_TASK_STATES.has(task?.state) || attempt?.supervisor_evaluation) continue;
    }
    const decisionPath = join(base, 'activation-decisions', `${request.event_id}.json`);
    const decision = reader.read(decisionPath, { required: false });
    if (decision?.status === 'DELIVERED') continue;
    const uncertain = !validSchema || decision?.status === 'UNCERTAIN';
    items.push({
      event_id: request.event_id,
      task_id: request.task_id ?? null,
      attempt_id: request.attempt_id ?? null,
      queued_at: request.queued_at ?? null,
      terminal_type: request.terminal_type ?? null,
      classification: uncertain ? 'uncertain' : 'queued',
      reason: !validSchema
        ? 'invalid-wake-request'
        : (uncertain ? (decision.failure ?? 'activation-decision-uncertain') : (decision?.status ?? 'receipt-free')),
      request_path: requestPath,
      decision_path: decision ? decisionPath : null,
    });
  }
  const ranked = items.sort((left, right) => {
    const leftCurrent = left.task_id === state?.active_task_id
      && left.attempt_id === state?.active_attempt_id;
    const rightCurrent = right.task_id === state?.active_task_id
      && right.attempt_id === state?.active_attempt_id;
    if (leftCurrent !== rightCurrent) return leftCurrent ? -1 : 1;
    const priority = { 'awaiting-consumption': 0, uncertain: 1, queued: 2 };
    const classification = (priority[left.classification] ?? 3)
      - (priority[right.classification] ?? 3);
    if (classification !== 0) return classification;
    return String(right.queued_at ?? '').localeCompare(String(left.queued_at ?? ''));
  });
  return {
    attention_count: items.length,
    queued: items.filter((item) => item.classification === 'queued').length,
    uncertain: items.filter((item) => item.classification === 'uncertain').length,
    selected_count: Math.min(1, ranked.length),
    omitted_count: Math.max(0, ranked.length - 1),
    items: ranked.slice(0, 1),
  };
}

function compactDecision(attempt, taskId) {
  if (attempt?.supervisor_evaluation) return {
    kind: 'supervisor_evaluation',
    decision_id: attempt.supervisor_evaluation.decision_id ?? null,
    decision: attempt.supervisor_evaluation.decision ?? null,
    task_id: taskId,
    evaluated_at: attempt.supervisor_evaluation.evaluated_at ?? null,
  };
  const gearbox = attempt?.policy_snapshot?.gearbox_decision;
  if (gearbox) return {
    kind: 'gearbox',
    decision_id: gearbox.decision_id ?? null,
    decision: gearbox.selected_route ?? null,
    task_id: taskId,
  };
  return null;
}

function identitySelector(value) {
  const keys = [
    'schema', 'task_id', 'attempt_id', 'claim_id', 'state', 'child_state',
    'fence_generation', 'status', 'owner_supervisor_id', 'owner_generation',
  ];
  return Object.fromEntries(keys.filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]));
}

function classifyActiveWork({ root, p, reader, evidence, issues, state, supervisor, objective }) {
  const taskId = state?.active_task_id ?? null;
  const attemptId = state?.active_attempt_id ?? null;
  if (!taskId && !attemptId) return { activeWork: null, decision: null, attempt: null };
  if (!taskId || !attemptId) issues.add('active-task-attempt-pair-incomplete', 'contradictory');
  const taskPath = taskId ? join(p.tasks, `${taskId}.json`) : null;
  const attemptPath = attemptId ? join(p.attempts, `${attemptId}.json`) : null;
  const task = taskPath ? reader.read(taskPath) : null;
  const attempt = attemptPath ? reader.read(attemptPath) : null;
  evidence.authoritative(taskPath);
  evidence.authoritative(attemptPath);
  if (task && (task.schema !== 'opsle.durable-supervisor.task-handoff/v1'
      || task.task_id !== taskId || task.supervisor_id !== supervisor?.supervisor_id)) {
    issues.add('active-task-identity-mismatch', 'contradictory');
    evidence.escalation(taskPath, 'identity', 'active-task-identity-mismatch');
  }
  if (attempt && (attempt.schema !== 'opsle.durable-supervisor.child-attempt/v1'
      || attempt.attempt_id !== attemptId || attempt.task_id !== taskId)) {
    issues.add('active-attempt-identity-mismatch', 'contradictory');
    evidence.escalation(attemptPath, 'identity', 'active-attempt-identity-mismatch');
  }
  if (task && attemptId && !task.attempts?.includes(attemptId)) {
    issues.add('active-attempt-not-listed-by-task', 'contradictory');
    evidence.escalation(taskPath, 'identity', 'active-attempt-not-listed-by-task');
  }
  if (task && objective && (task.parent_objective_id !== objective.objective_id
      || task.parent_objective_revision !== objective.current_revision)) {
    issues.add('active-task-objective-revision-stale', 'requires_escalation');
    evidence.escalation(taskPath, 'identity', 'active-task-objective-revision-stale');
  }
  let claim = null;
  let claimPath = null;
  let indexed = null;
  if (attempt?.claim_id) {
    claimPath = join(p.claims, `${attempt.claim_id}.json`);
    claim = reader.read(claimPath);
    evidence.authoritative(claimPath);
    const indexPath = join(p.claims, 'index.json');
    const index = reader.read(indexPath);
    evidence.authoritative(indexPath);
    indexed = index?.[`task-${taskId}`] ?? null;
    const exact = claim
      && claim.schema === 'opsle.durable-supervisor.claim/v1'
      && claim.claim_id === attempt.claim_id
      && claim.task_id === taskId
      && claim.attempt_id === attemptId
      && claim.fence_generation === attempt.fence_generation
      && claim.owner_supervisor_id === supervisor?.supervisor_id
      && claim.owner_generation === attempt.policy_snapshot?.supervisor_generation
      && attempt.policy_snapshot?.claim_id === claim.claim_id
      && attempt.policy_snapshot?.fence_generation === claim.fence_generation
      && index?.schema === 'opsle.durable-supervisor.claim-index/v1'
      && indexed?.claim_id === claim.claim_id
      && indexed?.fence_generation === claim.fence_generation
      && indexed?.status === claim.status;
    if (!exact) {
      issues.add('active-claim-fence-relationship-contradictory', 'contradictory');
      evidence.escalation(claimPath, 'identity', 'active-claim-fence-relationship-contradictory');
      evidence.escalation(indexPath, `task-${taskId}`, 'active-claim-index-relationship-contradictory');
    }
    if (ACTIVE_CHILD_STATES.has(attempt.child_state) && claim?.status !== 'ACTIVE') {
      issues.add('nonterminal-attempt-without-active-claim', 'contradictory');
    }
    if (TERMINAL_CHILD_STATES.has(attempt.child_state) && claim?.status === 'ACTIVE') {
      issues.add('terminal-attempt-with-active-claim', 'contradictory');
    }
  } else if (attempt) {
    issues.add('active-attempt-claim-missing', 'incomplete');
  }
  if (attempt?.child_state === 'UNKNOWN') {
    issues.add('active-child-state-unknown', 'requires_escalation');
    evidence.escalation(attemptPath, 'identity', 'active-child-state-unknown');
  }
  if (attempt && !ACTIVE_CHILD_STATES.has(attempt.child_state)
      && !TERMINAL_CHILD_STATES.has(attempt.child_state)
      && attempt.child_state !== 'UNKNOWN') {
    issues.add('active-child-state-unclassified', 'contradictory');
    evidence.escalation(attemptPath, 'identity', 'active-child-state-unclassified');
  }
  if (task && attempt) {
    if (ACTIVE_CHILD_STATES.has(attempt.child_state) && task.state !== 'QUEUED') {
      issues.add('nonterminal-attempt-task-state-mismatch', 'contradictory');
    }
    if (TERMINAL_CHILD_STATES.has(attempt.child_state) && task.state !== 'AWAITING_SUPERVISOR') {
      issues.add('terminal-attempt-task-state-mismatch', 'contradictory');
    }
    if (TERMINAL_TASK_STATES.has(task.state)) {
      issues.add('terminal-task-remains-active', 'contradictory');
    }
  }
  return {
    activeWork: {
      task_id: taskId,
      title: boundedText(task?.title, 160),
      task_state: task?.state ?? null,
      attempt_id: attemptId,
      child_state: attempt?.child_state ?? null,
      claim_id: attempt?.claim_id ?? null,
      claim_status: claim?.status ?? null,
      fence_generation: attempt?.fence_generation ?? null,
      route: attempt?.gearbox_route ?? null,
    },
    decision: compactDecision(attempt, taskId),
    attempt,
  };
}

function rejectedTaskId(unresolved) {
  if (typeof unresolved !== 'string') return null;
  const match = unresolved.match(/^Supervisor rejected ([A-Za-z0-9][A-Za-z0-9._-]*):/);
  return match?.[1] ?? null;
}

function loadTaskSupervisorDecision({
  p,
  reader,
  evidence,
  issues,
  objective,
  taskId,
  expectedTaskState,
  relationship,
}) {
  if (!taskId) return null;
  const taskPath = join(p.tasks, `${taskId}.json`);
  const task = reader.read(taskPath);
  if (!task) return null;
  evidence.authoritative(taskPath);
  if (task.parent_objective_id !== objective?.objective_id
      || task.parent_objective_revision !== objective?.current_revision) return null;
  if (task.schema !== 'opsle.durable-supervisor.task-handoff/v1'
      || task.task_id !== taskId || task.state !== expectedTaskState) {
    issues.add(`${relationship}-task-relationship-contradictory`, 'contradictory');
    evidence.escalation(taskPath, 'identity', `${relationship}-task-relationship-contradictory`);
  }
  const attemptId = task.attempts?.at(-1);
  if (!attemptId) {
    issues.add(`${relationship}-attempt-missing`, 'incomplete');
    return null;
  }
  const attemptPath = join(p.attempts, `${attemptId}.json`);
  const attempt = reader.read(attemptPath);
  evidence.authoritative(attemptPath);
  const expectedDecision = expectedTaskState === 'ACCEPTED' ? 'ACCEPT' : 'REJECT';
  if (attempt && (attempt.schema !== 'opsle.durable-supervisor.child-attempt/v1'
      || attempt.task_id !== taskId || attempt.attempt_id !== attemptId
      || !attempt.supervisor_evaluation
      || attempt.supervisor_evaluation.decision !== expectedDecision)) {
    issues.add(`${relationship}-decision-relationship-contradictory`, 'contradictory');
    evidence.escalation(attemptPath, 'identity', `${relationship}-decision-relationship-contradictory`);
  }
  return compactDecision(attempt, taskId);
}

function loadLatestSupervisorDecision({ p, reader, evidence, issues, state, objective }) {
  const candidates = [];
  const accepted = loadTaskSupervisorDecision({
    p,
    reader,
    evidence,
    issues,
    objective,
    taskId: state?.latest_accepted_task_id,
    expectedTaskState: 'ACCEPTED',
    relationship: 'latest-accepted',
  });
  if (accepted) candidates.push(accepted);
  const rejected = loadTaskSupervisorDecision({
    p,
    reader,
    evidence,
    issues,
    objective,
    taskId: rejectedTaskId(state?.latest_unresolved_issue),
    expectedTaskState: 'REJECTED',
    relationship: 'latest-rejected',
  });
  if (rejected) candidates.push(rejected);
  return candidates.sort((left, right) => (
    String(right.evaluated_at ?? '').localeCompare(String(left.evaluated_at ?? ''))
  ))[0] ?? null;
}

function deriveNextAction({
  state,
  active,
  wake,
  exactSessionStatus,
  objectiveComplete,
  unsatisfiedCount,
  requirementDriven = true,
  classification,
}) {
  const taskId = active.activeWork?.task_id;
  const pausedWithoutWork = state?.supervisor_state === 'PAUSED' && !active.activeWork;
  const sessionCurrent = exactSessionStatus?.classification === 'bound-authoritative-herdr'
    && exactSessionStatus.valid === true
    && exactSessionStatus.supported === true;
  const hasWakeAttention = (wake.attention_count ?? wake.items?.length ?? 0) > 0;
  const awaitingConsumption = wake.items?.find((item) => item.classification === 'awaiting-consumption');
  const hasUnresolved = Boolean(state?.latest_unresolved_issue);

  if (pausedWithoutWork) {
    if (!sessionCurrent || hasWakeAttention || hasUnresolved || classification !== 'complete_for_resume') {
      return 'No automatic action while PAUSED; operator must perform bounded reconciliation before explicit resume.';
    }
    return 'No automatic action while PAUSED; operator must explicitly resume.';
  }
  const awaitingEvaluation = active.attempt && TERMINAL_CHILD_STATES.has(active.attempt.child_state)
    && active.activeWork?.task_state === 'AWAITING_SUPERVISOR';
  if (awaitingConsumption) {
    return `Consume delivered terminal wake ${awaitingConsumption.event_id} before evaluating ${taskId}.`;
  }
  const runnerOnly = ACTIVE_CHILD_STATES.has(active.attempt?.child_state)
    && active.attempt?.wait_registration?.detached_dormancy?.monitoring_owner === 'RUNNER_ONLY';
  if (runnerOnly && !sessionCurrent) {
    return `Runner exclusively monitors detached task ${taskId}; operator must perform bounded reconciliation of the authoritative Herdr/Codex session binding.`;
  }
  if (runnerOnly && hasWakeAttention) {
    return `Runner exclusively monitors detached task ${taskId}; perform bounded reconciliation of the selected wake evidence.`;
  }
  if (runnerOnly) return `No supervisor monitoring action; Runner exclusively monitors detached task ${taskId}.`;
  if (!sessionCurrent) {
    if (awaitingEvaluation) {
      return `Operator must perform bounded reconciliation of the authoritative Herdr/Codex session binding, then evaluate ${taskId}.`;
    }
    return 'Operator must perform bounded reconciliation of the authoritative Herdr/Codex session binding before automatic work resumes.';
  }
  if (hasWakeAttention) return 'Perform bounded reconciliation of the selected current-generation wake evidence.';
  if (awaitingEvaluation) return `Perform bounded supervisor evaluation of ${taskId}.`;
  if (active.activeWork && ACTIVE_CHILD_STATES.has(active.attempt?.child_state)) {
    return `Continue only the bounded execution path for ${taskId}.`;
  }
  if (hasUnresolved || classification !== 'complete_for_resume') {
    return 'Perform bounded reconciliation using only the selected escalation evidence.';
  }
  if (objectiveComplete) return null;
  if (unsatisfiedCount > 0) return 'Select the next unsatisfied requirement slice.';
  return requirementDriven
    ? 'Evaluate objective completion from the authoritative requirement state.'
    : 'Evaluate objective completion from authoritative objective and task evidence.';
}

function measurePacket(packet) {
  let prior = '';
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const serialized = canonicalJson(packet);
    const bytes = Buffer.byteLength(serialized);
    const characters = [...serialized].length;
    packet.budget.packet_bytes = bytes;
    packet.budget.packet_characters = characters;
    const next = canonicalJson(packet);
    if (next === prior || next === serialized) return next;
    prior = next;
  }
  throw new Error('resume packet measurement did not converge');
}

export function generateResumePacket(root, {
  persist = true,
  bindingDependencies = {},
  sessionStatus = null,
  wakeStatus = null,
  clock = now,
  timer = () => performance.now(),
} = {}) {
  const started = timer();
  const p = paths(root);
  const issues = issueCollector();
  const reader = sourceReader(root, issues);
  const evidence = evidenceCollector(root, reader);
  const supervisor = reader.read(p.supervisor);
  const state = reader.read(p.state);
  const objective = reader.read(p.objective);
  const rawPolicy = reader.read(p.policy);
  const policy = rawPolicy;
  const bootstrap = reader.read(p.bootstrap, { required: false });
  const rawRequirements = reader.read(p.requirements, { required: false });
  const requirements = effectiveRequirementMatrix(root, {
    bootstrap,
    matrix: rawRequirements,
    state,
  });
  const requirementDriven = Boolean(requirements);
  for (const path of [p.supervisor, p.state, p.objective, p.policy]) evidence.authoritative(path);
  if (bootstrap) evidence.authoritative(p.bootstrap);
  if (requirements) evidence.authoritative(p.requirements);

  if (supervisor && (supervisor.repository !== root || supervisor.authority_status !== 'AUTHORITATIVE'
      || !Number.isSafeInteger(supervisor.generation) || supervisor.generation <= 0)) {
    issues.add('supervisor-authority-contradictory', 'contradictory');
    evidence.escalation(p.supervisor, 'identity', 'supervisor-authority-contradictory');
  }
  const currentObjective = objective?.history?.find((item) => item.revision === objective.current_revision) ?? null;
  if (!currentObjective) {
    issues.add('current-objective-revision-missing', 'contradictory');
    evidence.escalation(p.objective, 'current_objective', 'current-objective-revision-missing');
  }
  const requirementsPresent = Array.isArray(requirements?.requirements);
  const unsatisfied = requirements?.requirements?.filter(
    (item) => !SATISFIED_REQUIREMENT_STATES.has(item.state),
  ) ?? [];
  if (requirementDriven && !requirementsPresent) {
    issues.add('requirements-state-missing', 'incomplete');
    evidence.escalation(p.requirements, 'requirement_states', 'requirements-state-missing');
  }
  if (state?.phase === 'COMPLETE' && unsatisfied?.length) {
    issues.add('complete-phase-has-unsatisfied-requirements', 'contradictory');
    evidence.escalation(p.requirements, 'requirement_states', 'complete-phase-has-unsatisfied-requirements');
  }
  if (state?.phase === 'COMPLETE' && unsatisfied?.length === 0 && state.pending_next_action != null) {
    issues.add('complete-objective-has-next-action', 'contradictory');
    evidence.escalation(p.state, 'resume_fields', 'complete-objective-has-next-action');
  }
  if (state?.supervisor_state === 'PAUSED' && state.pause?.active !== true) {
    issues.add('paused-state-without-active-pause', 'contradictory');
  }
  if (state?.pause?.after_current === true
      && (!state.pause.active || !state.active_attempt_id)) {
    issues.add('pause-after-current-without-active-attempt', 'contradictory');
  }

  const active = classifyActiveWork({ root, p, reader, evidence, issues, state, supervisor, objective });
  const latestSupervisorDecision = loadLatestSupervisorDecision({
    p, reader, evidence, issues, state, objective,
  });
  const decision = active.decision?.kind === 'supervisor_evaluation'
    ? active.decision
    : (latestSupervisorDecision ?? active.decision);

  const bindingPath = join(p.opsle, 'wake', 'codex-session-binding.json');
  let exactSessionStatus = sessionStatus;
  if (!exactSessionStatus) {
    try {
      exactSessionStatus = refreshCodexSessionBinding(root, { dependencies: bindingDependencies });
    } catch (error) {
      exactSessionStatus = { classification: 'unknown', valid: false, supported: false, reasons: ['session-status-check-failed'] };
      issues.add('session-status-check-failed', 'incomplete');
    }
  }
  reader.track(bindingPath);
  evidence.authoritative(bindingPath);
  if (exactSessionStatus.classification === 'unbound') {
    issues.add('codex-session-binding-unbound', 'requires_escalation');
  } else if (['stale', 'attention'].includes(exactSessionStatus.classification)) {
    issues.add('codex-session-binding-stale', 'requires_escalation');
    evidence.escalation(bindingPath, 'session_binding', 'codex-session-binding-stale');
  } else if (!['unbound', 'bound-authoritative-herdr'].includes(exactSessionStatus.classification)) {
    issues.add('codex-session-binding-status-unknown', 'incomplete');
  } else if (exactSessionStatus.classification === 'bound-authoritative-herdr'
      && (!exactSessionStatus.valid
        || !exactSessionStatus.supported
        || exactSessionStatus.binding?.supervisor_id !== supervisor?.supervisor_id
        || exactSessionStatus.binding?.supervisor_generation !== supervisor?.generation
        || exactSessionStatus.binding?.host?.kind !== 'herdr'
        || exactSessionStatus.binding?.host?.authority !== 'authoritative')) {
    issues.add('authoritative-herdr-binding-relationship-contradictory', 'contradictory');
    evidence.escalation(bindingPath, 'session_binding', 'authoritative-herdr-binding-relationship-contradictory');
  }

  const wake = summarizeWake(root, reader, supervisor, state, wakeStatus);
  for (const item of wake.items ?? []) {
    evidence.authoritative(item.request_path);
    const issue = item.classification === 'uncertain'
      ? 'uncertain-wake-activation'
      : 'queued-wake-activation';
    issues.add(issue, 'requires_escalation');
    evidence.escalation(
      item.decision_path ?? item.request_path,
      item.decision_path ? 'wake_decision' : 'wake_request',
      issue,
    );
  }
  const objectiveSource = currentObjective?.objective;
  const objectiveText = objectiveSource == null
    ? null
    : (typeof objectiveSource === 'string' ? objectiveSource : canonicalJson(objectiveSource).trim());
  const unresolved = boundedText(state?.latest_unresolved_issue, 140);
  if (state?.latest_unresolved_issue) {
    issues.add('unresolved-supervisor-state', 'requires_escalation');
    evidence.escalation(p.state, 'resume_fields', 'unresolved-supervisor-state');
  }
  const classification = issues.classification();
  const objectiveComplete = state?.phase === 'COMPLETE'
    && (!requirementDriven || unsatisfied.length === 0);
  const nextAction = deriveNextAction({
    state,
    active,
    wake,
    exactSessionStatus,
    objectiveComplete,
    unsatisfiedCount: requirementDriven ? unsatisfied.length : 0,
    requirementDriven,
    classification,
  });
  const packet = {
    schema: RESUME_PACKET_SCHEMA,
    version: 1,
    classification,
    complete_for_resume: classification === 'complete_for_resume',
    requires_escalation: ['requires_escalation', 'contradictory'].includes(classification),
    repository: root,
    supervisor: {
      id: supervisor?.supervisor_id ?? null,
      generation: supervisor?.generation ?? null,
      authority: supervisor?.authority_status ?? null,
      state: state?.supervisor_state ?? null,
      phase: state?.phase ?? null,
    },
    herdr: compactHerdr(exactSessionStatus),
    session_binding: compactSessionStatus(exactSessionStatus),
    objective: {
      id: objective?.objective_id ?? null,
      revision: objective?.current_revision ?? null,
      text: objectiveText,
      objective_compacted: false,
      complete: objectiveComplete,
      unsatisfied_requirements: requirementDriven ? unsatisfied.length : null,
    },
    policy: policy ? {
      version: policy.version ?? null,
      providers: Object.fromEntries(Object.entries(policy.providers ?? {}).sort().map(([name, value]) => [name, {
        enabled: value.enabled === true,
        ...(value.model == null ? {} : { model: value.model }),
        ...(value.reasoning_effort == null ? {} : { reasoning_effort: value.reasoning_effort }),
      }])),
      review: policy.review ?? null,
      gearbox_required: policy.gearbox?.required ?? null,
      model_polling_permitted: policy.model_polling?.permitted ?? null,
      affected_verification: policy.affected_verification?.authority ?? null,
    } : null,
    pause: state?.pause ?? null,
    active_work: active.activeWork,
    wake_attention: {
      attention_count: wake.attention_count ?? wake.items?.length ?? 0,
      queued: wake.queued ?? 0,
      uncertain: wake.uncertain ?? 0,
      selected_count: wake.selected_count ?? Math.min(1, wake.items?.length ?? 0),
      omitted_count: wake.omitted_count ?? Math.max(0, (wake.items?.length ?? 0) - 1),
      items: (wake.items ?? []).slice(0, 1).map((item) => ({
        event_id: item.event_id,
        terminal_type: item.terminal_type ?? null,
        classification: item.classification,
        reason: boundedText(item.reason, 96),
      })),
    },
    latest_relevant_decision: decision,
    unresolved,
    next_action: nextAction,
    issues: issues.codes(),
    evidence: evidence.value(),
    budget: {
      measurement: 'exact serialized UTF-8 bytes and Unicode characters',
      byte_ceiling: PACKET_BYTE_CEILING,
      character_ceiling: PACKET_CHARACTER_CEILING,
      packet_bytes: 0,
      packet_characters: 0,
    },
  };
  applyFreshness(packet, reader.authorityFingerprint(), {
    session_binding_id: exactSessionStatus?.binding?.binding_id ?? null,
  });
  let serialized = measurePacket(packet);
  let packetBytes = Buffer.byteLength(serialized);
  let packetCharacters = [...serialized].length;
  if (packetBytes > PACKET_BYTE_CEILING
      || packetCharacters > PACKET_CHARACTER_CEILING) {
    const objectiveIssue = 'objective-text-requires-bounded-escalation';
    issues.add(objectiveIssue, 'requires_escalation');
    evidence.escalation(p.objective, 'current_objective', objectiveIssue);
    const compactedClassification = issues.classification();
    packet.classification = compactedClassification;
    packet.complete_for_resume = false;
    packet.requires_escalation = true;
    packet.objective.text = boundedText(objectiveSource, 120);
    packet.objective.objective_compacted = true;
    packet.objective.source_sha256 = objectiveText == null ? null : sha256(objectiveText);
    packet.objective.source_reference = {
      path: relativePath(root, p.objective),
      selector: 'current_objective',
    };
    packet.issues = issues.codes();
    packet.evidence = evidence.value();
    packet.next_action = deriveNextAction({
      state,
      active,
      wake,
      exactSessionStatus,
      objectiveComplete,
      unsatisfiedCount: requirementDriven ? unsatisfied.length : 0,
      requirementDriven,
      classification: compactedClassification,
    });
    applyFreshness(packet, reader.authorityFingerprint(), {
      session_binding_id: exactSessionStatus?.binding?.binding_id ?? null,
    });
    serialized = measurePacket(packet);
    packetBytes = Buffer.byteLength(serialized);
    packetCharacters = [...serialized].length;
  }
  if (packetBytes > PACKET_BYTE_CEILING
      || packetCharacters > PACKET_CHARACTER_CEILING) {
    throw new Error(`resume packet exceeds deterministic ceiling (${packetBytes} bytes, ${packetCharacters} characters)`);
  }
  reader.verifyUnchanged();
  const durableStateBytes = [...reader.considered.values()].reduce((sum, item) => sum + item.bytes, 0);
  const durationMs = Math.max(0, timer() - started);
  const telemetry = {
    schema: RECONSTRUCTION_TELEMETRY_SCHEMA,
    generated_at: clock(),
    duration_ms: Number(durationMs.toFixed(3)),
    packet_schema: RESUME_PACKET_SCHEMA,
    packet_version: 1,
    durable_state_bytes_considered: durableStateBytes,
    durable_source_files_considered: [...reader.considered.values()].map((item) => item.path).sort(),
    packet_bytes: packetBytes,
    packet_characters: packetCharacters,
    byte_suppression_ratio: durableStateBytes === 0
      ? 0
      : Number(Math.max(0, 1 - (packetBytes / durableStateBytes)).toFixed(6)),
    evidence_reference_count: packet.evidence.authoritative.count + packet.evidence.escalation.length,
    escalation: packet.requires_escalation,
  };
  if (persist) {
    writeJson(p.resumePacket, packet);
    writeJson(p.reconstructionTelemetry, telemetry);
  }
  return { packet, serialized, telemetry };
}

function selectedEvidence(value, selector) {
  if (selector === 'identity') return identitySelector(value);
  if (selector === 'session_binding') return value;
  if (selector === 'wake_request') return {
    schema: value.schema ?? null,
    event_id: value.event_id ?? null,
    terminal_type: value.terminal_type ?? null,
    target: value.target ?? null,
    task_id: value.task_id ?? null,
    attempt_id: value.attempt_id ?? null,
  };
  if (selector === 'wake_decision') return {
    schema: value.schema ?? null,
    event_id: value.event_id ?? null,
    decision_id: value.decision_id ?? null,
    status: value.status ?? null,
    failure: value.failure ?? null,
  };
  if (selector === 'current_objective') {
    return {
      objective_id: value.objective_id ?? null,
      current_revision: value.current_revision ?? null,
      current: value.history?.find((item) => item.revision === value.current_revision) ?? null,
    };
  }
  if (selector === 'requirement_states') {
    return {
      unsatisfied: (value.requirements ?? [])
        .filter((item) => !SATISFIED_REQUIREMENT_STATES.has(item.state))
        .map((item) => ({ id: item.id, state: item.state })),
    };
  }
  if (selector === 'resume_fields') {
    return {
      supervisor_state: value.supervisor_state ?? null,
      phase: value.phase ?? null,
      pause: value.pause ?? null,
      active_task_id: value.active_task_id ?? null,
      active_attempt_id: value.active_attempt_id ?? null,
      latest_unresolved_issue: value.latest_unresolved_issue ?? null,
      pending_next_action: value.pending_next_action ?? null,
    };
  }
  if (selector?.startsWith('task-')) return value[selector] ?? null;
  throw new Error(`unsupported bounded evidence selector: ${selector}`);
}

export function readResumePacket(root, {
  verifyFreshness = true,
  bindingDependencies = {},
  sessionStatus = null,
  wakeStatus = null,
} = {}) {
  const packet = JSON.parse(readFileSync(paths(root).resumePacket, 'utf8'));
  if (packet?.schema !== RESUME_PACKET_SCHEMA) throw new Error('unsupported resume packet schema');
  if (verifyFreshness && packet.complete_for_resume) {
    if (packet.freshness?.schema !== RESUME_FRESHNESS_SCHEMA
        || typeof packet.freshness?.authority_sha256 !== 'string') {
      throw new Error('complete resume packet lacks a freshness fence; regenerate it');
    }
    const current = generateResumePacket(root, {
      persist: false,
      bindingDependencies,
      sessionStatus,
      wakeStatus,
    });
    if (current.packet.freshness.authority_sha256 !== packet.freshness.authority_sha256) {
      const p = paths(root);
      writeJson(p.resumePacket, current.packet);
      writeJson(p.reconstructionTelemetry, current.telemetry);
      return current.packet;
    }
  }
  return packet;
}

export function readResumeEvidence(root, referencePath) {
  const packet = readResumePacket(root);
  const reference = packet.evidence?.escalation?.find((item) => item.path === referencePath);
  if (!reference) throw new Error('evidence path is not selected by the current resume packet');
  const absolute = resolve(root, reference.path);
  if (isAbsolute(reference.path) || (!absolute.startsWith(`${resolve(root)}${sep}`))) {
    throw new Error('evidence reference escapes repository');
  }
  const stats = lstatSync(absolute);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('evidence reference is not a regular file');
  const raw = readFileSync(absolute);
  const selected = selectedEvidence(JSON.parse(raw.toString('utf8')), reference.selector);
  if (sha256(canonicalJson(selected)) !== reference.sha256) {
    throw new Error('selected evidence changed since reconstruction');
  }
  const serialized = canonicalJson(selected);
  if (Buffer.byteLength(serialized) > EVIDENCE_OUTPUT_BYTE_CEILING) {
    throw new Error('selected evidence exceeds bounded output ceiling');
  }
  return {
    reference,
    source_bytes: statSync(absolute).size,
    selected_bytes: Buffer.byteLength(serialized),
    evidence: selected,
  };
}
