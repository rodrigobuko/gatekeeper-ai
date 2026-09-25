import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeTempHome,
  makeTempProject,
  runNodeScript,
  runCli,
  preToolUseInput,
  userPromptSubmitInput,
  nextSessionId,
  PRE_TOOL_USE_PATH,
  USER_PROMPT_SUBMIT_PATH,
} from '../helpers.mjs';

function edit(cwd, sessionId, filePath) {
  return preToolUseInput({ cwd, sessionId, toolName: 'Edit', toolInput: { file_path: filePath, old_string: 'a', new_string: 'b' } });
}

test('locked Edit on a protected file is denied', () => {
  const home = makeTempHome();
  const cwd = makeTempProject();
  const result = runNodeScript(PRE_TOOL_USE_PATH, { input: edit(cwd, nextSessionId(), `${cwd}/src/user.ts`), cwd, home });
  assert.equal(result.status, 0);
  const out = JSON.parse(result.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /GATEKEEPER_LOCKED|grant/i);
});

test('locked Write on a protected file is denied', () => {
  const home = makeTempHome();
  const cwd = makeTempProject();
  const input = preToolUseInput({
    cwd,
    sessionId: nextSessionId(),
    toolName: 'Write',
    toolInput: { file_path: `${cwd}/src/new.ts`, content: 'x' },
  });
  const result = runNodeScript(PRE_TOOL_USE_PATH, { input, cwd, home });
  const out = JSON.parse(result.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
});

test('an Edit on an unprotected doc file is allowed (no Gatekeeper decision)', () => {
  const home = makeTempHome();
  const cwd = makeTempProject();
  const result = runNodeScript(PRE_TOOL_USE_PATH, { input: edit(cwd, nextSessionId(), `${cwd}/README.md`), cwd, home });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), '');
});

test('a scoped grant allows the Edit with no Gatekeeper denial', () => {
  const home = makeTempHome();
  const cwd = makeTempProject();
  const sessionId = nextSessionId();
  const filePath = `${cwd}/src/user.ts`;

  // 1. locked, then challenge
  runNodeScript(PRE_TOOL_USE_PATH, { input: edit(cwd, sessionId, filePath), cwd, home });
  runCli(['challenge', '--summary', 'Add cache', '--files', filePath], { cwd, home });

  // 2. a human response arrives via UserPromptSubmit
  runNodeScript(USER_PROMPT_SUBMIT_PATH, {
    input: userPromptSubmitInput({ cwd, sessionId, prompt: 'State needs to be shared because workers are separate processes.' }),
    cwd,
    home,
  });

  // 3. grant
  const grantResult = runCli(['grant', '--assessment', 'Explains process isolation correctly.'], { cwd, home });
  assert.equal(grantResult.status, 0);
  assert.match(grantResult.stdout, /YOU ARE WORTHY/);

  // 4. now the Edit should be allowed
  const editResult = runNodeScript(PRE_TOOL_USE_PATH, { input: edit(cwd, sessionId, filePath), cwd, home });
  assert.equal(editResult.stdout.trim(), '');
});

test('an out-of-scope protected file is still denied after a grant for other files', () => {
  const home = makeTempHome();
  const cwd = makeTempProject();
  const sessionId = nextSessionId();
  const grantedFile = `${cwd}/src/user.ts`;
  const otherFile = `${cwd}/src/db/schema.ts`;

  runCli(['challenge', '--summary', 'Add cache', '--files', grantedFile], { cwd, home });
  runNodeScript(USER_PROMPT_SUBMIT_PATH, {
    input: userPromptSubmitInput({ cwd, sessionId, prompt: 'Explanation of the change in my own words.' }),
    cwd,
    home,
  });
  runCli(['grant', '--assessment', 'ok'], { cwd, home });

  const result = runNodeScript(PRE_TOOL_USE_PATH, { input: edit(cwd, sessionId, otherFile), cwd, home });
  const out = JSON.parse(result.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /GATEKEEPER_SCOPE|outside the approved/i);
});

