import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HOST_ADAPTER_SCHEMA,
  assertSupervisorHostAdapter,
  createHerdrHost,
  createHerdrHostBinding,
  createTmuxHostBinding,
  inspectHerdrBinding,
  selectSupervisorHostAdapter,
} from '../src/host-terminal.js';

const repository = '/workspace/durable-supervisor';
const supervisor = { supervisor_id: 'supervisor-1', generation: 9 };

function herdrBinding() {
  return createHerdrHostBinding({
    repository,
    supervisorId: supervisor.supervisor_id,
    supervisorGeneration: supervisor.generation,
    socketPath: '/run/user/1000/herdr.sock',
    workspaceId: 'w1',
    workspaceCwd: repository,
    paneId: 'p1',
    terminalId: 't1',
    process: {
      pid: 441,
      start_time_ticks: '8820',
      executable: '/opt/codex',
    },
    sessionId: 'codex-session-1',
  });
}

function herdrSnapshot(status = 'idle') {
  return {
    available: true,
    socket_path: '/run/user/1000/herdr.sock',
    attached_clients: [{ client_id: 'observer-1', mode: 'read-only' }],
    events: [{ type: 'agent-status', workspace_id: 'w1', pane_id: 'p1', status }],
    workspaces: [{
      id: 'w1',
      cwd: repository,
      repository_root: repository,
      panes: [{
        id: 'p1',
        terminal_id: 't1',
        process: {
          pid: 441,
          start_time_ticks: '8820',
          executable: '/opt/codex',
          argv: ['codex'],
          cwd: repository,
        },
        agent: {
          provider: 'codex',
          session_id: 'codex-session-1',
          status,
        },
      }],
    }],
  };
}

function adapter(hostKind, authority) {
  return assertSupervisorHostAdapter({
    schema: HOST_ADAPTER_SCHEMA,
    host_kind: hostKind,
    authority,
    inspect: () => ({}),
    commit: () => ({ submitted: false }),
  });
}

test('SupervisorHostAdapter selection is explicit and preserves tmux authority', () => {
  const tmuxBinding = createTmuxHostBinding({
    repository,
    supervisorId: supervisor.supervisor_id,
    supervisorGeneration: supervisor.generation,
    sessionId: 'opsle-durable-supervisor',
  });
  const tmux = adapter('tmux', 'authoritative');
  const herdr = adapter('herdr', 'candidate-only');
  assert.strictEqual(selectSupervisorHostAdapter(tmuxBinding, { tmux, herdr }), tmux);
  assert.strictEqual(selectSupervisorHostAdapter(herdrBinding(), { tmux, herdr }), herdr);
  assert.throws(
    () => selectSupervisorHostAdapter(tmuxBinding, { tmux: herdr, herdr }),
    /stale or mismatched SupervisorHostAdapter/,
  );
  assert.throws(() => assertSupervisorHostAdapter({ inspect() {} }), /invalid SupervisorHostAdapter/);
});

test('Herdr discovery requires every explicit stable binding fact and rejects ambiguity', () => {
  const binding = herdrBinding();
  const cases = [
    ['invalid binding', { binding: { ...binding, process: null } }, 'herdr-binding-invalid'],
    ['server unavailable', { snapshot: { available: false } }, 'herdr-server-unavailable'],
    ['socket mismatch', { mutate: (value) => { value.socket_path = '/tmp/other.sock'; } }, 'herdr-socket-mismatch'],
    ['workspace missing', { mutate: (value) => { value.workspaces = []; } }, 'herdr-workspace-missing'],
    ['workspace duplicate', { mutate: (value) => { value.workspaces.push(structuredClone(value.workspaces[0])); } }, 'herdr-workspace-duplicate'],
    ['workspace cwd mismatch', { mutate: (value) => { value.workspaces[0].cwd = '/workspace/other'; } }, 'herdr-workspace-cwd-mismatch'],
    ['repository mismatch', { mutate: (value) => { value.workspaces[0].repository_root = '/workspace/other'; } }, 'herdr-repository-mismatch'],
    ['pane missing', { mutate: (value) => { value.workspaces[0].panes = []; } }, 'herdr-pane-missing'],
    ['pane duplicate', { mutate: (value) => { value.workspaces[0].panes.push(structuredClone(value.workspaces[0].panes[0])); } }, 'herdr-pane-duplicate'],
    ['terminal mismatch', { mutate: (value) => { value.workspaces[0].panes[0].terminal_id = 't2'; } }, 'herdr-terminal-mismatch'],
    ['process mismatch', { mutate: (value) => { value.workspaces[0].panes[0].process.pid = 442; } }, 'herdr-process-mismatch'],
    ['Codex session unavailable', { mutate: (value) => { value.workspaces[0].panes[0].agent = null; } }, 'herdr-codex-session-unavailable'],
    ['supervisor generation mismatch', { supervisor: { ...supervisor, generation: 10 } }, 'herdr-supervisor-generation-mismatch'],
  ];
  for (const [label, values, reason] of cases) {
    const snapshot = values.snapshot ?? herdrSnapshot();
    values.mutate?.(snapshot);
    const result = inspectHerdrBinding({
      binding: values.binding ?? binding,
      snapshot,
      supervisor: values.supervisor ?? supervisor,
    });
    assert.equal(result.discovery_status, 'rejected', label);
    assert.equal(result.delivery_authorized, false, label);
    assert.equal(result.reason, reason, label);
  }
});

test('Herdr structured idle, working, and blocked status never authorizes input', () => {
  let status = 'idle';
  let promptCalls = 0;
  let sendTextCalls = 0;
  let sendKeysCalls = 0;
  const host = createHerdrHost({
    readSnapshot: () => herdrSnapshot(status),
    agentPrompt: () => { promptCalls += 1; },
    paneSendText: () => { sendTextCalls += 1; },
    paneSendKeys: () => { sendKeysCalls += 1; },
  });
  for (status of ['idle', 'working', 'blocked']) {
    const evidence = host.inspect({ binding: herdrBinding(), supervisor });
    assert.equal(evidence.discovery_status, 'matched');
    assert.equal(evidence.agent.status, status);
    assert.equal(evidence.events[0].status, status);
    assert.equal(evidence.evidence_source, 'herdr-structured-api');
    assert.equal(evidence.terminal_scraped, false);
    assert.equal(evidence.delivery_authorized, false);
    assert.equal(evidence.prompt_idle, false);
    assert.equal('capture_sha256' in evidence, false);
    assert.deepEqual(host.commit({ prompt: 'never submit' }), {
      submitted: false,
      reason: 'herdr-prompt-delivery-prohibited-unproven-exclusive-input-transaction',
    });
  }
  assert.deepEqual({ promptCalls, sendTextCalls, sendKeysCalls }, {
    promptCalls: 0,
    sendTextCalls: 0,
    sendKeysCalls: 0,
  });
});
