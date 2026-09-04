import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  closeSync, cpSync, existsSync, mkdtempSync, mkdirSync, openSync, readFileSync,
  readdirSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileSha256, readJson, writeJson } from '../src/io.js';
import {
  acquireClaim, createAttempt, createTask, releaseClaim, routeTask,
} from '../src/pipeline.js';
import { generateResumePacket } from '../src/reconstruction.js';
import { runAttempt } from '../src/runner.js';
import {
  effectiveRequirementMatrix, emit, initialize,
  derivePendingNextAction, NEXT_UNSATISFIED_REQUIREMENT_ACTION, paths, setRequirements,
  unsatisfiedRequirements, updateState, validateDurableState,
} from '../src/state.js';
import { recover } from '../src/cli.js';
import { renderWakeStatus } from '../src/operator-display.js';
import {
  adoptCodexSessionBinding, applyWakeEvent, bindCodexSession, consumeWakeDelivery,
  deliverWake, enqueueTerminalWake, processIdentity, registerWait,
  WAKE_DISPATCHER_IMPLEMENTATION_SHA256, wakeQueueStatus,
} from '../src/wakeup.js';

const sourceRoot = resolve(new URL('..', import.meta.url).pathname);
const cliPath = join(sourceRoot, 'bin', 'opsle.js');

function repository({ requirements = 'none', legacy = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'durable-supervisor-invariant-'));
  mkdirSync(join(root, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(root, '.git', 'refs', 'heads', 'main'), `${'6'.repeat(40)}\n`);
  writeFileSync(join(root, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');
  writeFileSync(join(root, 'README.md'), '# invariant fixture\n');
  if (requirements !== 'none') {
    mkdirSync(join(root, '.opsle'), { recursive: true });
    if (requirements === 'durable-supervisor') {
      cpSync(join(sourceRoot, '.opsle', 'specification.md'), join(root, '.opsle', 'specification.md'));
      cpSync(join(sourceRoot, '.opsle', 'requirements.json'), join(root, '.opsle', 'requirements.json'));
    } else {
      const specification = join(root, '.opsle', 'specification.md');
      writeFileSync(specification, '# Fixture requirements\n');
      writeJson(join(root, '.opsle', 'requirements.json'), {
        schema: 'opsle.durable-supervisor.requirements/v1',
        specification: '.opsle/specification.md',
        specification_sha256: fileSha256(specification),
        allowed_states: ['UNSTARTED', 'IMPLEMENTED', 'VERIFIED'],
        requirements: [{
          id: 'FIXTURE-001', title: 'Fixture requirement', state: 'UNSTARTED', evidence: [],
        }],
      });
    }
  }
  initialize(root, { actor: 'invariant-test', objectiveText: 'Exercise invariant harnesses.' });
  if (legacy) {
    const bootstrap = readJson(paths(root).bootstrap);
    bootstrap.requirements = { mode: 'none', path: null, specification_path: null };
    writeJson(paths(root).bootstrap, bootstrap);
  }
  return root;
}

function runCli(root, args) {
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const capture = mkdtempSync(join(tmpdir(), 'durable-supervisor-invariant-cli-'));
  const stdoutPath = join(capture, 'stdout.log');
  const stderrPath = join(capture, 'stderr.log');
  const stdout = openSync(stdoutPath, 'w');
  const stderr = openSync(stderrPath, 'w');
  try {
    const result = spawnSync(process.execPath, [cliPath, ...args], {
      cwd: root, env: environment, stdio: ['ignore', stdout, stderr],
    });
    closeSync(stdout);
    closeSync(stderr);
    return {
      ...result,
      stdout: readFileSync(stdoutPath, 'utf8'),
      stderr: readFileSync(stderrPath, 'utf8'),
    };
  } finally {
    try { closeSync(stdout); } catch { /* already closed */ }
    try { closeSync(stderr); } catch { /* already closed */ }
    rmSync(capture, { recursive: true, force: true });
  }
}

function handoff(taskId, requirementIds = []) {
  return {
    task_id: taskId,
    title: 'Invariant fixture task',
    objective: 'Prove canonical requirement handling.',
    scope: ['fixture.txt'],
    authorization: {
      may: ['run deterministic fixture'], may_modify: ['fixture.txt'], may_not: ['deploy'],
    },
    expected_deliverable: 'fixture result',
    expected_evidence: ['exit status'],
    acceptance_criteria: ['exit code 0'],
    prohibited_actions: ['deploy'],
    requirement_ids: requirementIds,
    deterministic_command: [process.execPath, '-e', ''],
    verification_command: null,
    expects_changes: false,
  };
}

function fileBytes(root) {
  const result = {};
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const info = statSync(path);
      if (info.isDirectory()) visit(path);
      else if (info.isFile()) result[relative(root, path)] = readFileSync(path).toString('base64');
    }
  };
  visit(root);
  return result;
}

function assertProtectedRejection(root, invoke) {
  const before = fileBytes(join(root, '.opsle'));
  let rejected = false;
  try { invoke(); } catch { rejected = true; }
  assert.equal(rejected, true, 'protected ownership operation accepted a mismatched owner');
  assert.deepEqual(
    fileBytes(join(root, '.opsle')),
    before,
    'protected ownership rejection changed durable bytes',
  );
}

function assertOwnershipVector({ name, cases, setup, invoke, verifyRejected }) {
  for (const [dimension, mutate] of cases) {
    const context = setup(dimension);
    try {
      mutate(context);
      verifyRejected(context, () => invoke(context), `${name}: ${dimension}`);
    } finally {
      rmSync(context.root, { recursive: true, force: true });
    }
  }
}

async function assertPolicyEffect({ snapshot, toggle, probe }) {
  const beforeBehavior = await probe();
  const beforeBytes = snapshot();
  try {
    await toggle();
  } catch {
    assert.deepEqual(snapshot(), beforeBytes, 'unsupported policy toggle mutated durable state');
    return 'unsupported-rejected';
  }
  const afterBehavior = await probe();
  assert.notDeepEqual(afterBehavior, beforeBehavior, 'policy toggle changed metadata without behavior');
  return 'behavior-changed';
}

