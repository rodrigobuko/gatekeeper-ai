#!/usr/bin/env node
// PreToolUse hook adapter. Registered for Edit|Write and Bash|PowerShell
// (hooks/hooks.json). Denies protected mutation while the gate is locked or
// out of scope; otherwise stays silent and lets Claude Code's normal
// permission flow decide (directive section 8).
//
// A crash or unrecognized input here fails OPEN (exits 0, no decision) —
// Gatekeeper is workflow enforcement, not a security sandbox, and a bug in
// this adapter must not be able to lock a developer out of their own editor
// with no recourse (directive section 2.10). A corrupted Gatekeeper STATE
// FILE is a different failure domain and fails CLOSED for protected
// mutation, handled inside state.mjs/engine.mjs.

import { resolveHome } from '../../core/state.mjs';
import { loadState, saveState } from '../../core/state.mjs';
import { observeSession, evaluateFileMutation, evaluateShellCommand } from '../../core/engine.mjs';
import { appendEvent } from '../../core/history.mjs';
import {
  readStdinJson,
  extractTargetFiles,
  shellFor,
  denyResponse,
  printJson,
} from './normalize.mjs';

function main() {
  const input = readStdinJson();
  const cwd = input.cwd || process.cwd();
  const toolName = input.tool_name;
  const toolInput = input.tool_input || {};
  const home = resolveHome();

  const { state, corrupt } = loadState(home, cwd);
  const { relocked } = observeSession(state, input.session_id);
  if (relocked) {
    appendEvent(home, { type: 'session_relocked', harness: 'claude' });
  }

  let result;
  if (toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit') {
    const targetFiles = extractTargetFiles(toolName, toolInput);
    if (targetFiles.length === 0) {
      saveState(home, cwd, state);
      return; // nothing to evaluate; let Claude Code's normal flow handle it
    }
    result = evaluateFileMutation(state, targetFiles, cwd);
  } else if (toolName === 'Bash' || toolName === 'PowerShell') {
    const command = toolInput.command;
    result = evaluateShellCommand(state, command, shellFor(toolName));
  } else {
    saveState(home, cwd, state);
    return;
  }

  saveState(home, cwd, state);

  if (!result.allowed) {
    const suffix = corrupt
      ? ' (a previous Gatekeeper state file was unreadable; treated as locked)'
      : '';
    printJson(denyResponse('PreToolUse', `${result.reason}${suffix}`));
  }
  // allowed: print nothing, exit 0 — no Gatekeeper decision, normal flow proceeds.
}

try {
  main();
} catch (err) {
  process.stderr.write(`gatekeeper pre-tool-use adapter error: ${err && err.stack ? err.stack : err}\n`);
  process.exitCode = 0;
}
