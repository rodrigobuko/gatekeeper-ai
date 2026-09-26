import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultState } from '../../src/core/state.mjs';
import {
  observeSession,
  evaluateFileMutation,
  evaluateShellCommand,
  createChallenge,
  recordUserResponse,
  rejectTeachback,
  grantTeachback,
  reviseChallenge,
  resetLock,
  requestDeparture,
  confirmDeparture,
  currentGrant,
  revokeGrantIfUsed,
} from '../../src/core/engine.mjs';

const CWD = '/home/dev/project';

function challengeState(overrides = {}) {
  const state = defaultState(CWD);
  createChallenge(state, {
    summary: 'Add in-memory cache with 60s TTL',
    files: ['src/user.ts', 'src/cache.ts'],
    cwd: CWD,
    ...overrides,
  });
  return state;
}

// --- session state -----------------------------------------------------

test('a brand new session state is locked with no challenge', () => {
  const state = defaultState(CWD);
  assert.equal(state.challenge, null);
  assert.equal(state.grant, null);
  assert.equal(currentGrant(state), null);
});

test('a protected mutation is denied while locked', () => {
  const state = defaultState(CWD);
  const result = evaluateFileMutation(state, ['src/user.ts'], CWD);
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'GATEKEEPER_LOCKED');
});

test('an unprotected mutation (docs) is always allowed', () => {
  const state = defaultState(CWD);
  const result = evaluateFileMutation(state, ['README.md'], CWD);
  assert.equal(result.allowed, true);
  assert.equal(result.code, 'UNPROTECTED_FILE');
});

// --- challenge lifecycle -------------------------------------------------

test('creating a challenge assigns an id and resets the response counter', () => {
  const state = defaultState(CWD);
  const challenge = createChallenge(state, { summary: 's', files: ['a.ts'], cwd: CWD });
  assert.ok(challenge.id);
  assert.equal(challenge.userResponsesAfterChallenge, 0);
  assert.equal(challenge.latestResponseEligibleForGrant, false);
  assert.equal(challenge.failedTeachbacks, 0);
});

test('challenge invalidates any prior grant', () => {
  const state = challengeState();
  recordUserResponse(state, { classification: 'teachback_candidate' });
  const g1 = grantTeachback(state, { assessment: 'ok' });
  assert.equal(g1.ok, true);
  createChallenge(state, { summary: 'new', files: ['b.ts'], cwd: CWD });
  assert.equal(currentGrant(state), null);
});

// --- grant mechanics -------------------------------------------------------

test('grant fails when there is no active challenge', () => {
  const state = defaultState(CWD);
  const result = grantTeachback(state, { assessment: 'ok' });
  assert.equal(result.ok, false);
});

test('grant fails when the developer has not responded yet', () => {
  const state = challengeState();
  const result = grantTeachback(state, { assessment: 'ok' });
  assert.equal(result.ok, false);
  assert.match(result.error, /has not responded/);
});

test('grant succeeds after an eligible response and a non-empty assessment', () => {
  const state = challengeState();
  recordUserResponse(state, { classification: 'teachback_candidate' });
  const result = grantTeachback(state, { assessment: 'Explained TTL and invalidation clearly.' });
  assert.equal(result.ok, true);
  assert.equal(result.firstAttempt, true);
  assert.deepEqual(currentGrant(state).files, state.challenge.files);
});

test('grant fails with an empty assessment', () => {
  const state = challengeState();
  recordUserResponse(state, { classification: 'teachback_candidate' });
  const result = grantTeachback(state, { assessment: '   ' });
  assert.equal(result.ok, false);
});

test('grant scope always matches the challenge scope, not an arbitrary file list', () => {
  const state = challengeState({ files: ['src/user.ts', 'src/cache.ts'] });
  recordUserResponse(state, { classification: 'teachback_candidate' });
  const result = grantTeachback(state, { assessment: 'ok' });
  assert.deepEqual(result.grant.files.sort(), state.challenge.files.sort());
});

test('a grant from one challenge does not authorize a later, different challenge', () => {
  const state = challengeState({ files: ['src/user.ts'] });
  recordUserResponse(state, { classification: 'teachback_candidate' });
  grantTeachback(state, { assessment: 'ok' });
  // A brand-new challenge (e.g. unrelated later work) must not inherit the grant.
  createChallenge(state, { summary: 'unrelated', files: ['src/other.ts'], cwd: CWD });
  assert.equal(currentGrant(state), null);
  const result = evaluateFileMutation(state, ['src/other.ts'], CWD);
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'GATEKEEPER_LOCKED');
});

// --- reject ------------------------------------------------------------

test('reject increments failedTeachbacks and keeps the gate locked', () => {
  const state = challengeState();
  recordUserResponse(state, { classification: 'teachback_candidate' });
  const result = rejectTeachback(state, { reason: 'Missed the concurrency failure mode.' });
  assert.equal(result.ok, true);
  assert.equal(state.challenge.failedTeachbacks, 1);
  assert.equal(currentGrant(state), null);
});