function claimIndexInvariant(root) {
  const indexPath = join(paths(root).claims, 'index.json');
  if (!existsSync(indexPath)) return { schema: 'opsle.durable-supervisor.claim-index/v1', next_fence: 1 };
  const index = readJson(indexPath);
  const activeByTask = new Map();
  for (const [key, claim] of Object.entries(index).filter(([key]) => key.startsWith('task-'))) {
    if (claim.status !== 'ACTIVE') continue;
    assert.equal(activeByTask.has(claim.task_id), false, `duplicate active claim for ${claim.task_id}`);
    activeByTask.set(claim.task_id, claim.claim_id);
    assert.equal(key, `task-${claim.task_id}`);
    assert.ok(index.next_fence > claim.fence_generation, 'claim index fence did not advance');
  }
  return index;
}

function assertGlobalInvariants(root, supervisorId) {
  assert.deepEqual(validateDurableState(root), { valid: true, errors: [] });
  const supervisor = readJson(paths(root).supervisor);
  assert.equal(supervisor.supervisor_id, supervisorId);
  assert.ok(Number.isSafeInteger(supervisor.generation) && supervisor.generation > 0);
  const state = readJson(paths(root).state);
  assert.equal(state.supervisor_state === 'PAUSED', state.pause.active === true);
  claimIndexInvariant(root);
  const consumptionDirectory = join(root, '.opsle', 'wake', 'consumptions');
  if (existsSync(consumptionDirectory)) {
    const eventIds = readdirSync(consumptionDirectory)
      .filter((name) => name.endsWith('.json'))
      .map((name) => readJson(join(consumptionDirectory, name)).event_id);
    assert.equal(new Set(eventIds).size, eventIds.length, 'duplicate wake consumption authority');
  }
}

function stageBinding(root, suffix = 'one') {
  const sessionId = suffix === 'one'
    ? '01a05952-e1fa-71e2-adea-df7e3f7d99ce'
    : '01a05952-e1fa-71e2-adea-df7e3f7d99cf';
  const sessionsRoot = join(root, `codex-sessions-${suffix}`);
  mkdirSync(sessionsRoot, { recursive: true });
  const rolloutPath = join(sessionsRoot, `rollout-${suffix}.jsonl`);
  writeFileSync(rolloutPath, `${JSON.stringify({
    timestamp: '2026-09-03T00:00:00.000Z',
    type: 'session_meta',
    payload: { id: sessionId, cwd: root },
  })}\n`);
  const process = {
    pid: suffix === 'one' ? 700 : 701,
    start_time_ticks: suffix === 'one' ? '7000' : '7010',
    executable: '/opt/codex',
    uid: 1000,
    tty: '/dev/pts/7',
    command_line_sha256: 'a'.repeat(64),
  };
  const host = {
    workspace_id: `workspace-${suffix}`,
    workspace_cwd: root,
    pane_id: `pane-${suffix}`,
    terminal_id: `terminal-${suffix}`,
  };
  const snapshot = () => ({
    type: 'session_snapshot',
    snapshot: {
      version: '1.2.3', protocol: 20,
      workspaces: [{ workspace_id: host.workspace_id, worktree: { checkout_path: root, repo_root: root } }],
      panes: [{
        workspace_id: host.workspace_id,
        pane_id: host.pane_id,
        terminal_id: host.terminal_id,
        cwd: root,
        foreground_cwd: root,
        agent: 'codex',
        agent_session: { source: 'integration', agent: 'codex', kind: 'id', value: sessionId },
      }],
      agents: [], tabs: [], layouts: [],
    },
  });
  const dependencies = {
    processIdentity: (pid) => (pid === process.pid ? structuredClone(process) : null),
    codexVersion: () => 'codex-cli 0.152.0',
    uid: () => 1000,
    legacyTmuxAuthority: () => false,
    environment: () => ({
      CODEX_SESSION_ID: sessionId,
      CODEX_THREAD_ID: sessionId,
      CODEX_HOME: root,
    }),
    sessionsRoot: () => sessionsRoot,
    herdrSnapshot: snapshot,
    herdrPaneProcessInfo: () => ({
      type: 'pane_process_info',
      process_info: {
        pane_id: host.pane_id,
        tty: process.tty,
        foreground_processes: [{ pid: process.pid, name: 'codex', cwd: root }],
      },
    }),
  };
  const result = bindCodexSession(root, {
    sessionId, rolloutPath, sessionsRoot, hostPid: process.pid,
    workspaceId: host.workspace_id, workspaceCwd: root,
    paneId: host.pane_id, terminalId: host.terminal_id,
  }, { dependencies });
  return { ...result, sessionId, dependencies };
}

function confirmedResume(sessionId, message) {
  return {
    classification: 'confirmed',
    cleanup_proven: true,
    authoritative_host_continuity_proven: true,
    argv: ['codex', 'resume', sessionId, message],
    process_group: 9000,
    launcher_exit_observed: true,
    frontend_exit_observed: true,
    tracked_process_groups: [9000],
    frontend_process_groups: [],
    signaled_process_groups: [9000],
    process_group_member_counts: [{ process_group: 9000, member_count: 0 }],
    process_group_member_count: 0,
    duplicate_frontend_count: 0,
    invalid_frontend_identity_count: 0,
    blocked_process_groups: [],
    authoritative_host_process_group: 10000,
    authoritative_host_signaled: false,
    accepted_ordinal: 10,
    accepted_record_sha256: 'a'.repeat(64),
    turn_began_ordinal: 11,
    turn_began_record_sha256: 'b'.repeat(64),
    turn_id: 'turn-invariant',
    turn_started_at_ms: 1,
  };
}

