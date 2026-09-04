import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import {
  DURABLE_COMPATIBILITY_SCHEMA,
  DURABLE_MIGRATION_WRITE_BOUNDARIES,
  DURABLE_SCHEMA_VERSION,
  assertSchemaEvolution,
  durableSchemaManifest,
  ensureDurableCompatibility,
} from '../src/durable-schema.js';
import { readJson, writeJson } from '../src/io.js';

const sourceRoot = resolve(dirname(new URL(import.meta.url).pathname), '..');
const priorRelease = '5d220d2014d0bfbf858277059ba9f10604bb9a55';

function fixture({ complete = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'opsle-schema-'));
  mkdirSync(join(root, '.opsle'), { recursive: true });
  writeJson(join(root, '.opsle', 'supervisor.json'), { supervisor_id: 'supervisor-schema' });
  writeJson(join(root, '.opsle', 'state.json'), { active_task_id: null });
  writeJson(join(root, '.opsle', 'objective.json'), { history: [] });
  if (complete) writeJson(join(root, '.opsle', 'policy.json'), { providers: {} });
  return root;
}

test('missing compatibility header backfills only after an idempotent migration succeeds', () => {
  const root = fixture({ complete: false });
  const compatibility = join(root, '.opsle', 'compatibility.json');
  try {
    assert.throws(
      () => ensureDurableCompatibility(root),
      (error) => error.classification === 'CORRUPT',
    );
    assert.equal(existsSync(compatibility), false);
    writeJson(join(root, '.opsle', 'policy.json'), { providers: {} });
    const migrated = ensureDurableCompatibility(root);
    assert.equal(migrated.schema, DURABLE_COMPATIBILITY_SCHEMA);
    assert.equal(migrated.durable_schema_version, DURABLE_SCHEMA_VERSION);
    assert.equal(existsSync(join(root, '.opsle', 'runner', 'requests')), true);
    const first = readFileSync(compatibility, 'utf8');
    ensureDurableCompatibility(root);
    assert.equal(readFileSync(compatibility, 'utf8'), first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the exact legacy incomplete v1 header resumes without publishing another intermediate version', () => {
  const root = fixture();
  const compatibility = join(root, '.opsle', 'compatibility.json');
  try {
    writeJson(compatibility, {
      schema: DURABLE_COMPATIBILITY_SCHEMA,
      durable_schema_version: 1,
      schema_fingerprint_sha256: null,
      migrated_at: '2026-09-03T00:00:00.000Z',
    });
    const migrated = ensureDurableCompatibility(root);
    assert.equal(migrated.durable_schema_version, DURABLE_SCHEMA_VERSION);
    assert.equal(migrated.schema_fingerprint_sha256, durableSchemaManifest().fingerprint_sha256);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function migrateInProcess(root, crashBoundary = '') {
  const moduleUrl = new URL('../src/durable-schema.js', import.meta.url).href;
  const source = [
    `import { ensureDurableCompatibility } from ${JSON.stringify(moduleUrl)};`,
    'const root = process.argv[1];',
    'const crash = process.argv[2] || null;',
    'const result = ensureDurableCompatibility(root, {',
    '  afterDurableWrite(boundary) {',
    '    if (boundary === crash) process.exit(86);',
    '  },',
    '});',
    'process.stdout.write(JSON.stringify(result));',
  ].join('\n');
  return spawnSync(process.execPath, [
    '--input-type=module', '-e', source, root, crashBoundary,
  ], { encoding: 'utf8' });
}

test('crash after every migration durable write restarts from valid committed state and converges', () => {
  for (const boundary of DURABLE_MIGRATION_WRITE_BOUNDARIES) {
    const root = fixture();
    const compatibility = join(root, '.opsle', 'compatibility.json');
    const authorityFiles = ['supervisor.json', 'state.json', 'objective.json', 'policy.json'];
    const authorityBefore = new Map(authorityFiles.map((name) => [
      name,
      readFileSync(join(root, '.opsle', name)),
    ]));
    try {
      const interrupted = migrateInProcess(root, boundary);
      assert.equal(interrupted.status, 86, `${boundary}: ${interrupted.stderr}`);
      if (existsSync(compatibility)) {
        const committed = readJson(compatibility);
        assert.equal(committed.durable_schema_version, DURABLE_SCHEMA_VERSION, boundary);
        assert.equal(committed.schema_fingerprint_sha256, durableSchemaManifest().fingerprint_sha256);
      }
      const restarted = migrateInProcess(root);
      assert.equal(restarted.status, 0, `${boundary}: ${restarted.stderr}`);
      const migrated = JSON.parse(restarted.stdout);
      assert.equal(migrated.durable_schema_version, DURABLE_SCHEMA_VERSION, boundary);
      assert.equal(migrated.schema_fingerprint_sha256, durableSchemaManifest().fingerprint_sha256);
      assert.equal(existsSync(join(root, '.opsle', 'runner', 'requests')), true);
      for (const [name, bytes] of authorityBefore) {
        assert.deepEqual(readFileSync(join(root, '.opsle', name)), bytes, `${boundary}: ${name}`);
      }
      const committedBytes = readFileSync(compatibility);
      const idempotent = migrateInProcess(root);
      assert.equal(idempotent.status, 0, `${boundary}: ${idempotent.stderr}`);
      assert.deepEqual(readFileSync(compatibility), committedBytes, boundary);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('newer compatibility state is UPGRADE_REQUIRED and malformed state is CORRUPT', () => {
  for (const [name, stage, classification] of [
    ['newer', (path) => writeJson(path, {
      schema: DURABLE_COMPATIBILITY_SCHEMA,
      durable_schema_version: DURABLE_SCHEMA_VERSION + 1,
      schema_fingerprint_sha256: '0'.repeat(64),
      migrated_at: '2026-09-04T00:00:00.000Z',
    }), 'UPGRADE_REQUIRED'],
    ['unknown-v1-fingerprint', (path) => writeJson(path, {
      schema: DURABLE_COMPATIBILITY_SCHEMA,
      durable_schema_version: 1,
      schema_fingerprint_sha256: '1'.repeat(64),
      migrated_at: '2026-09-04T00:00:00.000Z',
    }), 'CORRUPT'],
    ['malformed', (path) => writeFileSync(path, '{not-json\n'), 'CORRUPT'],
  ]) {
    const root = fixture();
    try {
      const path = join(root, '.opsle', 'compatibility.json');
      stage(path);
      assert.throws(
        () => ensureDurableCompatibility(root),
        (error) => error.classification === classification,
        name,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('durable schema fingerprint changes require a version change', () => {
  const current = durableSchemaManifest();
  assert.equal(assertSchemaEvolution(current, current), true);
  assert.throws(() => assertSchemaEvolution(current, {
    ...current,
    identifiers: [...current.identifiers, 'opsle.durable-supervisor.future/v1'],
  }), /without a durable schema version change/);
  assert.equal(assertSchemaEvolution(current, {
    version: current.version + 1,
    identifiers: [...current.identifiers, 'opsle.durable-supervisor.future/v1'],
  }), true);
});

test('current migration backfills state initialized by the exact Sep-2 release artifact', () => {
  const outer = mkdtempSync(join(tmpdir(), 'opsle-prior-release-'));
  const archive = join(outer, 'prior.tar');
  const runtime = join(outer, 'runtime');
  const root = join(outer, 'repository');
  try {
    mkdirSync(runtime);
    mkdirSync(root);
    execFileSync('git', ['-C', sourceRoot, 'archive', '--format=tar', '-o', archive, priorRelease]);
    execFileSync('tar', ['-xf', archive, '-C', runtime]);
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'schema-test@example.invalid'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Schema Test'], { cwd: root });
    writeFileSync(join(root, 'README.md'), 'prior release fixture\n');
    mkdirSync(join(root, '.opsle'));
    copyFileSync(join(runtime, '.opsle', 'specification.md'), join(root, '.opsle', 'specification.md'));
    copyFileSync(join(runtime, '.opsle', 'requirements.json'), join(root, '.opsle', 'requirements.json'));
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'prior release fixture'], { cwd: root });
    const initialized = spawnSync(process.execPath, [
      join(runtime, 'bin', 'opsle.js'), 'init', '--objective', 'prior release compatibility',
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.equal(existsSync(join(root, '.opsle', 'compatibility.json')), false);
    const compatibility = ensureDurableCompatibility(root);
    assert.equal(compatibility.durable_schema_version, DURABLE_SCHEMA_VERSION);
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});