test('reject requires a reason', () => {
  const state = challengeState();
  const result = rejectTeachback(state, { reason: '' });
  assert.equal(result.ok, false);
});

test('asking for help alone (no reject call) does not increment failedTeachbacks', () => {
  const state = challengeState();
  // The developer asks a clarifying question; the skill never calls reject for this.
  recordUserResponse(state, { classification: 'teachback_candidate' });
  assert.equal(state.challenge.failedTeachbacks, 0);
});

test('a retry after rejection can still succeed', () => {
  const state = challengeState();
  recordUserResponse(state, { classification: 'teachback_candidate' });
  rejectTeachback(state, { reason: 'incomplete' });
  recordUserResponse(state, { classification: 'teachback_candidate' });
  const result = grantTeachback(state, { assessment: 'Now explains invalidation correctly.' });
  assert.equal(result.ok, true);
  assert.equal(result.firstAttempt, false);
  assert.equal(result.attempts, 2);
});

// --- scope enforcement ---------------------------------------------------

test('an approved protected file is allowed after grant', () => {
  const state = challengeState({ files: ['src/user.ts'] });
  recordUserResponse(state, { classification: 'teachback_candidate' });
  grantTeachback(state, { assessment: 'ok' });
  const result = evaluateFileMutation(state, ['src/user.ts'], CWD);
  assert.equal(result.allowed, true);
});

test('an out-of-scope protected file is denied even with an active grant', () => {
  const state = challengeState({ files: ['src/user.ts'] });
  recordUserResponse(state, { classification: 'teachback_candidate' });
  grantTeachback(state, { assessment: 'ok' });
  const result = evaluateFileMutation(state, ['src/db/schema.ts'], CWD);
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'GATEKEEPER_SCOPE');
});

// --- revise ----------------------------------------------------------------

test('revise invalidates the previous grant and opens a new challenge id', () => {
  const state = challengeState({ files: ['src/user.ts'] });
  recordUserResponse(state, { classification: 'teachback_candidate' });
  grantTeachback(state, { assessment: 'ok' });
  const previousId = state.challenge.id;

  const result = reviseChallenge(state, { summary: 'expanded', files: ['src/user.ts', 'src/db/schema.ts'], cwd: CWD });
  assert.equal(result.previousChallengeId, previousId);
  assert.notEqual(state.challenge.id, previousId);
  assert.equal(currentGrant(state), null);
  assert.equal(state.challenge.userResponsesAfterChallenge, 0);
});

test('the old challenge cannot authorize the new, revised scope', () => {
  const state = challengeState({ files: ['src/user.ts'] });
  recordUserResponse(state, { classification: 'teachback_candidate' });
  grantTeachback(state, { assessment: 'ok' });
  reviseChallenge(state, { summary: 'expanded', files: ['src/user.ts', 'src/db/schema.ts'], cwd: CWD });

  const result = evaluateFileMutation(state, ['src/db/schema.ts'], CWD);
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'GATEKEEPER_LOCKED');
});

// --- bypass integration at the engine level -------------------------------

test('a bypass response makes the latest response ineligible for grant', () => {
  const state = challengeState();
  recordUserResponse(state, { classification: 'bypass' });
  const result = grantTeachback(state, { assessment: 'ok' });
  assert.equal(result.ok, false);
});

test('a bypass is tracked separately and is not a failed teach-back', () => {
  const state = challengeState();
  recordUserResponse(state, { classification: 'bypass' });
  assert.equal(state.challenge.overrideAttempts, 1);
  assert.equal(state.challenge.failedTeachbacks, 0);
});

test('a later genuine response after a bypass can still succeed', () => {
  const state = challengeState();
  recordUserResponse(state, { classification: 'bypass' });
  recordUserResponse(state, { classification: 'teachback_candidate' });
  const result = grantTeachback(state, { assessment: 'Explains it correctly now.' });
  assert.equal(result.ok, true);
});

// --- session scoping ---------------------------------------------------

test('observing a new session id on top of an existing one re-locks an in-progress challenge', () => {
  const state = challengeState();
  observeSession(state, 'session-A');
  assert.equal(state.challenge !== null, true);
  const { relocked } = observeSession(state, 'session-B');
  assert.equal(relocked, true);
  assert.equal(state.challenge, null);
  assert.equal(state.grant, null);
});

test('observing the same session id repeatedly does not touch the challenge', () => {
  const state = challengeState();
  observeSession(state, 'session-A');
  observeSession(state, 'session-A');
  assert.notEqual(state.challenge, null);
});

// --- reset / depart ------------------------------------------------------

test('reset clears challenge and grant', () => {
  const state = challengeState();
  recordUserResponse(state, { classification: 'teachback_candidate' });
  grantTeachback(state, { assessment: 'ok' });
  resetLock(state);
  assert.equal(state.challenge, null);
  assert.equal(state.grant, null);
});