function stageDispatcher(root) {
  const supervisor = readJson(paths(root).supervisor);
  const owner = processIdentity(process.pid);
  const dispatcher = {
    schema: 'opsle.durable-supervisor.host-wake-dispatcher/v1',
    dispatcher_id: 'dispatcher-invariant',
    dispatcher_generation: 1,
    implementation_sha256: WAKE_DISPATCHER_IMPLEMENTATION_SHA256,
    supervisor_id: supervisor.supervisor_id,
    supervisor_generation: supervisor.generation,
    queue_generation: supervisor.generation,
    process: owner,
    status: 'OWNED',
  };
  writeJson(join(root, '.opsle', 'wake', 'dispatcher.json'), dispatcher);
  return dispatcher;
}

function stageDeliveredWake(root) {
  const binding = stageBinding(root);
  const supervisor = readJson(paths(root).supervisor);
  const event = emit(root, 'CHILD_COMPLETION', {
    task_id: 'task-wake-invariant',
    attempt_id: 'attempt-wake-invariant',
    wait_id: 'attempt-wake-invariant',
    terminal_type: 'child-completed',
  });
  const request = enqueueTerminalWake(root, event);
  const dispatcher = stageDispatcher(root);
  const delivered = deliverWake(root, event.event_id, {
    bindingDependencies: binding.dependencies,
    dispatcher,
    nativeTransport: {
      kind: 'plain-codex-resume',
      resume: ({ session_id: sessionId, message }) => confirmedResume(sessionId, message),
    },
  });
  assert.equal(delivered.delivered, true);
  const receipt = delivered.receipt;
  const requestPath = join(root, '.opsle', 'wake', 'requests', `${event.event_id}.json`);
  const receiptPath = join(root, '.opsle', 'wake', 'deliveries', `${event.event_id}.json`);
  const decisionPath = join(root, '.opsle', 'wake', 'activation-decisions', `${event.event_id}.json`);
  const bindingPath = join(root, '.opsle', 'wake', 'codex-session-binding.json');
  return {
    root, event, request, receipt, requestPath, receiptPath, decisionPath,
    bindingPath, supervisor, binding, dispatcher,
  };
}

function stageEvaluableTask(root, task) {
  const attemptId = `${task.task_id}-attempt-evaluation`;
  task.attempts.push(attemptId);
  task.state = 'COMPLETED';
  writeJson(join(paths(root).tasks, `${task.task_id}.json`), task);
  writeJson(join(paths(root).attempts, `${attemptId}.json`), {
    schema: 'opsle.durable-supervisor.child-attempt/v1',
    task_id: task.task_id,
    attempt_id: attemptId,
    child_state: 'COMPLETED',
    compact_packet: '.opsle/evidence/compact/invariant.json',
    completion_handoff: '.opsle/evidence/compact/invariant.completion.json',
    acceptance: { state: 'SATISFIED' },
    supervisor_evaluation: null,
  });
  updateState(root, { active_task_id: task.task_id, active_attempt_id: attemptId });
}

