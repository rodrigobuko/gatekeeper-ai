// Dependency-free local-process file locking (hardening P1.1).
//
// The atomic temp-file-then-rename pattern used elsewhere protects a single
// WRITE from partial JSON, but it does not make a read -> modify -> write
// sequence atomic as a whole. Two hook processes racing for the same
// directory's state (or the shared stats file) could otherwise interleave
// and drop one side's update. This is a small mutex using exclusive file
// creation — no external dependency, no distributed-locking ambition, just
// enough to make the read-modify-write critical sections in this plugin
// safe against local concurrent Node processes.

import fs from 'node:fs';

const RETRY_DELAY_MS = 20;
const MAX_WAIT_MS = 2000; // comfortably below the 10s hook timeout in hooks.json
const STALE_LOCK_MS = 5000; // a holder that crashed without cleaning up

function sleepSync(ms) {
  // Atomics.wait gives a true synchronous sleep on Node's main thread with
  // no native addon and no busy-spinning.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquire(lockPath) {
  const deadline = Date.now() + MAX_WAIT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }

    let stale = false;
    try {
      stale = Date.now() - fs.statSync(lockPath).mtimeMs > STALE_LOCK_MS;
    } catch {
      continue; // the lock vanished between openSync and statSync; retry now
    }

    if (stale || Date.now() > deadline) {
      // Steal it rather than hang Claude Code indefinitely. A previous
      // holder that crashed mid-write is already guarded by the atomic
      // rename in state.mjs/stats.mjs, so the worst case here is losing at
      // most one interleaved update, not corrupting the file.
      try {
        fs.rmSync(lockPath, { force: true });
      } catch {
        /* another process already cleared it */
      }
      continue;
    }

    sleepSync(RETRY_DELAY_MS);
  }
}

function release(lockPath) {
  try {
    fs.rmSync(lockPath, { force: true });
  } catch {
    /* already gone */
  }
}

// Runs `fn` while holding an exclusive lock on `targetPath + '.lock'`.
// `fn` receives no arguments and its return value is passed through.
export function withFileLock(targetPath, fn) {
  const lockPath = `${targetPath}.lock`;
  acquire(lockPath);
  try {
    return fn();
  } finally {
    release(lockPath);
  }
}
