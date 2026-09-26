import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeTempHome,
  makeTempProject,
  runNodeScript,
  runCli,
  sessionStartInput,
  nextSessionId,
  SESSION_START_PATH,
} from '../helpers.mjs';

test('a fresh directory with no challenge produces no systemMessage', () => {
  const home = makeTempHome();
  const cwd = makeTempProject();
  const result = runNodeScript(SESSION_START_PATH, { input: sessionStartInput({ cwd, sessionId: nextSessionId() }), cwd, home });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), '');
});

test('a locked challenge produces a systemMessage reminder, shown to the human only', () => {
  const home = makeTempHome();
  const cwd = makeTempProject();
  runCli(['challenge', '--summary', 'Add cache', '--files', `${cwd}/src/user.ts`], { cwd, home });

  const result = runNodeScript(SESSION_START_PATH, {
    input: sessionStartInput({ cwd, sessionId: nextSessionId(), reason: 'compact' }),
    cwd,
    home,
  });
  const out = JSON.parse(result.stdout);
  assert.match(out.systemMessage, /LOCKED/);
  assert.match(out.systemMessage, /Add cache/);
  // Never a "decision" field — SessionStart cannot allow/deny anything.
  assert.equal('hookSpecificOutput' in out, false);
});

test('malformed input is handled safely (no crash, no output)', () => {
  const home = makeTempHome();
  const cwd = makeTempProject();
  const result = runNodeScript(SESSION_START_PATH, { input: '{ not json', cwd, home });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), '');
});