test('one effective requirement set drives all consumers across four authority profiles', () => {
  const profiles = [
    ['objective-no-matrix', { requirements: 'none' }, null, false],
    ['explicit-none-with-historical-matrix', { requirements: 'durable-supervisor', legacy: true }, null, false],
    ['explicit-requirement-driven', { requirements: 'custom' }, 'FIXTURE-001', false],
    ['completed-requirements', { requirements: 'custom' }, 'FIXTURE-001', true],
  ];
  for (const [name, options, expectedId, complete] of profiles) {
    const root = repository(options);
    try {
      if (complete) setRequirements(root, [expectedId], 'VERIFIED', ['invariant-harness']);
      const effective = effectiveRequirementMatrix(root);
      const effectiveIds = effective?.requirements.map((item) => item.id) ?? [];
      assert.deepEqual(effectiveIds, expectedId ? [expectedId] : [], name);
      const taskRequirementIds = expectedId && !complete ? [expectedId] : [];
      const task = createTask(root, handoff(`task-${name}`, taskRequirementIds));
      assert.deepEqual(task.requirement_ids, taskRequirementIds, name);
      if (!expectedId && existsSync(paths(root).requirements)) {
        const before = readFileSync(paths(root).requirements);
        assert.throws(() => setRequirements(root, ['DS-000'], 'VERIFIED'), /no effective requirements matrix/);
        assert.deepEqual(readFileSync(paths(root).requirements), before, name);
      }

      const state = readJson(paths(root).state);
      state.pending_next_action = NEXT_UNSATISFIED_REQUIREMENT_ACTION;
      writeJson(paths(root).state, state);
      const directNextAction = derivePendingNextAction(state, effective);
      const expectedUnsatisfied = effective ? unsatisfiedRequirements(effective).length : null;
      const expectedNextAction = expectedUnsatisfied > 0
        ? NEXT_UNSATISFIED_REQUIREMENT_ACTION
        : 'Evaluate objective completion against accepted task evidence.';
      assert.equal(directNextAction, expectedNextAction, `${name}: next-action`);

      const status = runCli(root, ['status', '--json']);
      assert.equal(status.status, 0, status.stderr);
      const progress = JSON.parse(status.stdout).progress;
      assert.equal(
        Object.values(progress.requirements).reduce((sum, count) => sum + count, 0),
        effectiveIds.length,
        `${name}: status`,
      );
      assert.equal(progress.pending_next_action, expectedNextAction, `${name}: status next-action`);

      const packet = generateResumePacket(root, {
        persist: false,
        sessionStatus: { classification: 'unbound', valid: false, supported: false, reasons: [] },
        wakeStatus: { requests: [], session_binding: { classification: 'unbound', valid: false } },
      }).packet;
      assert.equal(packet.objective.unsatisfied_requirements, expectedUnsatisfied, `${name}: reconstruction`);

      const recovered = recover(root, {
        startWakeDispatcher: () => ({ started: false, reason: 'invariant-fixture' }),
      });
      assert.equal(recovered.state.pending_next_action, expectedNextAction, `${name}: recovery`);

      stageEvaluableTask(root, task);
      const evaluated = runCli(root, [
        'task', 'evaluate', task.task_id, '--accept', '--rationale', 'invariant profile accepted',
      ]);
      assert.equal(evaluated.status, 0, `${name}: ${evaluated.stderr}`);
      assert.equal(readJson(paths(root).state).pending_next_action, expectedNextAction, `${name}: evaluation`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const root = repository();
  try {
    const task = createTask(root, handoff('task-contradictory-malformed'));
    stageEvaluableTask(root, task);
    const bootstrap = readJson(paths(root).bootstrap);
    bootstrap.requirements = {
      mode: 'matrix',
      path: '.opsle/requirements.json',
      specification_path: '.opsle/specification.md',
    };
    writeJson(paths(root).bootstrap, bootstrap);
    writeJson(paths(root).requirements, { schema: 'foreign.invalid/v1', requirements: 'not-an-array' });
    const before = fileBytes(join(root, '.opsle'));
    for (const invoke of [
      () => effectiveRequirementMatrix(root),
      () => createTask(root, handoff('task-malformed-new')),
      () => recover(root, { startWakeDispatcher: () => ({ started: false }) }),
      () => generateResumePacket(root, { persist: false }),
      () => derivePendingNextAction(readJson(paths(root).state), effectiveRequirementMatrix(root)),
    ]) {
      assert.throws(invoke, /contradicts a requirements matrix|malformed effective requirements matrix/);
      assert.deepEqual(fileBytes(join(root, '.opsle')), before);
    }
    for (const args of [
      ['status', '--json'],
      ['task', 'evaluate', task.task_id, '--accept', '--rationale', 'must fail closed'],
    ]) {
      const result = runCli(root, args);
      assert.equal(result.status, 1);
      assert.deepEqual(fileBytes(join(root, '.opsle')), before);
    }
    const validation = validateDurableState(root);
    assert.equal(validation.valid, false);
    assert.ok(validation.errors.some((error) => /contradicts a requirements matrix|malformed effective requirements matrix|invalid requirements matrix/.test(error)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ownership-vector harness fences wake consumption dimensions and multi-stale combinations', () => {
  const cases = [
    ['caller generation', (value) => { value.generation += 1; }],
    ['request generation', (value) => {
      value.request.target.supervisor_generation += 1; writeJson(value.requestPath, value.request);
    }],
    ['receipt generation', (value) => {
      value.receipt.supervisor_generation += 1; writeJson(value.receiptPath, value.receipt);
    }],
    ['request supervisor', (value) => {
      value.request.target.supervisor_id = 'supervisor-foreign'; writeJson(value.requestPath, value.request);
    }],
    ['receipt supervisor', (value) => {
      value.receipt.supervisor_id = 'supervisor-foreign'; writeJson(value.receiptPath, value.receipt);
    }],
    ['request repository', (value) => {
      value.request.target.repository = '/foreign/repository'; writeJson(value.requestPath, value.request);
    }],
    ['receipt repository', (value) => {
      value.receipt.repository = '/foreign/repository'; writeJson(value.receiptPath, value.receipt);
    }],
    ['missing delivery identity', (value) => { value.deliveryId = null; }],
    ['delivery identity', (value) => { value.deliveryId = 'delivery-foreign'; }],
    ['delivery fence', (value) => {
      value.receipt.activation_fencing_token += 1; writeJson(value.receiptPath, value.receipt);
    }],
    ['request event identity', (value) => {
      value.request.event_id = 'event-foreign'; writeJson(value.requestPath, value.request);
    }],
    ['receipt event identity', (value) => {
      value.receipt.event_id = 'event-foreign'; writeJson(value.receiptPath, value.receipt);
    }],
    ['queue version', (value) => {
      value.receipt.queue_version += 1; writeJson(value.receiptPath, value.receipt);
    }],
    ['session binding', (value) => {
      const binding = readJson(value.bindingPath); binding.binding_revision += 1; writeJson(value.bindingPath, binding);
    }],
    ['host binding', (value) => {
      const binding = readJson(value.bindingPath); binding.host.terminal_id = 'terminal-replaced'; writeJson(value.bindingPath, binding);
    }],
    ['implementation hash', (value) => {
      value.receipt.dispatcher_implementation_sha256 = '0'.repeat(64); writeJson(value.receiptPath, value.receipt);
    }],
    ['multi-stale identity generation session and implementation', (value) => {
      value.request.target.supervisor_id = 'supervisor-foreign';
      value.receipt.supervisor_generation += 1;
      value.receipt.dispatcher_implementation_sha256 = '0'.repeat(64);
      writeJson(value.requestPath, value.request);
      writeJson(value.receiptPath, value.receipt);
      const binding = readJson(value.bindingPath); binding.binding_revision += 1; writeJson(value.bindingPath, binding);
    }],
  ];
  assertOwnershipVector({
    name: 'wake consumption',
    cases,
    setup: () => {
      const root = repository();
      const staged = stageDeliveredWake(root);
      return { ...staged, generation: staged.supervisor.generation, deliveryId: staged.receipt.delivery_id };
    },
    invoke: (value) => consumeWakeDelivery(value.root, value.event.event_id, {
      deliveryId: value.deliveryId,
      generation: value.generation,
    }),
    verifyRejected: (value, invoke, message) => {
      assertProtectedRejection(value.root, invoke);
      assert.equal(existsSync(join(
        value.root, '.opsle', 'wake', 'consumptions', `${value.event.event_id}.json`,
      )), false, message);
    },
  });

  const root = repository();
  try {
    const staged = stageDeliveredWake(root);
    const result = consumeWakeDelivery(root, staged.event.event_id, {
      deliveryId: staged.receipt.delivery_id,
      generation: staged.supervisor.generation,
    });
    assert.equal(result.duplicate, false);
    assert.equal(result.consumption.supervisor_id, staged.supervisor.supervisor_id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ownership-vector harness fences claim acquisition and release on relevant dimensions', () => {
  assertOwnershipVector({
    name: 'claim acquisition',
    cases: [
      ['task supervisor identity', (value) => { value.task.supervisor_id = 'supervisor-foreign'; }],
      ['canonical task content', (value) => { value.task.title = 'stale task snapshot'; }],
      ['attempt identity', (value) => { value.attemptId = ''; }],
    ],
    setup: () => {
      const root = repository();
      const task = createTask(root, handoff('task-claim-acquire-vector'));
      return { root, task, attemptId: 'attempt-claim-vector' };
    },
    invoke: (value) => acquireClaim(value.root, value.task, value.attemptId),
    verifyRejected: (value, invoke) => assertProtectedRejection(value.root, invoke),
  });

  assertOwnershipVector({
    name: 'claim release',
    cases: [
      ['task identity', (value) => { value.claim.task_id = 'task-foreign'; }],
      ['attempt identity', (value) => { value.claim.attempt_id = 'attempt-foreign'; }],
      ['supervisor identity', (value) => { value.claim.owner_supervisor_id = 'supervisor-foreign'; }],
      ['owner generation', (value) => { value.claim.owner_generation += 1; }],
      ['fence generation', (value) => { value.claim.fence_generation += 1; }],
    ],
    setup: () => {
      const root = repository();
      const task = createTask(root, handoff('task-claim-release-vector'));
      const claim = acquireClaim(root, task, 'attempt-claim-vector');
      return { root, claim };
    },
    invoke: (value) => releaseClaim(value.root, value.claim, 'FAILED'),
    verifyRejected: (value, invoke) => assertProtectedRejection(value.root, invoke),
  });
});

test('ownership-vector harness fences final delivery commitment after transport races', () => {
  assertOwnershipVector({
    name: 'delivery commitment',
    cases: [
      ['repository request replacement', (value) => {
        value.duringTransport = () => {
          const request = readJson(value.requestPath);
          request.target.repository = '/foreign/repository';
          writeJson(value.requestPath, request);
        };
      }],
      ['supervisor identity replacement', (value) => {
        value.duringTransport = () => {
          const supervisor = readJson(paths(value.root).supervisor);
          supervisor.supervisor_id = 'supervisor-foreign';
          writeJson(paths(value.root).supervisor, supervisor);
        };
      }],
      ['dispatcher implementation replacement', (value) => {
        value.duringTransport = () => {
          const dispatcher = readJson(value.dispatcherPath);
          dispatcher.implementation_sha256 = '0'.repeat(64);
          writeJson(value.dispatcherPath, dispatcher);
        };
      }],
      ['session host replacement', (value) => {
        value.duringTransport = () => {
          const binding = readJson(value.bindingPath);
          binding.host.terminal_id = 'terminal-replaced';
          writeJson(value.bindingPath, binding);
        };
      }],
      ['activation decision fence replacement', (value) => {
        value.duringTransport = () => {
          const decision = readJson(value.decisionPath);
          decision.fencing_token += 1;
          writeJson(value.decisionPath, decision);
        };
      }],
    ],
    setup: () => {
      const root = repository();
      const binding = stageBinding(root);
      const dispatcher = stageDispatcher(root);
      const event = emit(root, 'CHILD_COMPLETION', {
        task_id: 'task-delivery-vector', attempt_id: 'attempt-delivery-vector',
        wait_id: 'attempt-delivery-vector', terminal_type: 'child-completed',
      });
      enqueueTerminalWake(root, event);
      return {
        root, binding, dispatcher, event,
        requestPath: join(root, '.opsle', 'wake', 'requests', `${event.event_id}.json`),
        receiptPath: join(root, '.opsle', 'wake', 'deliveries', `${event.event_id}.json`),
        decisionPath: join(root, '.opsle', 'wake', 'activation-decisions', `${event.event_id}.json`),
        dispatcherPath: join(root, '.opsle', 'wake', 'dispatcher.json'),
        bindingPath: join(root, '.opsle', 'wake', 'codex-session-binding.json'),
        duringTransport: () => {},
      };
    },
    invoke: (value) => deliverWake(value.root, value.event.event_id, {
      bindingDependencies: value.binding.dependencies,
      dispatcher: value.dispatcher,
      nativeTransport: {
        kind: 'plain-codex-resume',
        resume: ({ session_id: sessionId, message }) => {
          value.duringTransport();
          return confirmedResume(sessionId, message);
        },
      },
    }),
    verifyRejected: (value, invoke, message) => {
      const result = invoke();
      assert.equal(result.delivered, false, message);
      assert.equal(existsSync(value.receiptPath), false, message);
    },
  });
});

test('ownership-vector harness rejects ambiguous recovery adoption', () => {
  assertOwnershipVector({
    name: 'recovery adoption',
    cases: [
      ['task supervisor identity', (value) => {
        const task = readJson(value.taskPath); task.supervisor_id = 'supervisor-foreign'; writeJson(value.taskPath, task);
      }],
      ['attempt claim identity', (value) => {
        const attempt = readJson(value.attemptPath); attempt.claim_id = 'claim-foreign'; writeJson(value.attemptPath, attempt);
      }],
      ['claim owner identity', (value) => {
        const claim = readJson(value.claimPath); claim.owner_supervisor_id = 'supervisor-foreign'; writeJson(value.claimPath, claim);
      }],
      ['claim index fence', (value) => {
        const index = readJson(value.indexPath);
        index[`task-${value.task.task_id}`].fence_generation += 1;
        writeJson(value.indexPath, index);
      }],
    ],
    setup: () => {
      const root = repository();
      const task = createTask(root, handoff('task-recovery-vector'));
      const route = routeTask(root, task);
      const { attempt, claim } = createAttempt(root, task, route);
      attempt.child_state = 'RUNNING';
      attempt.pid = 424242;
      const taskPath = join(paths(root).tasks, `${task.task_id}.json`);
      const attemptPath = join(paths(root).attempts, `${attempt.attempt_id}.json`);
      const claimPath = join(paths(root).claims, `${claim.claim_id}.json`);
      const indexPath = join(paths(root).claims, 'index.json');
      writeJson(attemptPath, attempt);
      return { root, task, claim, taskPath, attemptPath, claimPath, indexPath };
    },
    invoke: (value) => recover(value.root, {
      isProcessAlive: (pid) => pid === 424242,
      startWakeDispatcher: () => ({ started: false, reason: 'invariant-fixture' }),
    }),
    verifyRejected: (value, invoke, message) => {
      const result = invoke();
      assert.equal(result.reconciliation.classification, 'unknown_unreconciled', message);
      assert.equal(readJson(paths(value.root).state).supervisor_state, 'PAUSED', message);
      assert.equal(readJson(value.claimPath).status, 'ACTIVE', message);
    },
  });
});

test('ownership-vector harness rejects stale session-binding adoption without mutation', () => {
  assertOwnershipVector({
    name: 'session-binding adoption',
    cases: [
      ['repository', (value) => {
        const binding = readJson(value.bindingPath); binding.repository_realpath = '/foreign/repository'; writeJson(value.bindingPath, binding);
      }],
      ['supervisor identity', (value) => {
        const binding = readJson(value.bindingPath); binding.supervisor_id = 'supervisor-foreign'; writeJson(value.bindingPath, binding);
      }],
      ['generation', (value) => {
        const binding = readJson(value.bindingPath); binding.supervisor_generation += 1; writeJson(value.bindingPath, binding);
      }],
      ['session identity', (value) => {
        const binding = readJson(value.bindingPath); binding.codex_session_uuid = '01a05952-e1fa-71e2-adea-df7e3f7d99cf'; writeJson(value.bindingPath, binding);
      }],
      ['host identity', (value) => {
        const binding = readJson(value.bindingPath); binding.host.process.start_time_ticks = '9999'; writeJson(value.bindingPath, binding);
      }],
    ],
    setup: () => {
      const root = repository();
      const binding = stageBinding(root);
      return {
        root, binding,
        bindingPath: join(root, '.opsle', 'wake', 'codex-session-binding.json'),
      };
    },
    invoke: (value) => adoptCodexSessionBinding(value.root, { dependencies: value.binding.dependencies }),
    verifyRejected: (value, invoke) => assertProtectedRejection(value.root, invoke),
  });
});

test('ownership harness is sensitive to test-only accept and mutate-on-reject defects', () => {
  const acceptingRoot = repository();
  const mutatingRoot = repository();
  try {
    assert.throws(
      () => assertProtectedRejection(acceptingRoot, () => undefined),
      /accepted a mismatched owner/,
    );
    assert.throws(
      () => assertProtectedRejection(mutatingRoot, () => {
        const state = readJson(paths(mutatingRoot).state);
        state.pending_next_action = 'test-only mutation';
        writeJson(paths(mutatingRoot).state, state);
        throw new Error('rejected after mutation');
      }),
      /changed durable bytes/,
    );
  } finally {
    rmSync(acceptingRoot, { recursive: true, force: true });
    rmSync(mutatingRoot, { recursive: true, force: true });
  }
});

function transitionSequences(alphabet, maximumLength) {
  const result = [[]];
  for (let length = 1; length <= maximumLength; length += 1) {
    for (const sequence of result.filter((item) => item.length === length - 1)) {
      for (const event of alphabet) result.push([...sequence, event]);
    }
  }
  return result.filter((sequence) => sequence.length > 0);
}

function assertWakeMachine(reducer) {
  const alphabet = [
    { event_id: 'heartbeat', type: 'heartbeat', wait_id: 'wait-machine' },
    { event_id: 'human', type: 'human-interaction', wait_id: 'wait-machine' },
    { event_id: 'terminal', type: 'child-completed', wait_id: 'wait-machine' },
    { event_id: 'foreign', type: 'child-completed', wait_id: 'wait-foreign' },
  ];
  for (const sequence of transitionSequences(alphabet, 3)) {
    let state = registerWait({
      waitId: 'wait-machine', taskId: 'task-machine', attemptId: 'attempt-machine',
      registeredAt: '2026-09-03T00:00:00.000Z', deadlineAt: '2026-09-03T00:01:00.000Z',
    });
    let terminalWake = null;
    for (const event of sequence) {
      state = reducer(state, event);
      assert.equal(new Set(state.seen_event_ids).size, state.seen_event_ids.length);
      if (state.state === 'READY') {
        assert.equal(state.wake?.class, 'terminal-event');
        assert.ok(
          ['child-completed', 'child-failed', 'child-timeout', 'child-stall', 'intervention-required'].includes(state.wake?.type),
          'nonterminal event crossed READY boundary',
        );
        terminalWake ??= structuredClone(state.wake);
        assert.deepEqual(state.wake, terminalWake, 'READY ownership changed after terminal transition');
      }
    }
  }
}

test('bounded wake state-machine sequences preserve global invariants after every step', () => {
  assertWakeMachine(applyWakeEvent);
  const brokenReducer = (state, event) => {
    const next = applyWakeEvent(state, event);
    if (event.type !== 'heartbeat' || next.state !== 'WAITING') return next;
    return {
      ...next,
      state: 'READY',
      wake: { event_id: event.event_id, type: event.type, class: 'terminal-event', automatic: true },
    };
  };
  assert.throws(() => assertWakeMachine(brokenReducer), /nonterminal event crossed READY boundary/);
});

test('bounded durable state machine preserves global invariants after every authority transition', () => {
  const root = repository();
  try {
    const supervisorId = readJson(paths(root).supervisor).supervisor_id;
    const check = () => assertGlobalInvariants(root, supervisorId);
    check();

    const task = createTask(root, handoff('task-durable-machine'));
    const first = acquireClaim(root, task, 'attempt-machine-001');
    check(); // acquire

    const released = releaseClaim(root, first, 'FAILED');
    assert.equal(released.status, 'FAILED');
    check(); // release

    const beforeDuplicateRelease = fileBytes(join(root, '.opsle'));
    assert.equal(releaseClaim(root, first, 'FAILED').status, 'FAILED');
    assert.deepEqual(fileBytes(join(root, '.opsle')), beforeDuplicateRelease);
    check(); // duplicate release

    const second = acquireClaim(root, task, 'attempt-machine-002');
    assert.ok(second.fence_generation > first.fence_generation);
    check(); // reacquire with a newer fence

    const generation = readJson(paths(root).supervisor).generation;
    recover(root, { startWakeDispatcher: () => ({ started: false, reason: 'machine' }) });
    assert.equal(readJson(paths(root).supervisor).generation, generation + 1);
    check(); // generation advance and recovery

    const beforeWrongSupervisor = fileBytes(join(root, '.opsle'));
    assert.throws(() => releaseClaim(root, {
      ...second, owner_supervisor_id: 'supervisor-foreign',
    }, 'FAILED'), /claim identity is ambiguous/);
    assert.deepEqual(fileBytes(join(root, '.opsle')), beforeWrongSupervisor);
    check(); // wrong-supervisor rejection

    const firstBinding = stageBinding(root, 'one');
    const firstBindingId = firstBinding.binding.binding_id;
    const secondBinding = stageBinding(root, 'two');
    assert.notEqual(secondBinding.binding.binding_id, firstBindingId);
    check(); // host/session replacement

    const event = emit(root, 'CHILD_COMPLETION', {
      task_id: task.task_id,
      attempt_id: 'attempt-machine-002',
      wait_id: 'attempt-machine-002',
      terminal_type: 'child-completed',
    });
    enqueueTerminalWake(root, event);
    const dispatcher = stageDispatcher(root);
    const delivered = deliverWake(root, event.event_id, {
      bindingDependencies: secondBinding.dependencies,
      dispatcher,
      nativeTransport: {
        kind: 'plain-codex-resume',
        resume: ({ session_id: sessionId, message }) => confirmedResume(sessionId, message),
      },
    });
    assert.equal(delivered.delivered, true);
    check(); // event delivery

    const consumed = consumeWakeDelivery(root, event.event_id, {
      deliveryId: delivered.receipt.delivery_id,
      generation: generation + 1,
    });
    assert.equal(consumed.duplicate, false);
    check(); // event consumption

    const beforeDuplicateConsumption = fileBytes(join(root, '.opsle'));
    assert.equal(consumeWakeDelivery(root, event.event_id, {
      deliveryId: delivered.receipt.delivery_id,
      generation: generation + 1,
    }).duplicate, true);
    assert.deepEqual(fileBytes(join(root, '.opsle')), beforeDuplicateConsumption);
    check(); // duplicate consumption

    assert.equal(runCli(root, ['pause', '--reason', 'state-machine']).status, 0);
    check(); // pause
    assert.equal(runCli(root, ['resume']).status, 0);
    check(); // resume
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mutation-sensitivity kills generation-only, stale-index, raw-requirement, and metadata-only mutants', async () => {
  const wakeRoot = repository();
  const claimRoot = repository();
  const requirementRoot = repository({ requirements: 'durable-supervisor', legacy: true });
  try {
    const staged = stageDeliveredWake(wakeRoot);
    const generationOnlyConsumption = () => {
      const request = readJson(staged.requestPath);
      const receipt = readJson(staged.receiptPath);
      if (request.target.supervisor_generation === staged.supervisor.generation
          && receipt.supervisor_generation === staged.supervisor.generation) return { accepted: true };
      throw new Error('stale generation');
    };
    const request = readJson(staged.requestPath);
    request.target.supervisor_id = 'supervisor-foreign';
    writeJson(staged.requestPath, request);
    assert.throws(
      () => assertProtectedRejection(wakeRoot, generationOnlyConsumption),
      /accepted a mismatched owner/,
    );

    const task = createTask(claimRoot, handoff('task-stale-index-mutant'));
    const first = acquireClaim(claimRoot, task, 'attempt-mutant-001');
    releaseClaim(claimRoot, first, 'FAILED');
    const second = acquireClaim(claimRoot, task, 'attempt-mutant-002');
    const staleOverwrite = () => {
      const index = readJson(join(paths(claimRoot).claims, 'index.json'));
      index.next_fence = first.fence_generation + 1;
      index[`task-${task.task_id}`] = { ...first, status: 'ACTIVE' };
      writeJson(join(paths(claimRoot).claims, 'index.json'), index);
    };
    staleOverwrite();
    assert.throws(() => {
      const index = claimIndexInvariant(claimRoot);
      assert.equal(index[`task-${task.task_id}`].claim_id, second.claim_id);
    });

    const effectiveIds = effectiveRequirementMatrix(requirementRoot)?.requirements ?? [];
    const rawLookupMutant = () => readJson(paths(requirementRoot).requirements).requirements;
    assert.throws(() => assert.deepEqual(rawLookupMutant(), effectiveIds));

    const metadataPolicy = { enabled: true };
    await assert.rejects(
      assertPolicyEffect({
        snapshot: () => structuredClone(metadataPolicy),
        toggle: () => { metadataPolicy.enabled = false; },
        probe: () => 'runner-executed-identically',
      }),
      /changed metadata without behavior/,
    );
  } finally {
    rmSync(wakeRoot, { recursive: true, force: true });
    rmSync(claimRoot, { recursive: true, force: true });
    rmSync(requirementRoot, { recursive: true, force: true });
  }
});

test('historical semantic replays remain inert and byte-identical', () => {
  const claimRoot = repository();
  const wakeRoot = repository();
  const foreignRoot = repository({ requirements: 'durable-supervisor', legacy: true });
  try {
    const task = createTask(claimRoot, handoff('task-history-claim'));
    const first = acquireClaim(claimRoot, task, 'attempt-history-001');
    releaseClaim(claimRoot, first, 'FAILED');
    const second = acquireClaim(claimRoot, task, 'attempt-history-002');
    const firstBytes = readFileSync(join(paths(claimRoot).claims, `${first.claim_id}.json`));
    const indexBytes = readFileSync(join(paths(claimRoot).claims, 'index.json'));
    releaseClaim(claimRoot, first, 'FAILED');
    assert.deepEqual(readFileSync(join(paths(claimRoot).claims, `${first.claim_id}.json`)), firstBytes);
    assert.deepEqual(readFileSync(join(paths(claimRoot).claims, 'index.json')), indexBytes);
    assert.equal(claimIndexInvariant(claimRoot)[`task-${task.task_id}`].claim_id, second.claim_id);

    const binding = stageBinding(wakeRoot);
    const event = emit(wakeRoot, 'CHILD_COMPLETION', {
      task_id: 'task-history-wake', attempt_id: 'attempt-history-wake',
      wait_id: 'attempt-history-wake', terminal_type: 'child-completed',
    });
    const request = enqueueTerminalWake(wakeRoot, event);
    const requestPath = join(wakeRoot, '.opsle', 'wake', 'requests', `${event.event_id}.json`);
    const requestBytes = readFileSync(requestPath);
    const bindingPath = join(wakeRoot, '.opsle', 'wake', 'codex-session-binding.json');
    const bindingBytes = readFileSync(bindingPath);
    recover(wakeRoot, { startWakeDispatcher: () => ({ started: false, reason: 'history' }) });
    assert.equal(deliverWake(wakeRoot, event.event_id, {
      bindingDependencies: binding.dependencies,
      expectedQueueVersion: request.queue_version,
    }).classification, 'obsolete');
    assert.deepEqual(readFileSync(requestPath), requestBytes, 'drain/resubscribe stale wake changed');
    assert.deepEqual(readFileSync(bindingPath), bindingBytes, 'stale session binding changed');
    assertProtectedRejection(wakeRoot, () => adoptCodexSessionBinding(wakeRoot, {
      dependencies: binding.dependencies,
    }));

    const rawRequirements = readFileSync(paths(foreignRoot).requirements);
    assert.equal(effectiveRequirementMatrix(foreignRoot), null);
    assert.deepEqual(readFileSync(paths(foreignRoot).requirements), rawRequirements);

    const consumptionRoot = repository();
    try {
      const delivered = stageDeliveredWake(consumptionRoot);
      const receiptBytes = readFileSync(delivered.receiptPath);
      assert.equal(existsSync(join(
        consumptionRoot, '.opsle', 'wake', 'consumptions', `${delivered.event.event_id}.json`,
      )), false, 'delivered event unexpectedly consumed');
      assert.deepEqual(readFileSync(delivered.receiptPath), receiptBytes, 'unconsumed delivery changed');
      const wrongSupervisor = readJson(delivered.requestPath);
      wrongSupervisor.target.supervisor_id = 'supervisor-foreign';
      writeJson(delivered.requestPath, wrongSupervisor);
      const historicalBytes = readFileSync(delivered.requestPath);
      assertProtectedRejection(consumptionRoot, () => consumeWakeDelivery(
        consumptionRoot,
        delivered.event.event_id,
        { deliveryId: delivered.receipt.delivery_id, generation: delivered.supervisor.generation },
      ));
      assert.deepEqual(readFileSync(delivered.requestPath), historicalBytes);
    } finally {
      rmSync(consumptionRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(claimRoot, { recursive: true, force: true });
    rmSync(wakeRoot, { recursive: true, force: true });
    rmSync(foreignRoot, { recursive: true, force: true });
  }
});

test('dispatcher machine and verbose status expose implementation currentness', () => {
  const root = repository();
  try {
    const supervisor = readJson(paths(root).supervisor);
    const owner = processIdentity(process.pid);
    const dispatcherPath = join(root, '.opsle', 'wake', 'dispatcher.json');
    mkdirSync(join(root, '.opsle', 'wake'), { recursive: true });
    const dispatcher = {
      schema: 'opsle.durable-supervisor.host-wake-dispatcher/v1',
      dispatcher_id: 'dispatcher-invariant',
      dispatcher_generation: 1,
      implementation_sha256: WAKE_DISPATCHER_IMPLEMENTATION_SHA256,
      supervisor_id: supervisor.supervisor_id,
      supervisor_generation: supervisor.generation,
      queue_generation: supervisor.generation,
      process: owner,
      status: 'OWNED',
    };
    writeJson(dispatcherPath, dispatcher);
    const dependencies = {
      environment: () => ({}), sessionsRoot: () => join(root, 'missing-codex-sessions'),
    };
    const current = wakeQueueStatus(root, {
      bindingDependencies: dependencies, getProcessIdentity: () => owner,
    });
    assert.equal(current.dispatcher.current, true);
    assert.deepEqual(current.dispatcher.implementation_fence, {
      expected_sha256: WAKE_DISPATCHER_IMPLEMENTATION_SHA256,
      observed_sha256: WAKE_DISPATCHER_IMPLEMENTATION_SHA256,
      current: true,
    });

    dispatcher.implementation_sha256 = '0'.repeat(64);
    writeJson(dispatcherPath, dispatcher);
    const stale = wakeQueueStatus(root, {
      bindingDependencies: dependencies, getProcessIdentity: () => owner,
    });
    assert.equal(stale.dispatcher.current, false);
    assert.equal(stale.dispatcher.implementation_fence.current, false);
    assert.equal(stale.dispatcher.implementation_fence.observed_sha256, '0'.repeat(64));
    const concise = renderWakeStatus(stale);
    const verbose = renderWakeStatus(stale, { verbose: true });
    assert.doesNotMatch(concise, /implementation expected|implementation observed/i);
    assert.match(verbose, /Dispatcher implementation current: no/);
    assert.match(verbose, new RegExp(WAKE_DISPATCHER_IMPLEMENTATION_SHA256));
    assert.match(verbose, /0{64}/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
