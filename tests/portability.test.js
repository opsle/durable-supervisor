import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileSha256, readJson, writeJson } from '../src/io.js';
import {
  BOOTSTRAP_SCHEMA,
  initialize,
  paths,
  validateDurableState,
} from '../src/state.js';

const sourceRoot = resolve(new URL('..', import.meta.url).pathname);
const cliPath = join(sourceRoot, 'bin', 'opsle.js');

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function repository({ commit = true, remote = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'opsle-foreign-proof-'));
  git(['init', '-q', '-b', 'main'], root);
  git(['config', 'user.name', 'Opsle Test'], root);
  git(['config', 'user.email', 'opsle@example.invalid'], root);
  if (remote) git(['remote', 'add', 'origin', 'https://example.invalid/foreign.git'], root);
  writeFileSync(join(root, 'README.md'), '# Foreign repository\n');
  git(['add', 'README.md'], root);
  if (commit) git(['commit', '-qm', 'fixture'], root);
  return root;
}

function runCli(cwd, args, environment = {}) {
  const env = { ...process.env, ...environment };
  delete env.NODE_TEST_CONTEXT;
  const capture = mkdtempSync(join(tmpdir(), 'opsle-portability-cli-'));
  const stdoutPath = join(capture, 'stdout.log');
  const stderrPath = join(capture, 'stderr.log');
  const stdout = openSync(stdoutPath, 'w');
  const stderr = openSync(stderrPath, 'w');
  try {
    const result = spawnSync(process.execPath, [cliPath, ...args], {
      cwd,
      env,
      stdio: ['ignore', stdout, stderr],
    });
    closeSync(stdout);
    closeSync(stderr);
    return {
      ...result,
      stdout: readFileSync(stdoutPath, 'utf8'),
      stderr: readFileSync(stderrPath, 'utf8'),
    };
  } finally {
    try { closeSync(stdout); } catch { /* Already closed. */ }
    try { closeSync(stderr); } catch { /* Already closed. */ }
    rmSync(capture, { recursive: true, force: true });
  }
}

function seedGenericRequirements(root) {
  mkdirSync(join(root, '.opsle'), { recursive: true });
  const specification = join(root, '.opsle', 'specification.md');
  writeFileSync(specification, '# Foreign requirements\n');
  writeJson(join(root, '.opsle', 'requirements.json'), {
    schema: 'opsle.durable-supervisor.requirements/v1',
    specification: '.opsle/specification.md',
    specification_sha256: fileSha256(specification),
    allowed_states: ['UNSTARTED', 'VERIFIED'],
    requirements: [{
      id: 'FOREIGN-001',
      title: 'A foreign requirement',
      state: 'UNSTARTED',
      evidence: [],
    }],
  });
}

