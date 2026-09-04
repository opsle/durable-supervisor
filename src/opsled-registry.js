import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { canonicalJson, now, readJson, sha256, writeJson } from './io.js';
import { acquireHostLock } from './host-lock.js';
import { ensureDurableCompatibility } from './durable-schema.js';

export const OPSLED_REGISTRY_SCHEMA = 'opsle.durable-supervisor.opsled-registry/v2';
export const OPSLED_REPOSITORY_SCHEMA = 'opsle.durable-supervisor.opsled-repository/v2';
export const HOST_OWNERSHIP_SCHEMA = 'opsle.durable-supervisor.host-ownership/v1';
const LEGACY_OPSLED_REGISTRY_SCHEMA = 'opsle.durable-supervisor.opsled-registry/v1';
const LEGACY_OPSLED_REPOSITORY_SCHEMA = 'opsle.durable-supervisor.opsled-repository/v1';

const FORBIDDEN_AUTHORITY_KEYS = new Set([
  'acceptance',
  'decisions',
  'evidence',
  'gearbox',
  'history',
  'objective',
  'policy',
  'requirements',
  'tasks',
]);

function classifiedError(classification, message) {
  const error = new Error(`${classification}: ${message}`);
  error.code = classification;
  error.classification = classification;
  return error;
}

function parseRegistry(bytes, path, { permitLegacy = false } = {}) {
  let value;
  try {
    value = JSON.parse(bytes);
  } catch (error) {
    throw classifiedError('CORRUPT', `malformed opsled registry ${path}: ${error.message}`);
  }
  if (bytes !== canonicalJson(value)) {
    throw classifiedError('CORRUPT', `opsled registry is not canonical JSON: ${path}`);
  }
  if (typeof value?.schema === 'string'
      && value.schema.startsWith('opsle.durable-supervisor.opsled-registry/')
      && value.schema !== OPSLED_REGISTRY_SCHEMA
      && !(permitLegacy && value.schema === LEGACY_OPSLED_REGISTRY_SCHEMA)) {
    throw classifiedError('UPGRADE_REQUIRED', `unsupported opsled registry schema ${value.schema}`);
  }
  if (permitLegacy && value.schema === LEGACY_OPSLED_REGISTRY_SCHEMA) return value;
  validateRegistry(value);
  return value;
}

function assertNoAuthority(value, path = 'registry') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoAuthority(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_AUTHORITY_KEYS.has(key.toLowerCase())) {
      throw classifiedError('CORRUPT', `repository authority field is forbidden in opsled ${path}: ${key}`);
    }
    assertNoAuthority(item, `${path}.${key}`);
  }
}

export function repositoryOperationalId(repositoryRealpath) {
  return `repository-${createHash('sha256').update(repositoryRealpath).digest('hex')}`;
}

export function registryPaths(hostRoot) {
  const root = resolve(hostRoot);
  return {
    root,
    registry: join(root, 'registry.json'),
    registryLock: join(root, 'registry.lock'),
    service: join(root, 'opsled.json'),
    serviceLock: join(root, 'opsled.lock'),
    upgradeLock: join(root, 'runtime', 'upgrade.lock'),
    repositories: join(root, 'repositories'),
  };
}

export function repositoryOwnershipPaths(repositoryRoot) {
  const opsle = join(resolve(repositoryRoot), '.opsle');
  return {
    pointer: join(opsle, 'host-ownership.json'),
    lock: join(opsle, 'host-ownership.lock'),
    runnerRequests: join(opsle, 'runner', 'requests'),
  };
}

export function emptyRegistry() {
  return {
    schema: OPSLED_REGISTRY_SCHEMA,
    revision: 0,
    updated_at: null,
    repositories: {},
  };
}

export function validateRepositoryMapping(mapping, key = mapping?.repository_id) {
  assertNoAuthority(mapping, 'repository mapping');
  const keys = Object.keys(mapping ?? {}).sort();
  const allowed = [
    'added_at',
    'enabled',
    'host_state_path',
    'herdr',
    'ownership_pointer_path',
    'repository_id',
    'repository_realpath',
    'schema',
    'updated_at',
  ].sort();
  if (mapping?.schema !== OPSLED_REPOSITORY_SCHEMA
      || keys.join(',') !== allowed.join(',')
      || typeof mapping.repository_realpath !== 'string'
      || !mapping.repository_realpath.startsWith('/')
      || mapping.repository_id !== repositoryOperationalId(mapping.repository_realpath)
      || key !== mapping.repository_id
      || mapping.enabled !== true
      || typeof mapping.host_state_path !== 'string'
      || typeof mapping.ownership_pointer_path !== 'string'
      || !validateHerdrPointer(mapping.herdr, { nullable: true })
      || typeof mapping.added_at !== 'string'
      || typeof mapping.updated_at !== 'string') {
    throw classifiedError('CORRUPT', 'invalid opsled repository mapping');
  }
  return true;
}

