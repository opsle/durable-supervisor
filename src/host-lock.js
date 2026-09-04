import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { canonicalJson, now, writeJson } from './io.js';
import { processStartIdentity } from './runtime-release.js';

export const HOST_LOCK_SCHEMA = 'opsle.durable-supervisor.host-lock/v1';

function classifiedError(classification, message) {
  const error = new Error(`${classification}: ${message}`);
  error.code = classification;
  error.classification = classification;
  return error;
}

export function sameProcessIdentity(left, right) {
  return left != null && right != null
    && left.pid === right.pid
    && left.start_time_ticks === right.start_time_ticks
    && left.executable === right.executable;
}

function exactProcessIdentity(value) {
  return Number.isSafeInteger(value?.pid) && value.pid > 0
    && typeof value.start_time_ticks === 'string' && value.start_time_ticks.length > 0
    && typeof value.executable === 'string' && value.executable.startsWith('/');
}

function readOwner(lockPath) {
  try {
    if (!lstatSync(lockPath).isDirectory()) return null;
    const bytes = readFileSync(join(lockPath, 'owner.json'), 'utf8');
    const owner = JSON.parse(bytes);
    if (bytes !== canonicalJson(owner)
        || owner?.schema !== HOST_LOCK_SCHEMA
        || !exactProcessIdentity(owner.process)
        || typeof owner.acquired_at !== 'string'
        || Object.keys(owner).sort().join(',') !== 'acquired_at,process,schema') return null;
    return { owner, bytes };
  } catch {
    return null;
  }
}

function temporarySibling(path, label) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = mkdtempSync(join(dirname(path), `.${basename(path)}.${label}-`));
  rmdirSync(temporary);
  return temporary;
}

function releaseObservedLock(lockPath, observed) {
  const retired = temporarySibling(lockPath, 'retired');
  try {
    renameSync(lockPath, retired);
  } catch (error) {
    if (['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(error.code)) return false;
    throw error;
  }
  const moved = readOwner(retired);
  if (!moved || moved.bytes !== observed.bytes) {
    rmSync(retired, { recursive: true, force: true });
    throw classifiedError('CORRUPT', `host lock owner changed during atomic retirement: ${lockPath}`);
  }
  rmSync(retired, { recursive: true, force: true });
  return true;
}

function takeoverName(processIdentity) {
  return `${processIdentity.pid}-${processIdentity.start_time_ticks.replaceAll(/[^0-9A-Za-z.-]/g, '_')}`;
}

function retireStaleLock(lockPath, observed, processIdentity, getProcessIdentity) {
  const takeovers = join(lockPath, '.takeovers');
  const candidate = join(takeovers, takeoverName(processIdentity));
  try {
    try { mkdirSync(takeovers, { mode: 0o700 }); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    try { mkdirSync(candidate, { mode: 0o700 }); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    writeJson(join(candidate, 'owner.json'), {
      schema: HOST_LOCK_SCHEMA,
      process: processIdentity,
      acquired_at: now(),
    });
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  const current = readOwner(lockPath);
  if (!current || current.bytes !== observed.bytes) {
    rmSync(candidate, { recursive: true, force: true });
    return false;
  }

  const liveCandidates = [];
  let names;
  try { names = readdirSync(takeovers).sort(); } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  for (const name of names) {
    const path = join(takeovers, name);
    const contender = readOwner(path);
    if (!contender
        || !sameProcessIdentity(
          contender.owner.process,
          getProcessIdentity(contender.owner.process.pid),
        )) {
      rmSync(path, { recursive: true, force: true });
      continue;
    }
    liveCandidates.push(name);
  }
  if (liveCandidates[0] !== basename(candidate)) {
    rmSync(candidate, { recursive: true, force: true });
    return false;
  }

  const confirmed = readOwner(lockPath);
  if (!confirmed || confirmed.bytes !== observed.bytes) {
    rmSync(candidate, { recursive: true, force: true });
    return false;
  }
  const retired = temporarySibling(lockPath, 'retired');
  try {
    renameSync(lockPath, retired);
  } catch (error) {
    if (['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(error.code)) return false;
    throw error;
  }
  const moved = readOwner(retired);
  if (!moved || moved.bytes !== observed.bytes) {
    throw classifiedError('CORRUPT', `host lock owner changed during stale takeover: ${lockPath}`);
  }
  rmSync(retired, { recursive: true, force: true });
  return true;
}

function waitMilliseconds(milliseconds) {
  if (milliseconds <= 0) return;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
}

export function acquireHostLock(lockPath, {
  attempts = 40,
  retryDelayMs = 5,
  getProcessIdentity = processStartIdentity,
  clock = now,
  wait = waitMilliseconds,
} = {}) {
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new Error('host lock attempts must be a positive integer');
  }
  const processIdentity = getProcessIdentity(process.pid);
  if (!exactProcessIdentity(processIdentity)) {
    throw new Error('host lock requires exact owner PID, process start ticks, and executable');
  }
  const owner = {
    schema: HOST_LOCK_SCHEMA,
    process: processIdentity,
    acquired_at: clock(),
  };

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const candidate = temporarySibling(lockPath, 'candidate');
    try {
      mkdirSync(candidate, { mode: 0o700 });
      writeJson(join(candidate, 'owner.json'), owner);
      try {
        renameSync(candidate, lockPath);
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      }
      if (!existsSync(candidate)) {
        let released = false;
        return {
          path: lockPath,
          owner: structuredClone(owner),
          release() {
            if (released) return false;
            released = true;
            const observed = readOwner(lockPath);
            if (!observed || canonicalJson(observed.owner) !== canonicalJson(owner)) return false;
            return releaseObservedLock(lockPath, observed);
          },
        };
      }
    } finally {
      rmSync(candidate, { recursive: true, force: true });
    }

    const observed = readOwner(lockPath);
    if (observed) {
      const live = getProcessIdentity(observed.owner.process.pid);
      if (!sameProcessIdentity(observed.owner.process, live)) {
        if (retireStaleLock(lockPath, observed, processIdentity, getProcessIdentity)) continue;
      }
    }
    if (attempt < attempts) wait(retryDelayMs);
  }
  throw classifiedError('BUSY', `host lock did not become available after ${attempts} attempts: ${lockPath}`);
}
