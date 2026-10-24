// Knowledge-aware gates, stage lifetime, decision checks and the
// dependency guard, at the engine level.

import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultState } from '../../src/core/state.mjs';
import {
  observeSession,
  evaluateFileMutation,
  evaluateShellCommand,
  createChallenge,
  startChallenge,
  recordUserResponse,
  grantTeachback,
  reviseChallenge,
  finishStage,
  passReview,
  failReview,
  resetLock,
  requestDeparture,
  confirmDeparture,
  currentGrant,
  validateChallengeInput,
  addsPackage,
} from '../../src/core/engine.mjs';

const CWD = '/home/dev/project';

function learnAll(state) {
  return state.challenge ? state.challenge.requiredConcepts.map((id) => ({ id, note: 'explained' })) : [];
}

function challengeState(overrides = {}) {
  const state = defaultState(CWD);
  createChallenge(state, { summary: 'Add cache', files: ['src/user.ts', 'src/cache.ts'], cwd: CWD, ...overrides });
  return state;
}

function grantedState(overrides = {}) {
  const state = challengeState({ files: ['src/user.ts'], ...overrides });
  recordUserResponse(state, { classification: 'teachback_candidate' });
  assert.equal(grantTeachback(state, { assessment: 'ok', learned: learnAll(state) }).ok, true);
  return state;
}

function finishedStageWithWork() {
  const state = grantedState();
  evaluateFileMutation(state, ['src/user.ts'], CWD);
  finishStage(state);
  return state;
}

// --- knowledge-aware gates -------------------------------------------------

test('in a fresh project every protected file in the plan is something to learn', () => {
  const state = challengeState();
  assert.deepEqual(state.challenge.requiredConcepts, ['file:src/user.ts', 'file:src/cache.ts']);
  assert.equal(state.challenge.tier, 'standard');
});

test('concepts the developer already knows are not asked again, and a known small change is light', () => {
  const state = challengeState({ knownConcepts: ['file:src/user.ts', 'file:src/cache.ts'] });
  assert.deepEqual(state.challenge.requiredConcepts, []);
  assert.equal(state.challenge.tier, 'light');
});

test('libraries and decisions are concepts too', () => {
  const state = challengeState({
    knownConcepts: ['file:src/user.ts', 'file:src/cache.ts'],
    uses: ['Redis'],
    decisions: ['Cache the promise, not the value'],
  });
  assert.deepEqual(state.challenge.requiredConcepts, ['dep:redis', 'decision:cache-the-promise-not-the-value']);
  assert.equal(state.challenge.tier, 'standard');
});

test('a big plan is a deep gate even when every file is known', () => {
  const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'].map((f) => `src/${f}`);
  const state = challengeState({ files, knownConcepts: files.map((f) => `file:${f}`) });
  assert.equal(state.challenge.tier, 'deep');
});

test('a light gate opens with one plain sentence, but never with passive approval', () => {
  const state = challengeState({ knownConcepts: ['file:src/user.ts', 'file:src/cache.ts'] });
  recordUserResponse(state, { classification: 'passive_approval' });
  assert.equal(grantTeachback(state, { assessment: 'ok' }).ok, false);
  recordUserResponse(state, { classification: 'other' });
  assert.equal(grantTeachback(state, { assessment: 'States the change correctly.' }).ok, true);
});

test('grant is denied until every new concept is covered', () => {
  const state = challengeState();
  recordUserResponse(state, { classification: 'teachback_candidate' });
  const partial = grantTeachback(state, { assessment: 'ok', learned: [{ id: 'file:src/user.ts', note: 'n' }] });
  assert.equal(partial.ok, false);
  assert.match(partial.error, /file:src\/cache\.ts/);
  assert.equal(grantTeachback(state, { assessment: 'ok', learned: learnAll(state) }).ok, true);
});

test('grant is denied for a learned concept that is not part of the plan', () => {
  const state = challengeState();
  recordUserResponse(state, { classification: 'teachback_candidate' });
  const result = grantTeachback(state, { assessment: 'ok', learned: [...learnAll(state), { id: 'dep:lodash', note: 'n' }] });
  assert.equal(result.ok, false);
  assert.match(result.error, /dep:lodash/);
});

test('a new dependency must be named, and architecture or schema changes must name a decision', () => {
  assert.equal(validateChallengeInput({ flags: { newDependency: true } }).ok, false);
  assert.equal(validateChallengeInput({ flags: { newDependency: true }, dependencies: ['redis'] }).ok, true);
  assert.equal(validateChallengeInput({ flags: { architectureChange: true } }).ok, false);
  assert.equal(validateChallengeInput({ flags: { schemaChange: true }, decisions: ['expiry column'] }).ok, true);
});

// --- stages and decision checks --------------------------------------------

test('the grant lasts for the whole stage, across many edits', () => {
  const state = grantedState();
  for (let i = 0; i < 3; i += 1) {
    assert.equal(evaluateFileMutation(state, ['src/user.ts'], CWD).allowed, true);
  }
  assert.notEqual(currentGrant(state), null);
});

test('finishing a stage that changed code opens a decision check and locks the gate', () => {
  const state = grantedState();
  evaluateFileMutation(state, ['src/user.ts'], CWD);
  const result = finishStage(state);
  assert.equal(result.ok, true);
  assert.equal(result.reviewOpened, true);
  assert.notEqual(state.review, null);
  assert.equal(evaluateFileMutation(state, ['src/user.ts'], CWD).allowed, false);
});

