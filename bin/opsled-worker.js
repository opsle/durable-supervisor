#!/usr/bin/env node

import { now, readJson, writeJson } from '../src/io.js';
import { registryPaths } from '../src/opsled-registry.js';
import { runOpsledService } from '../src/opsled.js';
import { loadRuntimeRelease, processStartIdentity } from '../src/runtime-release.js';

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index < 0 ? null : args[index + 1];
}

const args = process.argv.slice(2);
const hostRoot = valueAfter(args, '--home');
const serviceId = valueAfter(args, '--service');
const generation = Number(valueAfter(args, '--generation'));
const launchNonce = valueAfter(args, '--launch-nonce');
const intervalMs = Number(valueAfter(args, '--interval-ms'));
let stopping = false;

process.once('SIGTERM', () => { stopping = true; });
process.once('SIGINT', () => { stopping = true; });

async function main() {
  if (!hostRoot || !serviceId || !launchNonce
      || !Number.isSafeInteger(generation)
      || !Number.isSafeInteger(intervalMs) || intervalMs < 10) {
    throw new Error('opsled worker requires exact home, service, generation, nonce, and interval');
  }
  loadRuntimeRelease();
  const identity = {
    service_id: serviceId,
    generation,
    launch_nonce: launchNonce,
  };
  const result = await runOpsledService(hostRoot, identity, {
    intervalMs,
    processIdentity: processStartIdentity(),
    shouldStop: () => stopping,
  });
  if (result.status === 'STOP_REQUESTED') {
    const path = registryPaths(hostRoot).service;
    const service = readJson(path);
    if (service.service_id === serviceId && service.generation === generation
        && service.process?.pid === process.pid) {
      service.status = 'STOPPED';
      service.stopped_at = now();
      service.heartbeat_at = now();
      writeJson(path, service);
    }
  }
}

main().catch((error) => {
  try {
    const path = registryPaths(hostRoot).service;
    const service = readJson(path);
    if (service.service_id === serviceId && service.generation === generation
        && service.process?.pid === process.pid) {
      service.status = 'FAILED';
      service.failure = error.message;
      service.heartbeat_at = now();
      writeJson(path, service);
    }
  } catch {}
  process.stderr.write(`opsled worker: ${error.message}\n`);
  process.exitCode = 1;
});
