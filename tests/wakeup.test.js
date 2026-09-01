import assert from 'node:assert/strict';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
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
import { readJson, writeJson } from '../src/io.js';
import { emit, initialize, paths, validateDurableState } from '../src/state.js';
import {
  acquireActivationLease,
  adoptCodexSessionBinding,
  adoptQueuedWakes,
  applyWakeEvent,
  bindCodexSession,
  classifyWakeDelivery,
  classifyQueuedWake,
  codexSessionBindingStatus,
  constructWakeMessage,
  consumeWakeDelivery,
  deliverWake,
  drainWakeQueue,
  enqueueTerminalWake,
  ensureWakeDispatcher,
  registerWait,
  releaseActivationLease,
  runWakeDispatcher,
} from '../src/wakeup.js';
import { sessionCommand } from '../src/cli.js';

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

function terminalEvent(root, suffix = 'one') {
  return emit(root, 'CHILD_COMPLETION', {
    task_id: `task-${suffix}`,
    attempt_id: `attempt-${suffix}`,
    wait_id: `attempt-${suffix}`,
    terminal_type: 'child-completed',
  });
}

function bindingFixture(root, {
  topology = 'standalone-embedded-writer',
  duplicate = false,
  bind = true,
} = {}) {
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
    [701, {
      pid: 701,
      start_time_ticks: '7010',
      executable: '/opt/codex',
      uid: 1000,
      tty: '/dev/pts/7',
      command_line_sha256: 'b'.repeat(64),
    }],
  ]);
  const tmux = {
    session_name: 'opsle-wake-fixture',
    pane_id: '%7',
    pane_pid: 699,
    pane_tty: '/dev/pts/7',
  };
  const dependencies = {
    processIdentity: (pid) => structuredClone(processes.get(pid) ?? null),
    tmuxIdentity: () => structuredClone(tmux),
    codexVersion: () => 'codex-cli 0.151.0',
    uid: () => 1000,
  };
  if (!duplicate && bind) {
    bindCodexSession(root, {
      sessionId,
      rolloutPath,
      sessionsRoot,
      hostPid: 700,
      writerPid: 701,
      tmuxSession: tmux.session_name,
      tmuxPane: tmux.pane_id,
      topology,
      nativeProofSha256: topology === 'shared-app-server' ? 'c'.repeat(64) : null,
    }, { dependencies });
  }
  return { sessionId, sessionsRoot, rolloutPath, processes, tmux, dependencies };
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

