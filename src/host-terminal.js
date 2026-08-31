function isTerminal(result) {
  return Number.isInteger(result?.exit_code);
}

function isNonterminal(result) {
  return Number.isInteger(result?.session_id) && result.exit_code == null;
}

export async function consumeTerminalSession({
  start,
  resume,
  deadlineMs,
  nowMs = () => Date.now(),
}) {
  if (typeof start !== 'function' || typeof resume !== 'function') {
    throw new Error('terminal adapter requires start and resume functions');
  }
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= nowMs()) {
    throw new Error('terminal adapter requires a future bounded deadline');
  }
  const beforeDeadline = async (operation) => {
    const remaining = deadlineMs - nowMs();
    if (remaining <= 0) {
      const error = new Error('terminal adapter deadline reached before terminal evidence');
      error.code = 'TERMINAL_WAIT_DEADLINE';
      throw error;
    }
    let timeout;
    try {
      return await Promise.race([
        operation(),
        new Promise((resolve, reject) => {
          timeout = setTimeout(() => {
            const error = new Error('terminal adapter deadline reached before terminal evidence');
            error.code = 'TERMINAL_WAIT_DEADLINE';
            reject(error);
          }, remaining);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  };
  let result = await beforeDeadline(start);
  let nonterminalReturns = 0;
  while (!isTerminal(result)) {
    if (!isNonterminal(result)) {
      throw new Error('terminal adapter received neither terminal nor resumable control');
    }
    nonterminalReturns += 1;
    result = await beforeDeadline(() => resume(result.session_id));
  }
  return { result, nonterminal_returns_consumed: nonterminalReturns };
}
