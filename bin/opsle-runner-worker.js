#!/usr/bin/env node

import { runDetachedWorker } from '../src/runner.js';

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
}

const args = process.argv.slice(2);
const root = valueAfter(args, '--root');
const attemptId = valueAfter(args, '--attempt');
const launchNonce = valueAfter(args, '--launch-nonce');

if (!root || !attemptId || !launchNonce) {
  process.stderr.write('detached Runner requires --root, --attempt, and --launch-nonce\n');
  process.exitCode = 1;
} else {
  runDetachedWorker(root, attemptId, launchNonce).catch((error) => {
    process.stderr.write(`detached Runner: ${error.message}\n`);
    process.exitCode = 1;
  });
}
