import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { readJson, writeJson } from '../src/io.js';
import { initialize, paths, validateDurableState } from '../src/state.js';
import {
  DIRECT_SOURCE_ROUTE,
  EXTERNAL_DOCUMENTATION_ROUTE,
  EXPLICIT_OPTIONAL_ROUTE,
  loadSelectedSupervisorSkillInstructions,
  requireSelectedSupervisorCapability,
  selectSupervisorRoute,
} from '../src/supervisor-routing.js';

const sourceRoot = resolve(new URL('..', import.meta.url).pathname);
const cliPath = join(sourceRoot, 'bin', 'opsle.js');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'durable-supervisor-routing-'));
  mkdirSync(join(root, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(root, '.git', 'refs', 'heads', 'main'), `${'7'.repeat(40)}\n`);
  writeFileSync(join(root, '.git', 'config'), '[remote "origin"]\n\turl = https://example.invalid/routing.git\n');
  mkdirSync(join(root, '.opsle'));
  cpSync(join(sourceRoot, '.opsle', 'specification.md'), join(root, '.opsle', 'specification.md'));
  cpSync(join(sourceRoot, '.opsle', 'requirements.json'), join(root, '.opsle', 'requirements.json'));
  initialize(root, { actor: 'supervisor-routing-test' });
  return root;
}

function baseInput(overrides = {}) {
  return {
    work_description: 'Inspect a narrow local source defect.',
    work_class: 'narrow_repository_source_analysis',
    static_category_match: 'code',
    ...overrides,
  };
}

function runCli(root, args) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const capture = mkdtempSync(join(tmpdir(), 'durable-supervisor-routing-cli-'));
  const stdoutPath = join(capture, 'stdout.log');
  const stderrPath = join(capture, 'stderr.log');
  const stdout = openSync(stdoutPath, 'w');
  const stderr = openSync(stderrPath, 'w');
  try {
    const result = spawnSync(process.execPath, [cliPath, ...args], {
      cwd: root,
      env,
      stdio: ['ignore', stdout, stderr],
    });
    closeSync(stdout);
    closeSync(stderr);
    return {
      status: result.status,
      stdout: readFileSync(stdoutPath, 'utf8'),
      stderr: readFileSync(stderrPath, 'utf8'),
    };
  } finally {
    try { closeSync(stdout); } catch {}
    try { closeSync(stderr); } catch {}
    rmSync(capture, { recursive: true, force: true });
  }
}

