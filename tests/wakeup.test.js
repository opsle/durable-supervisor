import assert from 'node:assert/strict';
import test from 'node:test';
import { profileCodexActivations } from '../src/activation-telemetry.js';
import { consumeTerminalSession } from '../src/host-terminal.js';
import { applyWakeEvent, registerWait } from '../src/wakeup.js';

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
