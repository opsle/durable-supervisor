import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { evaluateTask } from '../../src/cli.js';

const [root, taskId, readyPath, gatePath, resultPath, workerId] = process.argv.slice(2);
const rationale = `atomic evaluation worker ${workerId}: ${'x'.repeat(4 * 1024 * 1024)}`;

writeFileSync(readyPath, `${process.pid}\n`);
while (!existsSync(gatePath)) await sleep(2);

try {
  const result = evaluateTask(root, taskId, true, rationale);
  writeFileSync(resultPath, `${JSON.stringify({
    idempotent: result.idempotent === true,
    decision_id: result.decision?.decision_id ?? result.attempt?.supervisor_evaluation?.decision_id ?? null,
  })}\n`);
} catch (error) {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
}
