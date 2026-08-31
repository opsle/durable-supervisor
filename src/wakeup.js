const WAIT_SCHEMA = 'opsle.durable-supervisor.wait-registration/v1';

export const TERMINAL_WAKE_TYPES = Object.freeze(new Set([
  'child-completed',
  'child-failed',
  'child-timeout',
  'child-stall',
  'intervention-required',
]));

export const INELIGIBLE_WAKE_TYPES = Object.freeze(new Set([
  'heartbeat',
  'host-wrapper-yield',
  'host-wrapper-timeout',
  'nonterminal-return',
]));

export function registerWait({ waitId, taskId, attemptId, registeredAt, deadlineAt }) {
  if (!waitId || !taskId || !attemptId || !registeredAt || !deadlineAt) {
    throw new Error('wait registration requires identity, registration time, and deadline');
  }
  return {
    schema: WAIT_SCHEMA,
    wait_id: waitId,
    task_id: taskId,
    attempt_id: attemptId,
    state: 'WAITING',
    registered_at: registeredAt,
    deadline_at: deadlineAt,
    seen_event_ids: [],
    human_interactions: [],
    wake: null,
  };
}

export function applyWakeEvent(wait, event) {
  if (wait?.schema !== WAIT_SCHEMA) throw new Error('unsupported wait registration');
  if (!event?.event_id || !event?.type || !event?.wait_id) {
    throw new Error('wake event requires event_id, type, and wait_id');
  }
  if (wait.seen_event_ids.includes(event.event_id)) return wait;
  const seen = [...wait.seen_event_ids, event.event_id];
  if (event.wait_id !== wait.wait_id || wait.state !== 'WAITING') {
    return { ...wait, seen_event_ids: seen };
  }
  if (INELIGIBLE_WAKE_TYPES.has(event.type)) {
    return { ...wait, seen_event_ids: seen };
  }
  if (event.type === 'human-interaction') {
    return {
      ...wait,
      seen_event_ids: seen,
      human_interactions: [...wait.human_interactions, {
        event_id: event.event_id,
        class: 'human',
        automatic: false,
      }],
    };
  }
  if (!TERMINAL_WAKE_TYPES.has(event.type)) {
    return { ...wait, seen_event_ids: seen };
  }
  return {
    ...wait,
    state: 'READY',
    seen_event_ids: seen,
    wake: {
      event_id: event.event_id,
      type: event.type,
      class: 'terminal-event',
      automatic: true,
    },
  };
}

export function terminalWakeType({ timedOut, stalled = false, exitCode }) {
  if (stalled) return 'child-stall';
  if (timedOut) return 'child-timeout';
  return exitCode === 0 ? 'child-completed' : 'child-failed';
}
