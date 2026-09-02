import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import {
  atomicCompareAndSwapJson,
  id,
  now,
  readJson,
  sha256,
  writeJson,
} from './io.js';
import {
  emit,
  gitMetadata,
  paths,
  policyHash,
  resolveExecutable,
  updateState,
} from './state.js';

const siblingRoot = (root) => resolve(root, '..');

function executable(command) {
  return resolveExecutable(command);
}

function version(path, args = ['--version']) {
  if (!path) return null;
  const result = spawnSync(path, args, { encoding: 'utf8' });
  return !result.error && result.status === 0
    ? `${result.stdout}${result.stderr}`.trim().split('\n')[0]
    : null;
}

export function discoverCapabilities(root) {
  const commands = {
    git: executable('git'),
    node: executable('node'),
    npm: executable('npm'),
    rg: executable('rg'),
    codex: executable('codex'),
    claude: executable('claude'),
    tmux: executable('tmux'),
  };
  const siblings = {};
  for (const name of [
    'gearbox',
    'context-firewall',
    'event-driven-agent-wakeup',
    'decision-evidence-protocol',
    'verifiable-agent-handoff',
    'affected-verification',
    'agent-trajectory-profiler',
  ]) {
    const path = join(siblingRoot(root), name);
    siblings[name] = {
      available: existsSync(join(path, '.git')),
      path,
      revision: existsSync(join(path, '.git'))
        ? gitMetadata(path).head
        : null,
    };
  }
  return {
    schema: 'opsle.durable-supervisor.discovery/v1',
    discovered_at: now(),
    commands: Object.fromEntries(Object.entries(commands).map(([name, path]) => [name, {
      available: Boolean(path), path, version: version(path, name === 'tmux' ? ['-V'] : ['--version']),
    }])),
    sibling_components: siblings,
  };
}

function validateRelativePath(value) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\0')) {
    throw new Error(`invalid authorized path: ${value}`);
  }
  const normalized = value.split('/');
  if (normalized.includes('..')) throw new Error(`invalid authorized path: ${value}`);
  return value;
}

