import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadState, saveState, statePath, sessionKey } from '../../src/core/state.mjs';
import { makeTempHome, makeTempProject } from '../helpers.mjs';

test('a fresh session has no on-disk file and loads as locked/default', () => {
  const home = makeTempHome();
  const cwd = makeTempProject();
  const { state, corrupt } = loadState(home, cwd);
  assert.equal(corrupt, false);
  assert.equal(state.challenge, null);
  assert.equal(state.grant, null);
});

test('state persists across independent load calls (same process resuming)', () => {
  const home = makeTempHome();
  const cwd = makeTempProject();
  const { state } = loadState(home, cwd);
  state.sessionId = 'abc';
  saveState(home, cwd, state);

  const reloaded = loadState(home, cwd);
  assert.equal(reloaded.state.sessionId, 'abc');
});

test('two different working directories get two different state files', () => {
  const home = makeTempHome();
  const cwdA = makeTempProject();
  const cwdB = makeTempProject();
  assert.notEqual(sessionKey(cwdA), sessionKey(cwdB));
  assert.notEqual(statePath(home, cwdA), statePath(home, cwdB));
});

test('corrupt state fails closed: it is treated as a fresh locked state, not a crash', () => {
  const home = makeTempHome();
  const cwd = makeTempProject();
  const file = statePath(home, cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not valid json', 'utf8');

  const { state, corrupt } = loadState(home, cwd);
  assert.equal(corrupt, true);
  assert.equal(state.challenge, null);
  assert.equal(state.grant, null);
});

test('an on-disk file with an unrecognized shape is also treated as corrupt', () => {
  const home = makeTempHome();
  const cwd = makeTempProject();
  const file = statePath(home, cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ totally: 'not gatekeeper state' }), 'utf8');

  const { corrupt } = loadState(home, cwd);
  assert.equal(corrupt, true);
});

test('saveState writes atomically (no leftover .tmp file after a save)', () => {
  const home = makeTempHome();
  const cwd = makeTempProject();
  const { state } = loadState(home, cwd);
  saveState(home, cwd, state);
  const dir = path.dirname(statePath(home, cwd));
  const leftoverTmp = fs.readdirSync(dir).some((f) => f.endsWith('.tmp'));
  assert.equal(leftoverTmp, false);
});

test('a symlinked cwd and its real path share one state key (macOS /var -> /private/var)', () => {
  const real = makeTempProject();
  const link = `${real}-link`;
  // 'junction' works on Windows without admin rights; it is ignored elsewhere.
  fs.symlinkSync(real, link, 'junction');
  assert.equal(sessionKey(link), sessionKey(real));
});
