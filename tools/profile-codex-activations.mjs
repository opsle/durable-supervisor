#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { profileCodexActivations } from '../src/activation-telemetry.js';

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
}

const args = process.argv.slice(2);
const trajectory = valueAfter(args, '--trajectory');
const start = valueAfter(args, '--start');
const end = valueAfter(args, '--end');
const taskId = valueAfter(args, '--task');
const attemptId = valueAfter(args, '--attempt');
if (!trajectory || !start || !end) {
  throw new Error('usage: profile-codex-activations --trajectory FILE --start ISO --end ISO [--task ID --attempt ID]');
}
const trajectoryBytes = readFileSync(trajectory);
const records = trajectoryBytes.toString('utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));
process.stdout.write(`${JSON.stringify(profileCodexActivations(records, {
  start,
  end,
  taskId,
  attemptId,
  trajectoryEvidence: {
    path: trajectory,
    sha256: createHash('sha256').update(trajectoryBytes).digest('hex'),
  },
}), null, 2)}\n`);
