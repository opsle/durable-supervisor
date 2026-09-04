import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RELEASE_MANIFEST_SCHEMA = 'opsle.durable-supervisor.runtime-release/v1';
export const RELEASE_FENCE_SCHEMA = 'opsle.durable-supervisor.runtime-release-fence/v1';
export const RUNTIME_HELPER_ROLES = Object.freeze({
  'bin/opsle.js': 'cli',
  'bin/opsle-codex-resume.js': 'codex-resume',
  'bin/opsle-runner-worker.js': 'runner-worker',
  'bin/opsle-wake-delivery.js': 'wake-delivery',
  'bin/opsled.js': 'opsled',
  'bin/opsled-worker.js': 'opsled-worker',
});

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(packageRoot, 'release-manifest.json');
const NORMALIZED_DIGEST = '0'.repeat(64);
let verifiedRelease = null;

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

function normalizedManifestBytes(manifest) {
  return canonicalJson({
    ...manifest,
    packaged_artifact_sha256: NORMALIZED_DIGEST,
  });
}

export function packagedArtifactDigest(root, manifest) {
  const digest = createHash('sha256');
  for (const entry of manifest.artifact.files) {
    const path = resolve(root, entry.path);
    if (relative(root, path).startsWith(`..${sep}`) || relative(root, path) === '..') {
      throw new Error(`release artifact path escapes package: ${entry.path}`);
    }
    const bytes = entry.path === 'release-manifest.json'
      ? Buffer.from(normalizedManifestBytes(manifest))
      : readFileSync(path);
    const mode = canonicalPackageMode(path);
    digest.update(`${entry.path}\0${mode.toString(8)}\0${bytes.length}\0`);
    digest.update(bytes);
  }
  return digest.digest('hex');
}

function validateManifestShape(manifest) {
  if (manifest?.schema !== RELEASE_MANIFEST_SCHEMA
      || !/^opsle-runtime-[a-z0-9.-]+-[a-f0-9]{16}$/.test(manifest.runtime_release_id ?? '')
      || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version ?? '')
      || typeof manifest.source_revision !== 'string' || !manifest.source_revision
      || typeof manifest.runtime_epoch !== 'string' || !manifest.runtime_epoch
      || !/^[a-f0-9]{64}$/.test(manifest.packaged_artifact_sha256 ?? '')
      || manifest.artifact?.digest_algorithm !== 'sha256-path-canonical-mode-length-bytes-manifest-digest-zeroed-v1'
      || manifest.artifact?.manifest_self_reference !== 'release-manifest.json is included with packaged_artifact_sha256 replaced by 64 ASCII zeroes'
      || !Array.isArray(manifest.artifact?.files) || manifest.artifact.files.length === 0) {
    throw new Error('invalid runtime release manifest');
  }
  const paths = manifest.artifact.files.map((entry) => entry?.path);
  if (paths.some((path) => typeof path !== 'string' || !path)
      || new Set(paths).size !== paths.length
      || canonicalJson(paths) !== canonicalJson([...paths].sort(packagePathCompare))
      || !paths.includes('release-manifest.json')) {
    throw new Error('runtime release artifact file inventory is incomplete or noncanonical');
  }
  const helperPaths = Object.keys(RUNTIME_HELPER_ROLES).sort();
  if (!Array.isArray(manifest.helpers)
      || canonicalJson(manifest.helpers.map((entry) => entry.path)) !== canonicalJson(helperPaths)) {
    throw new Error('runtime release helper inventory is incomplete');
  }
  for (const helper of manifest.helpers) {
    if (helper.role !== RUNTIME_HELPER_ROLES[helper.path]
        || !/^[a-f0-9]{64}$/.test(helper.sha256 ?? '')) {
      throw new Error(`invalid runtime release helper: ${helper.path}`);
    }
  }
}

export function loadRuntimeRelease({ root = packageRoot, verify = true, refresh = false } = {}) {
  if (!refresh && root === packageRoot && verifiedRelease) return structuredClone(verifiedRelease);
  const path = join(root, 'release-manifest.json');
  let manifest;
  try {
    const bytes = readFileSync(path, 'utf8');
    manifest = JSON.parse(bytes);
    if (bytes !== canonicalJson(manifest)) throw new Error('release manifest is not canonical JSON');
  } catch (error) {
    throw new Error(`runtime release manifest unavailable or malformed: ${error.message}`);
  }
  validateManifestShape(manifest);
  if (verify) {
    for (const entry of manifest.artifact.files) {
      const target = join(root, entry.path);
      if (!existsSync(target) || !statSync(target).isFile()) {
        throw new Error(`runtime release artifact file missing: ${entry.path}`);
      }
    }
    for (const helper of manifest.helpers) {
      if (sha256(readFileSync(join(root, helper.path))) !== helper.sha256) {
        throw new Error(`runtime release helper digest mismatch: ${helper.path}`);
      }
    }
    const observed = packagedArtifactDigest(root, manifest);
    if (observed !== manifest.packaged_artifact_sha256) {
      throw new Error(`runtime release artifact digest mismatch: expected ${manifest.packaged_artifact_sha256}, observed ${observed}`);
    }
  }
  if (root === packageRoot && verify) verifiedRelease = structuredClone(manifest);
  return manifest;
}

