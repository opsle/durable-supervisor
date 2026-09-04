import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, now, readJson, sha256, writeJson } from './io.js';

export const DURABLE_COMPATIBILITY_SCHEMA = 'opsle.durable-supervisor.compatibility/v1';
export const DURABLE_SCHEMA_VERSION = 2;
export const DURABLE_MIGRATION_WRITE_BOUNDARIES = Object.freeze([
  'runner-requests-directory',
  'compatibility-header-v2',
]);

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(packageRoot, 'src', 'durable-schema-manifest.json');

function classifiedError(classification, message) {
  const error = new Error(`${classification}: ${message}`);
  error.code = classification;
  error.classification = classification;
  return error;
}

export function durableSchemaManifest() {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const fingerprint = sha256(canonicalJson(manifest.identifiers));
  if (manifest.version !== DURABLE_SCHEMA_VERSION
      || !Array.isArray(manifest.identifiers)
      || canonicalJson(manifest.identifiers) !== canonicalJson([...new Set(manifest.identifiers)].sort())
      || manifest.fingerprint_sha256 !== fingerprint) {
    throw new Error('durable schema manifest is inconsistent');
  }
  return manifest;
}

function compatibilityPath(root) {
  return join(resolve(root), '.opsle', 'compatibility.json');
}

function readDurableJson(path) {
  try {
    return readJson(path);
  } catch (error) {
    throw classifiedError('CORRUPT', `malformed durable JSON at ${path}: ${error.message}`);
  }
}

function validateCoreState(root) {
  for (const name of ['supervisor.json', 'state.json', 'objective.json', 'policy.json']) {
    const path = join(root, '.opsle', name);
    if (!existsSync(path)) throw classifiedError('CORRUPT', `missing durable state required for migration: ${path}`);
    readDurableJson(path);
  }
}

function migrateToCurrent(root, afterDurableWrite) {
  validateCoreState(root);
  const requests = join(root, '.opsle', 'runner', 'requests');
  if (!existsSync(requests)) {
    mkdirSync(requests, { recursive: true, mode: 0o700 });
    afterDurableWrite('runner-requests-directory');
  }
}

function legacyInterruptedHeader(header) {
  return header?.schema === DURABLE_COMPATIBILITY_SCHEMA
    && header.durable_schema_version === 1
    && header.schema_fingerprint_sha256 === null
    && typeof header.migrated_at === 'string'
    && Object.keys(header).sort().join(',') === [
      'durable_schema_version',
      'migrated_at',
      'schema',
      'schema_fingerprint_sha256',
    ].sort().join(',');
}

function validateHeader(header, manifest) {
  if (header?.schema !== DURABLE_COMPATIBILITY_SCHEMA
      || !Number.isSafeInteger(header.durable_schema_version)
      || header.durable_schema_version < 1
      || !/^[a-f0-9]{64}$/.test(header.schema_fingerprint_sha256 ?? '')
      || typeof header.migrated_at !== 'string') {
    throw classifiedError('CORRUPT', 'malformed durable compatibility header');
  }
  if (header.durable_schema_version > DURABLE_SCHEMA_VERSION) {
    throw classifiedError(
      'UPGRADE_REQUIRED',
      `repository durable schema v${header.durable_schema_version} is newer than runtime v${DURABLE_SCHEMA_VERSION}`,
    );
  }
  if (header.durable_schema_version === DURABLE_SCHEMA_VERSION
      && header.schema_fingerprint_sha256 !== manifest.fingerprint_sha256) {
    throw classifiedError('CORRUPT', 'durable schema fingerprint does not match its declared version');
  }
  return header;
}

export function ensureDurableCompatibility(root, {
  afterDurableWrite = () => {},
} = {}) {
  const repositoryRoot = resolve(root);
  const path = compatibilityPath(repositoryRoot);
  const manifest = durableSchemaManifest();
  if (existsSync(path)) {
    const header = readDurableJson(path);
    if (!legacyInterruptedHeader(header)) {
      const validated = validateHeader(header, manifest);
      if (validated.durable_schema_version === DURABLE_SCHEMA_VERSION) return validated;
      throw classifiedError(
        'CORRUPT',
        `unsupported historical durable schema v${validated.durable_schema_version} fingerprint`,
      );
    }
  }
  migrateToCurrent(repositoryRoot, afterDurableWrite);
  const header = {
    schema: DURABLE_COMPATIBILITY_SCHEMA,
    durable_schema_version: DURABLE_SCHEMA_VERSION,
    schema_fingerprint_sha256: manifest.fingerprint_sha256,
    migrated_at: now(),
  };
  writeJson(path, header);
  afterDurableWrite('compatibility-header-v2');
  return validateHeader(readDurableJson(path), manifest);
}

export function assertSchemaEvolution(previous, current) {
  const previousFingerprint = sha256(canonicalJson(previous.identifiers));
  const currentFingerprint = sha256(canonicalJson(current.identifiers));
  if (previousFingerprint !== currentFingerprint && previous.version === current.version) {
    throw new Error('durable schema identifiers changed without a durable schema version change');
  }
  return true;
}
