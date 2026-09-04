#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  chmodSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const manifestPath = join(root, 'release-manifest.json');
const zeroDigest = '0'.repeat(64);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value))}\n`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalPackageMode(path) {
  return (statSync(path).mode & 0o111) === 0 ? 0o644 : 0o755;
}

function packagePathCompare(left, right) {
  const lower = left.toLowerCase().localeCompare(right.toLowerCase(), 'en');
  return lower || left.localeCompare(right, 'en');
}

function filesUnder(path) {
  const stats = statSync(path);
  if (stats.isFile()) return [path];
  const files = [];
  for (const name of readdirSync(path).sort()) files.push(...filesUnder(join(path, name)));
  return files;
}

const packageFiles = [join(root, 'package.json')];
for (const entry of packageJson.files) {
  if (entry === 'release-manifest.json') continue;
  packageFiles.push(...filesUnder(join(root, entry)));
}
packageFiles.push(manifestPath);
const relativeFiles = [...new Set(packageFiles.map((path) => relative(root, path)))]
  .sort(packagePathCompare);

const git = spawnSync('git', ['-C', root, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' });
const sourceRevision = process.env.OPSLE_BUILD_REVISION?.trim()
  || (git.status === 0 ? git.stdout.trim() : null);
if (!sourceRevision) throw new Error('runtime release build requires an exact source revision');

const releaseContent = createHash('sha256');
for (const path of relativeFiles.filter((entry) => entry !== 'release-manifest.json')) {
  const target = join(root, path);
  const bytes = readFileSync(target);
  const mode = canonicalPackageMode(target);
  releaseContent.update(`${path}\0${mode.toString(8)}\0${bytes.length}\0`);
  releaseContent.update(bytes);
}
const releaseContentRevision = releaseContent.digest('hex');

const helpers = [
  ['bin/opsle-codex-resume.js', 'codex-resume'],
  ['bin/opsle-runner-worker.js', 'runner-worker'],
  ['bin/opsle-wake-delivery.js', 'wake-delivery'],
  ['bin/opsle.js', 'cli'],
].map(([path, role]) => ({ path, role, sha256: sha256(readFileSync(join(root, path))) }));

// The manifest mode is part of the logical package digest. Normalize it before
// hashing so a prior checkout umask cannot change the release identity.
if (statExists(manifestPath)) chmodSync(manifestPath, 0o644);

const manifest = {
  schema: 'opsle.durable-supervisor.runtime-release/v1',
  runtime_release_id: `opsle-runtime-${packageJson.version}-${releaseContentRevision.slice(0, 16)}`,
  version: packageJson.version,
  source_revision: sourceRevision,
  runtime_epoch: `${packageJson.version}+${sourceRevision}`,
  packaged_artifact_sha256: zeroDigest,
  supported_reader_versions: [1, 2, 3],
  supported_writer_versions: [1, 2, 3],
  migration_versions: [],
  helpers,
  artifact: {
    digest_algorithm: 'sha256-path-canonical-mode-length-bytes-manifest-digest-zeroed-v1',
    manifest_self_reference: 'release-manifest.json is included with packaged_artifact_sha256 replaced by 64 ASCII zeroes',
    files: relativeFiles.map((path) => ({ path })),
  },
};

const digest = createHash('sha256');
for (const entry of manifest.artifact.files) {
  const path = join(root, entry.path);
  const bytes = entry.path === basename(manifestPath)
    ? Buffer.from(canonicalJson(manifest))
    : readFileSync(path);
  const mode = entry.path === basename(manifestPath)
    ? 0o644
    : canonicalPackageMode(path);
  digest.update(`${entry.path}\0${mode.toString(8)}\0${bytes.length}\0`);
  digest.update(bytes);
}
manifest.packaged_artifact_sha256 = digest.digest('hex');
writeFileSync(manifestPath, canonicalJson(manifest), { mode: 0o644 });
chmodSync(manifestPath, 0o644);

function statExists(path) {
  try { statSync(path); return true; } catch { return false; }
}
