import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

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
export const fileSha256 = (path) => sha256(readFileSync(path));

export function readJson(path) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`invalid durable JSON ${path}: ${error.message}`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`durable JSON must be an object: ${path}`);
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

export const writeJson = (path, value) => atomicWrite(path, canonicalJson(value));

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

export function assertRegular(path) {
  const stats = statSync(path);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`expected regular non-symlink file: ${path}`);
  }
}
