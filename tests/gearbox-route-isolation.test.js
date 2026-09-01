import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createAttempt, createTask, routeTask } from '../src/pipeline.js';
import { readJson, writeJson } from '../src/io.js';
import { initialize, paths, validateDurableState } from '../src/state.js';
import {
  childPrompt,
  codexLaunchSpec,
  prepareIsolatedCodexHome,
  promptByteMeasurement,
} from '../src/runner.js';

const sourceRoot = resolve(new URL('..', import.meta.url).pathname);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'durable-route-isolation-'));
  mkdirSync(join(root, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(root, '.git', 'refs', 'heads', 'main'), `${'1'.repeat(40)}\n`);
  writeFileSync(join(root, '.git', 'config'), [
    '[core]',
    '\trepositoryformatversion = 0',
    '[remote "origin"]',
    '\turl = https://example.invalid/fixture.git',
    '',
  ].join('\n'));
  writeFileSync(join(root, 'README.md'), '# fixture\n');
  mkdirSync(join(root, '.opsle'));
  cpSync(join(sourceRoot, '.opsle', 'specification.md'), join(root, '.opsle', 'specification.md'));
  cpSync(join(sourceRoot, '.opsle', 'requirements.json'), join(root, '.opsle', 'requirements.json'));
  initialize(root, { actor: 'test' });
  return root;
}

function handoff(overrides = {}) {
  return {
    title: 'Implement an isolated child fixture',
    objective: 'Make one bounded repository change without external tools.',
    scope: ['README.md'],
    authorization: {
      may: ['inspect and edit README.md'],
      may_modify: ['README.md'],
      may_not: ['use web, MCP, plugins, subagents, review, or provider fallback'],
    },
    required_inputs: ['README.md'],
    relevant_context: ['The fixture must remain local.'],
    expected_deliverable: 'A bounded README change.',
    expected_evidence: ['source diff', 'focused test output'],
    acceptance_criteria: ['only README.md changes', 'focused tests pass'],
    prohibited_actions: ['external tools', 'fallback'],
    requirement_ids: [],
    route_hint: 'graphify',
    deterministic_command: null,
    verification_command: null,
    ...overrides,
  };
}

