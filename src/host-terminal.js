import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, dirname } from 'node:path';
import { existsSync, readFileSync, readlinkSync, readdirSync, watch } from 'node:fs';

export const HOST_ADAPTER_SCHEMA = 'opsle.durable-supervisor.host-adapter/v1';
export const HOST_BINDING_SCHEMA = 'opsle.durable-supervisor.host-binding/v1';

function absolutePath(value) {
  return typeof value === 'string' && value.startsWith('/') && value.length > 1;
}

function nonempty(value) {
  return typeof value === 'string' && value.length > 0;
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function validateHostBinding(binding) {
  if (binding?.schema !== HOST_BINDING_SCHEMA) {
    throw new Error('unsupported supervisor host binding');
  }
  if (!['tmux', 'herdr'].includes(binding.host)) {
    throw new Error('unsupported supervisor host');
  }
  if (!['authoritative', 'candidate-only'].includes(binding.authority)) {
    throw new Error('invalid supervisor host authority');
  }
  if (!nonempty(binding.supervisor_id)
      || !positiveInteger(binding.supervisor_generation)
      || !absolutePath(binding.repository)
      || !nonempty(binding.session_id)) {
    throw new Error('incomplete supervisor host binding identity');
  }
  if (binding.host === 'tmux') {
    if (binding.authority !== 'authoritative') {
      throw new Error('tmux supervisor host must be authoritative');
    }
    return binding;
  }
  if (binding.authority !== 'authoritative') {
    throw new Error('Herdr supervisor host must be authoritative');
  }
  if (!absolutePath(binding.socket_path)
      || !nonempty(binding.workspace_id)
      || !absolutePath(binding.workspace_cwd)
      || !nonempty(binding.pane_id)
      || !nonempty(binding.terminal_id)
      || !positiveInteger(binding.process?.pid)
      || !/^[0-9]+$/.test(binding.process?.start_time_ticks ?? '')
      || !absolutePath(binding.process?.executable)
      || binding.agent?.provider !== 'codex'
      || binding.agent?.session_id !== binding.session_id) {
    throw new Error('incomplete Herdr supervisor host binding facts');
  }
  return binding;
}

export function createTmuxHostBinding({
  repository,
  supervisorId,
  supervisorGeneration,
  sessionId,
  legacy = false,
}) {
  return validateHostBinding({
    schema: HOST_BINDING_SCHEMA,
    host: 'tmux',
    authority: 'authoritative',
    repository,
    supervisor_id: supervisorId,
    supervisor_generation: supervisorGeneration,
    session_id: sessionId,
    legacy,
  });
}

export function createHerdrHostBinding({
  repository,
  supervisorId,
  supervisorGeneration,
  socketPath,
  workspaceId,
  workspaceCwd,
  paneId,
  terminalId,
  process,
  sessionId,
}) {
  return validateHostBinding({
    schema: HOST_BINDING_SCHEMA,
    host: 'herdr',
    authority: 'authoritative',
    repository,
    supervisor_id: supervisorId,
    supervisor_generation: supervisorGeneration,
    socket_path: socketPath,
    workspace_id: workspaceId,
    workspace_cwd: workspaceCwd,
    pane_id: paneId,
    terminal_id: terminalId,
    process: { ...process },
    session_id: sessionId,
    agent: { provider: 'codex', session_id: sessionId },
  });
}

export function hostBindingFromWakeTarget(target, repository) {
  if (target?.host_binding) return validateHostBinding(target.host_binding);
  if (!nonempty(target?.tmux_session)) throw new Error('wake target has no supported host binding');
  return createTmuxHostBinding({
    repository,
    supervisorId: target.supervisor_id,
    supervisorGeneration: target.supervisor_generation,
    sessionId: target.tmux_session,
    legacy: true,
  });
}

export function assertSupervisorHostAdapter(adapter) {
  if (adapter?.schema !== HOST_ADAPTER_SCHEMA
      || !['tmux', 'herdr'].includes(adapter.host_kind)
      || !['authoritative', 'candidate-only'].includes(adapter.authority)
      || typeof adapter.inspect !== 'function'
      || typeof adapter.commit !== 'function') {
    throw new Error('invalid SupervisorHostAdapter');
  }
  return adapter;
}

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

// Compatibility wait cells observe the containing directory, not the current
// file inode. Opsle durable JSON is atomically replaced, so watching the inode
// can miss the rename. Registration is followed by an immediate state check to
// close the check/subscription race without model polling.
export function registerAtomicReplaceWait(path, {
  ready = (value) => value != null,
  read = (target) => (existsSync(target) ? readFileSync(target, 'utf8') : null),
  watchFactory = watch,
} = {}) {
  let settled = false;
  let watcher = null;
  let resolveSignal;
  let rejectSignal;
  const signal = new Promise((resolve, reject) => {
    resolveSignal = resolve;
    rejectSignal = reject;
  });
  const inspect = () => {
    if (settled) return;
    try {
      const value = read(path);
      if (!ready(value)) return;
      settled = true;
      watcher?.close();
      resolveSignal({ type: 'terminal-file-ready', path, value });
    } catch (error) {
      settled = true;
      watcher?.close();
      rejectSignal(error);
    }
  };
  try {
    watcher = watchFactory(dirname(path), (_event, filename) => {
      if (filename == null || String(filename) === basename(path)) inspect();
    });
    watcher.on?.('error', (error) => {
      if (settled) return;
      settled = true;
      watcher?.close();
      rejectSignal(error);
    });
  } catch (error) {
    settled = true;
    rejectSignal(error);
  }
  if (!settled) inspect();
  return {
    wait: () => signal,
    close() {
      if (settled) return;
      settled = true;
      watcher?.close();
      resolveSignal({ type: 'terminal-file-wait-closed', path });
    },
  };
}

function commandResult(run, args) {
  const result = run('tmux', args, { encoding: 'utf8' });
  return {
    ok: result.status === 0,
    raw_stdout: result.stdout ?? '',
    stdout: result.stdout?.trimEnd() ?? '',
    stderr: result.stderr?.trim() ?? '',
  };
}

export function classifyCodexPane(capture, cursor) {
  if (typeof capture !== 'string'
      || !Number.isSafeInteger(cursor?.x)
      || !Number.isSafeInteger(cursor?.y)) {
    return {
      prompt_state: 'ambiguous',
      prompt_idle: false,
      composer_empty: false,
      composer_text: null,
      reason: 'invalid-pane-capture-or-cursor',
    };
  }
  const lines = capture.replaceAll('\r', '').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const cursorLine = lines[cursor.y];
  if (cursorLine == null) {
    return {
      prompt_state: 'ambiguous',
      prompt_idle: false,
      composer_empty: false,
      composer_text: null,
      reason: 'cursor-line-not-present-in-visible-capture',
    };
  }
  const nearby = lines.slice(Math.max(0, cursor.y - 5), cursor.y + 2).join('\n');
  if (/esc to interrupt|working \(|thinking \(|running \(|waiting for/i.test(nearby)) {
    return {
      prompt_state: 'busy',
      prompt_idle: false,
      composer_empty: false,
      composer_text: null,
      reason: 'codex-busy-indicator-visible',
    };
  }
  if (/^\s*›\s*$/u.test(cursorLine) && cursor.x <= cursorLine.length) {
    return {
      prompt_state: 'idle',
      prompt_idle: true,
      composer_empty: true,
      composer_text: '',
      reason: 'empty-codex-composer-at-cursor',
    };
  }
  const composed = cursorLine.match(/^\s*›\s+(.+?)\s*$/u);
  if (composed) {
    return {
      prompt_state: 'human-composer',
      prompt_idle: false,
      composer_empty: false,
      composer_text: composed[1],
      reason: 'nonempty-codex-composer-at-cursor',
    };
  }
  return {
    prompt_state: 'ambiguous',
    prompt_idle: false,
    composer_empty: false,
    composer_text: null,
    reason: 'codex-prompt-not-directly-observed-at-cursor',
  };
}

function safeTmuxIdentity(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`unsafe tmux ${label} identity`);
  }
  return value;
}

function tmuxCommitPredicate(expected) {
  const session = safeTmuxIdentity(expected.session_name, /^[A-Za-z0-9_-]+$/, 'session');
  const pane = safeTmuxIdentity(expected.pane_id, /^%[0-9]+$/, 'pane');
  const command = safeTmuxIdentity(expected.current_command, /^[A-Za-z0-9._+-]+$/, 'command');
  if (!Number.isSafeInteger(expected.pane_pid)
      || !Number.isSafeInteger(expected.cursor?.x)
      || !Number.isSafeInteger(expected.cursor?.y)) {
    throw new Error('invalid tmux numeric commit identity');
  }
  const predicates = [
    `#{==:#{session_name},${session}}`,
    `#{==:#{pane_id},${pane}}`,
    `#{==:#{pane_pid},${expected.pane_pid}}`,
    '#{==:#{pane_dead},0}',
    `#{==:#{pane_current_command},${command}}`,
    `#{==:#{cursor_x},${expected.cursor.x}}`,
    `#{==:#{cursor_y},${expected.cursor.y}}`,
    '#{==:#{session_attached},0}',
  ];
  return predicates.reduce((left, right) => `#{&&:${left},${right}}`);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function tmuxFinalShellPredicate(expected) {
  const pane = safeTmuxIdentity(expected.pane_id, /^%[0-9]+$/, 'pane');
  if (!/^[a-f0-9]{64}$/.test(expected.capture_sha256 ?? '')) {
    throw new Error('invalid tmux capture identity');
  }
  const processIdentity = expected.codex_process;
  if (!Number.isSafeInteger(processIdentity?.pid)
      || !/^\d+$/.test(processIdentity?.start_time_ticks ?? '')
      || typeof processIdentity?.executable !== 'string'
      || !processIdentity.executable.startsWith('/')) {
    throw new Error('invalid Codex process commit identity');
  }
  const stat = `/proc/${processIdentity.pid}/stat`;
  const executable = `/proc/${processIdentity.pid}/exe`;
  if (!Array.isArray(expected.durable_files) || expected.durable_files.length < 3) {
    throw new Error('missing durable delivery commit fences');
  }
  const durablePredicates = expected.durable_files.map((file) => {
    if (typeof file?.path !== 'string'
        || !file.path.startsWith('/')
        || !/^[a-f0-9]{64}$/.test(file.sha256 ?? '')) {
      throw new Error('invalid durable delivery commit fence');
    }
    return `test "$(sha256sum ${shellQuote(file.path)} | cut -d' ' -f1)" = ${shellQuote(file.sha256)}`;
  });
  return [
    `test "$(tmux capture-pane -p -t ${pane} | sha256sum | cut -d' ' -f1)" = ${shellQuote(expected.capture_sha256)}`,
    `test "$(sed -E 's/^[0-9]+ \\(.*\\) //' ${shellQuote(stat)} | cut -d' ' -f20)" = ${shellQuote(processIdentity.start_time_ticks)}`,
    `test "$(readlink ${shellQuote(executable)})" = ${shellQuote(processIdentity.executable)}`,
    ...durablePredicates,
  ].join(' && ');
}

function processRows(procRoot = '/proc') {
  const rows = [];
  let names = [];
  try { names = readdirSync(procRoot); } catch { return rows; }
  for (const name of names.filter((entry) => /^\d+$/.test(entry))) {
    try {
      const stat = readFileSync(`${procRoot}/${name}/stat`, 'utf8');
      const close = stat.lastIndexOf(') ');
      if (close === -1) continue;
      const fields = stat.slice(close + 2).trim().split(/\s+/);
      rows.push({
        pid: Number(name),
        ppid: Number(fields[1]),
        start_time_ticks: fields[19],
        executable: readlinkSync(`${procRoot}/${name}/exe`),
        command_line: readFileSync(`${procRoot}/${name}/cmdline`, 'utf8').replaceAll('\0', ' ').trim(),
      });
    } catch {
      // Processes can disappear while /proc is being inspected.
    }
  }
  return rows;
}

function codexDescendant(panePid, procRoot = '/proc') {
  const rows = processRows(procRoot);
  const descendants = new Set([panePid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
        descendants.add(row.pid);
        changed = true;
      }
    }
  }
  const candidates = rows.filter((row) => descendants.has(row.pid) && (
    basename(row.executable).includes('codex')
    || row.command_line.includes('@openai/codex')
    || /(^|\s)codex(\s|$)/.test(row.command_line)
  ));
  const selected = candidates.sort((left, right) => right.pid - left.pid)[0];
  return selected ? {
    pid: selected.pid,
    start_time_ticks: selected.start_time_ticks,
    executable: selected.executable,
  } : null;
}

function herdrRejected(reason, details = {}) {
  return {
    host_kind: 'herdr',
    authority: 'authoritative',
    available: details.available ?? true,
    session_alive: details.session_alive ?? false,
    discovery_status: 'rejected',
    delivery_authorized: false,
    prompt_state: 'unproven',
    prompt_idle: false,
    composer_empty: false,
    composer_text: null,
    terminal_scraped: false,
    evidence_source: 'herdr-structured-api',
    reason,
  };
}

function oneExact(rows, predicate, missingReason, duplicateReason) {
  if (!Array.isArray(rows)) return { error: missingReason };
  const matches = rows.filter(predicate);
  if (matches.length === 0) return { error: missingReason };
  if (matches.length !== 1) return { error: duplicateReason };
  return { value: matches[0] };
}

export function inspectHerdrBinding({ binding, snapshot, supervisor }) {
  try { validateHostBinding(binding); } catch (error) {
    return herdrRejected('herdr-binding-invalid', { binding_error: error.message });
  }
  if (binding.host !== 'herdr') return herdrRejected('herdr-binding-host-mismatch');
  if (binding.authority !== 'authoritative') return herdrRejected('herdr-binding-authority-mismatch');
  if (binding.supervisor_id !== supervisor?.supervisor_id
      || binding.supervisor_generation !== supervisor?.generation) {
    return herdrRejected('herdr-supervisor-generation-mismatch');
  }
  if (!snapshot || snapshot.available === false) {
    return herdrRejected(snapshot?.reason ?? 'herdr-server-unavailable', { available: false });
  }
  if (snapshot.socket_path !== binding.socket_path) {
    return herdrRejected('herdr-socket-mismatch', { session_alive: true });
  }
  const workspaceMatch = oneExact(
    snapshot.workspaces,
    (workspace) => workspace?.id === binding.workspace_id,
    'herdr-workspace-missing',
    'herdr-workspace-duplicate',
  );
  if (workspaceMatch.error) return herdrRejected(workspaceMatch.error, { session_alive: true });
  const workspace = workspaceMatch.value;
  if (workspace.cwd !== binding.workspace_cwd) {
    return herdrRejected('herdr-workspace-cwd-mismatch', { session_alive: true });
  }
  if (workspace.repository_root !== binding.repository) {
    return herdrRejected('herdr-repository-mismatch', { session_alive: true });
  }
  const paneMatch = oneExact(
    workspace.panes,
    (pane) => pane?.id === binding.pane_id,
    'herdr-pane-missing',
    'herdr-pane-duplicate',
  );
  if (paneMatch.error) return herdrRejected(paneMatch.error, { session_alive: true });
  const pane = paneMatch.value;
  if (pane.terminal_id !== binding.terminal_id) {
    return herdrRejected('herdr-terminal-mismatch', { session_alive: true });
  }
  if (pane.process?.pid !== binding.process.pid
      || pane.process?.start_time_ticks !== binding.process.start_time_ticks
      || pane.process?.executable !== binding.process.executable) {
    return herdrRejected('herdr-process-mismatch', { session_alive: true });
  }
  if (pane.agent?.provider !== 'codex'
      || pane.agent?.session_id !== binding.session_id) {
    return herdrRejected('herdr-codex-session-unavailable', { session_alive: true });
  }
  const events = [
    ...(Array.isArray(snapshot.events) ? snapshot.events : []),
    ...(Array.isArray(workspace.events) ? workspace.events : []),
    ...(Array.isArray(pane.events) ? pane.events : []),
  ].filter((event) => (
    (event.workspace_id == null || event.workspace_id === workspace.id)
    && (event.pane_id == null || event.pane_id === pane.id)
  ));
  return {
    host_kind: 'herdr',
    authority: 'authoritative',
    available: true,
    session_alive: true,
    discovery_status: 'matched',
    delivery_authorized: false,
    prompt_state: 'unproven',
    prompt_idle: false,
    composer_empty: false,
    composer_text: null,
    terminal_scraped: false,
    evidence_source: 'herdr-structured-api',
    socket_path: snapshot.socket_path,
    repository: binding.repository,
    supervisor_id: binding.supervisor_id,
    supervisor_generation: binding.supervisor_generation,
    workspace: {
      id: workspace.id,
      cwd: workspace.cwd,
      repository_root: workspace.repository_root,
    },
    pane: { id: pane.id, terminal_id: pane.terminal_id },
    process: { ...pane.process },
    agent: { ...pane.agent },
    events,
    attached_clients: Array.isArray(snapshot.attached_clients)
      ? [...snapshot.attached_clients]
      : [],
    reason: 'herdr-prompt-delivery-prohibited-unproven-exclusive-input-transaction',
  };
}

export function createHerdrHost({
  readSnapshot = () => ({ available: false, reason: 'herdr-structured-status-unconfigured' }),
} = {}) {
  return assertSupervisorHostAdapter({
    schema: HOST_ADAPTER_SCHEMA,
    host_kind: 'herdr',
    authority: 'authoritative',
    inspect({ binding, supervisor }) {
      let snapshot;
      try { snapshot = readSnapshot({ binding }); } catch (error) {
        return herdrRejected('herdr-server-unavailable', { available: false, error: error.message });
      }
      return inspectHerdrBinding({ binding, snapshot, supervisor });
    },
    commit() {
      return {
        submitted: false,
        reason: 'herdr-prompt-delivery-prohibited-unproven-exclusive-input-transaction',
      };
    },
  });
}

export function createTmuxHost({ run = spawnSync, procRoot = '/proc' } = {}) {
  return assertSupervisorHostAdapter({
    schema: HOST_ADAPTER_SCHEMA,
    host_kind: 'tmux',
    authority: 'authoritative',
    inspect({ session, pane = null }) {
      if (!session) return {
        host_kind: 'tmux', authority: 'authoritative', available: false, reason: 'tmux-session-unbound',
      };
      const version = commandResult(run, ['-V']);
      if (!version.ok) return {
        host_kind: 'tmux', authority: 'authoritative', available: false, reason: 'tmux-unavailable',
      };
      const target = pane ?? session;
      const format = [
        '#{session_name}', '#{pane_id}', '#{pane_pid}', '#{pane_dead}',
        '#{pane_current_command}', '#{cursor_x}', '#{cursor_y}',
      ].join('\t');
      const displayed = commandResult(run, ['display-message', '-p', '-t', target, format]);
      if (!displayed.ok) {
        return {
          host_kind: 'tmux', authority: 'authoritative', available: true, session_alive: false,
          reason: 'tmux-session-or-pane-unavailable',
        };
      }
      const [sessionName, paneId, panePidRaw, paneDeadRaw, currentCommand, cursorX, cursorY]
        = displayed.stdout.split('\t');
      const captured = commandResult(run, ['capture-pane', '-p', '-t', paneId]);
      const clients = commandResult(run, ['list-clients', '-t', sessionName, '-F', '#{client_tty}']);
      if (!captured.ok || !clients.ok) {
        return {
          host_kind: 'tmux', authority: 'authoritative', available: true, session_alive: true,
          pane_id: paneId, reason: 'tmux-evidence-unavailable',
        };
      }
      const panePid = Number(panePidRaw);
      const cursor = { x: Number(cursorX), y: Number(cursorY) };
      const capture = captured.raw_stdout;
      return {
        host_kind: 'tmux',
        authority: 'authoritative',
        available: true,
        session_alive: true,
        session_name: sessionName,
        pane_id: paneId,
        pane_pid: panePid,
        pane_dead: paneDeadRaw === '1',
        current_command: currentCommand,
        cursor,
        capture_sha256: createHash('sha256').update(capture).digest('hex'),
        attached_clients: clients.stdout ? clients.stdout.split('\n').filter(Boolean) : [],
        codex_process: Number.isInteger(panePid) ? codexDescendant(panePid, procRoot) : null,
        ...classifyCodexPane(capture, cursor),
      };
    },
    commit({ expected, prompt, deliveryId }) {
      const pane = safeTmuxIdentity(expected.pane_id, /^%[0-9]+$/, 'pane');
      const delivery = safeTmuxIdentity(deliveryId, /^[A-Za-z0-9_-]+$/, 'delivery');
      const buffer = `opsle-${delivery}`;
      const marker = `submitted-${delivery}`;
      const rejected = `rejected-${delivery}`;
      const prepared = commandResult(run, ['set-buffer', '-b', buffer, prompt]);
      if (!prepared.ok) throw new Error(prepared.stderr || 'tmux literal buffer preparation failed');
      const acceptedCommands = [
        `paste-buffer -d -b ${buffer} -t ${pane}`,
        `send-keys -t ${pane} Enter`,
        `set-option -p -t ${pane} @opsle_delivery_commit ${marker}`,
      ].join(' ; ');
      const rejectedCommand = `set-option -p -t ${pane} @opsle_delivery_commit ${rejected}`;
      const finalCommands = [
        'if-shell', shellQuote(tmuxFinalShellPredicate(expected)),
        shellQuote(acceptedCommands), shellQuote(rejectedCommand),
      ].join(' ');
      const committed = commandResult(run, [
        'if-shell', '-F', '-t', pane,
        tmuxCommitPredicate(expected),
        finalCommands,
        rejectedCommand,
      ]);
      if (!committed.ok) {
        commandResult(run, ['delete-buffer', '-b', buffer]);
        throw new Error(committed.stderr || 'tmux submission commit was uncertain');
      }
      const observed = commandResult(run, [
        'show-options', '-p', '-v', '-t', pane, '@opsle_delivery_commit',
      ]);
      commandResult(run, ['set-option', '-p', '-u', '-t', pane, '@opsle_delivery_commit']);
      commandResult(run, ['delete-buffer', '-b', buffer]);
      if (!observed.ok) throw new Error(observed.stderr || 'tmux submission outcome was uncertain');
      if (observed.stdout === rejected) {
        return { submitted: false, reason: 'tmux-final-predicate-changed' };
      }
      if (observed.stdout !== marker) throw new Error('tmux submission outcome was uncertain');
      return { submitted: true };
    },
  });
}

export const tmuxHost = createTmuxHost();
export const herdrCandidateHost = createHerdrHost();

export function selectSupervisorHostAdapter(binding, {
  tmux = tmuxHost,
  herdr = herdrCandidateHost,
} = {}) {
  validateHostBinding(binding);
  const adapter = binding.host === 'tmux' ? tmux : herdr;
  assertSupervisorHostAdapter(adapter);
  if (adapter.host_kind !== binding.host || adapter.authority !== binding.authority) {
    throw new Error('stale or mismatched SupervisorHostAdapter');
  }
  return adapter;
}