function validateArgv(value, field) {
  if (value == null) return;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must be a nonempty argv array`);
  }
  if (typeof value[0] !== 'string' || value[0].length === 0) {
    throw new Error(`${field}[0] must be a nonempty command string`);
  }
  if (value.some((argument) => typeof argument !== 'string')) {
    throw new Error(`${field} argv entries must all be strings`);
  }
}

export function validateTaskCommands(task) {
  validateArgv(task.deterministic_command, 'deterministic_command');
  validateArgv(task.verification_command, 'verification_command');
  return task;
}

export function validateHandoff(input) {
  const required = [
    'title', 'objective', 'scope', 'authorization', 'expected_deliverable',
    'expected_evidence', 'acceptance_criteria', 'prohibited_actions',
    'requirement_ids',
  ];
  for (const field of required) if (input[field] == null) throw new Error(`handoff missing ${field}`);
  if (!Array.isArray(input.scope) || input.scope.length === 0) throw new Error('scope must be nonempty');
  if (!Array.isArray(input.authorization.may_modify)) throw new Error('authorization.may_modify required');
  input.authorization.may_modify.forEach(validateRelativePath);
  if (!Array.isArray(input.authorization.may_not)) throw new Error('authorization.may_not required');
  if (!Array.isArray(input.acceptance_criteria) || input.acceptance_criteria.length === 0) {
    throw new Error('acceptance criteria must be nonempty');
  }
  validateTaskCommands(input);
  return input;
}

export function createTask(root, input) {
  validateHandoff(input);
  const p = paths(root);
  const objective = readJson(p.objective);
  const supervisor = readJson(p.supervisor);
  const taskId = input.task_id ?? id('task');
  const path = join(p.tasks, `${taskId}.json`);
  if (existsSync(path)) throw new Error(`task already exists: ${taskId}`);
  const task = {
    schema: 'opsle.durable-supervisor.task-handoff/v1',
    task_id: taskId,
    parent_objective_id: objective.objective_id,
    parent_objective_revision: objective.current_revision,
    parent_decision_id: input.parent_decision_id ?? null,
    title: input.title,
    objective: input.objective,
    scope: input.scope,
    authorization: input.authorization,
    required_inputs: input.required_inputs ?? [],
    relevant_context: input.relevant_context ?? [],
    expected_deliverable: input.expected_deliverable,
    expected_evidence: input.expected_evidence,
    acceptance_criteria: input.acceptance_criteria,
    prohibited_actions: input.prohibited_actions,
    operator_policy_constraints: input.operator_policy_constraints ?? [],
    requirement_ids: input.requirement_ids,
    route_hint: input.route_hint ?? null,
    deterministic_command: input.deterministic_command ?? null,
    verification_command: input.verification_command ?? null,
    timeout_seconds: input.timeout_seconds ?? 1800,
    expects_changes: input.expects_changes ?? true,
    supervisor_id: supervisor.supervisor_id,
    supervisor_generation: supervisor.generation,
    state: 'READY',
    attempts: [],
    created_at: now(),
  };
  writeJson(path, task);
  emit(root, 'TASK_HANDOFF_CREATED', { task_id: taskId });
  return task;
}

function filterCapabilities(discovery, policy) {
  const commands = structuredClone(discovery.commands);
  for (const provider of ['codex', 'claude']) {
    commands[provider].policy_enabled = policy.providers[provider]?.enabled === true;
    commands[provider].eligible = commands[provider].available && commands[provider].policy_enabled;
    commands[provider].rejected_reason = commands[provider].eligible
      ? null
      : (!commands[provider].available ? 'UNAVAILABLE' : 'DISABLED_BY_OPERATOR_POLICY');
  }
  return { ...discovery, commands };
}

export function routeTask(root, task) {
  validateTaskCommands(task);
  const p = paths(root);
  const policy = readJson(p.policy);
  const discovery = discoverCapabilities(root);
  const permitted = filterCapabilities(discovery, policy);
  const considered = [];
  if (task.deterministic_command) {
    const command = task.deterministic_command[0];
    const capability = permitted.commands[basename(command)] ?? {
      available: Boolean(executable(command)), policy_enabled: true, eligible: Boolean(executable(command)),
    };
    const eligible = capability.eligible ?? capability.available === true;
    considered.push({ route: 'deterministic', capability: command, eligible, reason: eligible ? null : 'COMMAND_UNAVAILABLE' });
  }
  considered.push({
    route: 'codex',
    capability: 'codex',
    eligible: permitted.commands.codex.eligible,
    reason: permitted.commands.codex.rejected_reason,
  });
  considered.push({
    route: 'claude',
    capability: 'claude',
    eligible: permitted.commands.claude.eligible,
    reason: permitted.commands.claude.rejected_reason,
  });
  // route_hint is advisory classification input only. Adequacy, discovery, and
  // policy determine the route; a hint can neither force nor veto selection.
  const selected = task.deterministic_command
    ? considered.find((item) => item.route === 'deterministic' && item.eligible)
    : considered.find((item) => item.route === 'codex' && item.eligible);
  if (!selected) throw new Error('no authorized, available, policy-permitted Gearbox route');
  const selectedRoute = selected.route === 'deterministic' ? {
    schema: 'opsle.durable-supervisor.exact-child-route/v2',
    provider: null,
    execution_class: 'deterministic_command',
    selected_tool: 'deterministic-command',
    tool_allowlist: [{
      tool: 'deterministic-command',
      command: task.deterministic_command[0],
      argv: task.deterministic_command,
    }],
    skill_allowlist: [],
    web: { enabled: false, mode: 'disabled' },
    mcp: { enabled: false, server_allowlist: [] },
    plugins: { enabled: false, plugin_allowlist: [] },
    subagents: { enabled: false },
    review: { enabled: false, mode: 'off', reviewer: null },
    fallback: { enabled: false, provider_allowlist: [] },
  } : {
    schema: 'opsle.durable-supervisor.exact-child-route/v2',
    provider: {
      name: 'codex',
      model: policy.providers.codex.model,
      reasoning_effort: policy.providers.codex.reasoning_effort,
    },
    execution_class: 'bounded_implementation',
    selected_tool: 'none',
    tool_allowlist: [],
    skill_allowlist: [],
    web: { enabled: false, mode: 'disabled' },
    mcp: { enabled: false, server_allowlist: [] },
    plugins: { enabled: false, plugin_allowlist: [] },
    subagents: { enabled: false },
    review: { enabled: false, mode: 'off', reviewer: null },
    fallback: { enabled: false, provider_allowlist: [] },
  };
  const decision = {
    schema: 'opsle.durable-supervisor.gearbox-decision/v3',
    decision_id: id('gearbox'),
    task_id: task.task_id,
    classified_work: task.deterministic_command ? 'bounded_command_or_implementation' : 'bounded_implementation',
    discovery,
    permitted_capabilities: permitted,
    considered_routes: considered,
    selected_route: selected.route,
    selected_capability: selected.capability,
    selected_route_config: selectedRoute,
    classification_inputs: {
      route_hint: task.route_hint,
      route_hint_authority: 'advisory_only',
      deterministic_command_present: Boolean(task.deterministic_command),
    },
    rationale: selected.route === 'deterministic'
      ? 'A predeclared deterministic command is adequate and authorized.'
      : 'The task requires bounded repository implementation judgment; Codex is available and enabled.',
    operator_policy_version: policy.version,
    operator_policy_sha256: policyHash(root),
    created_at: now(),
  };
  return decision;
}

const CLAIM_INDEX_CAS_ATTEMPTS = 256;

function claimIndexSnapshot(indexPath) {
  let raw;
  try {
    raw = readFileSync(indexPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        index: { schema: 'opsle.durable-supervisor.claim-index/v1', next_fence: 1 },
        sha256: null,
      };
    }
    throw error;
  }
  let index;
  try {
    index = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid durable JSON ${indexPath}: ${error.message}`);
  }
  if (index === null || typeof index !== 'object' || Array.isArray(index)) {
    throw new Error(`durable JSON must be an object: ${indexPath}`);
  }
  if (index.schema !== 'opsle.durable-supervisor.claim-index/v1'
      || !Number.isSafeInteger(index.next_fence)
      || index.next_fence <= 0) {
    throw new Error('invalid claim index');
  }
  return { index, sha256: sha256(raw) };
}