test('route_hint is advisory and cannot force the final Gearbox route', () => {
  const root = fixture();
  try {
    const codexTask = createTask(root, handoff({
      task_id: 'task-hint-cannot-force-codex',
      route_hint: 'deterministic',
    }));
    const codexDecision = routeTask(root, codexTask);
    assert.equal(codexDecision.selected_route, 'codex');
    assert.deepEqual(codexDecision.classification_inputs, {
      route_hint: 'deterministic',
      route_hint_authority: 'advisory_only',
      deterministic_command_present: false,
    });

    const deterministicTask = createTask(root, handoff({
      task_id: 'task-hint-cannot-force-provider',
      route_hint: 'codex',
      deterministic_command: [process.execPath, '-e', 'process.exit(0)'],
      expects_changes: false,
    }));
    const deterministicDecision = routeTask(root, deterministicTask);
    assert.equal(deterministicDecision.selected_route, 'deterministic');
    assert.equal(deterministicDecision.selected_route_config.selected_tool,
      'deterministic-command');
    assert.equal(
      deterministicDecision.selected_route_config.selected_tool,
      deterministicDecision.selected_route_config.tool_allowlist[0].tool,
    );
    assert.deepEqual(
      deterministicDecision.selected_route_config.tool_allowlist[0].argv,
      deterministicTask.deterministic_command,
    );
    const { attempt: deterministicAttempt } = createAttempt(
      root,
      deterministicTask,
      deterministicDecision,
    );
    assert.equal(deterministicAttempt.policy_snapshot.selected_route.selected_tool,
      deterministicDecision.selected_route_config.selected_tool);
    for (const invalidSelectedTool of [undefined, 'none']) {
      const invalidAttempt = structuredClone(deterministicAttempt);
      if (invalidSelectedTool === undefined) {
        delete invalidAttempt.policy_snapshot.selected_route.selected_tool;
      } else {
        invalidAttempt.policy_snapshot.selected_route.selected_tool = invalidSelectedTool;
      }
      invalidAttempt.policy_snapshot.gearbox_decision.selected_route_config = structuredClone(
        invalidAttempt.policy_snapshot.selected_route,
      );
      writeJson(
        join(paths(root).attempts, `${deterministicAttempt.attempt_id}.json`),
        invalidAttempt,
      );
      const invalidState = validateDurableState(root);
      assert.equal(invalidState.valid, false);
      assert.ok(invalidState.errors.includes(
        `invalid exact selected route in ${deterministicAttempt.attempt_id}.json`,
      ));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('disabled providers cannot be selected or recovered through fallback', () => {
  const root = fixture();
  try {
    const policy = readJson(paths(root).policy);
    policy.providers.codex.enabled = false;
    policy.providers.claude.enabled = false;
    policy.version += 1;
    writeJson(paths(root).policy, policy);
    const task = createTask(root, handoff({
      task_id: 'task-disabled-provider-route',
      route_hint: 'codex',
    }));
    assert.throws(
      () => routeTask(root, task),
      /no authorized, available, policy-permitted Gearbox route/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('exact selected route is immutable in decision and policy snapshot', () => {
  const root = fixture();
  try {
    const task = createTask(root, handoff({ task_id: 'task-exact-route-snapshot' }));
    const decision = routeTask(root, task);
    const { attempt } = createAttempt(root, task, decision);
    assert.equal(decision.schema, 'opsle.durable-supervisor.gearbox-decision/v3');
    assert.equal(attempt.policy_snapshot.schema,
      'opsle.durable-supervisor.delegation-policy-snapshot/v3');
    assert.deepEqual(attempt.policy_snapshot.selected_route, decision.selected_route_config);
    assert.deepEqual(attempt.policy_snapshot.selected_route, {
      schema: 'opsle.durable-supervisor.exact-child-route/v2',
      provider: {
        name: 'codex',
        model: 'gpt-5.6-sol',
        reasoning_effort: 'high',
      },
      execution_class: 'bounded_implementation',
      selected_tool: 'none',
      tool_allowlist: [],
      skill_allowlist: [],
      web: { enabled: false, mode: 'disabled' },
      mcp: { enabled: false, server_allowlist: [] },
      plugins: { enabled: false, plugin_allowlist: [] },
      subagents: { enabled: false },
      review: { enabled: false, mode: 'off', reviewer: null },
      fallback: { enabled: false, provider_allowlist: [] },
    });
    assert.equal(
      decision.considered_routes.find((route) => route.route === 'claude').eligible,
      false,
    );
    assert.equal(validateDurableState(root).valid, true);

    for (const invalidSelectedTool of [undefined, 'deterministic-command']) {
      const invalidAttempt = structuredClone(attempt);
      if (invalidSelectedTool === undefined) {
        delete invalidAttempt.policy_snapshot.selected_route.selected_tool;
      } else {
        invalidAttempt.policy_snapshot.selected_route.selected_tool = invalidSelectedTool;
      }
      invalidAttempt.policy_snapshot.gearbox_decision.selected_route_config = structuredClone(
        invalidAttempt.policy_snapshot.selected_route,
      );
      writeJson(join(paths(root).attempts, `${attempt.attempt_id}.json`), invalidAttempt);
      const invalidState = validateDurableState(root);
      assert.equal(invalidState.valid, false);
      assert.ok(invalidState.errors.includes(
        `invalid exact selected route in ${attempt.attempt_id}.json`,
      ));
    }

    const legacyAttempt = structuredClone(attempt);
    legacyAttempt.policy_snapshot.schema =
      'opsle.durable-supervisor.delegation-policy-snapshot/v2';
    legacyAttempt.policy_snapshot.selected_route.schema =
      'opsle.durable-supervisor.exact-child-route/v1';
    delete legacyAttempt.policy_snapshot.selected_route.selected_tool;
    legacyAttempt.policy_snapshot.gearbox_decision.schema =
      'opsle.durable-supervisor.gearbox-decision/v2';
    legacyAttempt.policy_snapshot.gearbox_decision.selected_route_config = structuredClone(
      legacyAttempt.policy_snapshot.selected_route,
    );
    writeJson(join(paths(root).attempts, `${attempt.attempt_id}.json`), legacyAttempt);
    assert.equal(validateDurableState(root).valid, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('tool-none Codex launch is isolated and prompt is route-scoped', (t) => {
  const root = fixture();
  try {
    const task = createTask(root, handoff({ task_id: 'task-isolated-launch-fixture' }));
    const decision = routeTask(root, task);
    const { attempt } = createAttempt(root, task, decision);
    const rawDirectory = join(paths(root).raw, attempt.attempt_id);
    mkdirSync(rawDirectory, { recursive: true });
    const sourceCodexHome = join(root, 'source-codex-home');
    mkdirSync(join(sourceCodexHome, 'skills', 'global-skill'), { recursive: true });
    mkdirSync(join(sourceCodexHome, 'plugins', 'global-plugin'), { recursive: true });
    writeFileSync(join(sourceCodexHome, 'auth.json'), '{"fixture":true}\n', { mode: 0o600 });
    writeFileSync(join(sourceCodexHome, 'config.toml'), 'web_search = "live"\n');
    writeFileSync(join(sourceCodexHome, 'skills', 'global-skill', 'SKILL.md'), 'global skill');
    writeFileSync(join(sourceCodexHome, 'plugins', 'global-plugin', 'plugin.json'), '{}');

    const isolated = prepareIsolatedCodexHome(root, attempt.attempt_id, { sourceCodexHome });
    assert.deepEqual(readdirSync(isolated.path), ['auth.json']);
    assert.equal(lstatSync(join(isolated.path, 'auth.json')).isSymbolicLink(), true);
    assert.equal(readlinkSync(join(isolated.path, 'auth.json')),
      join(sourceCodexHome, 'auth.json'));
    assert.deepEqual(isolated.linked_authentication_files, ['auth.json']);
    assert.deepEqual(isolated.copied_authentication_files, []);
    assert.equal(readFileSync(join(isolated.path, 'auth.json'), 'utf8'), '{"fixture":true}\n');

    const lastMessagePath = join(rawDirectory, 'last-message.txt');
    const launch = codexLaunchSpec(root, task, attempt, {
      codexHome: isolated.path,
      lastMessagePath,
      inheritedEnvironment: { PATH: '/usr/bin' },
    });
    assert.equal(launch.environment.CODEX_HOME, isolated.path);
    assert.equal(launch.environment.PATH, '/usr/bin');
    assert.ok(launch.args.includes('--ignore-user-config'));
    assert.ok(launch.args.includes('--ignore-rules'));
    assert.ok(launch.args.includes('--strict-config'));
    assert.ok(launch.args.includes('--ephemeral'));
    assert.ok(launch.args.includes('skip_host_skill_discovery'));
    for (const feature of ['apps', 'plugins', 'skill_search', 'multi_agent', 'multi_agent_v2']) {
      assert.ok(launch.args.some((value, index) => (
        value === '--disable' && launch.args[index + 1] === feature
      )), `missing disabled feature ${feature}`);
    }
    for (const override of [
      'web_search="disabled"',
      'mcp_servers={}',
      'agents.enabled=false',
      'skills.bundled.enabled=false',
      'skills.config=[]',
      'include_apps_instructions=false',
      'include_collaboration_mode_instructions=false',
      'sandbox_workspace_write.network_access=false',
    ]) assert.ok(launch.args.includes(override), `missing override ${override}`);
    const parserProbe = spawnSync(
      launch.command,
      [...launch.args.slice(0, -1), '-'],
      { env: launch.environment, input: '', encoding: 'utf8', timeout: 5000 },
    );
    assert.doesNotMatch(parserProbe.stderr, /unknown configuration field/);
    assert.match(parserProbe.stderr, /No prompt provided via stdin/);
    assert.equal(launch.audit.isolation.review, 'off');
    assert.deepEqual(launch.audit.isolation.fallback_provider_allowlist, []);
    assert.deepEqual(launch.audit.isolation.mcp_server_allowlist, []);
    assert.deepEqual(launch.audit.isolation.plugin_allowlist, []);
    assert.deepEqual(launch.audit.isolation.skill_allowlist, []);

    for (const invalidSelectedTool of [undefined, 'deterministic-command']) {
      const invalidAttempt = structuredClone(attempt);
      if (invalidSelectedTool === undefined) {
        delete invalidAttempt.policy_snapshot.selected_route.selected_tool;
      } else {
        invalidAttempt.policy_snapshot.selected_route.selected_tool = invalidSelectedTool;
      }
      invalidAttempt.policy_snapshot.gearbox_decision.selected_route_config = structuredClone(
        invalidAttempt.policy_snapshot.selected_route,
      );
      assert.throws(
        () => codexLaunchSpec(root, task, invalidAttempt, {
          codexHome: isolated.path,
          lastMessagePath,
          inheritedEnvironment: { PATH: '/usr/bin' },
        }),
        /exact Gearbox-selected Codex route/,
      );
    }

    const prompt = childPrompt(task, attempt);
    const payload = JSON.parse(prompt.slice(prompt.indexOf('{')));
    assert.deepEqual(Object.keys(payload), [
      'bounded_task',
      'authorization',
      'selected_route',
      'required_context',
      'acceptance_criteria',
      'selected_tool_instructions',
    ]);
    assert.deepEqual(payload.selected_tool_instructions, []);
    assert.doesNotMatch(prompt, /graphify/i);
    assert.doesNotMatch(prompt, /sibling_components|permitted_capabilities|policy_snapshot/);
    assert.doesNotMatch(prompt, /source-codex-home|global-skill|global-plugin/);
    const bytes = promptByteMeasurement(task, attempt);
    assert.ok(bytes.legacy_full_snapshot_bytes > bytes.isolated_route_scoped_bytes,
      JSON.stringify(bytes));
    assert.ok(bytes.saved_bytes > 0);
    assert.ok(bytes.reduction_ratio > 0);
    t.diagnostic(`prompt bytes ${JSON.stringify(bytes)}`);
    rmSync(isolated.path, { recursive: true, force: true });
    assert.equal(existsSync(join(sourceCodexHome, 'auth.json')), true);
    assert.equal(readFileSync(join(sourceCodexHome, 'auth.json'), 'utf8'), '{"fixture":true}\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
