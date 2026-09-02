function contentText(output) {
  if (!Array.isArray(output)) return '';
  return output.map((item) => item?.text ?? '').join('\n');
}

function toolResult(payload) {
  const text = contentText(payload?.output);
  const candidates = [text, ...text.split('\n')];
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object') return value;
    } catch {}
  }
  return null;
}

function inside(timestamp, start, end) {
  return timestamp >= start && timestamp <= end;
}

export function profileCodexActivations(records, {
  start,
  end,
  taskId = null,
  attemptId = null,
  trajectoryEvidence = null,
}) {
  if (!start || !end || start > end) throw new Error('activation interval is invalid');
  const ordered = records
    .filter((record) => record?.timestamp)
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  let humanPending = false;
  const activations = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const record = ordered[index];
    const payload = record.payload ?? {};
    if ((record.type === 'event_msg' && payload.type === 'user_message')
        || (record.type === 'response_item'
          && payload.type === 'message'
          && payload.role === 'user')) {
      if (inside(record.timestamp, start, end)) humanPending = true;
      continue;
    }
    if (record.type !== 'response_item' || payload.type !== 'custom_tool_call_output') continue;
    if (!inside(record.timestamp, start, end)) continue;
    const next = ordered.slice(index + 1).find((candidate) => (
      candidate.type === 'response_item'
      && ['reasoning', 'message', 'custom_tool_call'].includes(candidate.payload?.type)
      && candidate.payload?.role !== 'user'
    ));
    if (!next) continue;
    const result = toolResult(payload);
    const terminal = Number.isInteger(result?.exit_code);
    const classification = humanPending
      ? 'human'
      : (terminal ? 'terminal-event' : 'wait-induced-automatic');
    activations.push({
      cause_timestamp: record.timestamp,
      activation_timestamp: next.timestamp,
      classification,
      automatic: classification !== 'human',
    });
    humanPending = false;
  }
  const count = (classification) => activations
    .filter((item) => item.classification === classification).length;
  const terminalEvent = count('terminal-event');
  const waitInduced = count('wait-induced-automatic');
  const human = count('human');
  return {
    schema: 'opsle.durable-supervisor.activation-profile/v1',
    task_id: taskId,
    attempt_id: attemptId,
    interval: { start, end },
    evidence: 'observable-codex-trajectory',
    trajectory_evidence: trajectoryEvidence,
    measurement_basis: 'model continuation after an observable tool-output boundary',
    counts: {
      total_automatic: terminalEvent + waitInduced,
      terminal_event: terminalEvent,
      human,
      wait_induced_automatic: waitInduced,
    },
    provider_model_turns: null,
    limitation: 'activation counts are trajectory-derived, not provider-recorded billing turns or tokens',
    activations,
  };
}

export function activationSummary(events) {
  const profiles = events.filter((event) => event.type === 'ACTIVATION_PROFILED');
  if (profiles.length > 0) {
    const completedAttempts = new Set(events
      .filter((event) => event.type === 'CHILD_COMPLETION')
      .map((event) => event.attempt_id));
    const profiledAttempts = new Set(profiles.map((event) => event.attempt_id));
    const complete = [...completedAttempts]
      .every((attemptId) => profiledAttempts.has(attemptId));
    if (!complete) {
      return {
        evidence: 'partial-trajectory-profiles',
        total_automatic: null,
        terminal_event: null,
        human: null,
        wait_induced_automatic: null,
      };
    }
    return profiles.reduce((summary, event) => ({
      evidence: 'trajectory-profiled',
      total_automatic: summary.total_automatic + event.counts.total_automatic,
      terminal_event: summary.terminal_event + event.counts.terminal_event,
      human: summary.human + event.counts.human,
      wait_induced_automatic: summary.wait_induced_automatic
        + event.counts.wait_induced_automatic,
    }), {
      evidence: 'trajectory-profiled',
      total_automatic: 0,
      terminal_event: 0,
      human: 0,
      wait_induced_automatic: 0,
    });
  }
  const terminal = events.filter((event) => (
    event.type === 'SUPERVISOR_ACTIVATION'
    && event.classification === 'terminal-event'
  )).length;
  const human = events.filter((event) => (
    event.type === 'SUPERVISOR_ACTIVATION'
    && event.classification === 'human'
  )).length;
  const completions = events.filter((event) => event.type === 'CHILD_COMPLETION');
  const waitZeroProven = completions.length > 0 && completions.every((event) => (
    event.activation_counts?.wait_induced_automatic === 0
    && event.wait_mechanism?.includes('no initiating supervisor wait cell')
  ));
  return {
    evidence: terminal || human || waitZeroProven ? 'partial-local-events' : 'absent',
    total_automatic: null,
    terminal_event: terminal || null,
    human: human || null,
    wait_induced_automatic: waitZeroProven ? 0 : null,
  };
}
