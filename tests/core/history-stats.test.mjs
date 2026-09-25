import test from 'node:test';
import assert from 'node:assert/strict';
import { appendEvent, readHistory } from '../../src/core/history.mjs';
import { loadStats, saveStats, updateStats, defaultStats } from '../../src/core/stats.mjs';
import { resetLock } from '../../src/core/engine.mjs';
import { defaultState, loadState, saveState } from '../../src/core/state.mjs';
import { makeTempHome, makeTempProject } from '../helpers.mjs';

test('appendEvent + readHistory round-trips and orders newest first', () => {
  const home = makeTempHome();
  appendEvent(home, { type: 'challenge_started', challengeId: 'c1', fileCount: 2 });
  appendEvent(home, { type: 'gate_passed', challengeId: 'c1', attempt: 1, fileCount: 2 });
  const entries = readHistory(home, { limit: 10 });
  assert.equal(entries.length, 2);
  assert.equal(entries[0].type, 'gate_passed'); // newest first
  assert.equal(entries[1].type, 'challenge_started');
});

test('history entries never contain a raw prompt or message field', () => {
  const home = makeTempHome();
  appendEvent(home, { type: 'teachback_rejected', challengeId: 'c1', reason: 'short reason' });
  const [entry] = readHistory(home, { limit: 1 });
  assert.equal('prompt' in entry, false);
  assert.equal('message' in entry, false);
  assert.equal('code' in entry, false);
});

test('long strings passed into history are clamped, not stored in full', () => {
  const home = makeTempHome();
  const longReason = 'x'.repeat(5000);
  appendEvent(home, { type: 'teachback_rejected', reason: longReason });
  const [entry] = readHistory(home, { limit: 1 });
  assert.ok(entry.reason.length < 200);
});

test('stats start at zero and never include a human ranking/score field', () => {
  const home = makeTempHome();
  const stats = loadStats(home);
  assert.deepEqual(stats, defaultStats());
  assert.equal('score' in stats, false);
  assert.equal('rank' in stats, false);
  assert.equal('skillLevel' in stats, false);
});

test('updateStats persists mutations across loads', () => {
  const home = makeTempHome();
  updateStats(home, (s) => {
    s.gatesFaced += 1;
    s.gatesPassed += 1;
  });
  const reloaded = loadStats(home);
  assert.equal(reloaded.gatesFaced, 1);
  assert.equal(reloaded.gatesPassed, 1);
});

test('reset preserves history and stats (only session state is cleared)', () => {
  const home = makeTempHome();
  const cwd = makeTempProject();
  updateStats(home, (s) => {
    s.gatesFaced += 1;
  });
  appendEvent(home, { type: 'challenge_started', fileCount: 1 });

  const { state } = loadState(home, cwd);
  state.challenge = { id: 'x' };
  resetLock(state);
  saveState(home, cwd, state);

  assert.equal(loadStats(home).gatesFaced, 1);
  assert.equal(readHistory(home, { limit: 10 }).length, 1);
});