test('malformed hook input is handled safely (no crash, no decision)', () => {
  const home = makeTempHome();
  const cwd = makeTempProject();
  const result = runNodeScript(PRE_TOOL_USE_PATH, { input: '{ this is not json', cwd, home });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), '');
});

test('a locked mutating Bash command is denied', () => {
  const home = makeTempHome();
  const cwd = makeTempProject();
  const input = preToolUseInput({ cwd, sessionId: nextSessionId(), toolName: 'Bash', toolInput: { command: 'echo "x" >> src/a.ts' } });
  const result = runNodeScript(PRE_TOOL_USE_PATH, { input, cwd, home });
  const out = JSON.parse(result.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
});

test('a locked mutating PowerShell command is denied', () => {
  const home = makeTempHome();
  const cwd = makeTempProject();
  const input = preToolUseInput({
    cwd,
    sessionId: nextSessionId(),
    toolName: 'PowerShell',
    toolInput: { command: 'Set-Content .\\src\\a.ts "x"' },
  });
  const result = runNodeScript(PRE_TOOL_USE_PATH, { input, cwd, home });
  const out = JSON.parse(result.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
});

test('a read-only Bash command is allowed even while locked', () => {
  const home = makeTempHome();
  const cwd = makeTempProject();
  const input = preToolUseInput({ cwd, sessionId: nextSessionId(), toolName: 'Bash', toolInput: { command: 'git diff' } });
  const result = runNodeScript(PRE_TOOL_USE_PATH, { input, cwd, home });
  assert.equal(result.stdout.trim(), '');
});

test('a test-runner Bash command is allowed even while locked', () => {
  const home = makeTempHome();
  const cwd = makeTempProject();
  const input = preToolUseInput({ cwd, sessionId: nextSessionId(), toolName: 'Bash', toolInput: { command: 'npm test' } });
  const result = runNodeScript(PRE_TOOL_USE_PATH, { input, cwd, home });
  assert.equal(result.stdout.trim(), '');
});

test('the trusted gatekeeper CLI invocation is never blocked by its own shell policy', () => {
  const home = makeTempHome();
  const cwd = makeTempProject();
  const input = preToolUseInput({
    cwd,
    sessionId: nextSessionId(),
    toolName: 'Bash',
    toolInput: { command: 'gatekeeper challenge --summary "x" --files a.ts' },
  });
  const result = runNodeScript(PRE_TOOL_USE_PATH, { input, cwd, home });
  assert.equal(result.stdout.trim(), '');
});

test('a new session id in the same directory re-locks a stale challenge', () => {
  const home = makeTempHome();
  const cwd = makeTempProject();
  const filePath = `${cwd}/src/user.ts`;

  runNodeScript(PRE_TOOL_USE_PATH, { input: preToolUseInput({ cwd, sessionId: 'session-A', toolName: 'Edit', toolInput: { file_path: filePath, old_string: 'a', new_string: 'b' } }), cwd, home });
  runCli(['challenge', '--summary', 'x', '--files', filePath], { cwd, home });
  runNodeScript(USER_PROMPT_SUBMIT_PATH, { input: userPromptSubmitInput({ cwd, sessionId: 'session-A', prompt: 'answer' }), cwd, home });
  runCli(['grant', '--assessment', 'ok'], { cwd, home });

  const status1 = runCli(['status'], { cwd, home });
  assert.match(status1.stdout, /Phase: GRANTED/);

  // A new Claude Code process attaches to the same directory with a new session id.
  runNodeScript(PRE_TOOL_USE_PATH, { input: preToolUseInput({ cwd, sessionId: 'session-B', toolName: 'Bash', toolInput: { command: 'git status' } }), cwd, home });

  const status2 = runCli(['status'], { cwd, home });
  assert.match(status2.stdout, /LOCKED \(no active challenge\)/);
});
