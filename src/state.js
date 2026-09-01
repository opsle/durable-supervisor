import { spawnSync } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
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

export const OPSLE_SCHEMA = 'opsle.durable-supervisor';
export const VALID_SUPERVISOR_STATES = new Set(['ACTIVE', 'DORMANT', 'PAUSED']);
export const VALID_CHILD_STATES = new Set([
  'NONE', 'QUEUED', 'LAUNCHING', 'RUNNING', 'COMPLETED', 'FAILED',
  'STALLED', 'CANCELLED', 'UNKNOWN',
]);
export const REVIEW_MODES = new Set(['off', 'manual', 'risk_based', 'always']);
export const SATISFIED_REQUIREMENT_STATES = new Set([
  'VERIFIED',
  'DEFERRED_WITH_JUSTIFICATION',
  'NOT_APPLICABLE_WITH_JUSTIFICATION',
]);
export const NEXT_UNSATISFIED_REQUIREMENT_ACTION = 'Select the next unsatisfied requirement slice.';

export function unsatisfiedRequirements(matrix) {
  return matrix.requirements.filter((requirement) => !SATISFIED_REQUIREMENT_STATES.has(requirement.state));
}

export function derivePendingNextAction(state, matrix, fallback = state.pending_next_action) {
  if (state.active_task_id || state.active_attempt_id) return fallback;
  const unsatisfied = unsatisfiedRequirements(matrix);
  if (state.phase === 'COMPLETE' && unsatisfied.length === 0) return null;
  if (fallback == null && unsatisfied.length > 0) return NEXT_UNSATISFIED_REQUIREMENT_ACTION;
  return fallback;
}

export function repositoryRoot(cwd = process.cwd()) {
  let candidate = resolve(cwd);
  while (true) {
    if (existsSync(join(candidate, '.git'))) return candidate;
    const parent = dirname(candidate);
    if (parent === candidate) throw new Error(`not inside a Git repository: ${cwd}`);
    candidate = parent;
  }
}

function gitDirectory(root) {
  const dotGit = join(root, '.git');
  if (!existsSync(dotGit)) throw new Error(`missing Git metadata: ${root}`);
  if (statSync(dotGit).isDirectory()) return dotGit;
  const pointer = readFileSync(dotGit, 'utf8').trim();
  if (!pointer.startsWith('gitdir: ')) throw new Error(`invalid Git metadata pointer: ${dotGit}`);
  const target = pointer.slice('gitdir: '.length);
  return isAbsolute(target) ? target : resolve(root, target);
}

function packedRef(gitDir, ref) {
  const path = join(gitDir, 'packed-refs');
  if (!existsSync(path)) return null;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line || line.startsWith('#') || line.startsWith('^')) continue;
    const [revision, name] = line.split(' ');
    if (name === ref) return revision;
  }
  return null;
}

function originUrl(gitDir) {
  const path = join(gitDir, 'config');
  if (!existsSync(path)) return null;
  let inOrigin = false;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (section) {
      inOrigin = section[1] === 'remote "origin"';
      continue;
    }
    if (inOrigin) {
      const url = line.match(/^\s*url\s*=\s*(.+?)\s*$/);
      if (url) return url[1];
    }
  }
  return null;
}

export function gitMetadata(root) {
  const gitDir = gitDirectory(root);
  const headValue = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
  if (!headValue.startsWith('ref: ')) {
    return { head: headValue, branch: '', remote: originUrl(gitDir) };
  }
  const ref = headValue.slice('ref: '.length);
  const refPath = join(gitDir, ...ref.split('/'));
  const head = existsSync(refPath) ? readFileSync(refPath, 'utf8').trim() : packedRef(gitDir, ref);
  return {
    head,
    branch: ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : '',
    remote: originUrl(gitDir),
  };
}

export function resolveExecutable(command) {
  const candidates = command.includes('/')
    ? [command]
    : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map((directory) => join(directory, command));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return resolve(candidate);
    } catch {
      // Continue searching PATH.
    }
  }
  return null;
}

export const paths = (root) => {
  const opsle = join(root, '.opsle');
  return {
    root,
    opsle,
    specification: join(opsle, 'specification.md'),
    requirements: join(opsle, 'requirements.json'),
    objective: join(opsle, 'objective.json'),
    policy: join(opsle, 'policy.json'),
    supervisor: join(opsle, 'supervisor.json'),
    state: join(opsle, 'state.json'),
    eventsLog: join(opsle, 'events.jsonl'),
    decisionsLog: join(opsle, 'decisions.jsonl'),
    tasks: join(opsle, 'tasks'),
    attempts: join(opsle, 'children'),
    claims: join(opsle, 'claims'),
    events: join(opsle, 'events'),
    raw: join(opsle, 'evidence', 'raw'),
    compact: join(opsle, 'evidence', 'compact'),
    audit: join(opsle, 'evidence', 'repository-audit.json'),
  };
};

