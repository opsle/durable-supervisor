import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { operationalRootForPath } from './runtime-release.js';

export const now = () => new Date().toISOString();
export const id = (prefix) => `${prefix}-${randomUUID()}`;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

export const canonicalJson = (value) => `${JSON.stringify(canonicalize(value))}\n`;
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const fileSha256 = (path) => {
  return sha256(readFileSync(path));
};

export function readJson(path) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const wrapped = new Error(`invalid durable JSON ${path}: ${error.message}`);
    if (operationalRootForPath(path)) {
      wrapped.name = 'CorruptStateError';
      wrapped.code = 'CORRUPT';
      wrapped.classification = 'CORRUPT';
    }
    throw wrapped;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    const error = new Error(`durable JSON must be an object: ${path}`);
    if (operationalRootForPath(path)) {
      error.name = 'CorruptStateError';
      error.code = 'CORRUPT';
      error.classification = 'CORRUPT';
    }
    throw error;
  }
  return value;
}

export function atomicWrite(path, value, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const descriptor = openSync(temporary, 'wx', mode);
  try {
    writeFileSync(descriptor, value);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
  try {
    unlinkSync(temporary);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export const writeJson = (path, value, mode = 0o600) => atomicWrite(path, canonicalJson(value), mode);

export function atomicCreateJson(path, value, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.create-${process.pid}-${randomUUID()}`;
  const descriptor = openSync(temporary, 'wx', mode);
  try {
    writeFileSync(descriptor, canonicalJson(value));
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    linkSync(temporary, path);
    const directory = openSync(dirname(path), 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  } finally {
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

// Exact single-host compare-and-swap for cooperating Opsle processes. The
// directory lock serializes the read/hash/replace boundary; callers must retry
// a busy lock rather than guessing. A stale process never receives a successful
// CAS because the expected content hash is checked while the lock is held.
export function atomicCompareAndSwapJson(path, expectedSha256, value, mode = 0o600) {
  const lock = `${path}.cas-lock`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST') return { swapped: false, reason: 'cas-lock-busy' };
    throw error;
  }
  try {
    const exists = (() => {
      try { statSync(path); return true; } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    })();
    const current = exists ? readFileSync(path) : null;
    const currentSha256 = current == null ? null : sha256(current);
    if (currentSha256 !== expectedSha256) {
      return { swapped: false, reason: 'cas-content-changed', current_sha256: currentSha256 };
    }
    writeJson(path, value, mode);
    return { swapped: true, prior_sha256: currentSha256, current_sha256: fileSha256(path) };
  } finally {
    rmdirSync(lock);
  }
}

export function appendEvent(path, event) {
  mkdirSync(dirname(path), { recursive: true });
  const descriptor = openSync(path, 'a', 0o600);
  try {
    appendFileSync(descriptor, canonicalJson(event));
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