test('first route persists in an initialized repository missing its routing directory', () => {
  const root = fixture();
  try {
    const routing = paths(root).supervisorRouting;
    const supervisor = readJson(paths(root).supervisor);
    assert.equal(supervisor.authority_status, 'AUTHORITATIVE');
    rmSync(routing, { recursive: true, force: true });

    const decision = selectSupervisorRoute(root, baseInput());

    assert.deepEqual(
      readJson(join(routing, `${decision.decision_id}.json`)),
      decision,
    );
    assert.equal(statSync(routing).mode & 0o777, 0o700);
    assert.deepEqual(readJson(paths(root).supervisor), supervisor);
    assert.equal(validateDurableState(root).valid, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('narrow source analysis records Graphify availability but selects direct inspection', () => {
  const root = fixture();
  try {
    const skillPath = join(root, 'advertised-graphify-SKILL.md');
    writeFileSync(skillPath, 'instructions that discovery must not read\n');
    const probed = [];
    const decision = selectSupervisorRoute(root, baseInput({
      advertised_capabilities: [{
        capability_id: 'graphify',
        kind: 'skill',
        instruction_path: skillPath,
      }],
    }), {
      lstat(path) {
        probed.push(path);
        return lstatSync(path);
      },
    });
    assert.deepEqual(probed, [skillPath]);
    assert.equal(decision.selected_route.execution_route, DIRECT_SOURCE_ROUTE);
    assert.equal(decision.selected_route.selected_tool, 'direct-source-inspection');
    assert.equal(decision.selected_execution_route, DIRECT_SOURCE_ROUTE);
    assert.equal(decision.selected_tool, 'direct-source-inspection');
    assert.equal(decision.selected_skill, null);
    assert.ok(decision.subject.objective_id);
    assert.ok(decision.subject.objective);
    assert.equal(decision.subject.work_description, 'Inspect a narrow local source defect.');
    assert.match(decision.intelligence_or_tooling_rationale, /Direct deterministic/);
    assert.match(decision.direct_inspection_insufficiency_rationale, /sufficient/);
    assert.deepEqual(decision.discovery.instruction_files_read, []);
    const graphify = decision.discovery.capabilities.find(
      (item) => item.capability_id === 'graphify',
    );
    assert.equal(graphify.available, true);
    assert.equal(graphify.instruction_file_read, false);
    for (const capability of ['graphify', 'openai-docs', 'web', 'plugins', 'mcp', 'subagents']) {
      assert.throws(
        () => requireSelectedSupervisorCapability(root, decision.decision_id, {
          capability_id: capability,
        }),
        /optional capability was not selected durably/,
      );
    }
    assert.equal(validateDurableState(root).valid, true);
    const decisionPath = join(paths(root).supervisorRouting, `${decision.decision_id}.json`);
    const widened = readJson(decisionPath);
    widened.selected_route.web = { enabled: true, mode: 'live' };
    writeJson(decisionPath, widened);
    const invalid = validateDurableState(root);
    assert.equal(invalid.valid, false);
    assert.ok(invalid.errors.some((error) => error.includes(
      'direct route must deny every optional capability',
    )));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('OpenAI Docs and web need an exact current external documentation route', () => {
  const root = fixture();
  try {
    const advertised = [
      { capability_id: 'openai-docs', kind: 'tool', available: true },
      { capability_id: 'web', kind: 'web', available: true },
    ];
    assert.throws(() => selectSupervisorRoute(root, baseInput({
      requested_route: EXPLICIT_OPTIONAL_ROUTE,
      requested_capability: 'openai-docs',
      advertised_capabilities: advertised,
      intelligence_or_tooling_rationale: 'Current API behavior is required.',
      direct_inspection_insufficiency_rationale: 'The repository has no current API reference.',
    })), /requires exact current_external_documentation selection/);

    const categoryOnly = selectSupervisorRoute(root, baseInput({
      static_category_match: 'OpenAI API documentation',
      advertised_capabilities: advertised,
    }));
    assert.equal(categoryOnly.selected_route.execution_route, DIRECT_SOURCE_ROUTE);

    const selected = selectSupervisorRoute(root, baseInput({
      requested_route: EXTERNAL_DOCUMENTATION_ROUTE,
      requested_capability: 'openai-docs',
      advertised_capabilities: advertised,
      intelligence_or_tooling_rationale: 'Current external API facts are required.',
      direct_inspection_insufficiency_rationale: 'Pinned repository sources do not contain them.',
    }));
    assert.equal(selected.selected_route.selected_capability, 'openai-docs');
    assert.equal(selected.selected_route.web.enabled, false);
    assert.equal(requireSelectedSupervisorCapability(root, selected.decision_id, {
      capability_id: 'openai-docs',
      kind: 'tool',
    }).decision.decision_id, selected.decision_id);
    assert.throws(() => requireSelectedSupervisorCapability(root, selected.decision_id, {
      capability_id: 'web',
    }), /not selected durably/);
    const selectedWeb = selectSupervisorRoute(root, baseInput({
      requested_route: EXTERNAL_DOCUMENTATION_ROUTE,
      requested_capability: 'web',
      advertised_capabilities: advertised,
      intelligence_or_tooling_rationale: 'A current external publication is required.',
      direct_inspection_insufficiency_rationale: 'It is absent from repository sources.',
    }));
    assert.deepEqual(selectedWeb.selected_route.web, {
      enabled: true,
      mode: 'selected-current-external-documentation',
    });
    assert.equal(requireSelectedSupervisorCapability(root, selectedWeb.decision_id, {
      capability_id: 'web',
      kind: 'web',
    }).selected_route.selected_capability, 'web');
    assert.equal(validateDurableState(root).valid, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a safely explicit selected skill can be read only after durable selection', () => {
  const root = fixture();
  try {
    const skillPath = join(root, 'selected-skill.md');
    writeFileSync(skillPath, 'selected instructions\n');
    const decision = selectSupervisorRoute(root, baseInput({
      requested_route: EXPLICIT_OPTIONAL_ROUTE,
      requested_capability: 'fixture-skill',
      advertised_capabilities: [{
        capability_id: 'fixture-skill',
        kind: 'skill',
        instruction_path: skillPath,
      }],
      intelligence_or_tooling_rationale: 'The fixture requires its selected procedure.',
      direct_inspection_insufficiency_rationale: 'The procedure is not represented in source.',
    }));
    let reads = 0;
    const loaded = loadSelectedSupervisorSkillInstructions(
      root,
      decision.decision_id,
      'fixture-skill',
      {
        readFile(path, encoding) {
          reads += 1;
          return readFileSync(path, encoding);
        },
      },
    );
    assert.equal(reads, 1);
    assert.equal(loaded.instructions, 'selected instructions\n');
    assert.throws(
      () => loadSelectedSupervisorSkillInstructions(root, decision.decision_id, 'graphify'),
      /not selected durably/,
    );
    assert.equal(validateDurableState(root).valid, true);
    const policy = readJson(paths(root).policy);
    policy.version += 1;
    writeJson(paths(root).policy, policy);
    assert.equal(validateDurableState(root).valid, true,
      'historical decisions remain structurally valid after prospective policy changes');
    assert.throws(
      () => loadSelectedSupervisorSkillInstructions(
        root,
        decision.decision_id,
        'fixture-skill',
      ),
      /decision policy is stale/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI persists, shows, and validates a supervisor-local route', () => {
  const root = fixture();
  try {
    const inputPath = join(root, 'route-input.json');
    writeJson(inputPath, baseInput());
    const selected = runCli(root, ['supervisor', 'route', 'select', '--input', inputPath]);
    assert.equal(selected.status, 0, selected.stderr);
    const decision = JSON.parse(selected.stdout);
    const shown = runCli(root, ['supervisor', 'route', 'show', decision.decision_id]);
    assert.equal(shown.status, 0, shown.stderr);
    assert.deepEqual(JSON.parse(shown.stdout), readJson(
      join(paths(root).supervisorRouting, `${decision.decision_id}.json`),
    ));
    assert.equal(validateDurableState(root).valid, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
