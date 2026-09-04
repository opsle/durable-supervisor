#!/usr/bin/env node
import { appendFileSync, closeSync, openSync, unlinkSync } from 'node:fs';
import { acquireHostLock } from '../../src/host-lock.js';

const [lockPath, criticalPath, logPath] = process.argv.slice(2);
const lock = acquireHostLock(lockPath, { attempts: 400, retryDelayMs: 2 });
let critical = null;
try {
  critical = openSync(criticalPath, 'wx');
  appendFileSync(logPath, `${process.pid}:enter\n`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80);
  appendFileSync(logPath, `${process.pid}:leave\n`);
} catch (error) {
  appendFileSync(logPath, `${process.pid}:overlap:${error.code ?? error.message}\n`);
  process.exitCode = 2;
} finally {
  if (critical != null) closeSync(critical);
  try { unlinkSync(criticalPath); } catch {}
  lock.release();
}