test('exact Codex session binding validates identity and explicit generation adoption', () => {
  const root = fixture();
  try {
    const bound = bindingFixture(root, { bind: false });
    const status = sessionCommand(root, 'bind', [
      '--session', bound.sessionId,
      '--rollout', bound.rolloutPath,
      '--sessions-root', bound.sessionsRoot,
      '--host-pid', '700',
      '--writer-pid', '701',
      '--tmux-session', bound.tmux.session_name,
      '--tmux-pane', bound.tmux.pane_id,
      '--topology', 'standalone-embedded-writer',
    ], { dependencies: bound.dependencies });
    assert.equal(status.classification, 'bound-unsupported');
    assert.equal(status.valid, true);
    assert.equal(status.supported, false);
    assert.equal(status.binding.codex_session_uuid, bound.sessionId);
    assert.equal(status.binding.rollout.realpath, realpathSync(bound.rolloutPath));
    assert.equal(status.binding.rollout.device, statSync(bound.rolloutPath).dev);
    assert.equal(status.binding.rollout.inode, statSync(bound.rolloutPath).ino);
    assert.equal(status.binding.codex_cli_version, 'codex-cli 0.151.0');
    assert.equal(status.binding.host_process.uid, 1000);
    assert.equal(status.binding.tmux.pane_tty, '/dev/pts/7');
    assert.deepEqual(validateDurableState(root), { valid: true, errors: [] });

    const supervisor = readJson(paths(root).supervisor);
    supervisor.generation += 1;
    writeJson(paths(root).supervisor, supervisor);
    const stale = sessionCommand(root, 'status', [], { dependencies: bound.dependencies });
    assert.equal(stale.valid, false);
    assert.ok(stale.reasons.includes('supervisor-generation-stale'));
    const adopted = sessionCommand(root, 'adopt', [], { dependencies: bound.dependencies });
    assert.equal(adopted.adopted, true);
    assert.equal(adopted.binding.supervisor_generation, supervisor.generation);
    assert.equal(adopted.status.valid, true);
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
      writerPid: 701,
      tmuxSession: duplicate.tmux.session_name,
      tmuxPane: duplicate.tmux.pane_id,
    }, { dependencies: duplicate.dependencies }), /one exact rollout candidate/);
  } finally {
    rmSync(duplicateRoot, { recursive: true, force: true });
  }

  const cases = [
    ['wrong repository', ({ dependencies }, root) => ({
      ...dependencies,
      realpath: (path) => (path === root ? '/wrong/repository' : realpathSync(path)),
    }), 'repository-mismatch'],
    ['dead or reused host process', ({ dependencies }) => ({
      ...dependencies,
      processIdentity: (pid) => (pid === 700 ? null : dependencies.processIdentity(pid)),
    }), 'host-process-dead-or-reused'],
    ['writer topology changed', ({ dependencies }) => ({
      ...dependencies,
      processIdentity: (pid) => (pid === 701
        ? { ...dependencies.processIdentity(pid), start_time_ticks: 'reused' }
        : dependencies.processIdentity(pid)),
    }), 'writer-process-dead-reused-or-topology-changed'],
    ['tmux identity changed', ({ dependencies, tmux }) => ({
      ...dependencies,
      tmuxIdentity: () => ({ ...tmux, pane_tty: '/dev/pts/99' }),
    }), 'tmux-pane-session-tty-mismatch'],
    ['installed CLI changed', ({ dependencies }) => ({
      ...dependencies,
      codexVersion: () => 'codex-cli 0.152.0',
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

test('standalone writer topology retains queued work with zero resume and zero terminal input', async () => {
  const root = fixture();
  try {
    const bound = bindingFixture(root);
    const event = terminalEvent(root, 'unsupported-writer');
    enqueueTerminalWake(root, event);
    let resumeCalls = 0;
    let terminalCalls = 0;
    const nativeTransport = {
      kind: 'shared-app-server-rpc',
      resume: () => { resumeCalls += 1; return { submitted: true }; },
    };
    const result = deliverWake(root, event.event_id, {
      nativeTransport,
      bindingDependencies: bound.dependencies,
      host: { commit: () => { terminalCalls += 1; } },
    });
    assert.equal(result.classification, 'unsupported-topology');
    assert.equal(result.reason, 'codex-0.151.0-standalone-embedded-writer-lock');
    assert.equal(result.delivered, false);
    assert.equal(resumeCalls, 0);
    assert.equal(terminalCalls, 0);
    assert.equal(existsSync(join(root, '.opsle', 'wake', 'requests', `${event.event_id}.json`)), true);
    assert.equal(existsSync(join(root, '.opsle', 'wake', 'deliveries', `${event.event_id}.json`)), false);
    assert.equal(existsSync(join(root, '.opsle', 'wake', 'activation-decisions', `${event.event_id}.json`)), false);

    const dispatcher = stageDispatcher(root);
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
    assert.equal(dispatched.results[0].classification, 'unsupported-topology');
    assert.equal(resumeCalls, 0);
    assert.equal(terminalCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('supported native topology uses a tiny message and an exactly-once decision boundary', () => {
  const root = fixture();
  try {
    const bound = bindingFixture(root, { topology: 'shared-app-server' });
    const event = terminalEvent(root, 'native-supported');
    enqueueTerminalWake(root, event);
    const calls = [];
    const nativeTransport = {
      kind: 'shared-app-server-rpc',
      resume: (request) => { calls.push(request); return { submitted: true }; },
    };
    const delivered = deliverWake(root, event.event_id, {
      nativeTransport,
      bindingDependencies: bound.dependencies,
    });
    assert.equal(delivered.delivered, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].message, constructWakeMessage(
      event.event_id,
      readJson(paths(root).supervisor).generation,
    ));
    assert.match(calls[0].message, /^OPSLE_WAKE v1 event=[^ ]+ gen=\d+; read durable repository state\.$/);
    assert.doesNotMatch(calls[0].message, /task-|attempt-|child output|claimed outcome/i);
    assert.equal(deliverWake(root, event.event_id, {
      nativeTransport,
      bindingDependencies: bound.dependencies,
    }).classification, 'duplicate');
    assert.equal(calls.length, 1);
    const generation = readJson(paths(root).supervisor).generation;
    assert.equal(consumeWakeDelivery(root, event.event_id, {
      deliveryId: delivered.receipt.delivery_id,
      generation,
    }).duplicate, false);
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

test('crash-uncertain native activation never crosses the decision boundary twice', () => {
  const root = fixture();
  try {
    const bound = bindingFixture(root, { topology: 'shared-app-server' });
    const event = terminalEvent(root, 'native-crash');
    enqueueTerminalWake(root, event);
    let calls = 0;
    const transport = {
      kind: 'shared-app-server-rpc',
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