function validateHerdrPointer(value, { nullable = false } = {}) {
  if (nullable && value === null) return true;
  return value?.kind === 'herdr'
    && typeof value.workspace_id === 'string'
    && typeof value.pane_id === 'string'
    && typeof value.terminal_id === 'string'
    && typeof value.sessions_root_realpath === 'string'
    && value.sessions_root_realpath.startsWith('/')
    && Object.keys(value).sort().join(',') === 'kind,pane_id,sessions_root_realpath,terminal_id,workspace_id';
}

export function validateHostOwnershipPointer(pointer, repositoryRoot = pointer?.repository_realpath) {
  const root = resolve(repositoryRoot);
  if (pointer?.schema !== HOST_OWNERSHIP_SCHEMA
      || pointer.repository_realpath !== root
      || pointer.repository_id !== repositoryOperationalId(root)
      || typeof pointer.opsled_root !== 'string'
      || !pointer.opsled_root.startsWith('/')
      || pointer.registry_path !== registryPaths(pointer.opsled_root).registry
      || pointer.session_binding_path !== join(root, '.opsle', 'wake', 'codex-session-binding.json')
      || !validateHerdrPointer(pointer.herdr)
      || typeof pointer.registered_at !== 'string'
      || typeof pointer.updated_at !== 'string'
      || Object.keys(pointer).sort().join(',') !== [
        'herdr', 'opsled_root', 'registered_at', 'registry_path', 'repository_id',
        'repository_realpath', 'schema', 'session_binding_path', 'updated_at',
      ].sort().join(',')) {
    throw classifiedError('CORRUPT', 'invalid repository host ownership pointer');
  }
  return true;
}

export function readHostOwnershipPointer(repositoryRoot) {
  const path = repositoryOwnershipPaths(repositoryRoot).pointer;
  if (!existsSync(path)) return null;
  const pointer = readJson(path);
  validateHostOwnershipPointer(pointer, realpathSync(resolve(repositoryRoot)));
  return pointer;
}

export function ensureRepositoryOwnershipPointer(mapping) {
  validateRepositoryMapping(mapping, mapping.repository_id);
  const ownership = repositoryOwnershipPaths(mapping.repository_realpath);
  if (mapping.ownership_pointer_path !== ownership.pointer || !mapping.herdr) {
    throw classifiedError('CORRUPT', 'registered repository cannot establish its host ownership pointer');
  }
  const hostRoot = dirname(dirname(mapping.host_state_path));
  if (basename(dirname(mapping.host_state_path)) !== 'repositories'
      || basename(mapping.host_state_path) !== mapping.repository_id) {
    throw classifiedError('CORRUPT', 'registered repository host state path is not canonical');
  }
  const lock = acquireHostLock(ownership.lock);
  try {
    const existing = readHostOwnershipPointer(mapping.repository_realpath);
    if (existing) {
      if (existing.opsled_root !== hostRoot
          || existing.repository_id !== mapping.repository_id
          || canonicalJson(existing.herdr) !== canonicalJson(mapping.herdr)) {
        throw classifiedError('OWNERSHIP_CONFLICT', 'repository host ownership pointer disagrees with the registry');
      }
      return existing;
    }
    const pointer = {
      schema: HOST_OWNERSHIP_SCHEMA,
      repository_id: mapping.repository_id,
      repository_realpath: mapping.repository_realpath,
      opsled_root: hostRoot,
      registry_path: registryPaths(hostRoot).registry,
      herdr: mapping.herdr,
      session_binding_path: join(mapping.repository_realpath, '.opsle', 'wake', 'codex-session-binding.json'),
      registered_at: mapping.added_at,
      updated_at: mapping.updated_at,
    };
    validateHostOwnershipPointer(pointer, mapping.repository_realpath);
    writeJson(ownership.pointer, pointer);
    return pointer;
  } finally {
    lock.release();
  }
}

