import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { HOST_LOCK_SCHEMA, acquireHostLock } from '../src/host-lock.js';
import { writeJson } from '../src/io.js';
import { acquireUpgradeLock, registryPaths, updateRegistry } from '../src/opsled-registry.js';

const childScript = resolve(new URL('fixtures/host-lock-child.js', import.meta.url).pathname);

function child(path, critical, log) {
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  return new Promise((resolveChild) => {
    const childProcess = spawn(process.execPath, [childScript, path, critical, log], {
      env: environment,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    childProcess.stderr.on('data', (chunk) => { stderr += chunk; });
    childProcess.on('close', (code) => resolveChild({ code, stderr }));
  });
}

test('concurrent stale takeover serializes exact process owners', async () => {
  const root = mkdtempSync(join(tmpdir(), 'opsle-host-lock-race-'));
  const lockPath = join(root, 'shared.lock');
  const critical = join(root, 'critical');
  const log = join(root, 'entries.log');
  try {
    mkdirSync(lockPath, { mode: 0o700 });
    writeJson(join(lockPath, 'owner.json'), {
      schema: HOST_LOCK_SCHEMA,
      process: {
        pid: 2_000_000_000,
        start_time_ticks: 'stale-owner',
        executable: '/stale/runtime',
      },
      acquired_at: '2026-09-04T00:00:00.000Z',
    });
    const results = await Promise.all([
      child(lockPath, critical, log),
      child(lockPath, critical, log),
    ]);
    assert.deepEqual(results.map((result) => result.code), [0, 0], JSON.stringify(results));
    const entries = readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(entries.filter((line) => line.endsWith(':enter')).length, 2);
    assert.equal(entries.filter((line) => line.endsWith(':leave')).length, 2);
    assert.equal(entries.some((line) => line.includes(':overlap:')), false);
    assert.equal(existsSync(lockPath), false);
    assert.equal(existsSync(critical), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('registry and upgrade primitives share the reusable host lock', () => {
  const root = mkdtempSync(join(tmpdir(), 'opsle-host-lock-callers-'));
  try {
    const paths = registryPaths(root);
    const registryLock = acquireHostLock(paths.registryLock, { attempts: 1 });
    assert.throws(() => updateRegistry(root, (registry) => registry), (error) => error.code === 'BUSY');
    assert.equal(registryLock.release(), true);

    const upgradeLock = acquireUpgradeLock(root, { attempts: 1 });
    assert.equal(upgradeLock.path, paths.upgradeLock);
    assert.equal(upgradeLock.owner.schema, HOST_LOCK_SCHEMA);
    assert.equal(upgradeLock.release(), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
