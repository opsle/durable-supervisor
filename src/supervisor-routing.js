import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, id, now, readJson, sha256, writeJson } from './io.js';

export const SUPERVISOR_DISCOVERY_SCHEMA =
  'opsle.durable-supervisor.supervisor-capability-discovery/v1';
export const SUPERVISOR_DECISION_SCHEMA =
  'opsle.durable-supervisor.supervisor-gearbox-decision/v1';
export const SUPERVISOR_ROUTE_SCHEMA =
  'opsle.durable-supervisor.exact-supervisor-route/v1';

export const DIRECT_SOURCE_ROUTE = 'direct_deterministic_source_inspection';
export const EXTERNAL_DOCUMENTATION_ROUTE = 'current_external_documentation';
export const EXPLICIT_OPTIONAL_ROUTE = 'explicit_optional_capability';

const OPTIONAL_KINDS = new Set(['skill', 'tool', 'web', 'mcp', 'plugin', 'subagent']);
const EXTERNAL_DOCUMENTATION_CAPABILITIES = new Set(['openai-docs', 'web']);
const DEFAULT_CAPABILITIES = [
  { capability_id: 'graphify', kind: 'skill' },
  { capability_id: 'openai-docs', kind: 'skill' },
  { capability_id: 'web', kind: 'web' },
  { capability_id: 'plugins', kind: 'plugin' },
  { capability_id: 'mcp', kind: 'mcp' },
  { capability_id: 'subagents', kind: 'subagent' },
];

const routingDirectory = (root) => join(root, '.opsle', 'supervisor-routing');
const decisionPath = (root, decisionId) => join(routingDirectory(root), `${decisionId}.json`);

function persistSupervisorRoutingDecision(root, decision) {
  mkdirSync(routingDirectory(root), { recursive: true, mode: 0o700 });
  writeJson(decisionPath(root, decision.decision_id), decision);
}

