import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeTempHome,
  makeTempProject,
  runNodeScript,
  runCli,
  preToolUseInput,
  userPromptSubmitInput,
  stopInput,
  nextSessionId,
  PRE_TOOL_USE_PATH,
  USER_PROMPT_SUBMIT_PATH,
  STOP_PATH,
} from '../helpers.mjs';

function edit(cwd, sessionId, filePath) {
  return preToolUseInput({ cwd, sessionId, toolName: 'Edit', toolInput: { file_path: filePath, old_string: 'a', new_string: 'b' } });
}

test('a grant that was used to mutate during the turn is revoked at Stop', () => {
  const home = makeTempHome();
  const cwd = makeTempProject();
  const sessionId = nextSessionId();
  const filePath = `${cwd}/src/user.ts`;

  runCli(['challenge', '--summary', 'x', '--files', filePath], { cwd, home });
  runNodeScript(USER_PROMPT_SUBMIT_PATH, { input: userPromptSubmitInput({ cwd, sessionId, prompt: 'answer' }), cwd, home });
  runCli(['grant', '--assessment', 'ok'], { cwd, home });

  // The grant is used to perform the approved edit.
  runNodeScript(PRE_TOOL_USE_PATH, { input: edit(cwd, sessionId, filePath), cwd, home });

  runNodeScript(STOP_PATH, { input: stopInput({ cwd, sessionId }), cwd, home });

  const status = runCli(['status'], { cwd, home });
  assert.match(status.stdout, /LOCKED/);

  // A further edit to the same file now requires a fresh grant.
  const result = runNodeScript(PRE_TOOL_USE_PATH, { input: edit(cwd, sessionId, filePath), cwd, home });
  const out = JSON.parse(result.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
});

test('an unused grant (no mutation happened) survives Stop', () => {
  const home = makeTempHome();
  const cwd = makeTempProject();
  const sessionId = nextSessionId();
  const filePath = `${cwd}/src/user.ts`;

  runCli(['challenge', '--summary', 'x', '--files', filePath], { cwd, home });
  runNodeScript(USER_PROMPT_SUBMIT_PATH, { input: userPromptSubmitInput({ cwd, sessionId, prompt: 'answer' }), cwd, home });
  runCli(['grant', '--assessment', 'ok'], { cwd, home });

  runNodeScript(STOP_PATH, { input: stopInput({ cwd, sessionId }), cwd, home });

  const status = runCli(['status'], { cwd, home });
  assert.match(status.stdout, /Phase: GRANTED/);
});

test('Stop never emits a decision that would force continuation (no recursion risk)', () => {
  const home = makeTempHome();
  const cwd = makeTempProject();
  const sessionId = nextSessionId();
  const result = runNodeScript(STOP_PATH, { input: stopInput({ cwd, sessionId }), cwd, home });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), '');
});
