import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from './io.js';
import { paths } from './state.js';
import {
  assertReleaseFence,
  compatibilityPreflight,
  processStartIdentity,
} from './runtime-release.js';
import { deliverWake, wakeQueueStatus } from './wakeup.js';
import { validateRepositoryMapping } from './opsled-registry.js';

export const OPSLED_WAKE_RESULT_SCHEMA = 'opsle.durable-supervisor.opsled-wake-result/v1';

export function assertOpsledRepositoryAccess(mapping, releaseFence, {
  processIdentity = processStartIdentity(),
} = {}) {
  validateRepositoryMapping(mapping, mapping.repository_id);
  assertReleaseFence(releaseFence, { role: 'opsled-worker', processIdentity });
  compatibilityPreflight(mapping.repository_realpath, { operation: 'read' });
  return true;
}

function requestFiles(root) {
  const directory = join(paths(root).opsle, 'wake', 'requests');
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => join(directory, name));
}

export function dispatchRepositoryWakes(mapping, {
  releaseFence,
  processIdentity,
  serviceIdentity,
  nativeTransport = null,
  bindingDependencies = {},
  deliver = deliverWake,
} = {}) {
  assertOpsledRepositoryAccess(mapping, releaseFence, { processIdentity });
  if (typeof serviceIdentity?.service_id !== 'string'
      || !Number.isSafeInteger(serviceIdentity?.generation)) {
    throw new Error('opsled wake dispatch requires current service identity');
  }
  const root = mapping.repository_realpath;
  const results = [];
  for (const path of requestFiles(root)) {
    let request;
    try {
      request = readJson(path);
      results.push(deliver(root, request.event_id, {
        nativeTransport,
        bindingDependencies,
        expectedQueueVersion: request.queue_version,
        activationOwner: {
          schema: 'opsle.durable-supervisor.opsled-wake-owner/v1',
          kind: 'opsled',
          service_id: serviceIdentity.service_id,
          service_generation: serviceIdentity.generation,
          release_fence: releaseFence,
          process: processIdentity,
        },
      }));
    } catch (error) {
      results.push({
        classification: error.classification ?? 'error',
        reason: error.message,
        event_id: request?.event_id ?? null,
        delivered: false,
      });
    }
  }
  return {
    schema: OPSLED_WAKE_RESULT_SCHEMA,
    repository_id: mapping.repository_id,
    repository_realpath: root,
    scanned: results.length,
    delivered: results.filter((item) => item.delivered === true).length,
    results,
  };
}

export function repositoryWakeSummary(mapping, {
  releaseFence,
  processIdentity,
  bindingDependencies = {},
} = {}) {
  assertOpsledRepositoryAccess(mapping, releaseFence, { processIdentity });
  const status = wakeQueueStatus(mapping.repository_realpath, { bindingDependencies });
  const pending = status.requests.filter((item) => !['duplicate', 'obsolete'].includes(item.classification));
  return {
    repository_id: mapping.repository_id,
    queued: pending.filter((item) => item.classification === 'queued').length,
    ready: pending.filter((item) => item.classification === 'native-ready').length,
    awaiting_consumption: pending.filter((item) => item.classification === 'awaiting-consumption').length,
    session: status.session_binding.classification,
    requests: status.requests,
  };
}