function exactIndexedClaim(indexed, claim) {
  return indexed?.task_id === claim.task_id
    && indexed?.claim_id === claim.claim_id
    && indexed?.fence_generation === claim.fence_generation;
}

export function acquireClaim(root, task, attemptId) {
  const p = paths(root);
  const indexPath = join(p.claims, 'index.json');
  const supervisor = readJson(p.supervisor);
  for (let attempt = 0; attempt < CLAIM_INDEX_CAS_ATTEMPTS; attempt += 1) {
    const snapshot = claimIndexSnapshot(indexPath);
    for (const name of Object.keys(snapshot.index).filter((key) => key.startsWith('task-'))) {
      const existing = snapshot.index[name];
      if (existing.task_id === task.task_id && existing.status === 'ACTIVE') {
        throw new Error(`claim conflict: ${existing.claim_id}`);
      }
    }
    const claim = {
      schema: 'opsle.durable-supervisor.claim/v1',
      claim_id: id('claim'),
      task_id: task.task_id,
      attempt_id: attemptId,
      owner_supervisor_id: supervisor.supervisor_id,
      owner_generation: supervisor.generation,
      fence_generation: snapshot.index.next_fence,
      status: 'ACTIVE',
      acquired_at: now(),
      heartbeat_at: now(),
      completed_at: null,
    };
    const nextIndex = {
      ...snapshot.index,
      next_fence: snapshot.index.next_fence + 1,
      [`task-${task.task_id}`]: claim,
    };
    const swapped = atomicCompareAndSwapJson(indexPath, snapshot.sha256, nextIndex);
    if (!swapped.swapped) continue;
    writeJson(join(p.claims, `${claim.claim_id}.json`), claim);
    emit(root, 'CLAIM_ACQUIRED', { task_id: task.task_id, attempt_id: attemptId, claim_id: claim.claim_id, fence_generation: claim.fence_generation });
    return claim;
  }
  throw new Error('claim index contention did not resolve');
}

export function releaseClaim(root, claim, status = 'COMPLETED') {
  const p = paths(root);
  const path = join(p.claims, `${claim.claim_id}.json`);
  const current = readJson(path);
  if (current.claim_id !== claim.claim_id || current.task_id !== claim.task_id) {
    throw new Error('claim identity is ambiguous');
  }
  if (current.fence_generation !== claim.fence_generation) throw new Error('stale claim fence');
  const indexPath = join(p.claims, 'index.json');
  if (current.status !== 'ACTIVE') {
    if (current.status !== status) {
      throw new Error(`claim is already terminal: ${current.status}`);
    }
    return current;
  }
  for (let attempt = 0; attempt < CLAIM_INDEX_CAS_ATTEMPTS; attempt += 1) {
    const snapshot = claimIndexSnapshot(indexPath);
    const taskKey = `task-${current.task_id}`;
    const indexed = snapshot.index[taskKey];
    if (!exactIndexedClaim(indexed, current)) {
      throw new Error('claim index ownership is ambiguous or stale');
    }
    if (indexed.status !== 'ACTIVE') {
      throw new Error(`claim index is already terminal: ${indexed.status}`);
    }
    const released = { ...current, status, completed_at: now() };
    const nextIndex = { ...snapshot.index, [taskKey]: released };
    const swapped = atomicCompareAndSwapJson(indexPath, snapshot.sha256, nextIndex);
    if (!swapped.swapped) continue;
    writeJson(path, released);
    return released;
  }
  throw new Error('claim index contention did not resolve');
}