export function validateRegistry(registry) {
  assertNoAuthority(registry);
  if (registry?.schema !== OPSLED_REGISTRY_SCHEMA
      || !Number.isSafeInteger(registry.revision) || registry.revision < 0
      || (registry.updated_at !== null && typeof registry.updated_at !== 'string')
      || !registry.repositories || typeof registry.repositories !== 'object'
      || Array.isArray(registry.repositories)
      || Object.keys(registry).sort().join(',') !== 'repositories,revision,schema,updated_at') {
    throw classifiedError('CORRUPT', 'invalid opsled registry');
  }
  const realpaths = new Set();
  const herdrWorkspaces = new Set();
  for (const [key, mapping] of Object.entries(registry.repositories)) {
    validateRepositoryMapping(mapping, key);
    if (realpaths.has(mapping.repository_realpath)) {
      throw classifiedError('CORRUPT', `duplicate repository realpath in opsled registry: ${mapping.repository_realpath}`);
    }
    realpaths.add(mapping.repository_realpath);
    if (mapping.herdr && herdrWorkspaces.has(mapping.herdr.workspace_id)) {
      throw classifiedError('CORRUPT', `Herdr workspace is registered to more than one repository: ${mapping.herdr.workspace_id}`);
    }
    if (mapping.herdr) herdrWorkspaces.add(mapping.herdr.workspace_id);
  }
  return true;
}

function herdrFromBinding(binding, repositoryRealpath) {
  if (binding.schema !== 'opsle.durable-supervisor.codex-session-binding/v3'
      || binding.state !== 'CURRENT'
      || binding.repository_realpath !== repositoryRealpath
      || binding.host?.kind !== 'herdr'
      || typeof binding.host.workspace_id !== 'string'
      || typeof binding.host.pane_id !== 'string'
      || typeof binding.host.terminal_id !== 'string'
      || typeof binding.sessions_root_realpath !== 'string') return null;
  return {
    kind: 'herdr',
    workspace_id: binding.host.workspace_id,
    pane_id: binding.host.pane_id,
    terminal_id: binding.host.terminal_id,
    sessions_root_realpath: binding.sessions_root_realpath,
  };
}

function herdrFromSessionBinding(repositoryRealpath) {
  const path = join(repositoryRealpath, '.opsle', 'wake', 'codex-session-binding.json');
  return existsSync(path) ? herdrFromBinding(readJson(path), repositoryRealpath) : null;
}

function migrateRegistryV1(registry) {
  const repositories = {};
  for (const [repositoryId, mapping] of Object.entries(registry.repositories ?? {})) {
    if (mapping?.schema !== LEGACY_OPSLED_REPOSITORY_SCHEMA) {
      throw classifiedError('CORRUPT', `invalid legacy opsled mapping ${repositoryId}`);
    }
    repositories[repositoryId] = {
      ...mapping,
      schema: OPSLED_REPOSITORY_SCHEMA,
      ownership_pointer_path: repositoryOwnershipPaths(mapping.repository_realpath).pointer,
      herdr: herdrFromSessionBinding(mapping.repository_realpath),
    };
  }
  const migrated = {
    ...registry,
    schema: OPSLED_REGISTRY_SCHEMA,
    repositories,
    updated_at: now(),
  };
  validateRegistry(migrated);
  return migrated;
}

function ensureSafeHostRoot(hostRoot) {
  const paths = registryPaths(hostRoot);
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  const stats = lstatSync(paths.root);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw classifiedError('CORRUPT', `opsled host root must be a non-symlink directory: ${paths.root}`);
  }
  return paths;
}