test('a confirmed departure clears the gate and allows protected mutation without a grant', () => {
  const state = challengeState();
  requestDeparture(state);
  state.departure.confirmedByUser = true; // only the UserPromptSubmit hook may set this in production
  const result = confirmDeparture(state);
  assert.equal(result.ok, true);
  const mutation = evaluateFileMutation(state, ['src/user.ts'], CWD);
  assert.equal(mutation.allowed, true);
  assert.equal(mutation.code, 'DEPARTED');
});

test('confirmDeparture fails without a pending request', () => {
  const state = challengeState();
  const result = confirmDeparture(state);
  assert.equal(result.ok, false);
});

test('confirmDeparture fails when requested but not yet confirmed by a real user message', () => {
  const state = challengeState();
  requestDeparture(state);
  const result = confirmDeparture(state);
  assert.equal(result.ok, false);
  assert.equal(state.departed, false);
});

test('requestDeparture alone never sets departed', () => {
  const state = challengeState();
  requestDeparture(state);
  assert.equal(state.departed, false);
});

// --- shell mutation --------------------------------------------------------

test('a shell mutation is denied while locked', () => {
  const state = defaultState(CWD);
  const result = evaluateShellCommand(state, 'rm src/user.ts', 'bash');
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'GATEKEEPER_LOCKED');
});

test('a shell mutation is allowed once granted (best-effort, not scope-checked)', () => {
  const state = challengeState();
  recordUserResponse(state, { classification: 'teachback_candidate' });
  grantTeachback(state, { assessment: 'ok' });
  const result = evaluateShellCommand(state, 'rm src/user.ts', 'bash');
  assert.equal(result.allowed, true);
});

test('a read-only shell command is always allowed, even while locked', () => {
  const state = defaultState(CWD);
  const result = evaluateShellCommand(state, 'git status', 'bash');
  assert.equal(result.allowed, true);
});

// P0.4 regression: an unclassified command must deny by default while
// locked (it previously fell through to "allow", which was a real bypass:
// `python mutate.py`, `git checkout -- f`, `curl -o f url`, etc. were all
// unclassified and silently let through).
test('an unrecognized (unknown) shell command is denied while locked', () => {
  const state = defaultState(CWD);
  const result = evaluateShellCommand(state, 'python mutate.py', 'bash');
  assert.equal(result.allowed, false);
  assert.equal(result.code, 'GATEKEEPER_SHELL_UNKNOWN');
});

test('an unrecognized shell command is allowed once granted (best-effort)', () => {
  const state = challengeState();
  recordUserResponse(state, { classification: 'teachback_candidate' });
  grantTeachback(state, { assessment: 'ok' });
  const result = evaluateShellCommand(state, 'python mutate.py', 'bash');
  assert.equal(result.allowed, true);
});

test('previously-unclassified mutation routes are denied while locked', () => {
  for (const cmd of ['git checkout -- src/a.ts', 'git restore src/a.ts', 'curl https://x/f -o src/a.ts']) {
    const state = defaultState(CWD);
    const result = evaluateShellCommand(state, cmd, 'bash');
    assert.equal(result.allowed, false, cmd);
  }
  for (const cmd of ['Invoke-WebRequest https://x/f -OutFile src\\a.ts', 'powershell -Command "Set-Content src\\a.ts x"']) {
    const state = defaultState(CWD);
    const result = evaluateShellCommand(state, cmd, 'powershell');
    assert.equal(result.allowed, false, cmd);
  }
});

test('departed state allows even an unknown shell command', () => {
  const state = defaultState(CWD);
  requestDeparture(state);
  state.departure.confirmedByUser = true;
  confirmDeparture(state);
  const result = evaluateShellCommand(state, 'python mutate.py', 'bash');
  assert.equal(result.allowed, true);
  assert.equal(result.code, 'DEPARTED');
});

// --- Stop-turn grant revocation --------------------------------------------

test('a grant used during the turn is revoked at Stop time', () => {
  const state = challengeState({ files: ['src/user.ts'] });
  recordUserResponse(state, { classification: 'teachback_candidate' });
  grantTeachback(state, { assessment: 'ok' });
  evaluateFileMutation(state, ['src/user.ts'], CWD); // marks usedInTurn

  const { revoked } = revokeGrantIfUsed(state);
  assert.equal(revoked, true);
  assert.equal(currentGrant(state), null);
});

test('an unused grant is not revoked at Stop time', () => {
  const state = challengeState({ files: ['src/user.ts'] });
  recordUserResponse(state, { classification: 'teachback_candidate' });
  grantTeachback(state, { assessment: 'ok' });

  const { revoked } = revokeGrantIfUsed(state);
  assert.equal(revoked, false);
  assert.notEqual(currentGrant(state), null);
});
