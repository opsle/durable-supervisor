#!/usr/bin/env node

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createReleaseFence,
  assertReleaseFence,
  completeRuntimeReleaseManifest,
  loadRuntimeRelease,
} from '../src/runtime-release.js';
import {
  defaultOpsledHome,
  opsledStatus,
  renderOpsledStatus,
  startOpsled,
  stopOpsled,
} from '../src/opsled.js';
import {
  registerRepository,
  unregisterRepository,
} from '../src/opsled-registry.js';
import { upgradeHostRuntime } from '../src/runtime-upgrade.js';

function valueAfter(args, flag, fallback = null) {
  const index = args.indexOf(flag);
  return index < 0 ? fallback : args[index + 1];
}

function usage() {
  return `usage: opsled COMMAND

commands:
  register [REPOSITORY]
  unregister [REPOSITORY]
  start [--interval-ms MS]
  stop
  upgrade --release PATH
  status [--verbose|--json]
`;
}

function print(value) {
  process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
}

function renderError(error) {
  const prefix = error.classification && !String(error.message).startsWith(`${error.classification}:`)
    ? `${error.classification}: `
    : '';
  return `opsled: ${prefix}${error.message}\n`;
}

export async function main(args, {
  home = defaultOpsledHome(),
  output = print,
  upgradeOptions = {},
} = {}) {
  const command = args[0];
  if (command === '--complete-release-manifest') {
    completeRuntimeReleaseManifest();
    return;
  }
  loadRuntimeRelease();
  if (!command || command === 'help' || command === '--help') {
    output(usage());
    return;
  }
  if (args.includes('--home')) throw new Error('--home is not supported; opsled host authority is caller-independent');
  if (command === 'status') {
    const verbose = args.includes('--verbose');
    if (verbose && args.includes('--json')) throw new Error('choose only one of --verbose or --json');
    const status = opsledStatus(home, { verbose });
    output(args.includes('--json') ? status : renderOpsledStatus(status, { verbose }));
    return;
  }
  if (command === 'start') {
    const rawInterval = valueAfter(args, '--interval-ms', '1000');
    if (!/^\d+$/.test(rawInterval) || Number(rawInterval) < 10) {
      throw new Error('--interval-ms must be an integer of at least 10');
    }
    output(await startOpsled(home, { intervalMs: Number(rawInterval) }));
    return;
  }
  if (command === 'stop') {
    output(stopOpsled(home));
    return;
  }
  if (command === 'upgrade') {
    const release = valueAfter(args, '--release');
    if (!release) throw new Error('upgrade requires --release PATH');
    const result = await upgradeHostRuntime(home, release, upgradeOptions);
    const attention = result.repositories.filter((entry) => entry.status === 'ATTENTION').length;
    output(args.includes('--json') ? result : [
      `Upgraded opsled to ${result.target.runtime_release_id}.`,
      `Repositories: ${result.repositories.length}.`,
      `Healthy: ${result.repositories.length - attention}.`,
      `Attention: ${attention}.`,
    ].join('\n'));
    return;
  }
  if (command === 'register' || command === 'unregister') {
    const operationFence = createReleaseFence('opsled');
    assertReleaseFence(operationFence, { role: 'opsled' });
    const repository = resolve(args[1] && !args[1].startsWith('--') ? args[1] : process.cwd());
    output(command === 'register'
      ? registerRepository(home, repository)
      : unregisterRepository(home, repository));
    return;
  }
  throw new Error(`unknown opsled command: ${command}`);
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (import.meta.url === entrypoint) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(renderError(error));
    process.exitCode = 1;
  });
}