test('initialization matrix A: ordinary Git repository gets a neutral objective-driven bootstrap', () => {
  const root = repository();
  try {
    const trackedBefore = git(['ls-files', '-s'], root);
    const readmeBefore = readFileSync(join(root, 'README.md'), 'utf8');
    const result = initialize(root, { actor: 'matrix-a' });
    assert.equal(result.bootstrap.schema, BOOTSTRAP_SCHEMA);
    assert.equal(result.bootstrap.requirements.mode, 'none');
    assert.equal(result.objective.current_revision, 0);
    assert.equal(result.state.phase, 'INITIALIZED');
    assert.equal(existsSync(paths(root).specification), false);
    assert.equal(existsSync(paths(root).requirements), false);
    assert.equal(git(['ls-files', '-s'], root), trackedBefore);
    assert.equal(readFileSync(join(root, 'README.md'), 'utf8'), readmeBefore);
    assert.deepEqual(validateDurableState(root), { valid: true, errors: [] });
    const status = runCli(root, ['status']);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /^Lifecycle: Initialized — no objective set/m);
    assert.match(status.stdout, /^Pause: clear/m);
    assert.match(status.stdout, /^Work: none/m);
    assert.match(status.stdout, /^Wake: clear/m);
    assert.match(status.stdout, /^Herdr: unbound/m);
    assert.match(status.stdout, /^Next: Set the repository objective\./m);
    const objectiveSet = runCli(root, [
      'objective', 'set', '--text', 'Operate the foreign repository.',
    ]);
    assert.equal(objectiveSet.status, 0, objectiveSet.stderr);
    const objective = readJson(paths(root).objective);
    assert.equal(objective.history[0].objective, 'Operate the foreign repository.');
    assert.equal(objective.history[0].specification_sha256, undefined);
    assert.equal(readJson(paths(root).state).phase, 'ACTIVE');
    assert.equal(existsSync(paths(root).requirements), false);
    assert.deepEqual(validateDurableState(root), { valid: true, errors: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('initialization matrix B: an explicit objective is retained without invented requirements', () => {
  const root = repository();
  try {
    const result = initialize(root, { actor: 'matrix-b', objectiveText: 'Release the foreign library.' });
    assert.equal(result.objective.history[0].objective, 'Release the foreign library.');
    assert.equal(result.state.phase, 'ACTIVE');
    assert.equal(existsSync(paths(root).requirements), false);
    assert.doesNotMatch(JSON.stringify(result), /Durable Supervisor V0\.1 according/);
    assert.deepEqual(validateDurableState(root), { valid: true, errors: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('initialization matrix C: an unborn repository and absent remote are supported', () => {
  const root = repository({ commit: false, remote: false });
  try {
    const result = initialize(root, { actor: 'matrix-c' });
    assert.equal(result.supervisor.repository_remote, null);
    assert.equal(result.audit.head, null);
    assert.deepEqual(validateDurableState(root), { valid: true, errors: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('initialization matrix D: Git metadata pointer repositories remain repository-local', () => {
  const root = mkdtempSync(join(tmpdir(), 'opsle-foreign-proof-gitfile-'));
  try {
    const gitDirectory = join(root, '.gitdata');
    mkdirSync(join(gitDirectory, 'refs', 'heads'), { recursive: true });
    writeFileSync(join(root, '.git'), `gitdir: ${gitDirectory}\n`);
    writeFileSync(join(gitDirectory, 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(gitDirectory, 'refs', 'heads', 'main'), `${'d'.repeat(40)}\n`);
    writeFileSync(join(gitDirectory, 'config'), '[core]\n\trepositoryformatversion = 0\n');
    const result = initialize(root, { actor: 'matrix-d' });
    assert.equal(result.audit.head, 'd'.repeat(40));
    assert.equal(result.supervisor.repository, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('initialization matrix E: any complete requirement seed uses generic matrix authority', () => {
  const root = repository();
  try {
    mkdirSync(join(root, '.opsle'));
    writeFileSync(join(root, '.opsle', 'specification.md'), readFileSync(join(sourceRoot, '.opsle', 'specification.md')));
    writeFileSync(join(root, '.opsle', 'requirements.json'), readFileSync(join(sourceRoot, '.opsle', 'requirements.json')));
    const result = initialize(root, { actor: 'matrix-e' });
    assert.equal(result.bootstrap.requirements.mode, 'matrix');
    assert.equal(result.state.phase, 'INITIALIZED');
    assert.equal(result.objective.current_revision, 0);
    assert.deepEqual(validateDurableState(root), { valid: true, errors: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('initialization matrix F: a foreign requirement matrix is preserved without a fabricated objective', () => {
  const root = repository();
  try {
    seedGenericRequirements(root);
    const matrixBefore = readFileSync(paths(root).requirements, 'utf8');
    const result = initialize(root, { actor: 'matrix-f' });
    assert.equal(result.bootstrap.requirements.mode, 'matrix');
    assert.equal(result.objective.current_revision, 0);
    assert.equal(readFileSync(paths(root).requirements, 'utf8'), matrixBefore);
    assert.deepEqual(validateDurableState(root), { valid: true, errors: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const [letter, file] of [['G', 'specification.md'], ['H', 'requirements.json']]) {
  test(`initialization matrix ${letter}: a partial requirement seed fails before authority is created`, () => {
    const root = repository();
    try {
      mkdirSync(join(root, '.opsle'));
      writeFileSync(join(root, '.opsle', file), file.endsWith('.json') ? '{}\n' : '# partial\n');
      assert.throws(() => initialize(root, { actor: `matrix-${letter.toLowerCase()}` }), /must either both exist or both be absent/);
      assert.equal(existsSync(paths(root).supervisor), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('initialization matrix I: malformed pre-seeded requirements fail without partial authority', () => {
  const root = repository();
  try {
    mkdirSync(join(root, '.opsle'));
    writeFileSync(paths(root).specification, '# malformed\n');
    writeJson(paths(root).requirements, { schema: 'foreign.invalid/v1' });
    assert.throws(() => initialize(root, { actor: 'matrix-i' }), /invalid pre-seeded requirements matrix/);
    assert.equal(existsSync(paths(root).supervisor), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('initialization matrix J: a second authoritative identity is rejected without replacement', () => {
  const root = repository();
  try {
    initialize(root, { actor: 'matrix-j-first' });
    const before = readJson(paths(root).supervisor);
    assert.throws(() => initialize(root, { actor: 'matrix-j-second' }), /authoritative supervisor already exists/);
    assert.deepEqual(readJson(paths(root).supervisor), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('initialization matrix K: explicit retired authority may be replaced', () => {
  const root = repository();
  try {
    initialize(root, { actor: 'matrix-k-first' });
    const supervisor = readJson(paths(root).supervisor);
    supervisor.authority_status = 'RETIRED';
    writeJson(paths(root).supervisor, supervisor);
    const replacement = initialize(root, { actor: 'matrix-k-second' });
    assert.notEqual(replacement.supervisor.supervisor_id, supervisor.supervisor_id);
    assert.equal(replacement.supervisor.authority_status, 'AUTHORITATIVE');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('initialization matrix L: legacy bootstrap absence uses a real generic matrix', () => {
  const root = repository();
  try {
    seedGenericRequirements(root);
    initialize(root, { actor: 'matrix-l' });
    unlinkSync(paths(root).bootstrap);
    assert.deepEqual(validateDurableState(root), { valid: true, errors: [] });
    assert.equal(readJson(paths(root).requirements).requirements.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('explicit none authority keeps a later historical matrix inert without DS heuristics', () => {
  const root = repository();
  try {
    initialize(root, {
      actor: 'historical-foreign-seed',
      objectiveText: 'Analyze this foreign repository only.',
    });
    writeFileSync(
      paths(root).specification,
      readFileSync(join(sourceRoot, '.opsle', 'specification.md')),
    );
    writeFileSync(
      paths(root).requirements,
      readFileSync(join(sourceRoot, '.opsle', 'requirements.json')),
    );
    const state = readJson(paths(root).state);
    state.supervisor_state = 'PAUSED';
    state.pause = {
      active: true,
      after_current: false,
      reason: 'Foreign pilot complete.',
      changed_at: '2026-09-02T01:00:00.000Z',
    };
    state.pending_next_action = 'Select the next unsatisfied requirement slice.';
    writeJson(paths(root).state, state);

    assert.deepEqual(validateDurableState(root), { valid: true, errors: [] });
    const requirements = runCli(root, ['requirements', '--json']);
    assert.deepEqual(JSON.parse(requirements.stdout), {
      mode: 'objective_driven',
      requirements: null,
    });
    const status = JSON.parse(runCli(root, ['status', '--json']).stdout);
    assert.deepEqual(status.progress.requirements, {});
    assert.equal(status.progress.pending_next_action, 'Awaiting operator objective.');
    assert.equal(status.supervisor.state, 'PAUSED');
    assert.equal(existsSync(paths(root).requirements), true);
    assert.equal(existsSync(paths(root).specification), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('initialization matrix M: CLI init is human-readable and JSON remains explicit', () => {
  const humanRoot = repository();
  const jsonRoot = repository();
  try {
    const human = runCli(humanRoot, ['init', '--objective', 'Ship a portable change.']);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /^Initialized Durable Supervisor/);
    const machine = runCli(jsonRoot, ['init', '--json']);
    assert.equal(machine.status, 0, machine.stderr);
    const value = JSON.parse(machine.stdout);
    assert.equal(value.bootstrap.requirements.mode, 'none');
  } finally {
    rmSync(humanRoot, { recursive: true, force: true });
    rmSync(jsonRoot, { recursive: true, force: true });
  }
});

test('version output is repository-independent and includes available source provenance', () => {
  const root = mkdtempSync(join(tmpdir(), 'opsle-version-outside-repository-'));
  try {
    const result = runCli(root, ['--version']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^opsle 0\.1\.0$/m);
    assert.match(result.stdout, /^source [a-f0-9]{40}(?: \(dirty worktree\))?$/m);
    assert.equal(existsSync(join(root, '.opsle')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Context Firewall is mandatory behavior and has no policy switch', () => {
  const root = repository();
  try {
    initialize(root, { actor: 'firewall-policy' });
    const policyBefore = readFileSync(paths(root).policy);
    const eventsBefore = readFileSync(paths(root).eventsLog);
    const result = runCli(root, ['policy', 'context-firewall', 'disable']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unknown policy command/);
    assert.deepEqual(readFileSync(paths(root).policy), policyBefore);
    assert.deepEqual(readFileSync(paths(root).eventsLog), eventsBefore);
    assert.equal(readJson(paths(root).policy).context_firewall, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('lifecycle validation rejects objective, task, pause, completion, and bootstrap contradictions', () => {
  const mutations = [
    ['objective lifecycle', (root) => {
      const state = readJson(paths(root).state);
      state.phase = 'ACTIVE';
      writeJson(paths(root).state, state);
    }],
    ['task pair', (root) => {
      const state = readJson(paths(root).state);
      state.active_task_id = 'task-without-attempt';
      writeJson(paths(root).state, state);
    }],
    ['pause authority', (root) => {
      const state = readJson(paths(root).state);
      state.supervisor_state = 'PAUSED';
      writeJson(paths(root).state, state);
    }],
    ['complete authority', (root) => {
      const objective = readJson(paths(root).objective);
      objective.current_revision = 1;
      objective.history = [{ revision: 1, objective: 'Complete cleanly.' }];
      writeJson(paths(root).objective, objective);
      const state = readJson(paths(root).state);
      state.phase = 'COMPLETE';
      state.latest_unresolved_issue = 'still unresolved';
      state.pending_next_action = null;
      writeJson(paths(root).state, state);
    }],
    ['bootstrap authority', (root) => {
      const bootstrap = readJson(paths(root).bootstrap);
      bootstrap.requirements.mode = 'matrix';
      writeJson(paths(root).bootstrap, bootstrap);
    }],
  ];
  for (const [label, mutate] of mutations) {
    const root = repository();
    try {
      initialize(root, { actor: `contradiction-${label}` });
      mutate(root);
      assert.equal(validateDurableState(root).valid, false, label);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