test('finishing a stage that changed nothing, or a light stage, needs no decision check', () => {
  const unused = grantedState();
  assert.equal(finishStage(unused).reviewOpened, false);

  const light = challengeState({ files: ['src/user.ts'], knownConcepts: ['file:src/user.ts'] });
  recordUserResponse(light, { classification: 'other' });
  grantTeachback(light, { assessment: 'ok' });
  evaluateFileMutation(light, ['src/user.ts'], CWD);
  assert.equal(finishStage(light).reviewOpened, false);
});

test('a pending decision check blocks the next grant until it passes', () => {
  const state = finishedStageWithWork();
  createChallenge(state, { summary: 'next', files: ['src/other.ts'], cwd: CWD });
  recordUserResponse(state, { classification: 'teachback_candidate' });
  const blocked = grantTeachback(state, { assessment: 'ok', learned: learnAll(state) });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /decision check/);

  assert.equal(passReview(state, { learned: [{ id: 'decision:cache-the-promise', note: 'n' }] }).ok, true);
  assert.equal(grantTeachback(state, { assessment: 'ok', learned: learnAll(state) }).ok, true);
});

test('a decision check needs a real answer and a named decision', () => {
  const state = finishedStageWithWork();
  const decision = [{ id: 'decision:x', note: 'n' }];

  assert.equal(passReview(state, { learned: decision }).ok, false); // no answer yet
  recordUserResponse(state, { classification: 'passive_approval' });
  assert.equal(passReview(state, { learned: decision }).ok, false);
  recordUserResponse(state, { classification: 'teachback_candidate' });
  assert.equal(passReview(state, { learned: [{ id: 'file:src/user.ts', note: 'n' }] }).ok, false);

  assert.equal(failReview(state, { reason: 'did not mention the alternative' }).ok, true);
  assert.equal(state.review.failedAttempts, 1);
  assert.equal(passReview(state, { learned: decision }).ok, false); // the failed answer does not count
  recordUserResponse(state, { classification: 'teachback_candidate' });
  const passed = passReview(state, { learned: decision });
  assert.equal(passed.ok, true);
  assert.equal(passed.attempts, 2);
});

test('starting a new plan without "done" still owes the decision check for the work already done', () => {
  const state = grantedState();
  evaluateFileMutation(state, ['src/user.ts'], CWD);
  const { reviewOpened } = startChallenge(state, { summary: 'next', files: ['src/other.ts'], cwd: CWD });
  assert.equal(reviewOpened, true);
  assert.notEqual(state.review, null);
});

test('a new session closes the stage, and the decision check survives it', () => {
  const state = grantedState();
  observeSession(state, 'session-a');
  evaluateFileMutation(state, ['src/user.ts'], CWD);
  observeSession(state, 'session-b');
  assert.equal(state.challenge, null);
  assert.notEqual(state.review, null);
});

test('a revision only asks about what is new, and keeps the stage work', () => {
  const state = grantedState();
  evaluateFileMutation(state, ['src/user.ts'], CWD);
  reviseChallenge(state, { summary: 'more', files: ['src/user.ts', 'src/other.ts'], cwd: CWD, knownConcepts: ['file:src/user.ts'] });
  assert.deepEqual(state.challenge.requiredConcepts, ['file:src/other.ts']);
  recordUserResponse(state, { classification: 'teachback_candidate' });
  grantTeachback(state, { assessment: 'ok', learned: learnAll(state) });
  assert.equal(finishStage(state).reviewOpened, true);
});

test('reset keeps a pending decision check, departure clears it', () => {
  const state = finishedStageWithWork();
  resetLock(state);
  assert.notEqual(state.review, null);
  requestDeparture(state);
  state.departure.confirmedByUser = true;
  confirmDeparture(state);
  assert.equal(state.review, null);
});

// --- new dependencies through the shell -------------------------------------

test('addsPackage only fires when a package name is given', () => {
  const adds = [
    'npm install redis',
    'npm i -D vitest',
    'yarn add lodash',
    'pnpm add zod',
    'pip install requests',
    'python -m pip install flask',
    'cargo add serde',
    'go get github.com/x/y',
    'dotnet add package Newtonsoft.Json',
  ];
  for (const cmd of adds) assert.equal(addsPackage(cmd), true, cmd);
  const restores = ['npm install', 'npm ci', 'npm install --save-dev', 'pip install -r requirements.txt', 'pip install -e .', 'npm test'];
  for (const cmd of restores) assert.equal(addsPackage(cmd), false, cmd);
});

test('under a grant, adding a library the plan never declared is denied', () => {
  const state = grantedState();
  const denied = evaluateShellCommand(state, 'npm install redis', 'bash');
  assert.equal(denied.allowed, false);
  assert.equal(denied.code, 'GATEKEEPER_DEPENDENCY');
  assert.equal(evaluateShellCommand(state, 'npm install', 'bash').allowed, true);

  const declared = grantedState({ dependencies: ['redis'], flags: { newDependency: true } });
  assert.equal(evaluateShellCommand(declared, 'npm install redis', 'bash').allowed, true);
});