function nonempty(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be nonempty`);
  return value.trim();
}

function capabilityId(value) {
  const normalized = nonempty(value, 'capability_id').toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(normalized)) {
    throw new Error(`invalid capability_id: ${value}`);
  }
  return normalized;
}

function durableId(value, field) {
  const exact = nonempty(value, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(exact)) throw new Error(`invalid ${field}: ${value}`);
  return exact;
}

function probeInstructionPath(path, lstat = lstatSync) {
  if (!path) return { available: false, evidence: null };
  try {
    const stat = lstat(path);
    return {
      available: stat.isFile() && !stat.isSymbolicLink(),
      evidence: {
        path_type: stat.isFile() && !stat.isSymbolicLink() ? 'regular_file' : 'not_regular_file',
        device: stat.dev,
        inode: stat.ino,
        size: stat.size,
        modified_ms: stat.mtimeMs,
      },
    };
  } catch (error) {
    if (error.code === 'ENOENT') return { available: false, evidence: null };
    throw error;
  }
}

function normalizeAdvertisement(item, lstat) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error('advertised capabilities must be objects');
  }
  const idValue = capabilityId(item.capability_id);
  const kind = nonempty(item.kind, `kind for ${idValue}`);
  if (!OPTIONAL_KINDS.has(kind)) throw new Error(`unsupported optional capability kind: ${kind}`);
  if (item.instruction_path != null && typeof item.instruction_path !== 'string') {
    throw new Error(`instruction_path for ${idValue} must be a string`);
  }
  const probed = probeInstructionPath(item.instruction_path ?? null, lstat);
  const available = item.instruction_path
    ? probed.available
    : item.available === true;
  return {
    capability_id: idValue,
    kind,
    advertised: true,
    available,
    instruction_path: item.instruction_path ?? null,
    availability_evidence: item.instruction_path ? probed.evidence : {
      path_type: null,
      advertised_available: item.available === true,
    },
    instruction_file_read: false,
  };
}

export function discoverSupervisorCapabilities(
  root,
  advertisedCapabilities = [],
  { lstat = lstatSync } = {},
) {
  if (!Array.isArray(advertisedCapabilities)) {
    throw new Error('advertised_capabilities must be an array');
  }
  const advertised = new Map(advertisedCapabilities.map((item) => {
    const normalized = normalizeAdvertisement(item, lstat);
    return [normalized.capability_id, normalized];
  }));
  const capabilities = DEFAULT_CAPABILITIES.map((item) => advertised.get(item.capability_id) ?? {
    ...item,
    advertised: true,
    available: false,
    instruction_path: null,
    availability_evidence: null,
    instruction_file_read: false,
  });
  for (const item of advertised.values()) {
    if (!capabilities.some((existing) => existing.capability_id === item.capability_id)) {
      capabilities.push(item);
    }
  }
  return {
    schema: SUPERVISOR_DISCOVERY_SCHEMA,
    discovery_id: id('supervisor-discovery'),
    repository: root,
    discovered_at: now(),
    discovery_boundary: 'advertisement_and_metadata_only',
    instruction_files_read: [],
    capabilities,
  };
}

function disabledRoute() {
  return {
    schema: SUPERVISOR_ROUTE_SCHEMA,
    execution_route: DIRECT_SOURCE_ROUTE,
    selected_capability: null,
    selected_tool: 'direct-source-inspection',
    selected_skill: null,
    tool_allowlist: ['direct-source-inspection'],
    skill_allowlist: [],
    web: { enabled: false, mode: 'disabled' },
    mcp: { enabled: false, server_allowlist: [] },
    plugins: { enabled: false, plugin_allowlist: [] },
    subagents: { enabled: false },
  };
}

function optionalRoute(executionRoute, capability) {
  const route = {
    ...disabledRoute(),
    execution_route: executionRoute,
    selected_capability: capability.capability_id,
    selected_tool: capability.kind === 'skill' ? 'skill-instruction-loader' : capability.capability_id,
    selected_skill: capability.kind === 'skill' ? capability.capability_id : null,
    tool_allowlist: capability.kind === 'skill' ? ['skill-instruction-loader'] : [capability.capability_id],
    skill_allowlist: capability.kind === 'skill' ? [capability.capability_id] : [],
  };
  if (capability.kind === 'web') route.web = { enabled: true, mode: 'selected-current-external-documentation' };
  if (capability.kind === 'mcp') route.mcp = { enabled: true, server_allowlist: [capability.capability_id] };
  if (capability.kind === 'plugin') route.plugins = { enabled: true, plugin_allowlist: [capability.capability_id] };
  if (capability.kind === 'subagent') route.subagents = { enabled: true };
  return route;
}

function currentPolicyHash(root) {
  return sha256(readFileSync(join(root, '.opsle', 'policy.json')));
}

function decisionSubject(root, input) {
  const objective = readJson(join(root, '.opsle', 'objective.json'));
  const revision = objective.history.at(-1);
  let task = null;
  if (input.task_id != null) {
    const taskPath = join(root, '.opsle', 'tasks', `${durableId(input.task_id, 'task_id')}.json`);
    if (existsSync(taskPath)) task = readJson(taskPath);
  }
  return {
    task_id: input.task_id ?? null,
    task_objective: task?.objective ?? input.task_objective ?? null,
    objective_id: objective.objective_id,
    objective_revision: objective.current_revision,
    objective: revision.objective,
    work_description: nonempty(input.work_description, 'work_description'),
  };
}

export function selectSupervisorRoute(root, input, { lstat = lstatSync } = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('supervisor routing input must be an object');
  }
  const policy = readJson(join(root, '.opsle', 'policy.json'));
  if (policy.gearbox?.required !== true) throw new Error('operator policy does not require Gearbox');
  const discovery = discoverSupervisorCapabilities(root, input.advertised_capabilities ?? [], { lstat });
  const requestedRoute = input.requested_route ?? DIRECT_SOURCE_ROUTE;
  if (![DIRECT_SOURCE_ROUTE, EXTERNAL_DOCUMENTATION_ROUTE, EXPLICIT_OPTIONAL_ROUTE].includes(requestedRoute)) {
    throw new Error(`unsupported supervisor execution route: ${requestedRoute}`);
  }
  let selectedCapability = null;
  let selectedRoute;
  if (requestedRoute === DIRECT_SOURCE_ROUTE) {
    selectedRoute = disabledRoute();
  } else {
    const requestedCapability = capabilityId(input.requested_capability);
    selectedCapability = discovery.capabilities.find(
      (item) => item.capability_id === requestedCapability,
    );
    if (!selectedCapability?.available) {
      throw new Error(`optional capability is not advertised and available: ${requestedCapability}`);
    }
    if (EXTERNAL_DOCUMENTATION_CAPABILITIES.has(requestedCapability)
        && requestedRoute !== EXTERNAL_DOCUMENTATION_ROUTE) {
      throw new Error(`${requestedCapability} requires exact ${EXTERNAL_DOCUMENTATION_ROUTE} selection`);
    }
    if (requestedRoute === EXTERNAL_DOCUMENTATION_ROUTE
        && !EXTERNAL_DOCUMENTATION_CAPABILITIES.has(requestedCapability)) {
      throw new Error(`${requestedCapability} is not a current external documentation capability`);
    }
    selectedRoute = optionalRoute(requestedRoute, selectedCapability);
  }
  const directDefault = 'Direct deterministic/source inspection is adequate; no optional intelligence or tooling is required.';
  const sufficientDefault = 'Direct inspection is sufficient for this work, so no insufficiency justifies an optional route.';
  const intelligenceRationale = requestedRoute === DIRECT_SOURCE_ROUTE
    ? nonempty(input.intelligence_or_tooling_rationale ?? directDefault, 'intelligence_or_tooling_rationale')
    : nonempty(input.intelligence_or_tooling_rationale, 'intelligence_or_tooling_rationale');
  const insufficiencyRationale = requestedRoute === DIRECT_SOURCE_ROUTE
    ? nonempty(input.direct_inspection_insufficiency_rationale ?? sufficientDefault, 'direct_inspection_insufficiency_rationale')
    : nonempty(input.direct_inspection_insufficiency_rationale, 'direct_inspection_insufficiency_rationale');
  const subject = decisionSubject(root, input);
  const decision = {
    schema: SUPERVISOR_DECISION_SCHEMA,
    decision_id: id('supervisor-gearbox'),
    subject,
    work_class: input.work_class ?? 'unspecified',
    discovery,
    classification_inputs: {
      static_category_match: input.static_category_match ?? null,
      static_category_match_authority: 'non_authoritative',
      requested_route: requestedRoute,
      requested_capability: input.requested_capability ?? null,
    },
    selected_route: selectedRoute,
    selected_execution_route: selectedRoute.execution_route,
    selected_tool: selectedRoute.selected_tool,
    selected_skill: selectedRoute.selected_skill,
    intelligence_or_tooling_rationale: intelligenceRationale,
    direct_inspection_insufficiency_rationale: insufficiencyRationale,
    policy_version: policy.version,
    policy_sha256: currentPolicyHash(root),
    platform_safety_mandates: 'remain_authoritative_and_outside_optional_routing',
    created_at: now(),
  };
  const errors = supervisorRoutingDecisionErrors(decision, {
    objective: readJson(join(root, '.opsle', 'objective.json')),
    policySha256: currentPolicyHash(root),
  });
  if (errors.length) throw new Error(`invalid supervisor Gearbox decision: ${errors.join('; ')}`);
  persistSupervisorRoutingDecision(root, decision);
  return decision;
}

function exactOptionalShape(route, capability) {
  return canonicalJson(route) === canonicalJson(optionalRoute(route.execution_route, capability));
}

export function supervisorRoutingDecisionErrors(decision, { objective, policySha256 } = {}) {
  const errors = [];
  if (decision?.schema !== SUPERVISOR_DECISION_SCHEMA) errors.push('invalid decision schema');
  if (decision?.discovery?.schema !== SUPERVISOR_DISCOVERY_SCHEMA) errors.push('invalid discovery schema');
  if (decision?.discovery?.instruction_files_read?.length !== 0) errors.push('discovery read instruction files');
  if (decision?.classification_inputs?.static_category_match_authority !== 'non_authoritative') {
    errors.push('static category matching must be non-authoritative');
  }
  if (typeof decision?.intelligence_or_tooling_rationale !== 'string'
      || !decision.intelligence_or_tooling_rationale.trim()) errors.push('missing intelligence/tooling rationale');
  if (typeof decision?.direct_inspection_insufficiency_rationale !== 'string'
      || !decision.direct_inspection_insufficiency_rationale.trim()) errors.push('missing direct-inspection rationale');
  const route = decision?.selected_route;
  if (route?.schema !== SUPERVISOR_ROUTE_SCHEMA) errors.push('invalid exact route schema');
  if (![DIRECT_SOURCE_ROUTE, EXTERNAL_DOCUMENTATION_ROUTE, EXPLICIT_OPTIONAL_ROUTE].includes(route?.execution_route)) {
    errors.push('invalid execution route');
  }
  if (!Array.isArray(route?.tool_allowlist) || !Array.isArray(route?.skill_allowlist)) {
    errors.push('route allowlists must be arrays');
  }
  const capabilities = decision?.discovery?.capabilities;
  if (!Array.isArray(capabilities)
      || capabilities.some((item) => item.instruction_file_read !== false
        || typeof item.available !== 'boolean'
        || !OPTIONAL_KINDS.has(item.kind)
        || typeof item.capability_id !== 'string')) {
    errors.push('capability discovery must not read instructions');
  }
  if (decision?.selected_execution_route !== route?.execution_route
      || decision?.selected_tool !== route?.selected_tool
      || decision?.selected_skill !== route?.selected_skill) {
    errors.push('top-level selection must exactly match the selected route');
  }
  if (route?.execution_route === DIRECT_SOURCE_ROUTE) {
    if (route.selected_capability !== null
        || route.selected_tool !== 'direct-source-inspection'
        || route.selected_skill !== null
        || canonicalJson(route) !== canonicalJson(disabledRoute())) {
      errors.push('direct route must deny every optional capability');
    }
  } else if (Array.isArray(capabilities)) {
    const capability = capabilities.find((item) => item.capability_id === route?.selected_capability);
    if (!capability?.available || !exactOptionalShape(route, capability)) {
      errors.push('optional route is not exact, available, and fail-closed');
    }
    if (EXTERNAL_DOCUMENTATION_CAPABILITIES.has(route?.selected_capability)
        !== (route?.execution_route === EXTERNAL_DOCUMENTATION_ROUTE)) {
      errors.push('external documentation capability requires its exact route');
    }
  }
  if (!decision?.subject?.objective_id || !Number.isSafeInteger(decision?.subject?.objective_revision)
      || !decision?.subject?.objective || !decision?.subject?.work_description) {
    errors.push('decision subject must record task/objective context');
  }
  if (objective && (decision?.subject?.objective_id !== objective.objective_id
      || decision?.subject?.objective_revision !== objective.current_revision)) {
    errors.push('decision objective is stale');
  }
  if (policySha256 && decision?.policy_sha256 !== policySha256) errors.push('decision policy is stale');
  return errors;
}

export function readSupervisorRoutingDecision(root, decisionId) {
  const exactId = durableId(decisionId, 'decision_id');
  return readJson(decisionPath(root, exactId));
}

export function requireSelectedSupervisorCapability(root, decisionId, request) {
  const decision = readSupervisorRoutingDecision(root, decisionId);
  const errors = supervisorRoutingDecisionErrors(decision, {
    objective: readJson(join(root, '.opsle', 'objective.json')),
    policySha256: currentPolicyHash(root),
  });
  if (errors.length) throw new Error(`supervisor routing decision is not current and valid: ${errors.join('; ')}`);
  const requestedCapability = capabilityId(request.capability_id);
  const capability = decision.discovery.capabilities.find(
    (item) => item.capability_id === requestedCapability,
  );
  if (!capability || decision.selected_route.selected_capability !== requestedCapability) {
    throw new Error(`optional capability was not selected durably: ${requestedCapability}`);
  }
  if (request.kind && request.kind !== capability.kind) {
    throw new Error(`optional capability kind mismatch: ${requestedCapability}`);
  }
  return { decision, capability, selected_route: decision.selected_route };
}

export function loadSelectedSupervisorSkillInstructions(
  root,
  decisionId,
  skillId,
  { lstat = lstatSync, readFile = readFileSync } = {},
) {
  const selected = requireSelectedSupervisorCapability(root, decisionId, {
    capability_id: skillId,
    kind: 'skill',
  });
  const path = selected.capability.instruction_path;
  if (!path) throw new Error(`selected skill has no instruction path: ${skillId}`);
  const current = probeInstructionPath(path, lstat);
  if (!current.available
      || canonicalJson(current.evidence) !== canonicalJson(selected.capability.availability_evidence)) {
    throw new Error(`selected skill instruction path changed after discovery: ${skillId}`);
  }
  return {
    decision_id: selected.decision.decision_id,
    skill_id: selected.capability.capability_id,
    instruction_path: path,
    instructions: readFile(path, 'utf8'),
  };
}
