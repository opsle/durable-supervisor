#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { canonicalJson, now, readJson, sha256, writeJson } from '../src/io.js';
import { resolveRepositoryMapping, updateRepositoryHerdrBinding } from '../src/opsled-registry.js';
import { assertCurrentOpsledService } from '../src/opsled.js';
import {
  repositoryBindingDependencies,
  validateWakeTransportRecord,
  wakeTransportPath,
} from '../src/opsled-wake.js';
import { deliverWake, refreshCodexSessionBinding } from '../src/wakeup.js';
import { assertReleaseFence, loadRuntimeRelease, processStartIdentity } from '../src/runtime-release.js';

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index < 0 ? null : args[index + 1];
}

const args = process.argv.slice(2);
const hostRoot = valueAfter(args, '--home');
const repositoryId = valueAfter(args, '--repository');
const eventId = valueAfter(args, '--event');

async function main() {
  if (!hostRoot || !repositoryId || !eventId) {
    throw new Error('opsled wake worker requires host, repository, and event');
  }
  loadRuntimeRelease();
  let mapping = resolveRepositoryMapping(hostRoot, repositoryId);
  const target = wakeTransportPath(mapping, eventId);
  let record = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(target)) {
      const candidate = readJson(target);
      if (candidate.worker?.pid === process.pid) {
        record = candidate;
        break;
      }
    }
    await sleep(10);
  }
  if (!record) throw new Error('wake transport ownership record was not published');
  validateWakeTransportRecord(record, mapping);
  const identity = processStartIdentity();
  assertReleaseFence(record.worker_release_fence, {
    role: 'opsled-wake-worker',
    processIdentity: identity,
  });
  assertCurrentOpsledService(hostRoot, record.owner, {
    processIdentity: processStartIdentity(record.owner.process.pid),
  });
  const requestPath = `${mapping.repository_realpath}/.opsle/wake/requests/${eventId}.json`;
  const requestBytes = readFileSync(requestPath, 'utf8');
  if (requestBytes !== canonicalJson(JSON.parse(requestBytes))
      || sha256(requestBytes) !== record.request_sha256) {
    throw new Error('wake request changed before transport execution');
  }
  record.status = 'RUNNING';
  writeJson(target, record);
  const session = refreshCodexSessionBinding(mapping.repository_realpath, {
    dependencies: repositoryBindingDependencies(mapping),
    allowEnvironmentMismatch: true,
  });
  if (session.valid && !session.refresh_error) {
    mapping = updateRepositoryHerdrBinding(hostRoot, repositoryId, session.binding);
  }
  const result = deliverWake(mapping.repository_realpath, eventId, {
    bindingDependencies: repositoryBindingDependencies(mapping),
    activationOwner: {
      schema: 'opsle.durable-supervisor.opsled-wake-owner/v1',
      kind: 'opsled-wake-worker',
      service_id: record.owner.service_id,
      service_generation: record.owner.generation,
      release_fence: record.worker_release_fence,
      process: identity,
    },
  });
  record = readJson(target);
  record.status = result.delivered ? 'DELIVERED' : 'NO_DELIVERY';
  record.classification = result.classification ?? null;
  record.terminal_at = now();
  writeJson(target, record);
}

main().catch((error) => {
  try {
    const mapping = resolveRepositoryMapping(hostRoot, repositoryId);
    const target = wakeTransportPath(mapping, eventId);
    if (existsSync(target)) {
      const record = readJson(target);
      if (record.worker?.pid === process.pid) {
        record.status = 'FAILED';
        record.failure = error.message;
        record.terminal_at = now();
        writeJson(target, record);
      }
    }
  } catch {}
  process.stderr.write(`opsled wake worker: ${error.message}\n`);
  process.exitCode = 1;
});
