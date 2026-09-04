#!/usr/bin/env node

import { resolve } from 'node:path';
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

function valueAfter(args, flag, fallback = null) {
  const index = args.indexOf(flag);
  return index < 0 ? fallback : args[index + 1];
}

function usage() {
  return `usage: opsled COMMAND [--home PATH]

commands:
  register [REPOSITORY]
  unregister [REPOSITORY]
  start [--interval-ms MS]
  stop
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

async function main(args) {
  const command = args[0];
  if (command === '--complete-release-manifest') {
    completeRuntimeReleaseManifest();
    return;
  }
  loadRuntimeRelease();
  if (!command || command === 'help' || command === '--help') {
    print(usage());
    return;
  }
  const home = defaultOpsledHome({ ...process.env, OPSLED_HOME: valueAfter(args, '--home', process.env.OPSLED_HOME) });
  if (command === 'status') {
    const verbose = args.includes('--verbose');
    if (verbose && args.includes('--json')) throw new Error('choose only one of --verbose or --json');
    const status = opsledStatus(home, { verbose });
    print(args.includes('--json') ? status : renderOpsledStatus(status, { verbose }));
    return;
  }
  if (command === 'start') {
    const rawInterval = valueAfter(args, '--interval-ms', '1000');
    if (!/^\d+$/.test(rawInterval) || Number(rawInterval) < 10) {
      throw new Error('--interval-ms must be an integer of at least 10');
    }
    print(await startOpsled(home, { intervalMs: Number(rawInterval) }));
    return;
  }
  if (command === 'stop') {
    print(stopOpsled(home));
    return;
  }
  if (command === 'register' || command === 'unregister') {
    const operationFence = createReleaseFence('opsled');
    assertReleaseFence(operationFence, { role: 'opsled' });
    const repository = resolve(args[1] && !args[1].startsWith('--') ? args[1] : process.cwd());
    print(command === 'register'
      ? registerRepository(home, repository)
      : unregisterRepository(home, repository));
    return;
  }
  throw new Error(`unknown opsled command: ${command}`);
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(renderError(error));
  process.exitCode = 1;
});
