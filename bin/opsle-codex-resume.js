#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCodexResumeTransport } from '../src/codex-resume-transport.js';
import { readJson, writeJson } from '../src/io.js';
import {
  commitConfirmedWakeReceipt,
  updateCommittedWakeCleanup,
} from '../src/wakeup.js';
import {
  assertReleaseFence,
  compatibilityPreflight,
  createReleaseFence,
  loadRuntimeRelease,
  releaseIdentity,
  sameReleaseIdentity,
} from '../src/runtime-release.js';

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index < 0 ? null : args[index + 1];
}

export async function resumeHelperResult(args, {
  runTransport = runCodexResumeTransport,
  readEvidence = readJson,
  writeEvidence = writeJson,
  commitReceipt = commitConfirmedWakeReceipt,
  updateCleanup = updateCommittedWakeCleanup,
} = {}) {
  const sessionId = valueAfter(args, '--session');
  const message = valueAfter(args, '--message');
  const rolloutPath = valueAfter(args, '--rollout');
  const hostPid = Number(valueAfter(args, '--host-pid'));
  const hostStart = valueAfter(args, '--host-start');
  const hostExecutable = valueAfter(args, '--host-executable');
  const evidencePath = valueAfter(args, '--evidence');
  if (!sessionId || !message || !rolloutPath || !Number.isSafeInteger(hostPid)
      || hostPid <= 0 || !hostStart || !hostExecutable) {
    return {
      exitCode: 2,
      stdout: '',
      stderr: 'Codex resume delivery requires session, rollout, and exact host identity\n',
    };
  }
  try {
    const attemptEvidence = evidencePath ? readEvidence(evidencePath) : null;
    const repositoryRoot = attemptEvidence?.repository_realpath ?? null;
    loadRuntimeRelease();
    if (repositoryRoot) compatibilityPreflight(repositoryRoot, { operation: 'read' });
    if (attemptEvidence?.helper?.expected_release) {
      const expected = releaseIdentity('codex-resume');
      if (!sameReleaseIdentity(attemptEvidence.helper.expected_release, expected)) {
        throw new Error('runtime release fence mismatch');
      }
      attemptEvidence.helper.release_fence = createReleaseFence('codex-resume');
      assertReleaseFence(attemptEvidence.helper.release_fence, { role: 'codex-resume' });
      writeEvidence(evidencePath, attemptEvidence);
    }
    const result = await runTransport({
      sessionId,
      message,
      rolloutPath,
      attemptEvidence,
      checkpointEvidence: evidencePath ? (evidence) => writeEvidence(evidencePath, evidence) : null,
      commitConfirmation: evidencePath && repositoryRoot
        ? (evidence) => commitReceipt(
          repositoryRoot,
          evidencePath,
          evidence.rollout_confirmation,
        )
        : null,
      completeCommittedDelivery: evidencePath && repositoryRoot
        ? (evidence) => updateCleanup(repositoryRoot, evidencePath, evidence)
        : null,
      inspectExecutable: attemptEvidence ? () => attemptEvidence.transport?.resolved_executable ?? {
        requested: 'codex', resolved: null, version: null, version_error: 'parent-evidence-missing',
      } : undefined,
      authoritativeHostProcess: {
        pid: hostPid,
        start_time_ticks: hostStart,
        executable: hostExecutable,
      },
    });
    return { exitCode: 0, stdout: `${JSON.stringify(result)}\n`, stderr: '' };
  } catch (error) {
    if (evidencePath) try {
      const evidence = readEvidence(evidencePath);
      evidence.helper_failure = error.message;
      evidence.helper_failed_at = new Date().toISOString();
      evidence.confirmation_absence ??= 'helper-failed-without-confirmation';
      writeEvidence(evidencePath, evidence);
    } catch {
      // The caller retains its pre-spawn attempt record if helper journaling fails.
    }
    return {
      exitCode: 1,
      stdout: `${JSON.stringify({
        classification: 'uncertain',
        reason: `resume-helper-failed-after-launch-possible: ${error.message}`,
      })}\n`,
      stderr: '',
    };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await resumeHelperResult(process.argv.slice(2));
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.stdout) process.stdout.write(result.stdout);
  process.exitCode = result.exitCode;
}
