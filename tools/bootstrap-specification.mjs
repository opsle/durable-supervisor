#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

const SPEC_MARKER = 'Opsle Durable Supervisor V0.1';
const REQUIREMENT_STATES = [
  'UNSTARTED',
  'IN_PROGRESS',
  'IMPLEMENTED',
  'VERIFIED',
  'DEFERRED_WITH_JUSTIFICATION',
  'BLOCKED',
  'NOT_APPLICABLE_WITH_JUSTIFICATION',
];

function fail(message) {
  process.stderr.write(`bootstrap-specification: ${message}\n`);
  process.exit(1);
}

function atomicWrite(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  const descriptor = openSync(temporary, 'w', 0o600);
  try {
    writeFileSync(descriptor, bytes);
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

function extractSpecification(sessionPath) {
  const lines = readFileSync(sessionPath, 'utf8').split('\n').filter(Boolean);
  const candidates = [];
  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = record?.type === 'response_item' ? record.payload : null;
    if (payload?.type !== 'message' || payload.role !== 'user') continue;
    for (const item of payload.content ?? []) {
      if (item.type !== 'input_text' || typeof item.text !== 'string') continue;
      if (item.text.includes(SPEC_MARKER)) candidates.push(item.text);
    }
  }
  if (candidates.length !== 1) {
    fail(`expected one specification in ${sessionPath}; found ${candidates.length}`);
  }
  return `${candidates[0].trimEnd()}\n`;
}

function buildRequirements(specification) {
  const matches = [...specification.matchAll(/^DS-(\d{3}):\s+(.+)$/gm)];
  if (matches.length !== 101) {
    fail(`expected 101 DS requirements; found ${matches.length}`);
  }
  const requirements = matches.map((match, index) => {
    const expected = String(index).padStart(3, '0');
    if (match[1] !== expected) {
      fail(`expected DS-${expected}; found DS-${match[1]}`);
    }
    const start = match.index;
    const end = matches[index + 1]?.index ?? specification.length;
    const source = specification.slice(start, end).trimEnd();
    return {
      id: `DS-${match[1]}`,
      title: match[2].trim(),
      state: 'UNSTARTED',
      source_sha256: createHash('sha256').update(source).digest('hex'),
      evidence: [],
      justification: null,
      notes: [],
    };
  });
  return {
    schema: 'opsle.durable-supervisor.requirements/v1',
    allowed_states: REQUIREMENT_STATES,
    specification: '.opsle/specification.md',
    specification_sha256: createHash('sha256')
      .update(specification)
      .digest('hex'),
    requirement_count: requirements.length,
    requirements,
  };
}

const sessionArgument = process.argv[2];
if (!sessionArgument) {
  fail('usage: node tools/bootstrap-specification.mjs SESSION_JSONL');
}

const repository = resolve(new URL('..', import.meta.url).pathname);
const specification = extractSpecification(resolve(sessionArgument));
const requirements = buildRequirements(specification);
atomicWrite(resolve(repository, '.opsle/specification.md'), specification);
atomicWrite(
  resolve(repository, '.opsle/requirements.json'),
  `${JSON.stringify(requirements, null, 2)}\n`,
);

process.stdout.write(`${JSON.stringify({
  specification: '.opsle/specification.md',
  specification_bytes: Buffer.byteLength(specification),
  specification_sha256: requirements.specification_sha256,
  requirements: requirements.requirement_count,
})}\n`);
