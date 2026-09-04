#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(new URL('..', import.meta.url).pathname);
const manifestPath = join(root, 'src', 'durable-schema-manifest.json');

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function compactCanonicalJson(value) {
  return `${JSON.stringify(canonicalize(value))}\n`;
}

function fingerprint(identifiers) {
  return createHash('sha256').update(compactCanonicalJson(identifiers)).digest('hex');
}

function sourceFiles(directory) {
  return readdirSync(join(root, directory))
    .filter((name) => name.endsWith('.js'))
    .sort()
    .map((name) => join(root, directory, name));
}

function observedIdentifiers() {
  const identifiers = new Set();
  for (const path of [...sourceFiles('src'), ...sourceFiles('bin')]) {
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(/opsle\.durable-supervisor[A-Za-z0-9._/-]*/g)) {
      identifiers.add(match[0]);
    }
    for (const match of source.matchAll(/\$\{OPSLE_SCHEMA\}([A-Za-z0-9._/-]+)/g)) {
      identifiers.add(`opsle.durable-supervisor${match[1]}`);
    }
  }
  return [...identifiers].filter((identifier) => /\/v\d+$/.test(identifier)).sort();
}

const observed = observedIdentifiers();
const current = JSON.parse(readFileSync(manifestPath, 'utf8'));
const generated = {
  version: current.version,
  identifiers: observed,
  fingerprint_sha256: fingerprint(observed),
};

if (process.argv.includes('--write')) {
  writeFileSync(manifestPath, canonicalJson(generated));
  process.exit(0);
}

if (compactCanonicalJson(current) !== compactCanonicalJson(generated)) {
  throw new Error('durable schema manifest is stale; update identifiers and bump version when the set changed');
}

const mergeBase = spawnSync('git', ['-C', root, 'merge-base', 'HEAD', 'origin/main'], { encoding: 'utf8' });
if (mergeBase.status === 0) {
  const prior = spawnSync('git', [
    '-C', root, 'show', `${mergeBase.stdout.trim()}:src/durable-schema-manifest.json`,
  ], { encoding: 'utf8' });
  if (prior.status === 0) {
    const previous = JSON.parse(prior.stdout);
    if (previous.fingerprint_sha256 !== current.fingerprint_sha256
        && previous.version === current.version) {
      throw new Error('durable schema identifiers changed without a durable schema version bump');
    }
  }
}
