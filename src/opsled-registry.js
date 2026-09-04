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
import { dirname, join, resolve } from 'node:path';
import { canonicalJson, now, sha256 } from './io.js';
import { acquireHostLock } from './host-lock.js';

export const OPSLED_REGISTRY_SCHEMA = 'opsle.durable-supervisor.opsled-registry/v1';
export const OPSLED_REPOSITORY_SCHEMA = 'opsle.durable-supervisor.opsled-repository/v1';

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

function parseRegistry(bytes, path) {
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
      && value.schema !== OPSLED_REGISTRY_SCHEMA) {
    throw classifiedError('UPGRADE_REQUIRED', `unsupported opsled registry schema ${value.schema}`);
  }
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
      || typeof mapping.added_at !== 'string'
      || typeof mapping.updated_at !== 'string') {
    throw classifiedError('CORRUPT', 'invalid opsled repository mapping');
  }
  return true;
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
  for (const [key, mapping] of Object.entries(registry.repositories)) {
    validateRepositoryMapping(mapping, key);
    if (realpaths.has(mapping.repository_realpath)) {
      throw classifiedError('CORRUPT', `duplicate repository realpath in opsled registry: ${mapping.repository_realpath}`);
    }
    realpaths.add(mapping.repository_realpath);
  }
  return true;
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
  return parseRegistry(readFileSync(paths.registry, 'utf8'), paths.registry);
}

export function updateRegistry(hostRoot, mutate) {
  const paths = ensureSafeHostRoot(hostRoot);
  const lock = acquireHostLock(paths.registryLock);
  try {
    const beforeBytes = existsSync(paths.registry) ? readFileSync(paths.registry, 'utf8') : null;
    const before = beforeBytes == null ? emptyRegistry() : parseRegistry(beforeBytes, paths.registry);
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

export function registerRepository(hostRoot, repositoryPath) {
  const repositoryRealpath = realpathSync(resolve(repositoryPath));
  const supervisorPath = join(repositoryRealpath, '.opsle', 'supervisor.json');
  if (!existsSync(supervisorPath)) throw new Error(`repository is not initialized for Opsle: ${repositoryRealpath}`);
  const repositoryId = repositoryOperationalId(repositoryRealpath);
  return updateRegistry(hostRoot, (registry) => {
    for (const mapping of Object.values(registry.repositories)) {
      if (mapping.repository_realpath === repositoryRealpath && mapping.repository_id !== repositoryId) {
        throw classifiedError('CORRUPT', `conflicting mapping for repository realpath ${repositoryRealpath}`);
      }
    }
    const existing = registry.repositories[repositoryId];
    const timestamp = now();
    registry.repositories[repositoryId] = {
      schema: OPSLED_REPOSITORY_SCHEMA,
      repository_id: repositoryId,
      repository_realpath: repositoryRealpath,
      host_state_path: join(registryPaths(hostRoot).repositories, repositoryId),
      enabled: true,
      added_at: existing?.added_at ?? timestamp,
      updated_at: timestamp,
    };
    return { created: !existing, repository_id: repositoryId };
  });
}

export function unregisterRepository(hostRoot, repositoryPath) {
  const candidate = resolve(repositoryPath);
  let repositoryRealpath;
  try { repositoryRealpath = realpathSync(candidate); } catch { repositoryRealpath = candidate; }
  return updateRegistry(hostRoot, (registry) => {
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
