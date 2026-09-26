// Concurrency regression tests for hardening P1.1. These spawn real,
// concurrent child processes (not just concurrent promises in one process)
// racing to mutate the same on-disk state/stats, to prove the lock actually
// prevents a lost update — the exact failure mode a temp-file-then-rename
// write alone does not protect against.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempHome, makeTempProject } from '../helpers.mjs';
import { loadStats } from '../../src/core/stats.mjs';
import { loadState } from '../../src/core/state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(__dirname, 'fixtures', 'lock-increment-worker.mjs');

function runWorkerAsync(home, cwd, target) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, target], {
      env: { ...process.env, GATEKEEPER_HOME: home },
      cwd,
      stdio: 'ignore',
    });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}`))));
  });
}

const CONCURRENCY = 20;

test('concurrent stats updates from separate processes do not lose an increment', async () => {
  const home = makeTempHome();
  const cwd = makeTempProject();

  await Promise.all(Array.from({ length: CONCURRENCY }, () => runWorkerAsync(home, cwd, 'stats')));

  const stats = loadStats(home);
  assert.equal(stats.gatesFaced, CONCURRENCY);
});

test('concurrent state updates from separate processes do not lose an increment', async () => {
  const home = makeTempHome();
  const cwd = makeTempProject();

  await Promise.all(Array.from({ length: CONCURRENCY }, () => runWorkerAsync(home, cwd, 'state')));

  const { state } = loadState(home, cwd);
  assert.equal(state.counter, CONCURRENCY);
});