export function createAttempt(root, task, gearbox, claimFactory = acquireClaim) {
  validateTaskCommands(task);
  if (task.state === 'REJECTED') {
    throw new Error(`rejected task cannot be relaunched: ${task.task_id}`);
  }
  const p = paths(root);
  const policy = readJson(p.policy);
  const selectedRoute = gearbox.selected_route_config;
  if (gearbox.schema !== 'opsle.durable-supervisor.gearbox-decision/v3'
      || selectedRoute?.schema !== 'opsle.durable-supervisor.exact-child-route/v2'
      || gearbox.operator_policy_sha256 !== policyHash(root)) {
    throw new Error('Gearbox decision lacks a current exact selected route');
  }
  if (gearbox.selected_route === 'codex') {
    if (!policy.providers.codex.enabled
        || selectedRoute.provider?.name !== 'codex'
        || selectedRoute.provider.model !== policy.providers.codex.model
        || selectedRoute.provider.reasoning_effort !== policy.providers.codex.reasoning_effort
        || selectedRoute.execution_class !== 'bounded_implementation'
        || selectedRoute.selected_tool !== 'none'
        || !Array.isArray(selectedRoute.tool_allowlist)
        || selectedRoute.tool_allowlist.length !== 0) {
      throw new Error('Gearbox Codex route is not permitted by current operator policy');
    }
  } else if (gearbox.selected_route === 'deterministic') {
    const selectedCommandTool = selectedRoute.tool_allowlist?.[0];
    if (selectedRoute.provider !== null
        || selectedRoute.execution_class !== 'deterministic_command'
        || selectedRoute.tool_allowlist?.length !== 1
        || typeof selectedCommandTool?.tool !== 'string'
        || selectedRoute.selected_tool !== selectedCommandTool?.tool
        || JSON.stringify(selectedCommandTool?.argv) !== JSON.stringify(task.deterministic_command)) {
      throw new Error('Gearbox deterministic route does not exactly match the task command');
    }
  } else {
    throw new Error(`unsupported Gearbox selected route: ${gearbox.selected_route}`);
  }
  const supervisor = readJson(p.supervisor);
  const attemptNumber = task.attempts.length + 1;
  const attemptId = `${task.task_id}-attempt-${String(attemptNumber).padStart(3, '0')}`;
  const claim = claimFactory(root, task, attemptId);
  const snapshot = {
    schema: 'opsle.durable-supervisor.delegation-policy-snapshot/v3',
    task_id: task.task_id,
    attempt_id: attemptId,
    parent_objective_id: task.parent_objective_id,
    parent_decision_id: task.parent_decision_id,
    supervisor_id: supervisor.supervisor_id,
    supervisor_generation: supervisor.generation,
    provider: gearbox.selected_route === 'codex' ? 'codex' : null,
    model: gearbox.selected_route === 'codex' ? policy.providers.codex.model : null,
    reasoning_effort: gearbox.selected_route === 'codex' ? policy.providers.codex.reasoning_effort : null,
    gearbox_decision: gearbox,
    selected_route: structuredClone(gearbox.selected_route_config),
    allowed_providers: Object.entries(policy.providers).filter(([, value]) => value.enabled).map(([name]) => name),
    review_mode: policy.review.mode,
    reviewer: policy.review.reviewer,
    independent_review: 'none',
    authorization_envelope: task.authorization,
    policy_version: policy.version,
    policy_sha256: policyHash(root),
    claim_id: claim.claim_id,
    fence_generation: claim.fence_generation,
    expected_evidence: task.expected_evidence,
    acceptance_criteria: task.acceptance_criteria,
    launch_time: now(),
  };
  const attempt = {
    schema: 'opsle.durable-supervisor.child-attempt/v1',
    task_id: task.task_id,
    attempt_id: attemptId,
    attempt_number: attemptNumber,
    child_state: 'QUEUED',
    provider: snapshot.provider,
    model: snapshot.model,
    gearbox_route: gearbox.selected_route,
    claim_id: claim.claim_id,
    fence_generation: claim.fence_generation,
    pid: null,
    provider_run_id: null,
    started_at: null,
    heartbeat_at: null,
    completed_at: null,
    exit_code: null,
    raw_evidence: [],
    compact_packet: null,
    completion_handoff: null,
    acceptance: null,
    supervisor_evaluation: null,
    policy_snapshot: snapshot,
  };
  writeJson(join(p.attempts, `${attemptId}.json`), attempt);
  task.attempts.push(attemptId);
  task.state = 'QUEUED';
  writeJson(join(p.tasks, `${task.task_id}.json`), task);
  updateState(root, { active_task_id: task.task_id, active_attempt_id: attemptId });
  emit(root, 'ATTEMPT_CREATED', { task_id: task.task_id, attempt_id: attemptId, claim_id: claim.claim_id });
  return { attempt, claim };
}
