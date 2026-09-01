#!/usr/bin/env node
import { runCodexResumeTransport } from '../src/codex-resume-transport.js';

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index < 0 ? null : args[index + 1];
}

const args = process.argv.slice(2);
const sessionId = valueAfter(args, '--session');
const message = valueAfter(args, '--message');
const rolloutPath = valueAfter(args, '--rollout');
const hostPid = Number(valueAfter(args, '--host-pid'));
const hostStart = valueAfter(args, '--host-start');
const hostExecutable = valueAfter(args, '--host-executable');
if (!sessionId || !message || !rolloutPath || !Number.isSafeInteger(hostPid)
    || hostPid <= 0 || !hostStart || !hostExecutable) {
  process.stderr.write('Codex resume delivery requires session, rollout, and exact host identity\n');
  process.exitCode = 2;
} else {
  try {
    process.stdout.write(`${JSON.stringify(await runCodexResumeTransport({
      sessionId,
      message,
      rolloutPath,
      authoritativeHostProcess: {
        pid: hostPid,
        start_time_ticks: hostStart,
        executable: hostExecutable,
      },
    }))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      classification: 'uncertain',
      reason: `resume-helper-failed-after-launch-possible: ${error.message}`,
    })}\n`);
    process.exitCode = 1;
  }
}