export function emit(root, type, details = {}) {
  const p = paths(root);
  const supervisor = existsSync(p.supervisor) ? readJson(p.supervisor) : null;
  const event = {
    schema: `${OPSLE_SCHEMA}.event/v1`,
    event_id: id('event'),
    type,
    time: now(),
    actor: details.actor ?? 'durable-supervisor',
    supervisor_id: supervisor?.supervisor_id ?? null,
    supervisor_generation: supervisor?.generation ?? null,
    ...details,
  };
  appendEvent(p.eventsLog, event);
  writeJson(join(p.events, `${event.event_id}.json`), event);
  return event;
}

function commandIdentity(command, args = ['--version']) {
  const executable = resolveExecutable(command);
  if (!executable) return { available: false, path: null, version: null };
  const version = spawnSync(executable, args, { encoding: 'utf8' });
  return {
    available: true,
    path: executable,
    version: version.error
      ? null
      : `${version.stdout}${version.stderr}`.trim().split('\n')[0] || null,
  };
}

export function initialize(root, { actor = 'bootstrap-codex' } = {}) {
  const p = paths(root);
  if (!existsSync(p.specification) || !existsSync(p.requirements)) {
    throw new Error('DS-000 durable specification and requirements matrix must exist first');
  }
  for (const directory of [p.tasks, p.attempts, p.claims, p.events, p.raw, p.compact]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  if (existsSync(p.supervisor)) {
    const current = readJson(p.supervisor);
    if (current.authority_status === 'AUTHORITATIVE') {
      throw new Error(`authoritative supervisor already exists: ${current.supervisor_id}`);
    }
  }
  const repository = gitMetadata(root);
  const supervisor = {
    schema: `${OPSLE_SCHEMA}.supervisor/v1`,
    repository: root,
    repository_remote: repository.remote,
    supervisor_id: id('supervisor'),
    generation: 1,
    session_id: null,
    authority_status: 'AUTHORITATIVE',
    created_at: now(),
    recovered_at: null,
    last_durable_event: null,
  };
  const policy = {
    schema: `${OPSLE_SCHEMA}.policy/v1`,
    version: 1,
    changed_at: now(),
    changed_by: actor,
    providers: {
      codex: { enabled: true, model: 'gpt-5.6-sol', reasoning_effort: 'high' },
      claude: { enabled: false, model: null, reasoning_effort: null },
    },
    review: { mode: 'off', reviewer: null },
    affected_verification: { authority: 'advisory_only' },
    gearbox: { required: true },
    model_polling: { permitted: false },
  };
  const objective = {
    schema: `${OPSLE_SCHEMA}.objective/v1`,
    objective_id: id('objective'),
    current_revision: 1,
    history: [{
      revision: 1,
      objective: 'Implement, dogfood, verify, and document Opsle Durable Supervisor V0.1 according to .opsle/specification.md.',
      specification_sha256: fileSha256(p.specification),
      changed_by: actor,
      effective_at: now(),
    }],
  };
  const state = {
    schema: `${OPSLE_SCHEMA}.state/v1`,
    supervisor_state: 'ACTIVE',
    phase: 'BOOTSTRAP',
    pause: { active: false, after_current: false, reason: null, changed_at: null },
    active_task_id: null,
    active_attempt_id: null,
    latest_accepted_task_id: null,
    latest_unresolved_issue: null,
    pending_next_action: 'Complete and verify the minimum self-hosting substrate.',
    updated_at: now(),
  };
  const audit = {
    schema: `${OPSLE_SCHEMA}.repository-audit/v1`,
    repository: root,
    remote: supervisor.repository_remote,
    head: repository.head,
    branch: repository.branch,
    clean_before_bootstrap: true,
    canonical_opsle_root: resolve(root, '..'),
    authoritative_registry: resolve(root, '../research/program/registry.json'),
    sibling_repositories_modified: false,
    discovered_runtime: {
      node: commandIdentity('node'),
      git: commandIdentity('git'),
      codex: commandIdentity('codex'),
      tmux: commandIdentity('tmux', ['-V']),
    },
    inspected_at: now(),
    actor,
  };
  writeJson(p.supervisor, supervisor);
  writeJson(p.policy, policy);
  writeJson(p.objective, objective);
  writeJson(p.state, state);
  writeJson(p.audit, audit);
  const event = emit(root, 'SUPERVISOR_INITIALIZED', { actor, repository: root });
  supervisor.last_durable_event = event.event_id;
  writeJson(p.supervisor, supervisor);
  setRequirements(root, ['DS-000', 'DS-001'], 'VERIFIED', [
    '.opsle/specification.md',
    '.opsle/requirements.json',
    '.opsle/evidence/repository-audit.json',
  ]);
  return { supervisor, policy, objective, state, audit };
}

export function setRequirements(root, ids, state, evidence = [], justification = null) {
  const p = paths(root);
  const matrix = readJson(p.requirements);
  if (!matrix.allowed_states.includes(state)) throw new Error(`invalid requirement state: ${state}`);
  for (const requirementId of ids) {
    const requirement = matrix.requirements.find((item) => item.id === requirementId);
    if (!requirement) throw new Error(`unknown requirement: ${requirementId}`);
    requirement.state = state;
    requirement.evidence = [...new Set([...requirement.evidence, ...evidence])];
    requirement.justification = justification;
    requirement.updated_at = now();
  }
  writeJson(p.requirements, matrix);
}

export function updateState(root, patch) {
  const p = paths(root);
  const state = readJson(p.state);
  const next = { ...state, ...patch, updated_at: now() };
  if (!VALID_SUPERVISOR_STATES.has(next.supervisor_state)) {
    throw new Error(`invalid supervisor state: ${next.supervisor_state}`);
  }
  writeJson(p.state, next);
  return next;
}

export function validateDurableState(root) {
  const p = paths(root);
  const errors = [];
  const required = [p.specification, p.requirements, p.objective, p.policy, p.supervisor, p.state];
  for (const path of required) if (!existsSync(path)) errors.push(`missing ${path}`);
  if (errors.length) return { valid: false, errors };
  const matrix = readJson(p.requirements);
  const ids = matrix.requirements.map((item) => item.id);
  if (ids.length !== 101 || new Set(ids).size !== 101) errors.push('requirements must contain 101 unique IDs');
  for (let index = 0; index <= 100; index += 1) {
    const expected = `DS-${String(index).padStart(3, '0')}`;
    if (ids[index] !== expected) errors.push(`requirement ordering mismatch at ${expected}`);
  }
  if (matrix.specification_sha256 !== fileSha256(p.specification)) errors.push('specification hash mismatch');
  const policy = readJson(p.policy);
  if (!REVIEW_MODES.has(policy.review?.mode)) errors.push('invalid review mode');
  const objective = readJson(p.objective);
  if (!Array.isArray(objective.history) || objective.history.length === 0) {
    errors.push('objective history must be nonempty');
  } else {
    for (let index = 0; index < objective.history.length; index += 1) {
      const revision = objective.history[index];
      if (revision.revision !== index + 1) errors.push(`objective revision ordering mismatch at ${index + 1}`);
      if (typeof revision.objective !== 'string' || !revision.objective.trim()) {
        errors.push(`objective revision ${revision.revision} must contain text`);
      }
    }
    if (objective.current_revision !== objective.history.at(-1).revision) {
      errors.push('current objective revision must be the latest history revision');
    }
  }
  const supervisor = readJson(p.supervisor);
  if (supervisor.repository !== root) errors.push('repository identity mismatch');
  if (supervisor.authority_status !== 'AUTHORITATIVE') errors.push('no authoritative supervisor');
  const state = readJson(p.state);
  if (!VALID_SUPERVISOR_STATES.has(state.supervisor_state)) errors.push('invalid supervisor state');
  if (
    state.phase === 'COMPLETE'
    && unsatisfiedRequirements(matrix).length === 0
    && state.pending_next_action !== null
  ) {
    errors.push('complete state with no unsatisfied requirements must not have a pending next action');
  }
  for (const file of readdirSync(p.attempts).filter((name) => name.endsWith('.json'))) {
    const attempt = readJson(join(p.attempts, file));
    if (!VALID_CHILD_STATES.has(attempt.child_state)) errors.push(`invalid child state in ${file}`);
    if (!existsSync(join(p.tasks, `${attempt.task_id}.json`))) errors.push(`orphan attempt ${attempt.attempt_id}`);
    const snapshot = attempt.policy_snapshot;
    if (![
      'opsle.durable-supervisor.delegation-policy-snapshot/v1',
      'opsle.durable-supervisor.delegation-policy-snapshot/v2',
      'opsle.durable-supervisor.delegation-policy-snapshot/v3',
    ].includes(snapshot?.schema)) {
      errors.push(`invalid policy snapshot schema in ${file}`);
    } else if (snapshot.schema.endsWith('/v2') || snapshot.schema.endsWith('/v3')) {
      const route = snapshot.selected_route;
      const decision = snapshot.gearbox_decision;
      const currentContract = snapshot.schema.endsWith('/v3');
      const expectedRouteSchema = currentContract
        ? 'opsle.durable-supervisor.exact-child-route/v2'
        : 'opsle.durable-supervisor.exact-child-route/v1';
      const expectedDecisionSchema = currentContract
        ? 'opsle.durable-supervisor.gearbox-decision/v3'
        : 'opsle.durable-supervisor.gearbox-decision/v2';
      const routeTypeKnown = ['codex', 'deterministic'].includes(decision?.selected_route);
      const codexToolSelectionValid = decision?.selected_route !== 'codex'
        || (route?.provider?.name === 'codex'
          && route?.execution_class === 'bounded_implementation'
          && (currentContract
            ? route?.selected_tool === 'none'
            : route?.selected_tool == null || route?.selected_tool === 'none')
          && Array.isArray(route?.tool_allowlist)
          && route?.tool_allowlist.length === 0);
      const deterministicToolSelectionValid = decision?.selected_route !== 'deterministic'
        || (route?.provider === null
          && route?.execution_class === 'deterministic_command'
          && Array.isArray(route?.tool_allowlist)
          && route?.tool_allowlist.length === 1
          && typeof route?.tool_allowlist[0]?.tool === 'string'
          && (currentContract
            ? route?.selected_tool === route?.tool_allowlist[0]?.tool
            : route?.selected_tool == null
              || route?.selected_tool === route?.tool_allowlist[0]?.tool));
      if (route?.schema !== expectedRouteSchema
          || decision?.schema !== expectedDecisionSchema
          || !routeTypeKnown
          || canonicalJson(route) !== canonicalJson(decision.selected_route_config)
          || decision.selected_route !== attempt.gearbox_route
          || snapshot.policy_sha256 !== decision.operator_policy_sha256
          || !codexToolSelectionValid
          || !deterministicToolSelectionValid
          || !Array.isArray(route.skill_allowlist)
          || route.web?.enabled !== false
          || route.web?.mode !== 'disabled'
          || route.mcp?.enabled !== false
          || !Array.isArray(route.mcp?.server_allowlist)
          || route.mcp.server_allowlist.length !== 0
          || route.plugins?.enabled !== false
          || !Array.isArray(route.plugins?.plugin_allowlist)
          || route.plugins.plugin_allowlist.length !== 0
          || route.subagents?.enabled !== false
          || route.review?.enabled !== false
          || route.review?.mode !== 'off'
          || route.review?.reviewer != null
          || route.fallback?.enabled !== false
          || !Array.isArray(route.fallback?.provider_allowlist)
          || route.fallback.provider_allowlist.length !== 0) {
        errors.push(`invalid exact selected route in ${file}`);
      }
    }
  }
  const wake = join(p.opsle, 'wake');
  const sessionBinding = join(wake, 'codex-session-binding.json');
  if (existsSync(sessionBinding)) {
    const binding = readJson(sessionBinding);
    if (![
      'opsle.durable-supervisor.codex-session-binding/v1',
      'opsle.durable-supervisor.codex-session-binding/v2',
    ].includes(binding.schema)) {
      errors.push('invalid Codex session binding schema');
    }
    if (binding.supervisor_id !== supervisor.supervisor_id) {
      errors.push('Codex session binding supervisor identity mismatch');
    }
  }
  const activationLease = join(wake, 'activation-lease.json');
  if (existsSync(activationLease)) {
    const lease = readJson(activationLease);
    if (lease.schema !== 'opsle.durable-supervisor.activation-lease/v1'
        || !Number.isSafeInteger(lease.fencing_token)
        || lease.fencing_token <= 0) {
      errors.push('invalid activation lease');
    }
  }
  const activationDecisions = join(wake, 'activation-decisions');
  if (existsSync(activationDecisions)) {
    for (const file of readdirSync(activationDecisions).filter((name) => name.endsWith('.json'))) {
      const decision = readJson(join(activationDecisions, file));
      if (decision.schema !== 'opsle.durable-supervisor.activation-decision/v1') {
        errors.push(`invalid activation decision in ${file}`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

export function policyHash(root) {
  const p = paths(root);
  return sha256(readFileSync(p.policy));
}
