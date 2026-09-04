#!/usr/bin/env node

import { runWakeDispatcher } from '../src/wakeup.js';
import { loadRuntimeRelease } from '../src/runtime-release.js';

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
}

const args = process.argv.slice(2);
const root = valueAfter(args, '--root');
const dispatcherId = valueAfter(args, '--dispatcher');
const dispatcherGeneration = Number(valueAfter(args, '--dispatcher-generation'));
const launchNonce = valueAfter(args, '--launch-nonce');

if (!root || !dispatcherId || !launchNonce || !Number.isSafeInteger(dispatcherGeneration)) {
  process.stderr.write('wake dispatcher requires root, dispatcher identity, generation, and launch nonce\n');
  process.exitCode = 1;
} else {
  loadRuntimeRelease();
  runWakeDispatcher(root, {
    dispatcherId,
    dispatcherGeneration,
    launchNonce,
  }).catch((error) => {
    process.stderr.write(`wake dispatcher: ${error.message}\n`);
    process.exitCode = 1;
  });
}
