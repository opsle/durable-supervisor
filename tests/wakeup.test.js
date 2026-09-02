import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { profileCodexActivations } from '../src/activation-telemetry.js';
import {
  classifyCodexPane,
  consumeTerminalSession,
  createTmuxHost,
  registerAtomicReplaceWait,
} from '../src/host-terminal.js';
import { readJson, sha256, writeJson } from '../src/io.js';
import { emit, initialize, paths, validateDurableState } from '../src/state.js';
import {
  canonicalResumeArgv,
  CODEX_RESUME_CLEANUP_TIMEOUT_MS,
  CODEX_RESUME_CONFIRMATION_TIMEOUT_MS,
  CODEX_RESUME_WORST_CASE_CLEANUP_TIMEOUT_MS,
  rolloutAcceptance,
  rolloutConfirmation,
  runCodexResumeTransport,
} from '../src/codex-resume-transport.js';
import {
  acquireActivationLease,
  ACTIVATION_LEASE_TTL_MS,
  adoptCodexSessionBinding,
  adoptQueuedWakes,
  applyWakeEvent,
  bindCodexSession,
  classifyWakeDelivery,
  classifyQueuedWake,
  commitConfirmedWakeReceipt,
  codexSessionBindingStatus,
  constructWakeMessage,
  consumeWakeDelivery,
  deliverWake,
  decisionFenceCurrent,
  drainWakeQueue,
  enqueueTerminalWake,
  ensureWakeDispatcher,
  CODEX_RESUME_HELPER_TIMEOUT_MS,
  plainCodexResumeTransport,
  processIdentity,
  registerBoundRolloutOpportunity,
  registerWait,
  releaseActivationLease,
  runWakeDispatcher,
  updateCommittedWakeCleanup,
} from '../src/wakeup.js';
import { sessionCommand } from '../src/cli.js';
import { resumeHelperResult } from '../bin/opsle-codex-resume.js';

