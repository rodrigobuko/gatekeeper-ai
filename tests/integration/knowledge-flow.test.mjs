// The knowledge map end to end through the CLI: what was explained once is
// not asked again, and forgetting brings the question back.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeTempHome,
  makeTempProject,
  runNodeScript,
  runCli,
  userPromptSubmitInput,
  nextSessionId,
  USER_PROMPT_SUBMIT_PATH,
} from '../helpers.mjs';

function say(cwd, home, sessionId, prompt) {
  runNodeScript(USER_PROMPT_SUBMIT_PATH, { input: userPromptSubmitInput({ cwd, sessionId, prompt }), cwd, home });
}

function status(cwd, home) {
  return JSON.parse(runCli(['status', '--json'], { cwd, home }).stdout);
}

test('explained once, never asked again; forget brings it back', () => {
  const home = makeTempHome();
  const cwd = makeTempProject();
  const sessionId = nextSessionId();
  const file = `${cwd}/src/user.ts`;

  const first = runCli(['challenge', '--summary', 'Add cache', '--files', file, '--uses', 'redis'], { cwd, home });
  assert.equal(first.status, 0);
  assert.match(first.stdout, /Not yet understood by the developer/);
  assert.deepEqual(status(cwd, home).requiredConcepts, ['file:src/user.ts', 'dep:redis']);

  say(cwd, home, sessionId, 'user.ts loads users through the API client, and redis keeps the cache shared between workers.');
  const missing = runCli(['grant', '--assessment', 'ok', '--learned', 'file:src/user.ts = loads users'], { cwd, home });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /dep:redis/);

  const grant = runCli(
    ['grant', '--assessment', 'ok', '--learned', 'file:src/user.ts = loads users', '--learned', 'dep:redis = shared cache between workers'],
    { cwd, home },
  );
  assert.equal(grant.status, 0);
  assert.match(grant.stdout, /YOU ARE WORTHY\./);
  assert.match(grant.stdout, /Added to the knowledge map: file:src\/user\.ts, dep:redis/);

  const map = runCli(['knowledge'], { cwd, home });
  assert.match(map.stdout, /redis: shared cache between workers/);

  // Nothing was edited, so the stage closes without a decision check.
  assert.doesNotMatch(runCli(['done'], { cwd, home }).stdout, /Decision check pending/);

  const second = runCli(['challenge', '--summary', 'Tweak TTL', '--files', file, '--uses', 'redis'], { cwd, home });
  assert.match(second.stdout, /Gate: LIGHT/);
  assert.match(second.stdout, /Already understood \(do not ask again\): file:src\/user\.ts, dep:redis/);
  say(cwd, home, sessionId, 'Raise the TTL to 120 seconds.');
  assert.equal(runCli(['grant', '--assessment', 'States the change.'], { cwd, home }).status, 0);
  runCli(['done'], { cwd, home });

  assert.equal(runCli(['forget', '--concept', 'dep:redis'], { cwd, home }).status, 0);
  runCli(['challenge', '--summary', 'Again', '--files', file, '--uses', 'redis'], { cwd, home });
  assert.deepEqual(status(cwd, home).requiredConcepts, ['dep:redis']);
});

test('a bare --new-dependency and an undecided architecture change are rejected', () => {
  const home = makeTempHome();
  const cwd = makeTempProject();
  const file = `${cwd}/src/user.ts`;
  const bare = runCli(['challenge', '--summary', 'x', '--files', file, '--new-dependency'], { cwd, home });
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /library name/);
  const arch = runCli(['challenge', '--summary', 'x', '--files', file, '--architecture-change'], { cwd, home });
  assert.equal(arch.status, 1);
  assert.match(arch.stderr, /--decision/);
});