export function operationalRootForPath(path) {
  const absolute = resolve(path);
  const marker = `${sep}.opsle${sep}`;
  const index = absolute.indexOf(marker);
  if (index < 0) return null;
  return absolute.slice(0, index);
}

export function processStartIdentity(pid = process.pid, procRoot = '/proc') {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const directory = join(procRoot, String(pid));
    const stat = readFileSync(join(directory, 'stat'), 'utf8');
    const close = stat.lastIndexOf(') ');
    if (close < 0) return null;
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    return {
      pid,
      start_time_ticks: fields[19],
      executable: readlinkSync(join(directory, 'exe')),
    };
  } catch {
    return null;
  }
}

export function releaseIdentity(role, { root = packageRoot } = {}) {
  if (!Object.values(RUNTIME_HELPER_ROLES).includes(role)) throw new Error(`unknown runtime helper role: ${role}`);
  const releaseRoot = realpathSync(resolve(root));
  const manifest = loadRuntimeRelease({ root: releaseRoot });
  return {
    runtime_release_id: manifest.runtime_release_id,
    release_root: releaseRoot,
    packaged_artifact_sha256: manifest.packaged_artifact_sha256,
    runtime_epoch: manifest.runtime_epoch,
    helper_role: role,
  };
}

export function sameReleaseIdentity(left, right) {
  return left != null
    && right != null
    && left.runtime_release_id === right.runtime_release_id
    && left.release_root === right.release_root
    && left.packaged_artifact_sha256 === right.packaged_artifact_sha256
    && left.runtime_epoch === right.runtime_epoch
    && left.helper_role === right.helper_role;
}

export function releaseConflictMessage(managed, invoking) {
  const summary = (label, release) => (
    `${label} root=${release?.release_root ?? 'unknown'} artifact=${release?.packaged_artifact_sha256 ?? 'unknown'}`
  );
  return `${summary('managed/current', managed)}; ${summary('invoking', invoking)}`;
}

export function createReleaseFence(role, processIdentity = processStartIdentity()) {
  if (!processIdentity?.pid || !processIdentity?.start_time_ticks || !processIdentity?.executable) {
    throw new Error('runtime release fence requires exact helper PID/start identity');
  }
  return {
    schema: RELEASE_FENCE_SCHEMA,
    ...releaseIdentity(role),
    helper_process: {
      pid: processIdentity.pid,
      start_time_ticks: processIdentity.start_time_ticks,
      executable: processIdentity.executable,
    },
  };
}

export function assertReleaseFence(fence, {
  role,
  processIdentity = processStartIdentity(),
} = {}) {
  const expected = releaseIdentity(role);
  if (fence?.schema !== RELEASE_FENCE_SCHEMA
      || fence.runtime_release_id !== expected.runtime_release_id
      || fence.release_root !== expected.release_root
      || fence.packaged_artifact_sha256 !== expected.packaged_artifact_sha256
      || fence.runtime_epoch !== expected.runtime_epoch
      || fence.helper_role !== role
      || !processIdentity
      || fence.helper_process?.pid !== processIdentity.pid
      || fence.helper_process?.start_time_ticks !== processIdentity.start_time_ticks
      || fence.helper_process?.executable !== processIdentity.executable) {
    throw new Error('runtime release fence mismatch');
  }
  return true;
}

export function runtimePackageRoot() {
  return packageRoot;
}

// The legacy manifest builder discovers the complete package inventory and
// source revision. This bounded completion step derives the helper inventory
// from the runtime's authoritative role table and then recomputes the complete
// normalized artifact digest.
export function completeRuntimeReleaseManifest({ root = packageRoot } = {}) {
  const path = join(root, 'release-manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  delete manifest.supported_reader_versions;
  delete manifest.supported_writer_versions;
  delete manifest.migration_versions;
  manifest.helpers = Object.entries(RUNTIME_HELPER_ROLES)
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([helperPath, role]) => ({
      path: helperPath,
      role,
      sha256: sha256(readFileSync(join(root, helperPath))),
    }));
  manifest.packaged_artifact_sha256 = NORMALIZED_DIGEST;
  chmodSync(path, 0o644);
  manifest.packaged_artifact_sha256 = packagedArtifactDigest(root, manifest);
  writeFileSync(path, canonicalJson(manifest), { mode: 0o644 });
  chmodSync(path, 0o644);
  validateManifestShape(manifest);
  return manifest;
}
