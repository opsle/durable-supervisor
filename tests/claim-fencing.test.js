import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { recover } from '../src/cli.js';
import { readJson, writeJson } from '../src/io.js';
import {
  acquireClaim,
  createAttempt,
  createTask,
  releaseClaim,
  routeTask,
} from '../src/pipeline.js';
import { initialize, paths } from '../src/state.js';

const sourceRoot = resolve(new URL('..', import.meta.url).pathname);
const pipelineUrl = new URL('../src/pipeline.js', import.meta.url).href;
const childScript = `
import { acquireClaim, releaseClaim } from ${JSON.stringify(pipelineUrl)};
const input = JSON.parse(process.env.OPSLE_CLAIM_TEST_INPUT);
process.send({ type: 'ready' });
process.once('message', (message) => {
  if (message !== 'go') throw new Error('missing race start signal');
  try {
    const value = input.action === 'acquire'
      ? acquireClaim(input.root, input.task, input.attempt_id)
      : releaseClaim(input.root, input.claim, input.status);
    process.send({ type: 'result', ok: true, value });
  } catch (error) {
    process.send({ type: 'result', ok: false, error: error.message });
  } finally {
    process.disconnect();
  }
});
`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'durable-supervisor-claim-fencing-'));
  mkdirSync(join(root, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(root, '.git', 'refs', 'heads', 'main'), `${'7'.repeat(40)}\n`);
  writeFileSync(join(root, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');
  writeFileSync(join(root, 'README.md'), '# claim fencing fixture\n');
  mkdirSync(join(root, '.opsle'));
  cpSync(join(sourceRoot, '.opsle', 'specification.md'), join(root, '.opsle', 'specification.md'));
  cpSync(join(sourceRoot, '.opsle', 'requirements.json'), join(root, '.opsle', 'requirements.json'));
  initialize(root, { actor: 'claim-fencing-test', objectiveText: 'Exercise claim fencing.' });
  return root;
}

function claimTask(root, taskId) {
  return createTask(root, handoff(taskId));
}

function indexedClaim(root, taskId) {
  return readJson(join(paths(root).claims, 'index.json'))[`task-${taskId}`];
}

function authoritativeSummary(root, taskId) {
  const index = readJson(join(paths(root).claims, 'index.json'));
  const active = Object.entries(index)
    .filter(([key, claim]) => key.startsWith('task-')
      && claim.task_id === taskId
      && claim.status === 'ACTIVE')
    .map(([, claim]) => claim);
  return {
    active_claim_ids: active.map((claim) => claim.claim_id),
    duplicate_active_claims: active.length > 1,
  };
}

function startRacer(input) {
  const env = { ...process.env, OPSLE_CLAIM_TEST_INPUT: JSON.stringify(input) };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', childScript], {
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const ready = new Promise((resolveReady, rejectReady) => {
    child.once('error', rejectReady);
    child.on('message', (message) => {
      if (message.type === 'ready') resolveReady();
    });
    child.once('exit', (code) => {
      if (code !== 0) rejectReady(new Error(`claim racer exited ${code}: ${stderr}`));
    });
  });
  const result = new Promise((resolveResult, rejectResult) => {
    child.once('error', rejectResult);
    child.on('message', (message) => {
      if (message.type === 'result') resolveResult(message);
    });
    child.once('exit', (code) => {
      if (code !== 0) rejectResult(new Error(`claim racer exited ${code}: ${stderr}`));
    });
  });
  return { child, ready, result };
}

async function race(inputs) {
  const racers = inputs.map(startRacer);
  await Promise.all(racers.map((racer) => racer.ready));
  racers.forEach((racer) => racer.child.send('go'));
  return Promise.all(racers.map((racer) => racer.result));
}

function handoff(taskId) {
  return {
    task_id: taskId,
    title: 'Exercise recovery with an exact fenced claim',
    objective: 'Preserve the exact current claim during recovery.',
    scope: ['README.md'],
    authorization: {
      may: ['inspect fixture'],
      may_modify: [],
      may_not: ['invoke a provider'],
    },
    required_inputs: [],
    relevant_context: [],
    expected_deliverable: 'No repository artifact changes',
    expected_evidence: ['exact claim ID and fence'],
    acceptance_criteria: ['current claim remains active'],
    prohibited_actions: ['provider invocation'],
    requirement_ids: [],
    route_hint: 'deterministic',
    deterministic_command: [process.execPath, '-e', 'process.exit(0)'],
    verification_command: null,
    expects_changes: false,
  };
}

test('stale and exact idempotent release cannot replace a newer authoritative claim', () => {
  const root = fixture();
  try {
    const task = claimTask(root, 'task-stale-release');
    const first = acquireClaim(root, task, 'attempt-001');
    const firstReleased = releaseClaim(root, first, 'FAILED');
    const firstHistoryBeforeReplay = readFileSync(join(paths(root).claims, `${first.claim_id}.json`));
    const second = acquireClaim(root, task, 'attempt-002');
    const indexBeforeReplay = readFileSync(join(paths(root).claims, 'index.json'));
    const secondHistoryBeforeReplay = readFileSync(join(paths(root).claims, `${second.claim_id}.json`));

    const replayed = releaseClaim(root, first, 'FAILED');

    assert.deepEqual(replayed, firstReleased);
    assert.deepEqual(readFileSync(join(paths(root).claims, 'index.json')), indexBeforeReplay);
    assert.deepEqual(readFileSync(join(paths(root).claims, `${first.claim_id}.json`)), firstHistoryBeforeReplay);
    assert.deepEqual(readFileSync(join(paths(root).claims, `${second.claim_id}.json`)), secondHistoryBeforeReplay);
    assert.equal(indexedClaim(root, task.task_id).claim_id, second.claim_id);
    assert.equal(indexedClaim(root, task.task_id).fence_generation, second.fence_generation);
    assert.equal(indexedClaim(root, task.task_id).status, 'ACTIVE');
    assert.throws(() => acquireClaim(root, task, 'attempt-003'), /claim conflict/);
    assert.deepEqual(authoritativeSummary(root, task.task_id), {
      active_claim_ids: [second.claim_id],
      duplicate_active_claims: false,
    });
    assert.ok(second.fence_generation > first.fence_generation);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('release with the exact claim ID but wrong fence fails without mutation', () => {
  const root = fixture();
  try {
    const task = claimTask(root, 'task-wrong-fence');
    const claim = acquireClaim(root, task, 'attempt-001');
    const historyBefore = readFileSync(join(paths(root).claims, `${claim.claim_id}.json`));
    const indexBefore = readFileSync(join(paths(root).claims, 'index.json'));

    assert.throws(() => releaseClaim(root, {
      ...claim,
      fence_generation: claim.fence_generation + 1,
    }, 'FAILED'), /stale claim fence/);

    assert.deepEqual(readFileSync(join(paths(root).claims, `${claim.claim_id}.json`)), historyBefore);
    assert.deepEqual(readFileSync(join(paths(root).claims, 'index.json')), indexBefore);
    assert.equal(indexedClaim(root, task.task_id).status, 'ACTIVE');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('competing acquisitions yield one ACTIVE authority and duplicate_active_claims=false', async () => {
  const root = fixture();
  try {
    const task = claimTask(root, 'task-competing-acquire');
    const results = await race([
      { action: 'acquire', root, task, attempt_id: 'attempt-a' },
      { action: 'acquire', root, task, attempt_id: 'attempt-b' },
    ]);
    const acquired = results.filter((result) => result.ok);
    const rejected = results.filter((result) => !result.ok);

    assert.equal(acquired.length, 1, JSON.stringify(results));
    assert.equal(rejected.length, 1, JSON.stringify(results));
    assert.ok(
      rejected[0].error.startsWith('claim conflict: ')
        || rejected[0].error === 'claim index contention did not resolve',
      rejected[0].error,
    );
    assert.equal(indexedClaim(root, task.task_id).claim_id, acquired[0].value.claim_id);
    assert.deepEqual(authoritativeSummary(root, task.task_id), {
      active_claim_ids: [acquired[0].value.claim_id],
      duplicate_active_claims: false,
    });
    const index = readJson(join(paths(root).claims, 'index.json'));
    assert.equal(index.next_fence, acquired[0].value.fence_generation + 1);
    assert.equal(readdirSync(paths(root).claims).filter((name) => name.startsWith('claim-')).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('release/acquire interleaving cannot create duplicate authority or restore stale ownership', async () => {
  const root = fixture();
  try {
    const task = claimTask(root, 'task-release-acquire-race');
    const first = acquireClaim(root, task, 'attempt-001');
    const [released, competing] = await race([
      { action: 'release', root, claim: first, status: 'FAILED' },
      { action: 'acquire', root, task, attempt_id: 'attempt-002' },
    ]);
    assert.equal(released.ok, true, JSON.stringify(released));
    let second;
    if (competing.ok) {
      second = competing.value;
    } else {
      assert.match(competing.error, /claim conflict/);
      second = acquireClaim(root, task, 'attempt-002-after-release');
    }

    assert.ok(second.fence_generation > first.fence_generation);
    assert.equal(indexedClaim(root, task.task_id).claim_id, second.claim_id);
    assert.equal(indexedClaim(root, task.task_id).status, 'ACTIVE');
    const indexBeforeReplay = readFileSync(join(paths(root).claims, 'index.json'));
    const firstHistoryBeforeReplay = readFileSync(join(paths(root).claims, `${first.claim_id}.json`));
    releaseClaim(root, first, 'FAILED');
    assert.deepEqual(readFileSync(join(paths(root).claims, 'index.json')), indexBeforeReplay);
    assert.deepEqual(readFileSync(join(paths(root).claims, `${first.claim_id}.json`)), firstHistoryBeforeReplay);
    assert.throws(() => acquireClaim(root, task, 'attempt-003'), /claim conflict/);
    assert.equal(authoritativeSummary(root, task.task_id).duplicate_active_claims, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recovery preserves the exact newer claim and fence after stale release replay', () => {
  const root = fixture();
  try {
    const task = createTask(root, handoff('task-claim-recovery'));
    const decision = routeTask(root, task);
    const first = createAttempt(root, task, decision);
    releaseClaim(root, first.claim, 'FAILED');
    const second = createAttempt(root, task, decision);
    second.attempt.child_state = 'RUNNING';
    second.attempt.pid = 424242;
    writeJson(join(paths(root).attempts, `${second.attempt.attempt_id}.json`), second.attempt);
    releaseClaim(root, first.claim, 'FAILED');
    const indexBeforeRecovery = readFileSync(join(paths(root).claims, 'index.json'));

    const recovered = recover(root, {
      isProcessAlive: (pid) => pid === second.attempt.pid,
      startWakeDispatcher: () => ({ started: false, reason: 'fixture-disabled' }),
    });

    assert.equal(recovered.reconciliation.classification, 'known_running');
    assert.equal(recovered.reconciliation.action, 'preserve_claim_and_wait');
    assert.deepEqual(readFileSync(join(paths(root).claims, 'index.json')), indexBeforeRecovery);
    assert.equal(indexedClaim(root, task.task_id).claim_id, second.claim.claim_id);
    assert.equal(indexedClaim(root, task.task_id).fence_generation, second.claim.fence_generation);
    assert.equal(readJson(join(paths(root).claims, `${first.claim.claim_id}.json`)).status, 'FAILED');
    assert.equal(readJson(join(paths(root).claims, `${second.claim.claim_id}.json`)).status, 'ACTIVE');
    assert.equal(authoritativeSummary(root, task.task_id).duplicate_active_claims, false);
    assert.ok(second.claim.fence_generation > first.claim.fence_generation);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