const sourceRoot = resolve(new URL('..', import.meta.url).pathname);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'durable-supervisor-wake-'));
  mkdirSync(join(root, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(root, '.git', 'refs', 'heads', 'main'), `${'4'.repeat(40)}\n`);
  writeFileSync(join(root, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');
  writeFileSync(join(root, 'README.md'), '# wake fixture\n');
  mkdirSync(join(root, '.opsle'));
  cpSync(join(sourceRoot, '.opsle', 'specification.md'), join(root, '.opsle', 'specification.md'));
  cpSync(join(sourceRoot, '.opsle', 'requirements.json'), join(root, '.opsle', 'requirements.json'));
  initialize(root, { actor: 'wake-test' });
  const supervisor = readJson(paths(root).supervisor);
  supervisor.session_id = 'opsle-wake-fixture';
  writeJson(paths(root).supervisor, supervisor);
  return root;
}

function hostEvidence(overrides = {}) {
  return {
    available: true,
    session_alive: true,
    session_name: 'opsle-wake-fixture',
    pane_id: '%7',
    pane_pid: 700,
    pane_dead: false,
    current_command: 'codex',
    cursor: { x: 0, y: 40 },
    capture_sha256: 'a'.repeat(64),
    attached_clients: [],
    codex_process: {
      pid: 701,
      start_time_ticks: '12345',
      executable: '/opt/codex',
    },
    prompt_state: 'idle',
    prompt_idle: true,
    composer_empty: true,
    composer_text: '',
    reason: 'empty-codex-composer-at-cursor',
    ...overrides,
  };
}

function stageDispatcher(root, {
  dispatcherId = 'wake-dispatcher-fixture',
  dispatcherGeneration = 1,
  pid = 8100,
  startTime = '810000',
  status = 'LAUNCHED',
} = {}) {
  const supervisor = readJson(paths(root).supervisor);
  const record = {
    schema: 'opsle.durable-supervisor.host-wake-dispatcher/v1',
    dispatcher_id: dispatcherId,
    dispatcher_generation: dispatcherGeneration,
    supervisor_id: supervisor.supervisor_id,
    supervisor_generation: supervisor.generation,
    queue_generation: supervisor.generation,
    launch_nonce: `launch-${dispatcherGeneration}`,
    process: { pid, start_time_ticks: startTime, executable: '/usr/bin/node' },
    status,
    launched_at: '2026-09-01T00:00:00.000Z',
    owned_at: status === 'OWNED' ? '2026-09-01T00:00:01.000Z' : null,
    last_observed_at: null,
    last_result: null,
    failure: null,
  };
  mkdirSync(join(root, '.opsle', 'wake'), { recursive: true });
  writeJson(join(root, '.opsle', 'wake', 'dispatcher.json'), record);
  return record;
}

function stageCurrentDispatcher(root, overrides = {}) {
  const owner = processIdentity(process.pid);
  const dispatcher = stageDispatcher(root, {
    status: 'OWNED',
    pid: owner.pid,
    startTime: owner.start_time_ticks,
    ...overrides,
  });
  dispatcher.process.executable = owner.executable;
  writeJson(join(root, '.opsle', 'wake', 'dispatcher.json'), dispatcher);
  return dispatcher;
}

function confirmedResumeResult(sessionId, message, processGroup, overrides = {}) {
  return {
    classification: 'confirmed',
    cleanup_proven: true,
    authoritative_host_continuity_proven: true,
    argv: canonicalResumeArgv(sessionId, message),
    process_group: processGroup,
    launcher_exit_observed: true,
    frontend_exit_observed: true,
    tracked_process_groups: [processGroup],
    frontend_process_groups: [],
    signaled_process_groups: [processGroup],
    process_group_member_counts: [{ process_group: processGroup, member_count: 0 }],
    process_group_member_count: 0,
    duplicate_frontend_count: 0,
    invalid_frontend_identity_count: 0,
    blocked_process_groups: [],
    authoritative_host_process_group: processGroup + 1000,
    authoritative_host_signaled: false,
    accepted_ordinal: 10,
    accepted_record_sha256: 'a'.repeat(64),
    turn_began_ordinal: 11,
    turn_began_record_sha256: 'b'.repeat(64),
    turn_id: 'turn-1',
    turn_started_at_ms: 1,
    ...overrides,
  };
}

function terminalEvent(root, suffix = 'one') {
  return emit(root, 'CHILD_COMPLETION', {
    task_id: `task-${suffix}`,
    attempt_id: `attempt-${suffix}`,
    wait_id: `attempt-${suffix}`,
    terminal_type: 'child-completed',
  });
}

function bindingFixture(root, { duplicate = false, bind = true } = {}) {
  const sessionId = '01a05952-e1fa-71e2-adea-df7e3f7d99ce';
  const sessionsRoot = join(root, 'codex-sessions');
  mkdirSync(sessionsRoot, { recursive: true });
  const rolloutPath = join(sessionsRoot, 'rollout-authoritative.jsonl');
  writeFileSync(rolloutPath, `${JSON.stringify({
    timestamp: '2026-09-01T00:00:00.000Z',
    type: 'session_meta',
    payload: { id: sessionId, cwd: root },
  })}\n`);
  if (duplicate) {
    writeFileSync(join(sessionsRoot, 'rollout-duplicate.jsonl'), `${JSON.stringify({
      type: 'session_meta', payload: { id: sessionId, cwd: root },
    })}\n`);
  }
  const processes = new Map([
    [700, {
      pid: 700,
      start_time_ticks: '7000',
      executable: '/opt/codex',
      uid: 1000,
      tty: '/dev/pts/7',
      command_line_sha256: 'a'.repeat(64),
    }],
  ]);
  const host = {
    workspace_id: 'workspace-1',
    workspace_cwd: root,
    pane_id: 'pane-1',
    terminal_id: 'terminal-1',
  };
  const dependencies = {
    processIdentity: (pid) => structuredClone(processes.get(pid) ?? null),
    codexVersion: () => 'codex-cli 0.152.0',
    uid: () => 1000,
    legacyTmuxAuthority: () => false,
  };
  if (!duplicate && bind) {
    bindCodexSession(root, {
      sessionId,
      rolloutPath,
      sessionsRoot,
      hostPid: 700,
      workspaceId: host.workspace_id,
      workspaceCwd: host.workspace_cwd,
      paneId: host.pane_id,
      terminalId: host.terminal_id,
    }, { dependencies });
  }
  return { sessionId, sessionsRoot, rolloutPath, processes, host, dependencies };
}

function appendWakeConfirmation(rolloutPath, sessionId, message, {
  acceptedOrdinal = 10,
  turnBeganOrdinal = 11,
  turnId = 'turn-late-confirmation',
} = {}) {
  const records = [
    {
      ordinal: acceptedOrdinal,
      type: 'response_item',
      payload: {
        type: 'message', role: 'user', content: [{ type: 'input_text', text: message }],
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      },
    },
    {
      ordinal: turnBeganOrdinal,
      type: 'event_msg',
      payload: {
        type: 'item_completed', thread_id: sessionId, turn_id: turnId,
        item: { type: 'UserMessage', content: [{ type: 'text', text: message }] },
        started_at_ms: 1788315000000,
      },
    },
  ];
  writeFileSync(
    rolloutPath,
    `${readFileSync(rolloutPath, 'utf8')}${records.map(JSON.stringify).join('\n')}\n`,
  );
}

function events(root) {
  const text = readFileSync(paths(root).eventsLog, 'utf8').trim();
  return text ? text.split('\n').map((line) => JSON.parse(line)) : [];
}

function wait() {
  return registerWait({
    waitId: 'wait-1',
    taskId: 'task-1',
    attemptId: 'attempt-1',
    registeredAt: '2026-08-31T20:00:00.000Z',
    deadlineAt: '2026-08-31T20:30:00.000Z',
  });
}

test('rollout confirmation accepts authoritative live Codex item-completed records', () => {
  const sessionId = '01a05dd0-0773-79a2-83b9-4fa2cf7c8ec3';
  const records = [
    {
      ordinal: 828,
      timestamp: '2026-09-01T17:15:35.786Z',
      type: 'response_item',
      payload: {
        type: 'message',
        id: 'msg_01a05df8-19e9-7460-a525-b40dc2c616e9',
        role: 'user',
        content: [{
          type: 'input_text',
          text: 'OPSLE_WAKE v1 event=event-84daed36-4011-4ef1-8cbf-9758fadaac1b gen=13; read durable state.',
        }],
        internal_chat_message_metadata_passthrough: {
          turn_id: '01a05dd0-2eb7-7bd1-9145-efcc9aa55b3e',
          create_time: 1788282935.7859228,
          content_item_kinds: ['user.text'],
        },
      },
    },
    {
      ordinal: 829,
      timestamp: '2026-09-01T17:15:35.788Z',
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: sessionId,
        turn_id: '01a05dd0-2eb7-7bd1-9145-efcc9aa55b3e',
        item: {
          type: 'UserMessage',
          id: '01a05df8-19eb-7062-9628-074ad767dcda',
          content: [{
            type: 'text',
            text: 'OPSLE_WAKE v1 event=event-84daed36-4011-4ef1-8cbf-9758fadaac1b gen=13; read durable state.',
            text_elements: [],
          }],
        },
        started_at_ms: 1788282935787,
        completed_at_ms: 1788282935787,
      },
    },
    {
      ordinal: 968,
      timestamp: '2026-09-01T17:21:58.907Z',
      type: 'response_item',
      payload: {
        type: 'message',
        id: 'msg_01a05dfd-f27b-7712-8070-6d4f9265ac96',
        role: 'user',
        content: [{
          type: 'input_text',
          text: 'OPSLE_WAKE v1 event=event-7e4371d3-a05b-489d-a7f6-bf9fb123e11d gen=13; read durable state.',
        }],
        internal_chat_message_metadata_passthrough: {
          turn_id: '01a05dd0-2eb7-7bd1-9145-efcc9aa55b3e',
          create_time: 1788283318.9072254,
          content_item_kinds: ['user.text'],
        },
      },
    },
    {
      ordinal: 969,
      timestamp: '2026-09-01T17:21:58.909Z',
      type: 'event_msg',
      payload: {
        type: 'item_completed',
        thread_id: sessionId,
        turn_id: '01a05dd0-2eb7-7bd1-9145-efcc9aa55b3e',
        item: {
          type: 'UserMessage',
          id: '01a05dfd-f27d-7302-ad4a-a7b71b3a0dd3',
          content: [{
            type: 'text',
            text: 'OPSLE_WAKE v1 event=event-7e4371d3-a05b-489d-a7f6-bf9fb123e11d gen=13; read durable state.',
            text_elements: [],
          }],
        },
        started_at_ms: 1788283318909,
        completed_at_ms: 1788283318909,
      },
    },
  ];

  const firstMessage = records[0].payload.content[0].text;
  const first = rolloutAcceptance(records, {
    sessionId, message: firstMessage, baselineOrdinal: 827,
  });
  assert.equal(first.classification, 'confirmed');
  assert.equal(first.turn_id, '01a05dd0-2eb7-7bd1-9145-efcc9aa55b3e');
  assert.equal(first.turn_started_at_ms, 1788282935787);

  const secondMessage = records[2].payload.content[0].text;
  const second = rolloutAcceptance(records, {
    sessionId, message: secondMessage, baselineOrdinal: 967,
  });
  assert.equal(second.classification, 'confirmed');
  assert.equal(second.turn_started_at_ms, 1788283318909);
  assert.equal(rolloutAcceptance(records, {
    sessionId, message: firstMessage, baselineOrdinal: 828,
  }), null);
  assert.equal(rolloutAcceptance([...records, records[0]], {
    sessionId, message: firstMessage, baselineOrdinal: 827,
  }).classification, 'ambiguous');

  const missingStartedAt = structuredClone(records.slice(0, 2));
  delete missingStartedAt[1].payload.started_at_ms;
  missingStartedAt[1].payload.item.started_at_ms = 1788282935787;
  assert.equal(rolloutAcceptance(missingStartedAt, {
    sessionId, message: firstMessage, baselineOrdinal: 827,
  }), null);
  for (const startedAt of ['1788282935787', Number.MAX_SAFE_INTEGER + 1]) {
    const malformed = structuredClone(records.slice(0, 2));
    malformed[1].payload.started_at_ms = startedAt;
    assert.equal(rolloutAcceptance(malformed, {
      sessionId, message: firstMessage, baselineOrdinal: 827,
    }), null);
  }

  const mismatchedTurn = structuredClone(records.slice(0, 2));
  mismatchedTurn[1].payload.turn_id = '01a05dd0-2eb7-7bd1-9145-efcc9aa55b3f';
  assert.equal(rolloutAcceptance(mismatchedTurn, {
    sessionId, message: firstMessage, baselineOrdinal: 827,
  }).classification, 'ambiguous');
  assert.equal(rolloutAcceptance(records, {
    sessionId, message: `${firstMessage} changed`, baselineOrdinal: 827,
  }), null);
});

test('plain resume transport cleans launcher and script-style separate frontend groups after confirmation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-resume-transport-'));
  try {
    const rolloutPath = join(root, 'rollout.jsonl');
    const sessionId = '01a05952-e1fa-71e2-adea-df7e3f7d99ce';
    const message = 'OPSLE_WAKE v1 event=event-1 gen=3; read durable state.';
    writeFileSync(rolloutPath, `${JSON.stringify({ ordinal: 1, type: 'session_meta', payload: { id: sessionId } })}\n`);
    const watcher = new EventEmitter();
    watcher.close = () => {};
    const child = new EventEmitter();
    child.pid = 9100;
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const spawns = [];
    const signals = [];
    const checkpoints = [];
    const deliveryBoundaries = [];
    let spawned = false;
    let exactFrontends = [];
    const groupMembers = new Map([
      [9100, [{ pid: 9100, pgrp: 9100, start_time_ticks: '910000' }]],
      [9110, [
        { pid: 9110, pgrp: 9110, start_time_ticks: '911000' },
        { pid: 9111, pgrp: 9110, start_time_ticks: '911100' },
      ]],
    ]);
    const resultPromise = runCodexResumeTransport({
      sessionId,
      message,
      rolloutPath,
      attemptEvidence: {
        schema: 'opsle.durable-supervisor.codex-resume-transport-attempt/v1',
        transport_attempt_id: 'transport-attempt-confirmed-fixture',
      },
      checkpointEvidence: (evidence) => checkpoints.push(evidence),
      commitConfirmation: (evidence) => {
        assert.deepEqual(signals, []);
        assert.equal(evidence.rollout_confirmation.turn_id, 'turn-1');
        deliveryBoundaries.push('receipt');
        return {
          committed: true,
          path: '/fixture/delivery.json',
          receipt: { delivery_id: 'delivery-ordering-fixture' },
        };
      },
      completeCommittedDelivery: () => {
        deliveryBoundaries.push('cleanup');
        return {
          updated: true,
          receipt: { temporary_frontend: { cleanup_status: 'PROVEN' } },
        };
      },
      inspectExecutable: () => ({
        requested: 'codex', resolved: '/opt/codex', version: 'codex-cli 0.152.1', version_error: null,
      }),
      spawnProcess: (command, args, options) => {
        spawns.push({ command, args, options });
        spawned = true;
        exactFrontends = [
          { pid: 9110, pgrp: 9110, start_time_ticks: '911000' },
          { pid: 9111, pgrp: 9110, start_time_ticks: '911100' },
        ];
        queueMicrotask(() => {
          const additions = [
            {
              ordinal: 2,
              type: 'response_item',
              payload: {
                type: 'message', role: 'user', content: [{ type: 'input_text', text: message }],
                internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' },
              },
            },
            {
              ordinal: 3,
              type: 'event_msg',
              payload: {
                type: 'item_completed', thread_id: sessionId, turn_id: 'turn-1',
                item: { type: 'UserMessage', content: [{ type: 'text', text: message }] },
                started_at_ms: 123,
              },
            },
          ];
          const lines = additions.map((record, index) => (
            index === 0
              ? JSON.stringify(record).replace('"ordinal":2', '"ordinal": 2')
              : JSON.stringify(record)
          ));
          writeFileSync(rolloutPath, `${readFileSync(rolloutPath, 'utf8')}${lines.join('\n')}\n`);
          // The rollout proof is already durable when busy text arrives. The
          // live output handler must inspect that proof before classifying it.
          child.stderr.emit('data', Buffer.from('session already busy'));
        });
        return child;
      },
      watchFactory: () => watcher,
      killProcess: (pid, signal) => {
        assert.deepEqual(deliveryBoundaries, ['receipt']);
        signals.push([pid, signal]);
        assert.equal(signal, 'SIGTERM');
        const group = -pid;
        groupMembers.set(group, []);
        if (group === 9110) exactFrontends = [];
        if (group === 9100) {
          child.signalCode = 'SIGTERM';
          child.emit('exit', null, 'SIGTERM');
        }
      },
      inspectFrontends: () => (spawned ? exactFrontends : []),
      inspectProcessGroup: (group) => groupMembers.get(group) ?? [],
      authoritativeHostProcess: {
        pid: 700, start_time_ticks: '7000', executable: '/opt/codex',
      },
      inspectHostProcess: () => ({
        pid: 700, pgrp: 7000, start_time_ticks: '7000', executable: '/opt/codex',
      }),
    });
    const result = await resultPromise;
    assert.deepEqual(result.argv, canonicalResumeArgv(sessionId, message));
    assert.equal(spawns[0].command, '/bin/sh');
    assert.match(spawns[0].args[1], /script -qefc/);
    assert.doesNotMatch(spawns[0].args.join(' '), /codex exec resume/);
    assert.equal(spawns[0].options.detached, true);
    assert.equal(result.classification, 'confirmed');
    assert.equal(result.cleanup_proven, true);
    assert.equal(result.authoritative_host_continuity_proven, true);
    assert.equal(result.authoritative_host_signaled, false);
    assert.equal(result.authoritative_host_process_group, 7000);
    assert.equal(result.launcher_exit_observed, true);
    assert.deepEqual(result.tracked_process_groups, [9100, 9110]);
    assert.deepEqual(result.frontend_process_groups, [9110]);
    assert.deepEqual(result.signaled_process_groups, [9100, 9110]);
    assert.deepEqual(result.process_group_member_counts, [
      { process_group: 9100, member_count: 0 },
      { process_group: 9110, member_count: 0 },
    ]);
    assert.deepEqual(signals, [[-9100, 'SIGTERM'], [-9110, 'SIGTERM']]);
    assert.deepEqual(deliveryBoundaries, ['receipt', 'cleanup']);
    assert.equal(result.delivery_receipt_committed, true);
    assert.equal(signals.some(([pid]) => pid === -7000), false);
    assert.equal(result.duplicate_frontend_count, 0);
    assert.equal(result.turn_id, 'turn-1');
    const confirmationCheckpoint = checkpoints.find((entry) => (
      entry.checkpoints.at(-1).stage === 'confirmation-before-cleanup'
    ));
    const cleanupCheckpoint = checkpoints.find((entry) => (
      entry.checkpoints.at(-1).stage === 'cleanup-started'
    ));
    assert.ok(confirmationCheckpoint);
    assert.ok(cleanupCheckpoint);
    assert.equal(confirmationCheckpoint.rollout_confirmation.turn_id, 'turn-1');
    assert.equal(confirmationCheckpoint.confirmation_absence, null);
    assert.equal(confirmationCheckpoint.transport.resolved_executable.resolved, '/opt/codex');
    assert.equal(confirmationCheckpoint.transport.resolved_executable.version, 'codex-cli 0.152.1');
    assert.match(confirmationCheckpoint.transport.environment.fingerprint_sha256, /^[a-f0-9]{64}$/);
    assert.equal(confirmationCheckpoint.transport.cwd, process.cwd());
    assert.ok(
      confirmationCheckpoint.timestamps.confirmation_checkpointed_at
      <= cleanupCheckpoint.timestamps.cleanup_started_at,
    );
    assert.equal(result.accepted_record_sha256, sha256(Buffer.from(`${JSON.stringify({
      ordinal: 2,
      type: 'response_item',
      payload: {
        type: 'message', role: 'user', content: [{ type: 'input_text', text: message }],
        internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' },
      },
    }).replace('"ordinal":2', '"ordinal": 2')}\n`)));
    assert.equal(result.turn_began_record_sha256, sha256(Buffer.from(`${JSON.stringify({
      ordinal: 3,
      type: 'event_msg',
      payload: {
        type: 'item_completed', thread_id: sessionId, turn_id: 'turn-1',
        item: { type: 'UserMessage', content: [{ type: 'text', text: message }] },
        started_at_ms: 123,
      },
    })}\n`)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('confirmed receipt is committed before signaling and cleanup failure remains delivered', () => {
  const root = fixture();
  try {
    const bound = bindingFixture(root);
    const event = terminalEvent(root, 'receipt-before-cleanup');
    enqueueTerminalWake(root, event);
    const dispatcher = stageCurrentDispatcher(root);
    const ordering = [];
    let calls = 0;
    const transport = {
      kind: 'plain-codex-resume',
      resume(request) {
        calls += 1;
        appendWakeConfirmation(bound.rolloutPath, bound.sessionId, request.message);
        const evidence = readJson(request.transport_attempt_path);
        evidence.transport = {
          ...(evidence.transport ?? {}),
          baseline_ordinal: -1,
          message_sha256: sha256(request.message),
        };
        evidence.process = {
          launcher: { pid: 9800, process_group: 9800 },
          frontends: [],
        };
        const confirmation = rolloutConfirmation(bound.rolloutPath, {
          sessionId: bound.sessionId,
          message: request.message,
          baselineOrdinal: -1,
        });
        evidence.rollout_confirmation = { ...confirmation };
        delete evidence.rollout_confirmation.classification;
        evidence.confirmation_absence = null;
        writeJson(request.transport_attempt_path, evidence);
        const committed = commitConfirmedWakeReceipt(
          root,
          request.transport_attempt_path,
          evidence.rollout_confirmation,
        );
        assert.equal(committed.committed, true);
        const pending = readJson(join(
          root, '.opsle', 'wake', 'deliveries', `${event.event_id}.json`,
        ));
        assert.equal(pending.status, 'DELIVERED');
        assert.equal(pending.temporary_frontend.cleanup_status, 'PENDING');
        ordering.push('receipt');

        // This models the first launcher signal after the durable boundary.
        assert.deepEqual(ordering, ['receipt']);
        ordering.push('signal');
        evidence.delivery_receipt = {
          committed: true,
          path: committed.path,
          delivery_id: committed.receipt.delivery_id,
        };
        evidence.cleanup = {
          process_group: 9800,
          launcher_exit_observed: false,
          frontend_exit_observed: false,
          tracked_process_groups: [9800],
          frontend_process_groups: [],
          signaled_process_groups: [9800],
          process_group_member_counts: [{ process_group: 9800, member_count: 1 }],
          process_group_member_count: 1,
          duplicate_frontend_count: 0,
          invalid_frontend_identity_count: 0,
          blocked_process_groups: [],
          authoritative_host_process_group: 7000,
          authoritative_host_signaled: false,
          authoritative_host_continuity_proven: true,
          cleanup_proven: false,
        };
        writeJson(request.transport_attempt_path, evidence);
        const cleanup = updateCommittedWakeCleanup(root, request.transport_attempt_path, evidence);
        assert.equal(cleanup.updated, true);
        assert.equal(cleanup.receipt.temporary_frontend.cleanup_status, 'INTERVENTION_REQUIRED');
        ordering.push('cleanup-intervention');

        // Delivery truth survives a helper failure after receipt commit.
        return {
          classification: 'uncertain',
          reason: 'fixture-helper-failed-after-receipt',
          transport_attempt_id: request.transport_attempt_id,
        };
      },
    };
    const delivered = deliverWake(root, event.event_id, {
      nativeTransport: transport,
      bindingDependencies: bound.dependencies,
      dispatcher,
    });
    assert.equal(delivered.classification, 'native-delivered');
    assert.equal(delivered.delivered, true);
    assert.equal(delivered.receipt.temporary_frontend.cleanup_status, 'INTERVENTION_REQUIRED');
    assert.equal(delivered.receipt.temporary_frontend.cleanup_proven, false);
    assert.deepEqual(ordering, ['receipt', 'signal', 'cleanup-intervention']);
    assert.equal(deliverWake(root, event.event_id, {
      nativeTransport: transport,
      bindingDependencies: bound.dependencies,
      dispatcher,
    }).classification, 'duplicate');
    assert.equal(calls, 1);
    assert.equal(events(root).filter((entry) => (
      entry.type === 'SUPERVISOR_ACTIVATION' && entry.cause_event_id === event.event_id
    )).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fenced receipt rejects stale repository authorities and mismatched confirmation', () => {
  const regressions = [
    ['supervisor-generation', (root) => {
      const value = readJson(paths(root).supervisor);
      value.generation += 1;
      writeJson(paths(root).supervisor, value);
    }],
    ['dispatcher-generation', (root) => {
      const path = join(root, '.opsle', 'wake', 'dispatcher.json');
      const value = readJson(path);
      value.dispatcher_generation += 1;
      writeJson(path, value);
    }],
    ['request', (root, eventId) => {
      const path = join(root, '.opsle', 'wake', 'requests', `${eventId}.json`);
      const value = readJson(path);
      value.queue_version += 1;
      writeJson(path, value);
    }],
    ['lease', (root) => {
      const path = join(root, '.opsle', 'wake', 'activation-lease.json');
      const value = readJson(path);
      value.fencing_token += 1;
      writeJson(path, value);
    }],
    ['activation-decision', (root, eventId) => {
      const path = join(root, '.opsle', 'wake', 'activation-decisions', `${eventId}.json`);
      const value = readJson(path);
      value.status = 'UNCERTAIN';
      writeJson(path, value);
    }],
    ['session-binding', (root) => {
      const path = join(root, '.opsle', 'wake', 'codex-session-binding.json');
      const value = readJson(path);
      value.binding_id = 'binding-replaced-before-receipt';
      writeJson(path, value);
    }],
    ['confirmation', () => {}],
  ];
  for (const [name, mutate] of regressions) {
    const root = fixture();
    try {
      const bound = bindingFixture(root);
      const event = terminalEvent(root, `receipt-fence-${name}`);
      enqueueTerminalWake(root, event);
      const dispatcher = stageCurrentDispatcher(root);
      const result = deliverWake(root, event.event_id, {
        dispatcher,
        bindingDependencies: bound.dependencies,
        nativeTransport: {
          kind: 'plain-codex-resume',
          resume(request) {
            appendWakeConfirmation(bound.rolloutPath, bound.sessionId, request.message);
            const evidence = readJson(request.transport_attempt_path);
            evidence.transport = {
              baseline_ordinal: -1,
              message_sha256: sha256(request.message),
            };
            evidence.process = { launcher: { pid: 9900, process_group: 9900 } };
            writeJson(request.transport_attempt_path, evidence);
            const confirmation = rolloutConfirmation(bound.rolloutPath, {
              sessionId: bound.sessionId,
              message: request.message,
              baselineOrdinal: -1,
            });
            mutate(root, event.event_id);
            const candidate = name === 'confirmation'
              ? { ...confirmation, turn_id: 'mismatched-turn' }
              : confirmation;
            const committed = commitConfirmedWakeReceipt(
              root,
              request.transport_attempt_path,
              candidate,
            );
            assert.equal(committed.committed, false, name);
            return { classification: 'uncertain', reason: `stale-${name}` };
          },
        },
      });
      assert.equal(result.delivered, false, name);
      assert.equal(existsSync(join(
        root, '.opsle', 'wake', 'deliveries', `${event.event_id}.json`,
      )), false, name);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('resume helper accepts the prior invocation without evidence and emits complete JSON', async () => {
  const result = await resumeHelperResult([
    '--session', '01a05952-e1fa-71e2-adea-df7e3f7d99ce',
    '--message', 'OPSLE_WAKE v1 event=event-legacy-helper gen=20; read durable state.',
    '--rollout', join(tmpdir(), 'missing-legacy-helper-rollout.jsonl'),
    '--host-pid', String(process.pid),
    '--host-start', '1',
    '--host-executable', process.execPath,
  ]);
  assert.equal(result.exitCode, 1);
  assert.equal(result.stderr, '');
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.classification, 'uncertain');
  assert.match(parsed.reason, /^resume-helper-failed-after-launch-possible:/);
});

test('plain resume cleanup never signals an exact frontend group containing the authoritative host', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-resume-host-safety-'));
  try {
    const rolloutPath = join(root, 'rollout.jsonl');
    const sessionId = '01a05952-e1fa-71e2-adea-df7e3f7d99ce';
    const message = 'OPSLE_WAKE v1 event=event-host-safety gen=3; read durable state.';
    writeFileSync(rolloutPath, `${JSON.stringify({ ordinal: 1, type: 'session_meta' })}\n`);
    const watcher = new EventEmitter();
    watcher.close = () => {};
    const child = new EventEmitter();
    child.pid = 9200;
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let spawned = false;
    const signals = [];
    const host = {
      pid: 2585062,
      pgrp: 7000,
      start_time_ticks: '243929270',
      executable: '/home/deploy/.local/bin/herdr',
    };
    const result = await runCodexResumeTransport({
      sessionId,
      message,
      rolloutPath,
      cleanupTimeoutMs: 0,
      spawnProcess: () => {
        spawned = true;
        queueMicrotask(() => child.stderr.emit('data', Buffer.from('session already busy')));
        return child;
      },
      watchFactory: () => watcher,
      killProcess: (pid, signal) => {
        signals.push([pid, signal]);
        if (pid === -9200) {
          child.signalCode = signal;
          child.emit('exit', null, signal);
        }
      },
      inspectFrontends: () => (spawned ? [{
        pid: 9210, pgrp: host.pgrp, start_time_ticks: '921000',
      }] : []),
      inspectProcessGroup: (group) => (group === host.pgrp ? [host] : []),
      authoritativeHostProcess: host,
      inspectHostProcess: () => host,
    });
    assert.equal(result.classification, 'busy');
    assert.equal(result.cleanup_proven, false);
    assert.equal(result.authoritative_host_continuity_proven, true);
    assert.equal(result.authoritative_host_signaled, false);
    assert.deepEqual(result.blocked_process_groups, [7000]);
    assert.deepEqual(signals, [[-9200, 'SIGTERM']]);
    assert.equal(signals.some(([pid]) => pid === -host.pgrp), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('plain resume refuses to spawn beside a preexisting exact-message frontend', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-resume-preexisting-'));
  try {
    const rolloutPath = join(root, 'rollout.jsonl');
    const sessionId = '01a05952-e1fa-71e2-adea-df7e3f7d99ce';
    const message = 'OPSLE_WAKE v1 event=event-preexisting gen=3; read durable state.';
    writeFileSync(rolloutPath, `${JSON.stringify({ ordinal: 1, type: 'session_meta' })}\n`);
    let spawnCalls = 0;
    const checkpoints = [];
    const result = await runCodexResumeTransport({
      sessionId,
      message,
      rolloutPath,
      spawnProcess: () => { spawnCalls += 1; },
      inspectExecutable: () => ({
        requested: 'codex', resolved: '/opt/codex', version: 'codex-cli 0.152.1', version_error: null,
      }),
      inspectFrontends: () => [{
        pid: 9250,
        pgrp: 9250,
        start_time_ticks: '925000',
        executable: '/opt/codex',
        command_line: ['codex', 'resume', sessionId, message],
      }],
      checkpointEvidence: (evidence) => checkpoints.push(evidence),
    });
    assert.equal(result.classification, 'busy');
    assert.equal(result.reason, 'matching-resume-frontend-already-exists-before-spawn');
    assert.equal(result.spawned, false);
    assert.equal(result.duplicate_frontend_count, 1);
    assert.equal(spawnCalls, 0);
    assert.equal(checkpoints.at(-1).status, 'KNOWN_BUSY_BEFORE_SPAWN');
    assert.equal(checkpoints.at(-1).process.frontends[0].start_time_ticks, '925000');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('plain resume transport rechecks durable rollout after one early coalesced notification', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-resume-coalesced-watch-'));
  try {
    const rolloutPath = join(root, 'rollout.jsonl');
    const sessionId = '01a05952-e1fa-71e2-adea-df7e3f7d99ce';
    const message = 'OPSLE_WAKE v1 event=event-coalesced gen=3; read durable state.';
    writeFileSync(rolloutPath, `${JSON.stringify({ ordinal: 1, type: 'session_meta' })}\n`);
    const watcher = new EventEmitter();
    watcher.close = () => {};
    const child = new EventEmitter();
    child.pid = 9125;
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let observeRollout;
    let confirmationDeadline;
    let notifications = 0;
    const accepted = JSON.stringify({
      ordinal: 2,
      type: 'response_item',
      payload: {
        type: 'message', role: 'user', content: [{ type: 'input_text', text: message }],
        internal_chat_message_metadata_passthrough: { turn_id: 'turn-coalesced' },
      },
    });
    const began = JSON.stringify({
      ordinal: 3,
      type: 'event_msg',
      payload: {
        type: 'item_completed', thread_id: sessionId, turn_id: 'turn-coalesced',
        item: { type: 'UserMessage', content: [{ type: 'text', text: message }] },
        started_at_ms: 456,
      },
    });
    const resultPromise = runCodexResumeTransport({
      sessionId,
      message,
      rolloutPath,
      watchFactory: (path, callback) => {
        assert.equal(path, rolloutPath);
        observeRollout = (...args) => {
          notifications += 1;
          callback(...args);
        };
        return watcher;
      },
      spawnProcess: () => {
        queueMicrotask(() => {
          const split = Math.floor(accepted.length / 2);
          writeFileSync(rolloutPath, `${readFileSync(rolloutPath, 'utf8')}${accepted.slice(0, split)}`);
          observeRollout('change');
          writeFileSync(rolloutPath, `${readFileSync(rolloutPath, 'utf8')}${accepted.slice(split)}\n${began}\n`);
          confirmationDeadline();
        });
        return child;
      },
      scheduleTimeout: (callback) => {
        confirmationDeadline = callback;
        return { callback };
      },
      cancelTimeout: () => {},
      killProcess: () => {
        child.signalCode = 'SIGTERM';
        child.emit('exit', null, 'SIGTERM');
      },
      inspectFrontends: () => [],
      inspectProcessGroup: () => [],
    });
    const result = await resultPromise;
    assert.equal(notifications, 1);
    assert.equal(result.classification, 'confirmed');
    assert.equal(result.turn_id, 'turn-coalesced');
    assert.equal(result.cleanup_proven, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('default confirmation window accepts exact proof after the former busy boundary', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-resume-busy-boundary-'));
  try {
    const rolloutPath = join(root, 'rollout.jsonl');
    const sessionId = '01a05952-e1fa-71e2-adea-df7e3f7d99ce';
    const message = 'OPSLE_WAKE v1 event=event-busy-boundary gen=3; read durable state.';
    writeFileSync(rolloutPath, `${JSON.stringify({ ordinal: 1, type: 'session_meta' })}\n`);
    const watcher = new EventEmitter();
    watcher.close = () => {};
    const child = new EventEmitter();
    child.pid = 9140;
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let observeRollout;
    let scheduledBound;
    const result = await runCodexResumeTransport({
      sessionId,
      message,
      rolloutPath,
      watchFactory: (_path, callback) => {
        observeRollout = callback;
        return watcher;
      },
      spawnProcess: () => {
        queueMicrotask(() => {
          const simulatedAcceptanceAtMs = 30_001;
          assert.ok(simulatedAcceptanceAtMs < scheduledBound);
          const records = [{
            ordinal: 2,
            type: 'response_item',
            payload: {
              type: 'message', role: 'user', content: [{ type: 'input_text', text: message }],
              internal_chat_message_metadata_passthrough: { turn_id: 'turn-busy-boundary' },
            },
          }, {
            ordinal: 3,
            type: 'event_msg',
            payload: {
              type: 'item_completed', thread_id: sessionId, turn_id: 'turn-busy-boundary',
              item: { type: 'UserMessage', content: [{ type: 'text', text: message }] },
              started_at_ms: simulatedAcceptanceAtMs,
            },
          }];
          writeFileSync(
            rolloutPath,
            `${readFileSync(rolloutPath, 'utf8')}${records.map(JSON.stringify).join('\n')}\n`,
          );
          observeRollout('change');
        });
        return child;
      },
      scheduleTimeout: (_callback, milliseconds) => {
        scheduledBound = milliseconds;
        return { milliseconds };
      },
      cancelTimeout: () => {},
      killProcess: () => {
        child.signalCode = 'SIGTERM';
        child.emit('exit', null, 'SIGTERM');
      },
      inspectFrontends: () => [],
      inspectProcessGroup: () => [],
    });
    assert.equal(CODEX_RESUME_CONFIRMATION_TIMEOUT_MS, 120_000);
    assert.equal(scheduledBound, CODEX_RESUME_CONFIRMATION_TIMEOUT_MS);
    assert.equal(result.classification, 'confirmed');
    assert.equal(result.turn_id, 'turn-busy-boundary');
    assert.equal(result.cleanup_proven, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('deadline expiry stays uncertain and helper covers both cleanup phases', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-resume-deadline-'));
  try {
    const rolloutPath = join(root, 'rollout.jsonl');
    const sessionId = '01a05952-e1fa-71e2-adea-df7e3f7d99ce';
    const message = 'OPSLE_WAKE v1 event=event-deadline gen=3; read durable state.';
    writeFileSync(rolloutPath, `${JSON.stringify({ ordinal: 1, type: 'session_meta' })}\n`);
    const watcher = new EventEmitter();
    watcher.close = () => {};
    const child = new EventEmitter();
    child.pid = 9145;
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let expireConfirmation;
    let scheduledBound;
    const result = await runCodexResumeTransport({
      sessionId,
      message,
      rolloutPath,
      watchFactory: () => watcher,
      spawnProcess: () => {
        queueMicrotask(() => expireConfirmation());
        return child;
      },
      scheduleTimeout: (callback, milliseconds) => {
        expireConfirmation = callback;
        scheduledBound = milliseconds;
        return { milliseconds };
      },
      cancelTimeout: () => {},
      cleanupTimeoutMs: 0,
      killProcess: () => {
        child.signalCode = 'SIGTERM';
        child.emit('exit', null, 'SIGTERM');
      },
      inspectFrontends: () => [],
      inspectProcessGroup: () => [],
    });
    assert.equal(scheduledBound, CODEX_RESUME_CONFIRMATION_TIMEOUT_MS);
    assert.equal(result.classification, 'uncertain');
    assert.equal(result.reason, 'rollout-confirmation-deadline-reached-after-spawn');

    let helperTimeout;
    const helperEvidencePath = join(root, 'helper-evidence.json');
    writeJson(helperEvidencePath, {
      schema: 'opsle.durable-supervisor.codex-resume-transport-attempt/v1',
      transport_attempt_id: 'transport-attempt-helper-timeout-fixture',
    });
    const transport = plainCodexResumeTransport({
      run: (_command, _args, options) => {
        helperTimeout = options.timeout;
        return { status: 0, signal: null, stderr: '', stdout: `${JSON.stringify({ classification: 'uncertain' })}\n` };
      },
    });
    transport.resume({
      session_id: sessionId,
      message,
      transport_attempt_path: helperEvidencePath,
      binding: {
        repository_realpath: root,
        rollout: { realpath: rolloutPath },
        host: { process: { pid: 1, start_time_ticks: '1', executable: '/bin/node' } },
      },
    });
    assert.equal(
      CODEX_RESUME_WORST_CASE_CLEANUP_TIMEOUT_MS,
      CODEX_RESUME_CLEANUP_TIMEOUT_MS * 2,
    );
    assert.equal(CODEX_RESUME_HELPER_TIMEOUT_MS, 135_000);
    assert.equal(ACTIVATION_LEASE_TTL_MS, 180_000);
    assert.ok(ACTIVATION_LEASE_TTL_MS > CODEX_RESUME_HELPER_TIMEOUT_MS);
    assert.equal(helperTimeout, CODEX_RESUME_HELPER_TIMEOUT_MS);
    assert.ok(helperTimeout > (
      CODEX_RESUME_CONFIRMATION_TIMEOUT_MS
      + CODEX_RESUME_WORST_CASE_CLEANUP_TIMEOUT_MS
    ));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('plain resume transport classifies live busy output while the stdin keeper remains alive', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-resume-busy-'));
  try {
    const rolloutPath = join(root, 'rollout.jsonl');
    const sessionId = '01a05952-e1fa-71e2-adea-df7e3f7d99ce';
    const message = 'OPSLE_WAKE v1 event=event-busy gen=3; read durable state.';
    writeFileSync(rolloutPath, `${JSON.stringify({ ordinal: 1, type: 'session_meta' })}\n`);
    const watcher = new EventEmitter();
    watcher.close = () => {};
    const child = new EventEmitter();
    child.pid = 9150;
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let exitedBeforeCleanup = false;
    let confirmationTimerCalled = false;
    let confirmationTimerCancelled = false;
    const result = await runCodexResumeTransport({
      sessionId,
      message,
      rolloutPath,
      spawnProcess: () => {
        queueMicrotask(() => {
          child.stdout.emit('data', Buffer.from('Session is bu'));
          child.stdout.emit('data', Buffer.from('sy; try again later'));
        });
        return child;
      },
      watchFactory: () => watcher,
      scheduleTimeout: (callback) => {
        return {
          callback: () => {
            confirmationTimerCalled = true;
            callback();
          },
        };
      },
      cancelTimeout: () => { confirmationTimerCancelled = true; },
      killProcess: (pid, signal) => {
        assert.equal(pid, -9150);
        assert.equal(signal, 'SIGTERM');
        exitedBeforeCleanup = child.exitCode != null || child.signalCode != null;
        child.signalCode = 'SIGTERM';
        child.emit('exit', null, 'SIGTERM');
      },
      inspectFrontends: () => [],
      inspectProcessGroup: () => [],
    });
    assert.equal(result.classification, 'busy');
    assert.equal(result.reason, 'codex-resume-busy-before-acceptance');
    assert.equal(exitedBeforeCleanup, false);
    assert.equal(confirmationTimerCalled, false);
    assert.equal(confirmationTimerCancelled, true);
    assert.equal(result.cleanup_proven, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('transport journal distinguishes spawn failure, session rejection, and early termination', async () => {
  const sessionId = '01a05952-e1fa-71e2-adea-df7e3f7d99ce';
  const message = 'OPSLE_WAKE v1 event=event-failure-evidence gen=3; read durable state.';
  for (const scenario of [
    {
      name: 'spawn-failure',
      expectedClassification: 'rejected',
      expectedReason: 'resume-spawn-rejected: executable unavailable',
      spawn() { throw new Error('executable unavailable'); },
    },
    {
      name: 'session-rejection',
      expectedClassification: 'rejected',
      expectedReason: 'codex-session-rejected-before-acceptance',
      stderr: 'session not found',
    },
    {
      name: 'early-termination',
      expectedClassification: 'uncertain',
      expectedReason: 'codex-resume-exited-without-rollout-acceptance-proof',
      stderr: 'frontend terminated',
    },
  ]) {
    const root = mkdtempSync(join(tmpdir(), `codex-resume-${scenario.name}-`));
    try {
      const rolloutPath = join(root, 'rollout.jsonl');
      writeFileSync(rolloutPath, `${JSON.stringify({ ordinal: 1, type: 'session_meta' })}\n`);
      const watcher = new EventEmitter();
      watcher.close = () => {};
      const checkpoints = [];
      const child = new EventEmitter();
      child.pid = 9700;
      child.exitCode = null;
      child.signalCode = null;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      const spawnProcess = scenario.spawn ?? (() => {
        queueMicrotask(() => {
          child.stderr.emit('data', Buffer.from(scenario.stderr));
          if (child.exitCode == null && child.signalCode == null) {
            child.exitCode = 1;
            child.emit('exit', 1, null);
          }
        });
        return child;
      });
      const result = await runCodexResumeTransport({
        sessionId,
        message,
        rolloutPath,
        spawnProcess,
        watchFactory: () => watcher,
        checkpointEvidence: (evidence) => checkpoints.push(evidence),
        inspectExecutable: () => ({
          requested: 'codex', resolved: '/opt/codex', version: 'codex-cli 0.152.1', version_error: null,
        }),
        inspectFrontends: () => [],
        inspectProcessGroup: () => [],
        killProcess: () => {
          const error = new Error('gone');
          error.code = 'ESRCH';
          throw error;
        },
        authoritativeHostProcess: {
          pid: 700, start_time_ticks: '7000', executable: '/opt/herdr',
        },
        inspectHostProcess: (pid) => (pid === 700 ? {
          pid: 700, pgrp: 7000, start_time_ticks: '7000', executable: '/opt/herdr',
        } : {
          pid, pgrp: pid, start_time_ticks: '970000', executable: '/bin/sh', command_line: ['/bin/sh'],
        }),
      });
      assert.equal(result.classification, scenario.expectedClassification, scenario.name);
      assert.equal(result.reason, scenario.expectedReason, scenario.name);
      const final = checkpoints.at(-1);
      assert.equal(final.outcome.classification, scenario.expectedClassification);
      assert.equal(final.confirmation_absence, scenario.expectedReason);
      assert.match(final.timestamps.deadline_at, /^\d{4}-\d{2}-\d{2}T/);
      if (scenario.name === 'spawn-failure') {
        assert.equal(result.spawned, false);
        assert.equal(final.timestamps.spawned_at, null);
        assert.equal(final.cleanup.required, false);
      } else {
        assert.equal(final.process.exit_code, 1);
        assert.equal(final.output.stderr, scenario.stderr);
        assert.equal(final.output.stderr_observed_bytes, Buffer.byteLength(scenario.stderr));
        assert.match(final.timestamps.exit_at, /^\d{4}-\d{2}-\d{2}T/);
        assert.equal(final.cleanup.cleanup_proven, true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('bound rollout opportunity closes registration races exactly once', async () => {
  const root = fixture();
  try {
    const bound = bindingFixture(root);
    const stats = statSync(bound.rolloutPath);
    const baseline = {
      path: realpathSync(bound.rolloutPath),
      device: stats.dev,
      inode: stats.ino,
      size_bytes: stats.size,
    };
    const watcher = new EventEmitter();
    let closes = 0;
    watcher.close = () => { closes += 1; };
    const observation = registerBoundRolloutOpportunity(root, baseline, {
      watchFactory: (directory) => {
        assert.equal(directory, resolve(bound.rolloutPath, '..'));
        writeFileSync(bound.rolloutPath, `${readFileSync(bound.rolloutPath, 'utf8')}${JSON.stringify({
          ordinal: 2, type: 'event_msg', payload: { type: 'turn_complete' },
        })}\n`);
        return watcher;
      },
    });
    const first = await observation.wait();
    const second = await observation.wait();
    assert.equal(first.type, 'bound-rollout-state-change');
    assert.deepEqual(second, first);
    assert.equal(closes, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('nonterminal wrapper returns and heartbeat cannot make a wait model-ready', () => {
  let current = wait();
  for (const [index, type] of [
    'heartbeat',
    'host-wrapper-yield',
    'host-wrapper-timeout',
    'nonterminal-return',
  ].entries()) {
    current = applyWakeEvent(current, {
      event_id: `event-${index}`,
      wait_id: current.wait_id,
      type,
    });
    assert.equal(current.state, 'WAITING');
    assert.equal(current.wake, null);
  }
});

test('heartbeat and nonterminal progress cannot enter the dispatcher queue', () => {
  const root = fixture();
  try {
    for (const type of ['HEARTBEAT', 'CHILD_PROGRESS']) {
      assert.throws(() => enqueueTerminalWake(root, {
        event_id: `event-${type.toLowerCase()}`,
        type,
        terminal_type: 'heartbeat',
      }), /only durable terminal child events/);
    }
    assert.equal(existsSync(join(root, '.opsle', 'wake')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('terminal and human wakes are distinct and duplicate terminal wake is idempotent', () => {
  const terminalEvent = {
    event_id: 'event-terminal',
    wait_id: 'wait-1',
    type: 'child-timeout',
  };
  const terminal = applyWakeEvent(wait(), terminalEvent);
  assert.equal(terminal.state, 'READY');
  assert.equal(terminal.wake.class, 'terminal-event');
  assert.equal(terminal.wake.automatic, true);
  assert.strictEqual(applyWakeEvent(terminal, terminalEvent), terminal);

  const human = applyWakeEvent(wait(), {
    event_id: 'event-human',
    wait_id: 'wait-1',
    type: 'human-interaction',
  });
  assert.equal(human.state, 'WAITING');
  assert.equal(human.wake, null);
  assert.deepEqual(human.human_interactions, [{
    event_id: 'event-human',
    class: 'human',
    automatic: false,
  }]);
});

test('host adapter mechanically consumes nonterminal returns inside one bounded wait', async () => {
  const results = [
    { session_id: 7 },
    { session_id: 7 },
    { exit_code: 0, output: 'done' },
  ];
  const consumed = await consumeTerminalSession({
    start: async () => results.shift(),
    resume: async () => results.shift(),
    deadlineMs: 100,
    nowMs: () => 0,
  });
  assert.equal(consumed.result.exit_code, 0);
  assert.equal(consumed.nonterminal_returns_consumed, 2);
  assert.equal(results.length, 0);
});

test('host adapter fails closed when its explicit deadline expires', async () => {
  await assert.rejects(
    consumeTerminalSession({
      start: async () => ({ session_id: 9 }),
      resume: async () => new Promise(() => {}),
      deadlineMs: Date.now() + 10,
    }),
    (error) => error.code === 'TERMINAL_WAIT_DEADLINE',
  );
});

test('visible Codex pane classification distinguishes idle, busy, composed, and ambiguous states', () => {
  assert.equal(classifyCodexPane('header\n› \nfooter\n', { x: 2, y: 1 }).prompt_state, 'idle');
  assert.equal(classifyCodexPane('header\n• Working (2s • esc to interrupt)\n', { x: 3, y: 1 }).prompt_state, 'busy');
  assert.equal(classifyCodexPane('header\n› do not submit this\n', { x: 20, y: 1 }).prompt_state, 'human-composer');
  assert.equal(classifyCodexPane('header\nno prompt\n', { x: 0, y: 1 }).prompt_state, 'ambiguous');
});

test('tmux commit uses one server-side predicate sequence for literal paste and Enter', () => {
  for (const changedAtBoundary of [false, true]) {
    const calls = [];
    const deliveryId = changedAtBoundary ? 'delivery-rejected' : 'delivery-submitted';
    const marker = `${changedAtBoundary ? 'rejected' : 'submitted'}-${deliveryId}`;
    const host = createTmuxHost({
      run(command, args) {
        calls.push({ command, args });
        if (args[0] === 'show-options') return { status: 0, stdout: `${marker}\n`, stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    const result = host.commit({
      expected: {
        session_name: 'opsle-wake-fixture',
        pane_id: '%7',
        pane_pid: 700,
        current_command: 'codex',
        cursor: { x: 0, y: 40 },
        capture_sha256: 'a'.repeat(64),
        codex_process: hostEvidence().codex_process,
        durable_files: [
          { path: '/tmp/supervisor.json', sha256: 'b'.repeat(64) },
          { path: '/tmp/request.json', sha256: 'c'.repeat(64) },
          { path: '/tmp/receipt.json', sha256: 'd'.repeat(64) },
        ],
      },
      prompt: 'literal prompt; no shell interpretation',
      deliveryId,
    });
    assert.equal(result.submitted, !changedAtBoundary);
    const commitCall = calls.find((call) => call.args[0] === 'if-shell');
    assert.ok(commitCall);
    assert.match(commitCall.args[4], /session_attached/);
    assert.match(commitCall.args[4], /cursor_x/);
    assert.match(commitCall.args[4], /pane_current_command/);
    assert.match(commitCall.args[5], /paste-buffer .* ; send-keys .* Enter ; set-option/);
    assert.match(commitCall.args[5], /capture-pane/);
    assert.match(commitCall.args[5], /\/proc\/701\/stat/);
    assert.match(commitCall.args[5], /supervisor\.json/);
    assert.equal(calls.filter((call) => call.args[0] === 'send-keys').length, 0);
    assert.equal(calls[0].args[0], 'set-buffer');
    assert.equal(calls[0].args.at(-1), 'literal prompt; no shell interpretation');
  }
});

test('trajectory evidence classifies terminal, human, and wait-induced activations', () => {
  const output = (timestamp, value) => ({
    timestamp,
    type: 'response_item',
    payload: {
      type: 'custom_tool_call_output',
      output: [{ text: JSON.stringify(value) }],
    },
  });
  const next = (timestamp) => ({
    timestamp,
    type: 'response_item',
    payload: { type: 'custom_tool_call' },
  });
  const records = [
    output('2026-08-31T20:00:01.000Z', { session_id: 3 }),
    next('2026-08-31T20:00:02.000Z'),
    output('2026-08-31T20:00:03.000Z', { exit_code: 0 }),
    next('2026-08-31T20:00:04.000Z'),
    {
      timestamp: '2026-08-31T20:00:05.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user' },
    },
    output('2026-08-31T20:00:06.000Z', { output: 'status' }),
    next('2026-08-31T20:00:07.000Z'),
  ];
  const profile = profileCodexActivations(records, {
    start: '2026-08-31T20:00:00.000Z',
    end: '2026-08-31T20:00:08.000Z',
  });
  assert.deepEqual(profile.counts, {
    total_automatic: 2,
    terminal_event: 1,
    human: 1,
    wait_induced_automatic: 1,
  });
});

test('delivery classification uses current host evidence and fails closed for unsafe states', () => {
  const supervisor = { supervisor_id: 'supervisor-1', generation: 3 };
  const request = {
    schema: 'opsle.durable-supervisor.host-wake-request/v1',
    target: { supervisor_id: 'supervisor-1', supervisor_generation: 3, tmux_session: 'opsle-wake-fixture' },
    queue_version: 1,
  };
  const classify = (values = {}) => classifyWakeDelivery({
    request,
    supervisor,
    busy: null,
    evidence: hostEvidence(),
    ...values,
  }).classification;
  assert.equal(classify(), 'prompt-idle');
  assert.equal(classify({ busy: { event_id: 'busy' } }), 'busy');
  assert.equal(classify({ evidence: hostEvidence({ attached_clients: ['/dev/pts/9'] }) }), 'human-interacting');
  assert.equal(classify({ evidence: { available: false } }), 'unavailable');
  assert.equal(classify({ supervisor: { ...supervisor, generation: 4 } }), 'stale-generation');
  assert.equal(classify({ evidence: hostEvidence({ prompt_state: 'busy', prompt_idle: false }) }), 'busy');
  assert.equal(classify({
    evidence: hostEvidence({
      prompt_state: 'human-composer',
      prompt_idle: false,
      composer_empty: false,
      composer_text: 'human draft',
    }),
  }), 'human-interacting');
  assert.equal(classify({
    evidence: hostEvidence({ prompt_state: 'ambiguous', prompt_idle: false, composer_empty: false }),
  }), 'ambiguous-composer');
});

test('duplicate dispatcher start is idempotent and exact process death advances dispatcher generation', () => {
  const root = fixture();
  try {
    let nextPid = 8200;
    const live = new Map();
    const getProcessIdentity = (pid) => live.get(pid) ?? null;
    const spawnProcess = () => {
      const pid = nextPid;
      nextPid += 1;
      live.set(pid, { pid, start_time_ticks: String(pid * 10), executable: '/usr/bin/node' });
      return { pid, unref() {} };
    };
    const first = ensureWakeDispatcher(root, { spawnProcess, getProcessIdentity });
    const duplicate = ensureWakeDispatcher(root, { spawnProcess, getProcessIdentity });
    assert.equal(first.started, true);
    assert.equal(duplicate.started, false);
    assert.equal(nextPid, 8201);
    live.delete(first.dispatcher.process.pid);
    const restarted = ensureWakeDispatcher(root, { spawnProcess, getProcessIdentity });
    assert.equal(restarted.started, true);
    assert.equal(restarted.dispatcher.dispatcher_generation, first.dispatcher.dispatcher_generation + 1);
    assert.equal(nextPid, 8202);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('authoritative Herdr Codex binding validates exact identity and rejects generation drift', () => {
  const root = fixture();
  try {
    const bound = bindingFixture(root, { bind: false });
    const status = sessionCommand(root, 'bind', [
      '--session', bound.sessionId,
      '--rollout', bound.rolloutPath,
      '--sessions-root', bound.sessionsRoot,
      '--host-pid', '700',
      '--workspace-id', bound.host.workspace_id,
      '--workspace-cwd', bound.host.workspace_cwd,
      '--pane-id', bound.host.pane_id,
      '--terminal-id', bound.host.terminal_id,
    ], { dependencies: bound.dependencies });
    assert.equal(status.classification, 'bound-authoritative-herdr');
    assert.equal(status.valid, true);
    assert.equal(status.supported, true);
    assert.equal(status.binding.codex_session_uuid, bound.sessionId);
    assert.equal(status.binding.rollout.realpath, realpathSync(bound.rolloutPath));
    assert.equal(status.binding.rollout.device, statSync(bound.rolloutPath).dev);
    assert.equal(status.binding.rollout.inode, statSync(bound.rolloutPath).ino);
    assert.equal(status.binding.codex_cli_version, 'codex-cli 0.152.0');
    assert.equal(status.binding.host.authority, 'authoritative');
    assert.equal(status.binding.host.process.uid, 1000);
    assert.equal(status.binding.native_wake.transport, 'plain-codex-resume');
    assert.deepEqual(validateDurableState(root), { valid: true, errors: [] });

    const supervisor = readJson(paths(root).supervisor);
    supervisor.generation += 1;
    writeJson(paths(root).supervisor, supervisor);
    const stale = sessionCommand(root, 'status', [], { dependencies: bound.dependencies });
    assert.equal(stale.valid, false);
    assert.ok(stale.reasons.includes('supervisor-generation-stale'));
    assert.throws(
      () => sessionCommand(root, 'adopt', [], { dependencies: bound.dependencies }),
      /must be replaced|generation drift/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('session binding fails deterministically for duplicate and mismatched identity facts', () => {
  const duplicateRoot = fixture();
  try {
    const duplicate = bindingFixture(duplicateRoot, { duplicate: true });
    assert.throws(() => bindCodexSession(duplicateRoot, {
      sessionId: duplicate.sessionId,
      rolloutPath: duplicate.rolloutPath,
      sessionsRoot: duplicate.sessionsRoot,
      hostPid: 700,
      workspaceId: duplicate.host.workspace_id,
      workspaceCwd: duplicate.host.workspace_cwd,
      paneId: duplicate.host.pane_id,
      terminalId: duplicate.host.terminal_id,
    }, { dependencies: duplicate.dependencies }), /one exact rollout candidate/);
  } finally {
    rmSync(duplicateRoot, { recursive: true, force: true });
  }

  const cases = [
    ['wrong repository', ({ dependencies }, root) => ({
      ...dependencies,
      realpath: (path) => (path === root ? '/wrong/repository' : realpathSync(path)),
    }), 'repository-mismatch'],
    ['dead or reused Herdr host process', ({ dependencies }) => ({
      ...dependencies,
      processIdentity: (pid) => (pid === 700 ? null : dependencies.processIdentity(pid)),
    }), 'herdr-host-process-dead-or-reused'],
    ['old tmux authority returned', ({ dependencies }) => ({
      ...dependencies,
      legacyTmuxAuthority: () => true,
    }), 'old-tmux-authority-live'],
    ['installed CLI changed', ({ dependencies }) => ({
      ...dependencies,
      codexVersion: () => 'codex-cli 0.153.0',
    }), 'codex-cli-version-mismatch'],
  ];
  for (const [label, mutate, reason] of cases) {
    const root = fixture();
    try {
      const bound = bindingFixture(root);
      const status = codexSessionBindingStatus(root, {
        dependencies: mutate(bound, root),
      });
      assert.equal(status.valid, false, label);
      assert.ok(status.reasons.includes(reason), `${label}: ${status.reasons.join(', ')}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const supersededRoot = fixture();
  try {
    const first = bindingFixture(supersededRoot);
    const old = readJson(join(supersededRoot, '.opsle', 'wake', 'codex-session-binding.json'));
    bindCodexSession(supersededRoot, {
      sessionId: first.sessionId,
      rolloutPath: first.rolloutPath,
      sessionsRoot: first.sessionsRoot,
      hostPid: 700,
      workspaceId: first.host.workspace_id,
      workspaceCwd: first.host.workspace_cwd,
      paneId: first.host.pane_id,
      terminalId: first.host.terminal_id,
    }, { dependencies: first.dependencies });
    const stale = codexSessionBindingStatus(supersededRoot, {
      binding: old,
      dependencies: first.dependencies,
    });
    assert.equal(stale.valid, false);
    assert.ok(stale.reasons.includes('session-binding-superseded'));
  } finally {
    rmSync(supersededRoot, { recursive: true, force: true });
  }

  const identityRoot = fixture();
  try {
    const bound = bindingFixture(identityRoot);
    const binding = readJson(join(identityRoot, '.opsle', 'wake', 'codex-session-binding.json'));
    const changedSession = codexSessionBindingStatus(identityRoot, {
      binding: { ...binding, codex_session_uuid: '01a05952-e1fa-71e2-adea-df7e3f7d99cf' },
      dependencies: bound.dependencies,
    });
    assert.equal(changedSession.valid, false);
    assert.ok(changedSession.reasons.includes('rollout-session-meta-mismatch'));
    const supervisor = readJson(paths(identityRoot).supervisor);
    supervisor.supervisor_id = 'supervisor-replaced';
    writeJson(paths(identityRoot).supervisor, supervisor);
    const changedSupervisor = codexSessionBindingStatus(identityRoot, {
      dependencies: bound.dependencies,
    });
    assert.equal(changedSupervisor.valid, false);
    assert.ok(changedSupervisor.reasons.includes('supervisor-identity-mismatch'));
  } finally {
    rmSync(identityRoot, { recursive: true, force: true });
  }

  for (const mode of ['metadata', 'missing', 'replaced', 'duplicate']) {
    const root = fixture();
    try {
      const bound = bindingFixture(root);
      if (mode === 'metadata') {
        writeFileSync(bound.rolloutPath, `${JSON.stringify({
          type: 'session_meta', payload: { id: bound.sessionId, cwd: '/wrong/repository' },
        })}\n`);
      } else if (mode === 'missing') {
        unlinkSync(bound.rolloutPath);
      } else if (mode === 'replaced') {
        unlinkSync(bound.rolloutPath);
        writeFileSync(bound.rolloutPath, `${JSON.stringify({
          type: 'session_meta', payload: { id: bound.sessionId, cwd: root },
        })}\n`);
      } else {
        writeFileSync(join(bound.sessionsRoot, 'late-duplicate.jsonl'), `${JSON.stringify({
          type: 'session_meta', payload: { id: bound.sessionId, cwd: root },
        })}\n`);
      }
      const status = codexSessionBindingStatus(root, { dependencies: bound.dependencies });
      assert.equal(status.valid, false, mode);
      assert.ok(status.reasons.some((reason) => (
        reason.startsWith('rollout-') || reason === 'duplicate-or-missing-rollout-candidate'
      )), status.reasons.join(', '));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('authoritative Herdr binding rejects stale tmux authority before any transport call', async () => {
  const root = fixture();
  try {
    const bound = bindingFixture(root);
    const event = terminalEvent(root, 'unsupported-writer');
    enqueueTerminalWake(root, event);
    let resumeCalls = 0;
    bound.dependencies.legacyTmuxAuthority = () => true;
    const nativeTransport = {
      kind: 'plain-codex-resume',
      resume: () => { resumeCalls += 1; return {
        classification: 'confirmed', cleanup_proven: true,
        authoritative_host_continuity_proven: true,
      }; },
    };
    const result = deliverWake(root, event.event_id, {
      nativeTransport,
      bindingDependencies: bound.dependencies,
    });
    assert.equal(result.classification, 'queued');
    assert.equal(result.reason, 'codex-session-binding-stale');
    assert.equal(result.delivered, false);
    assert.equal(resumeCalls, 0);
    assert.equal(existsSync(join(root, '.opsle', 'wake', 'requests', `${event.event_id}.json`)), true);
    assert.equal(existsSync(join(root, '.opsle', 'wake', 'deliveries', `${event.event_id}.json`)), false);
    assert.equal(existsSync(join(root, '.opsle', 'wake', 'activation-decisions', `${event.event_id}.json`)), false);

    const owner = processIdentity(process.pid);
    const dispatcher = stageDispatcher(root, {
      pid: owner.pid,
      startTime: owner.start_time_ticks,
    });
    dispatcher.process.executable = owner.executable;
    writeJson(join(root, '.opsle', 'wake', 'dispatcher.json'), dispatcher);
    const dispatched = await runWakeDispatcher(root, {
      dispatcherId: dispatcher.dispatcher_id,
      dispatcherGeneration: dispatcher.dispatcher_generation,
      launchNonce: dispatcher.launch_nonce,
      pid: dispatcher.process.pid,
      getProcessIdentity: () => dispatcher.process,
      nativeTransport,
      bindingDependencies: bound.dependencies,
      maxCycles: 1,
    });
    assert.equal(dispatched.results[0].classification, 'queued');
    assert.equal(resumeCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unchanged delivery fences preserve canonical plain Codex resume exactly once', () => {
  const root = fixture();
  try {
    const bound = bindingFixture(root);
    const event = terminalEvent(root, 'native-supported');
    enqueueTerminalWake(root, event);
    const dispatcher = stageCurrentDispatcher(root);
    const calls = [];
    const nativeTransport = {
      kind: 'plain-codex-resume',
      resume: (request) => {
        calls.push(request);
        return confirmedResumeResult(request.session_id, request.message, 9000);
      },
    };
    const delivered = deliverWake(root, event.event_id, {
      nativeTransport,
      bindingDependencies: bound.dependencies,
      dispatcher,
    });
    assert.equal(delivered.delivered, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].message, constructWakeMessage(
      event.event_id,
      readJson(paths(root).supervisor).generation,
    ));
    assert.match(calls[0].message, /^OPSLE_WAKE v1 event=[^ ]+ gen=\d+; read durable state\.$/);
    assert.doesNotMatch(calls[0].message, /task-|attempt-|child output|claimed outcome/i);
    assert.equal(deliverWake(root, event.event_id, {
      nativeTransport,
      bindingDependencies: bound.dependencies,
      dispatcher,
    }).classification, 'duplicate');
    assert.equal(calls.length, 1);
    assert.deepEqual(delivered.receipt.temporary_frontend.argv, [
      'codex', 'resume', bound.sessionId, calls[0].message,
    ]);
    assert.equal(delivered.receipt.temporary_frontend.cleanup_proven, true);
    assert.equal(delivered.receipt.rollout_confirmation.turn_id, 'turn-1');
    assert.equal(readJson(join(
      root,
      '.opsle',
      'wake',
      'activation-decisions',
      `${event.event_id}.json`,
    )).status, 'DELIVERED');
    assert.equal(events(root).filter((entry) => (
      entry.type === 'HOST_WAKE_DELIVERED'
      && entry.source_event_id === event.event_id
    )).length, 1);
    const generation = readJson(paths(root).supervisor).generation;
    assert.throws(() => consumeWakeDelivery(root, event.event_id, {
      deliveryId: delivered.receipt.delivery_id,
      generation: generation + 1,
    }), /stale supervisor generation/);
    assert.equal(consumeWakeDelivery(root, event.event_id, {
      deliveryId: delivered.receipt.delivery_id,
      generation,
    }).duplicate, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const regression of [
  {
    name: 'supervisor generation recovery',
    reason: 'supervisor-delivery-fence-changed-after-native-transport',
    mutate(root) {
      const supervisor = readJson(paths(root).supervisor);
      supervisor.generation += 1;
      writeJson(paths(root).supervisor, supervisor);
    },
  },
  {
    name: 'supervisor identity replacement',
    reason: 'supervisor-delivery-fence-changed-after-native-transport',
    mutate(root) {
      const supervisor = readJson(paths(root).supervisor);
      supervisor.supervisor_id = 'supervisor-mid-transport-replacement';
      writeJson(paths(root).supervisor, supervisor);
    },
  },
  {
    name: 'dispatcher generation replacement',
    reason: 'dispatcher-fence-no-longer-current-after-native-transport',
    mutate(root) {
      const path = join(root, '.opsle', 'wake', 'dispatcher.json');
      const dispatcher = readJson(path);
      dispatcher.dispatcher_generation += 1;
      writeJson(path, dispatcher);
    },
  },
  {
    name: 'dispatcher process replacement',
    reason: 'dispatcher-fence-no-longer-current-after-native-transport',
    mutate(root) {
      const path = join(root, '.opsle', 'wake', 'dispatcher.json');
      const dispatcher = readJson(path);
      dispatcher.process.start_time_ticks = 'replacement-start-time';
      writeJson(path, dispatcher);
    },
  },
  {
    name: 'queue version change',
    reason: 'wake-queue-version-changed-after-native-transport',
    mutate(root, eventId) {
      const path = join(root, '.opsle', 'wake', 'requests', `${eventId}.json`);
      const request = readJson(path);
      request.queue_version += 1;
      writeJson(path, request);
    },
  },
  {
    name: 'request content change',
    reason: 'wake-request-changed-after-native-transport',
    mutate(root, eventId) {
      const path = join(root, '.opsle', 'wake', 'requests', `${eventId}.json`);
      const request = readJson(path);
      request.attempt_id = 'attempt-mid-transport-replacement';
      writeJson(path, request);
    },
  },
  {
    name: 'activation lease takeover',
    reason: 'activation-lease-fence-changed-after-native-transport',
    mutate(root) {
      const path = join(root, '.opsle', 'wake', 'activation-lease.json');
      const lease = readJson(path);
      lease.lease_id = 'activation-lease-mid-transport-takeover';
      lease.event_id = 'event-mid-transport-takeover';
      lease.fencing_token += 1;
      writeJson(path, lease);
    },
  },
  {
    name: 'activation decision replacement',
    reason: 'activation-decision-fence-mismatch',
    decisionFailure: 'concurrent-uncertain-decision',
    mutate(root, eventId) {
      const path = join(
        root,
        '.opsle',
        'wake',
        'activation-decisions',
        `${eventId}.json`,
      );
      const decision = readJson(path);
      decision.status = 'UNCERTAIN';
      decision.failure = 'concurrent-uncertain-decision';
      writeJson(path, decision);
    },
  },
]) {
  test(`confirmed transport fails closed after mid-transport ${regression.name}`, () => {
    const root = fixture();
    try {
      const bound = bindingFixture(root);
      const event = terminalEvent(root, `post-transport-${regression.name.replaceAll(' ', '-')}`);
      enqueueTerminalWake(root, event);
      const dispatcher = stageCurrentDispatcher(root);
      const attemptPath = join(paths(root).attempts, `${event.attempt_id}.json`);
      writeJson(attemptPath, {
        attempt_id: event.attempt_id,
        telemetry: {
          activation_counts: {
            evidence: 'fixture',
            total_automatic: 0,
            terminal_event: 0,
            human: 0,
            wait_induced_automatic: 0,
          },
        },
      });
      const stateBefore = readFileSync(paths(root).state);
      const telemetryBefore = readFileSync(attemptPath);
      let transportCalls = 0;
      const nativeTransport = {
        kind: 'plain-codex-resume',
        resume: (request) => {
          transportCalls += 1;
          regression.mutate(root, event.event_id);
          return confirmedResumeResult(request.session_id, request.message, 9300);
        },
      };
      const result = deliverWake(root, event.event_id, {
        nativeTransport,
        bindingDependencies: bound.dependencies,
        dispatcher,
      });
      assert.equal(result.classification, 'uncertain');
      assert.equal(result.reason, regression.reason);
      assert.equal(result.delivered, false);
      assert.equal(result.replayed, false);
      assert.equal(transportCalls, 1);
      assert.equal(existsSync(join(
        root,
        '.opsle',
        'wake',
        'deliveries',
        `${event.event_id}.json`,
      )), false);
      const decision = readJson(join(
        root,
        '.opsle',
        'wake',
        'activation-decisions',
        `${event.event_id}.json`,
      ));
      assert.equal(decision.status, 'UNCERTAIN');
      assert.equal(
        decision.failure,
        regression.decisionFailure ?? regression.reason,
      );
      assert.deepEqual(readFileSync(paths(root).state), stateBefore);
      assert.deepEqual(readFileSync(attemptPath), telemetryBefore);
      assert.equal(events(root).some((entry) => (
        (entry.type === 'SUPERVISOR_ACTIVATION'
          && entry.cause_event_id === event.event_id)
        || (entry.type === 'SUPERVISOR_REACTIVATED'
          && entry.cause_event_id === event.event_id)
        || (entry.type === 'HOST_WAKE_DELIVERED'
          && entry.source_event_id === event.event_id)
      )), false);

      deliverWake(root, event.event_id, {
        nativeTransport,
        bindingDependencies: bound.dependencies,
        dispatcher,
      });
      assert.equal(transportCalls, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('busy-before-acceptance remains queued and dispatcher retry follows an observed state change', async () => {
  const root = fixture();
  try {
    const bound = bindingFixture(root);
    const event = terminalEvent(root, 'busy-retry');
    enqueueTerminalWake(root, event);
    const dispatcherOwner = processIdentity(process.pid);
    const dispatcher = stageDispatcher(root, {
      pid: dispatcherOwner.pid,
      startTime: dispatcherOwner.start_time_ticks,
    });
    dispatcher.process.executable = dispatcherOwner.executable;
    writeJson(join(root, '.opsle', 'wake', 'dispatcher.json'), dispatcher);
    let calls = 0;
    let opportunityWaits = 0;
    let opportunityRegistrations = 0;
    let delayCalls = 0;
    const transport = {
      kind: 'plain-codex-resume',
      resume: (request) => {
        calls += 1;
        if (calls === 1) {
          return { classification: 'busy', reason: 'codex-resume-busy-before-acceptance' };
        }
        return confirmedResumeResult(request.session_id, request.message, 9200, {
          accepted_ordinal: 20, accepted_record_sha256: 'c'.repeat(64),
          turn_began_ordinal: 21, turn_began_record_sha256: 'd'.repeat(64),
          turn_id: 'turn-busy-retry', turn_started_at_ms: 2,
        });
      },
    };
    const result = await runWakeDispatcher(root, {
      dispatcherId: dispatcher.dispatcher_id,
      dispatcherGeneration: dispatcher.dispatcher_generation,
      launchNonce: dispatcher.launch_nonce,
      pid: dispatcher.process.pid,
      getProcessIdentity: () => dispatcher.process,
      nativeTransport: transport,
      bindingDependencies: bound.dependencies,
      observeBoundRollout: (_fixtureRoot, baseline) => {
        opportunityRegistrations += 1;
        assert.equal(baseline.path, realpathSync(bound.rolloutPath));
        return {
        close() {},
        wait: async () => {
          opportunityWaits += 1;
          return { type: 'bound-rollout-state-change', path: bound.rolloutPath };
        },
        };
      },
      delay: async () => { delayCalls += 1; },
      maxCycles: 2,
    });
    assert.equal(opportunityWaits, 1);
    assert.equal(opportunityRegistrations, 2);
    assert.equal(delayCalls, 0);
    assert.equal(calls, 2, JSON.stringify(result));
    assert.equal(result.results[0].classification, 'native-delivered');
    const decision = readJson(join(root, '.opsle', 'wake', 'activation-decisions', `${event.event_id}.json`));
    assert.equal(decision.status, 'DELIVERED');
    assert.equal(decision.prior_attempts[0].status, 'BUSY');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('uncertain dispatcher delivery is not replayed while late confirmation gets one opportunity', async () => {
  const root = fixture();
  try {
    const bound = bindingFixture(root);
    const event = terminalEvent(root, 'uncertain-no-replay');
    enqueueTerminalWake(root, event);
    const owner = processIdentity(process.pid);
    const dispatcher = stageDispatcher(root, {
      pid: owner.pid,
      startTime: owner.start_time_ticks,
    });
    dispatcher.process.executable = owner.executable;
    writeJson(join(root, '.opsle', 'wake', 'dispatcher.json'), dispatcher);
    let calls = 0;
    let waits = 0;
    let closes = 0;
    const result = await runWakeDispatcher(root, {
      dispatcherId: dispatcher.dispatcher_id,
      dispatcherGeneration: dispatcher.dispatcher_generation,
      launchNonce: dispatcher.launch_nonce,
      pid: dispatcher.process.pid,
      getProcessIdentity: () => dispatcher.process,
      nativeTransport: {
        kind: 'plain-codex-resume',
        resume: () => {
          calls += 1;
          return { classification: 'uncertain', reason: 'fixture-uncertain' };
        },
      },
      bindingDependencies: bound.dependencies,
      observeBoundRollout: () => ({
        close: () => { closes += 1; },
        wait: async () => {
          waits += 1;
          return { type: 'bound-rollout-state-change' };
        },
      }),
      maxCycles: 2,
    });
    assert.equal(result.reason, 'test-cycle-limit');
    assert.equal(calls, 1);
    assert.equal(waits, 1);
    assert.equal(closes, 2);
    const decision = readJson(join(root, '.opsle', 'wake', 'activation-decisions', `${event.event_id}.json`));
    assert.equal(decision.status, 'UNCERTAIN');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('late exact confirmation reconciles one uncertain attempt without transport replay or duplicate activation', () => {
  const root = fixture();
  try {
    const bound = bindingFixture(root);
    const event = terminalEvent(root, 'late-confirmation');
    enqueueTerminalWake(root, event);
    const dispatcher = stageCurrentDispatcher(root);
    let calls = 0;
    const transport = {
      kind: 'plain-codex-resume',
      resume(request) {
        calls += 1;
        const evidence = readJson(request.transport_attempt_path);
        evidence.status = 'NON_DELIVERY_AND_CLEANED';
        evidence.transport = {
          baseline_ordinal: -1,
          resolved_executable: {
            requested: 'codex', resolved: '/opt/codex', version: 'codex-cli 0.152.1', version_error: null,
          },
          environment: { fingerprint_sha256: 'e'.repeat(64), key_names: [], selected: {} },
          cwd: root,
        };
        evidence.process = {
          launcher: {
            pid: 9500, process_group: 9500, start_time_ticks: '950000',
            executable: '/bin/sh', command_line_sha256: 'f'.repeat(64),
          },
          frontends: [{
            pid: 9510, process_group: 9510, start_time_ticks: '951000',
            executable: '/opt/codex', command_line_sha256: 'a'.repeat(64),
          }],
          exit_code: null,
          exit_signal: 'SIGTERM',
        };
        evidence.output = {
          stdout: '', stderr: '', stdout_observed_bytes: 0, stderr_observed_bytes: 0,
          capture_limit_bytes: 65536,
        };
        evidence.timestamps = {
          spawn_requested_at: '2026-09-02T02:00:00.000Z',
          spawned_at: '2026-09-02T02:00:00.001Z',
          transport_started_at: '2026-09-02T02:00:00.001Z',
          deadline_at: '2026-09-02T02:02:00.000Z',
          outcome_at: '2026-09-02T02:02:00.000Z',
          cleanup_started_at: '2026-09-02T02:02:00.001Z',
          cleanup_completed_at: '2026-09-02T02:02:00.002Z',
        };
        evidence.confirmation_absence = 'rollout-confirmation-deadline-reached-after-spawn';
        evidence.cleanup = {
          process_group: 9500,
          launcher_exit_observed: true,
          frontend_exit_observed: true,
          tracked_process_groups: [9500, 9510],
          frontend_process_groups: [9510],
          signaled_process_groups: [9500, 9510],
          process_group_member_counts: [
            { process_group: 9500, member_count: 0 },
            { process_group: 9510, member_count: 0 },
          ],
          process_group_member_count: 0,
          duplicate_frontend_count: 0,
          invalid_frontend_identity_count: 0,
          blocked_process_groups: [],
          authoritative_host_process_group: 7000,
          authoritative_host_signaled: false,
          authoritative_host_continuity_proven: true,
          cleanup_proven: true,
        };
        writeJson(request.transport_attempt_path, evidence);
        return {
          classification: 'uncertain',
          reason: 'rollout-confirmation-deadline-reached-after-spawn',
          transport_attempt_id: request.transport_attempt_id,
        };
      },
    };
    const first = deliverWake(root, event.event_id, {
      nativeTransport: transport,
      bindingDependencies: bound.dependencies,
      dispatcher,
    });
    assert.equal(first.classification, 'uncertain');
    assert.equal(calls, 1);
    const decisionPath = join(root, '.opsle', 'wake', 'activation-decisions', `${event.event_id}.json`);
    const uncertainDecision = readJson(decisionPath);
    assert.equal(uncertainDecision.status, 'UNCERTAIN');

    const message = constructWakeMessage(event.event_id, readJson(paths(root).supervisor).generation);
    appendWakeConfirmation(bound.rolloutPath, bound.sessionId, message);
    const staleDispatcher = structuredClone(dispatcher);
    staleDispatcher.dispatcher_generation -= 1;
    const stale = deliverWake(root, event.event_id, {
      nativeTransport: transport,
      bindingDependencies: bound.dependencies,
      dispatcher: staleDispatcher,
    });
    assert.equal(stale.classification, 'stale-generation');
    assert.equal(stale.reason, 'late-confirmation-dispatcher-fence-not-current');
    assert.equal(readJson(decisionPath).status, 'UNCERTAIN');
    assert.equal(calls, 1);
    const reconciled = deliverWake(root, event.event_id, {
      nativeTransport: transport,
      bindingDependencies: bound.dependencies,
      dispatcher,
    });
    assert.equal(reconciled.classification, 'native-delivered');
    assert.equal(reconciled.receipt.late_confirmation, true);
    assert.equal(reconciled.receipt.rollout_confirmation.turn_id, 'turn-late-confirmation');
    assert.equal(calls, 1);
    const deliveredDecision = readJson(decisionPath);
    assert.equal(deliveredDecision.decision_id, uncertainDecision.decision_id);
    assert.equal(deliveredDecision.status, 'DELIVERED');
    assert.equal(deliveredDecision.late_confirmation, true);
    const evidence = readJson(join(
      root, '.opsle', 'wake', 'transport-attempts', `${uncertainDecision.transport_attempt_id}.json`,
    ));
    assert.equal(evidence.status, 'LATE_CONFIRMED_AFTER_CLEANUP');
    assert.equal(evidence.confirmation_absence, null);

    const duplicate = deliverWake(root, event.event_id, {
      nativeTransport: transport,
      bindingDependencies: bound.dependencies,
      dispatcher,
    });
    assert.equal(duplicate.classification, 'duplicate');
    assert.equal(calls, 1);
    assert.equal(events(root).filter((entry) => (
      entry.type === 'SUPERVISOR_ACTIVATION' && entry.cause_event_id === event.event_id
    )).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('known busy bound rollout is durably deferred before transport and retries after exact rollout change', () => {
  const root = fixture();
  try {
    const bound = bindingFixture(root);
    const event = terminalEvent(root, 'known-busy-preflight');
    enqueueTerminalWake(root, event);
    const dispatcher = stageCurrentDispatcher(root);
    writeFileSync(bound.rolloutPath, `${readFileSync(bound.rolloutPath, 'utf8')}${JSON.stringify({
      ordinal: 1,
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-already-running' },
    })}\n`);
    let calls = 0;
    const transport = {
      kind: 'plain-codex-resume',
      resume(request) {
        calls += 1;
        return confirmedResumeResult(request.session_id, request.message, 9600);
      },
    };
    const busy = deliverWake(root, event.event_id, {
      nativeTransport: transport,
      bindingDependencies: bound.dependencies,
      dispatcher,
    });
    assert.equal(busy.classification, 'busy');
    assert.equal(busy.reason, 'bound-rollout-known-busy-before-transport');
    assert.equal(calls, 0);
    const decisionPath = join(root, '.opsle', 'wake', 'activation-decisions', `${event.event_id}.json`);
    assert.equal(readJson(decisionPath).status, 'BUSY');
    assert.equal(readdirSync(join(root, '.opsle', 'wake', 'transport-attempts')).length, 0);

    writeFileSync(bound.rolloutPath, `${readFileSync(bound.rolloutPath, 'utf8')}${JSON.stringify({
      ordinal: 2,
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'turn-already-running' },
    })}\n`);
    const delivered = deliverWake(root, event.event_id, {
      nativeTransport: transport,
      bindingDependencies: bound.dependencies,
      dispatcher,
    });
    assert.equal(delivered.classification, 'native-delivered');
    assert.equal(calls, 1);
    assert.equal(readJson(decisionPath).prior_attempts[0].status, 'BUSY');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('activation decision fence rejects malformed, expired, and boundary expiry', () => {
  const root = fixture();
  try {
    const acquired = acquireActivationLease(root, 'event-fence-expiry', {
      nowMs: 1_000,
      ttlMs: 100,
    });
    assert.equal(acquired.acquired, true);
    assert.equal(decisionFenceCurrent(root, acquired.lease, { nowMs: 1_099 }), true);
    assert.equal(decisionFenceCurrent(root, acquired.lease, { nowMs: 1_100 }), false);
    assert.equal(decisionFenceCurrent(root, acquired.lease, { nowMs: 1_101 }), false);
    assert.equal(decisionFenceCurrent(root, {
      ...acquired.lease,
      expires_at: 'malformed-expiry',
    }, { nowMs: 1_000 }), false);

    const leasePath = join(root, '.opsle', 'wake', 'activation-lease.json');
    const malformed = readJson(leasePath);
    malformed.expires_at = 'malformed-expiry';
    writeJson(leasePath, malformed);
    assert.equal(decisionFenceCurrent(root, malformed, { nowMs: 1_000 }), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('post-transport lease expiry without takeover is uncertain and non-replayable', () => {
  const root = fixture();
  try {
    const bound = bindingFixture(root);
    const event = terminalEvent(root, 'post-transport-lease-expiry');
    enqueueTerminalWake(root, event);
    const dispatcher = stageCurrentDispatcher(root);
    const attemptPath = join(paths(root).attempts, `${event.attempt_id}.json`);
    writeJson(attemptPath, {
      attempt_id: event.attempt_id,
      telemetry: {
        activation_counts: {
          evidence: 'fixture',
          total_automatic: 0,
          terminal_event: 0,
          human: 0,
          wait_induced_automatic: 0,
        },
      },
    });
    const stateBefore = readFileSync(paths(root).state);
    const telemetryBefore = readFileSync(attemptPath);
    const acquiredAtMs = 1_000;
    let transportCompleted = false;
    let transportCalls = 0;
    const nativeTransport = {
      kind: 'plain-codex-resume',
      resume: (request) => {
        transportCalls += 1;
        transportCompleted = true;
        return confirmedResumeResult(request.session_id, request.message, 9400);
      },
    };
    const deliveryOptions = {
      nativeTransport,
      bindingDependencies: bound.dependencies,
      dispatcher,
      getActivationNowMs: () => (
        transportCompleted
          ? acquiredAtMs + ACTIVATION_LEASE_TTL_MS + 1
          : acquiredAtMs
      ),
    };
    const result = deliverWake(root, event.event_id, deliveryOptions);
    assert.equal(result.classification, 'uncertain');
    assert.equal(result.reason, 'activation-lease-fence-changed-after-native-transport');
    assert.equal(result.delivered, false);
    assert.equal(result.replayed, false);
    assert.equal(transportCalls, 1);
    assert.equal(existsSync(join(
      root,
      '.opsle',
      'wake',
      'deliveries',
      `${event.event_id}.json`,
    )), false);
    const decision = readJson(join(
      root,
      '.opsle',
      'wake',
      'activation-decisions',
      `${event.event_id}.json`,
    ));
    assert.equal(decision.status, 'UNCERTAIN');
    assert.equal(
      decision.failure,
      'activation-lease-fence-changed-after-native-transport',
    );
    assert.deepEqual(readFileSync(paths(root).state), stateBefore);
    assert.deepEqual(readFileSync(attemptPath), telemetryBefore);
    assert.equal(events(root).some((entry) => (
      (entry.type === 'SUPERVISOR_ACTIVATION'
        && entry.cause_event_id === event.event_id)
      || (entry.type === 'SUPERVISOR_REACTIVATED'
        && entry.cause_event_id === event.event_id)
      || (entry.type === 'HOST_WAKE_DELIVERED'
        && entry.source_event_id === event.event_id)
    )), false);

    const replay = deliverWake(root, event.event_id, deliveryOptions);
    assert.equal(replay.classification, 'queued');
    assert.equal(replay.reason, 'activation-decision-uncertain');
    assert.equal(replay.delivered, false);
    assert.equal(transportCalls, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('activation lease serializes owners, fences generations, expires, and releases idempotently', () => {
  const root = fixture();
  try {
    const first = acquireActivationLease(root, 'event-one', { nowMs: 1_000, ttlMs: 100 });
    assert.equal(first.acquired, true);
    assert.equal(first.lease.fencing_token, 1);
    const duplicate = acquireActivationLease(root, 'event-one', { nowMs: 1_010, ttlMs: 100 });
    assert.equal(duplicate.acquired, true);
    assert.equal(duplicate.duplicate, true);
    const simultaneous = acquireActivationLease(root, 'event-two', { nowMs: 1_020, ttlMs: 100 });
    assert.equal(simultaneous.acquired, false);
    assert.equal(simultaneous.classification, 'busy');
    const takeover = acquireActivationLease(root, 'event-two', { nowMs: 1_101, ttlMs: 100 });
    assert.equal(takeover.acquired, true);
    assert.equal(takeover.takeover, true);
    assert.equal(takeover.lease.fencing_token, 2);
    assert.equal(releaseActivationLease(root, first.lease).released, false);
    assert.equal(releaseActivationLease(root, takeover.lease).released, true);
    assert.equal(releaseActivationLease(root, takeover.lease).duplicate, true);

    const third = acquireActivationLease(root, 'event-three', { nowMs: 1_200, ttlMs: 100 });
    const supervisor = readJson(paths(root).supervisor);
    supervisor.generation += 1;
    writeJson(paths(root).supervisor, supervisor);
    const generationTakeover = acquireActivationLease(root, 'event-four', { nowMs: 1_210, ttlMs: 100 });
    assert.equal(generationTakeover.acquired, true);
    assert.equal(generationTakeover.lease.supervisor_generation, supervisor.generation);
    assert.ok(generationTakeover.lease.fencing_token > third.lease.fencing_token);

    const currentDispatcher = stageDispatcher(root, { status: 'OWNED' });
    const staleDispatcher = { ...currentDispatcher, dispatcher_generation: 0 };
    const stale = acquireActivationLease(root, 'event-five', { dispatcher: staleDispatcher });
    assert.equal(stale.acquired, false);
    assert.equal(stale.classification, 'stale-dispatcher');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('uncertain plain resume activation never crosses the decision boundary twice', () => {
  const root = fixture();
  try {
    const bound = bindingFixture(root);
    const event = terminalEvent(root, 'native-crash');
    enqueueTerminalWake(root, event);
    let calls = 0;
    const transport = {
      kind: 'plain-codex-resume',
      resume: () => { calls += 1; throw new Error('connection lost after submit'); },
    };
    const first = deliverWake(root, event.event_id, {
      nativeTransport: transport,
      bindingDependencies: bound.dependencies,
    });
    assert.equal(first.reason, 'crash-uncertain-delivery');
    const second = deliverWake(root, event.event_id, {
      nativeTransport: transport,
      bindingDependencies: bound.dependencies,
    });
    assert.equal(second.reason, 'activation-decision-uncertain');
    assert.equal(calls, 1);
    assert.equal(existsSync(join(root, '.opsle', 'wake', 'deliveries', `${event.event_id}.json`)), false);
    assert.equal(existsSync(join(root, '.opsle', 'wake', 'requests', `${event.event_id}.json`)), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stale and evaluated historical wake requests are inert and byte-identical', () => {
  const root = fixture();
  try {
    const supervisor = readJson(paths(root).supervisor);
    const requestDirectory = join(root, '.opsle', 'wake', 'requests');
    mkdirSync(requestDirectory, { recursive: true });
    const legacyPath = join(requestDirectory, 'event-legacy-stale.json');
    const legacyBytes = Buffer.from(`${JSON.stringify({
      schema: 'opsle.durable-supervisor.host-wake-request/v1',
      event_id: 'event-legacy-stale',
      event_type: 'CHILD_COMPLETION',
      terminal_type: 'child-completed',
      task_id: 'task-legacy',
      attempt_id: 'attempt-legacy',
      wait_id: 'attempt-legacy',
      target: {
        supervisor_id: supervisor.supervisor_id,
        supervisor_generation: supervisor.generation - 1,
        tmux_session: supervisor.session_id,
      },
      queue_version: 1,
      queued_at: '2026-09-01T00:00:00.000Z',
      adoptions: [],
    })}\n`);
    writeFileSync(legacyPath, legacyBytes);
    const stale = drainWakeQueue(root)[0];
    assert.equal(stale.classification, 'obsolete');
    assert.equal(stale.reason, 'wake-target-generation-is-stale');
    assert.deepEqual(adoptQueuedWakes(root), []);
    assert.deepEqual(readFileSync(legacyPath), legacyBytes);

    const event = terminalEvent(root, 'evaluated');
    enqueueTerminalWake(root, event);
    writeJson(join(paths(root).tasks, 'task-evaluated.json'), {
      task_id: 'task-evaluated', state: 'ACCEPTED',
    });
    const requestPath = join(requestDirectory, `${event.event_id}.json`);
    const before = readFileSync(requestPath);
    const request = readJson(requestPath);
    const classified = classifyQueuedWake(root, request);
    assert.equal(classified.classification, 'obsolete');
    assert.equal(classified.reason, 'task-already-terminal-and-evaluated');
    assert.equal(deliverWake(root, event.event_id).classification, 'obsolete');
    assert.deepEqual(readFileSync(requestPath), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('directory-based compatibility wait observes atomic replacement without model polling', async () => {
  const root = fixture();
  try {
    const target = join(root, 'terminal-state.json');
    writeJson(target, { state: 'RUNNING' });
    const observation = registerAtomicReplaceWait(target, {
      read: (path) => readJson(path),
      ready: (value) => value.state === 'TERMINAL',
    });
    writeJson(target, { state: 'TERMINAL', exit_code: 0 });
    const result = await observation.wait();
    assert.equal(result.type, 'terminal-file-ready');
    assert.equal(result.value.exit_code, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
