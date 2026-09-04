import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, now, readJson, sha256, writeJson } from './io.js';

export const DURABLE_COMPATIBILITY_SCHEMA = 'opsle.durable-supervisor.compatibility/v1';
export const DURABLE_SCHEMA_VERSION = 2;

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

const MIGRATIONS = new Map([
  [1, function migrateToV1(root) {
    validateCoreState(root);
    mkdirSync(join(root, '.opsle', 'runner', 'requests'), { recursive: true, mode: 0o700 });
  }],
  [2, function migrateToV2(root) {
    validateCoreState(root);
    mkdirSync(join(root, '.opsle', 'runner', 'requests'), { recursive: true, mode: 0o700 });
  }],
]);

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

export function ensureDurableCompatibility(root) {
  const repositoryRoot = resolve(root);
  const path = compatibilityPath(repositoryRoot);
  const manifest = durableSchemaManifest();
  let version = 0;
  if (existsSync(path)) {
    version = validateHeader(readDurableJson(path), manifest).durable_schema_version;
  }
  while (version < DURABLE_SCHEMA_VERSION) {
    const targetVersion = version + 1;
    const migrate = MIGRATIONS.get(targetVersion);
    if (typeof migrate !== 'function') {
      throw classifiedError('CORRUPT', `missing migration function for durable schema v${targetVersion}`);
    }
    migrate(repositoryRoot);
    const header = {
      schema: DURABLE_COMPATIBILITY_SCHEMA,
      durable_schema_version: targetVersion,
      schema_fingerprint_sha256: targetVersion === DURABLE_SCHEMA_VERSION
        ? manifest.fingerprint_sha256
        : null,
      migrated_at: now(),
    };
    writeJson(path, header);
    version = targetVersion;
  }
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