function durableReplace(path, bytes) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const descriptor = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
  try { unlinkSync(temporary); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export function readRegistry(hostRoot, { create = false } = {}) {
  const paths = ensureSafeHostRoot(hostRoot);
  if (!existsSync(paths.registry)) {
    if (!create) return emptyRegistry();
    return updateRegistry(hostRoot, (registry) => registry);
  }
  if (lstatSync(paths.registry).isSymbolicLink()) {
    throw classifiedError('CORRUPT', 'opsled registry must not be a symbolic link');
  }
  const bytes = readFileSync(paths.registry, 'utf8');
  const parsed = parseRegistry(bytes, paths.registry, { permitLegacy: true });
  if (parsed.schema === OPSLED_REGISTRY_SCHEMA) return parsed;
  const lock = acquireHostLock(paths.registryLock);
  try {
    const currentBytes = readFileSync(paths.registry, 'utf8');
    const current = parseRegistry(currentBytes, paths.registry, { permitLegacy: true });
    if (current.schema === OPSLED_REGISTRY_SCHEMA) return current;
    const migrated = migrateRegistryV1(current);
    durableReplace(paths.registry, canonicalJson(migrated));
    return migrated;
  } finally {
    lock.release();
  }
}

export function updateRegistry(hostRoot, mutate) {
  const paths = ensureSafeHostRoot(hostRoot);
  const lock = acquireHostLock(paths.registryLock);
  try {
    const beforeBytes = existsSync(paths.registry) ? readFileSync(paths.registry, 'utf8') : null;
    const parsed = beforeBytes == null
      ? emptyRegistry()
      : parseRegistry(beforeBytes, paths.registry, { permitLegacy: true });
    const before = parsed.schema === OPSLED_REGISTRY_SCHEMA ? parsed : migrateRegistryV1(parsed);
    const next = structuredClone(before);
    const result = mutate(next);
    next.revision = before.revision + 1;
    next.updated_at = now();
    validateRegistry(next);
    durableReplace(paths.registry, canonicalJson(next));
    return {
      registry: next,
      prior_sha256: beforeBytes == null ? null : sha256(beforeBytes),
      current_sha256: sha256(canonicalJson(next)),
      result,
    };
  } finally {
    lock.release();
  }
}

export function acquireUpgradeLock(hostRoot, options = {}) {
  const paths = ensureSafeHostRoot(hostRoot);
  mkdirSync(dirname(paths.upgradeLock), { recursive: true, mode: 0o700 });
  return acquireHostLock(paths.upgradeLock, options);
}

export function registerRepository(hostRoot, repositoryPath, { sessionBinding = null } = {}) {
  const repositoryRealpath = realpathSync(resolve(repositoryPath));
  const supervisorPath = join(repositoryRealpath, '.opsle', 'supervisor.json');
  if (!existsSync(supervisorPath)) throw new Error(`repository is not initialized for Opsle: ${repositoryRealpath}`);
  const repositoryId = repositoryOperationalId(repositoryRealpath);
  const host = registryPaths(hostRoot);
  const ownershipPaths = repositoryOwnershipPaths(repositoryRealpath);
  const ownershipLock = acquireHostLock(ownershipPaths.lock);
  try {
    const existingPointer = readHostOwnershipPointer(repositoryRealpath);
    if (existingPointer && existingPointer.opsled_root !== host.root) {
      throw classifiedError('OWNERSHIP_CONFLICT', `repository is already owned by opsled ${existingPointer.opsled_root}`);
    }
    ensureDurableCompatibility(repositoryRealpath);
    const binding = sessionBinding ?? (existsSync(join(repositoryRealpath, '.opsle', 'wake', 'codex-session-binding.json'))
      ? readJson(join(repositoryRealpath, '.opsle', 'wake', 'codex-session-binding.json'))
      : null);
    const herdr = binding ? herdrFromBinding(binding, repositoryRealpath) : null;
    if (!herdr) throw classifiedError('CORRUPT', 'registration requires a current repository Herdr/Codex binding');
    const timestamp = now();
    const pointer = {
      schema: HOST_OWNERSHIP_SCHEMA,
      repository_id: repositoryId,
      repository_realpath: repositoryRealpath,
      opsled_root: host.root,
      registry_path: host.registry,
      herdr,
      session_binding_path: join(repositoryRealpath, '.opsle', 'wake', 'codex-session-binding.json'),
      registered_at: existingPointer?.registered_at ?? timestamp,
      updated_at: timestamp,
    };
    validateHostOwnershipPointer(pointer, repositoryRealpath);
    writeJson(ownershipPaths.pointer, pointer);
    try {
      return updateRegistry(hostRoot, (registry) => {
        for (const mapping of Object.values(registry.repositories)) {
          if (mapping.repository_realpath === repositoryRealpath && mapping.repository_id !== repositoryId) {
            throw classifiedError('CORRUPT', `conflicting mapping for repository realpath ${repositoryRealpath}`);
          }
          if (mapping.repository_id !== repositoryId
              && mapping.herdr?.workspace_id === herdr.workspace_id) {
            throw classifiedError('OWNERSHIP_CONFLICT', `Herdr workspace is already registered to ${mapping.repository_realpath}`);
          }
        }
        const existing = registry.repositories[repositoryId];
        const timestamp = now();
        registry.repositories[repositoryId] = {
          schema: OPSLED_REPOSITORY_SCHEMA,
          repository_id: repositoryId,
          repository_realpath: repositoryRealpath,
          host_state_path: join(registryPaths(hostRoot).repositories, repositoryId),
          ownership_pointer_path: ownershipPaths.pointer,
          herdr,
          enabled: true,
          added_at: existing?.added_at ?? timestamp,
          updated_at: timestamp,
        };
        return { created: !existing, repository_id: repositoryId, ownership: pointer };
      });
    } catch (error) {
      if (!existingPointer && existsSync(ownershipPaths.pointer)) unlinkSync(ownershipPaths.pointer);
      throw error;
    }
  } finally {
    ownershipLock.release();
  }
}

export function unregisterRepository(hostRoot, repositoryPath) {
  const candidate = resolve(repositoryPath);
  let repositoryRealpath;
  try { repositoryRealpath = realpathSync(candidate); } catch { repositoryRealpath = candidate; }
  const ownership = repositoryOwnershipPaths(repositoryRealpath);
  const lock = acquireHostLock(ownership.lock);
  try {
    const pointer = readHostOwnershipPointer(repositoryRealpath);
    if (pointer && pointer.opsled_root !== registryPaths(hostRoot).root) {
      throw classifiedError('OWNERSHIP_CONFLICT', `repository is owned by another opsled: ${pointer.opsled_root}`);
    }
    const result = updateRegistry(hostRoot, (registry) => {
      const matches = Object.entries(registry.repositories)
        .filter(([, mapping]) => mapping.repository_realpath === repositoryRealpath);
      if (matches.length > 1) {
        throw classifiedError('CORRUPT', `duplicate repository mappings prevent safe removal: ${repositoryRealpath}`);
      }
      if (matches.length === 0) return { removed: false, repository_id: null };
      const [[repositoryId]] = matches;
      delete registry.repositories[repositoryId];
      return { removed: true, repository_id: repositoryId };
    });
    if (pointer && existsSync(ownership.pointer)) unlinkSync(ownership.pointer);
    return result;
  } finally {
    lock.release();
  }
}

export function updateRepositoryHerdrBinding(hostRoot, repositoryId, binding) {
  const registry = readRegistry(hostRoot);
  const mapping = registry.repositories[repositoryId];
  if (!mapping) throw new Error(`repository is not registered with opsled: ${repositoryId}`);
  const herdr = herdrFromBinding(binding, mapping.repository_realpath);
  if (!herdr) throw classifiedError('CORRUPT', 'current session cannot update the registered Herdr pointer');
  const ownership = repositoryOwnershipPaths(mapping.repository_realpath);
  const lock = acquireHostLock(ownership.lock);
  try {
    const pointer = readHostOwnershipPointer(mapping.repository_realpath);
    if (!pointer || pointer.opsled_root !== registryPaths(hostRoot).root) {
      throw classifiedError('OWNERSHIP_CONFLICT', 'repository host ownership changed during session refresh');
    }
    const timestamp = now();
    let nextMapping = mapping;
    if (canonicalJson(mapping.herdr) !== canonicalJson(herdr)) {
      const updated = updateRegistry(hostRoot, (next) => {
        const current = next.repositories[repositoryId];
        if (!current || current.repository_realpath !== mapping.repository_realpath) {
          throw classifiedError('OWNERSHIP_CONFLICT', 'repository registry changed during session refresh');
        }
        current.herdr = herdr;
        current.updated_at = timestamp;
        return null;
      });
      nextMapping = updated.registry.repositories[repositoryId];
    }
    if (canonicalJson(pointer.herdr) !== canonicalJson(herdr)) {
      const nextPointer = { ...pointer, herdr, updated_at: timestamp };
      validateHostOwnershipPointer(nextPointer, mapping.repository_realpath);
      writeJson(ownership.pointer, nextPointer);
    }
    return nextMapping;
  } finally {
    lock.release();
  }
}

export function resolveRepositoryMapping(hostRoot, repositoryPathOrId) {
  const registry = readRegistry(hostRoot);
  if (registry.repositories[repositoryPathOrId]) return registry.repositories[repositoryPathOrId];
  const candidate = resolve(repositoryPathOrId);
  let repositoryRealpath;
  try { repositoryRealpath = realpathSync(candidate); } catch { repositoryRealpath = candidate; }
  const matches = Object.values(registry.repositories)
    .filter((mapping) => mapping.repository_realpath === repositoryRealpath);
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? `repository is not registered with opsled: ${repositoryRealpath}`
      : `repository registry mapping is ambiguous: ${repositoryRealpath}`);
  }
  return matches[0];
}
