// Shared test helpers. Not a test file itself (no ".test." in the name).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.join(__dirname, '..');
export const CLI_PATH = path.join(REPO_ROOT, 'src', 'cli', 'gatekeeper.mjs');
export const PRE_TOOL_USE_PATH = path.join(REPO_ROOT, 'src', 'adapters', 'claude', 'pre-tool-use.mjs');
export const USER_PROMPT_SUBMIT_PATH = path.join(REPO_ROOT, 'src', 'adapters', 'claude', 'user-prompt-submit.mjs');
export const STOP_PATH = path.join(REPO_ROOT, 'src', 'adapters', 'claude', 'stop.mjs');
export const CONFIG_CHANGE_PATH = path.join(REPO_ROOT, 'src', 'adapters', 'claude', 'config-change.mjs');

export function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gatekeeper-home-'));
}

export function makeTempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gatekeeper-project-'));
}

export function runNodeScript(scriptPath, { input, cwd, home, env } = {}) {
  const result = spawnSync(process.execPath, [scriptPath], {
    input: input !== undefined ? (typeof input === 'string' ? input : JSON.stringify(input)) : undefined,
    cwd: cwd || process.cwd(),
    env: { ...process.env, GATEKEEPER_HOME: home, ...env },
    encoding: 'utf8',
  });
  return result;
}

export function runCli(args, { cwd, home, env } = {}) {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: cwd || process.cwd(),
    env: { ...process.env, GATEKEEPER_HOME: home, ...env },
    encoding: 'utf8',
  });
  return result;
}

let counter = 0;
export function nextSessionId(prefix = 'session') {
  counter += 1;
  return `${prefix}-${counter}`;
}

export function preToolUseInput({ cwd, sessionId, toolName, toolInput }) {
  return {
    session_id: sessionId,
    prompt_id: 'test-prompt-id',
    transcript_path: path.join(cwd, 'transcript.jsonl'),
    cwd,
    permission_mode: 'default',
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: 'test-tool-use-id',
  };
}

export function userPromptSubmitInput({ cwd, sessionId, prompt }) {
  return {
    session_id: sessionId,
    prompt_id: 'test-prompt-id',
    transcript_path: path.join(cwd, 'transcript.jsonl'),
    cwd,
    permission_mode: 'default',
    hook_event_name: 'UserPromptSubmit',
    prompt,
    prompt_index: 0,
  };
}

export function stopInput({ cwd, sessionId }) {
  return {
    session_id: sessionId,
    prompt_id: 'test-prompt-id',
    transcript_path: path.join(cwd, 'transcript.jsonl'),
    cwd,
    permission_mode: 'default',
    hook_event_name: 'Stop',
    last_assistant_message: 'done',
    stop_reason: 'end_turn',
  };
}
