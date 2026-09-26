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

import { resolveHome, withStateLock } from '../../core/state.mjs';
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

  const { result, corrupt, relocked } = withStateLock(home, cwd, (state, isCorrupt) => {
    const { relocked: didRelock } = observeSession(state, input.session_id);

    if (toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit') {
      const targetFiles = extractTargetFiles(toolName, toolInput);
      if (targetFiles.length === 0) {
        return { result: null, corrupt: isCorrupt, relocked: didRelock };
      }
      return { result: evaluateFileMutation(state, targetFiles, cwd), corrupt: isCorrupt, relocked: didRelock };
    }
    if (toolName === 'Bash' || toolName === 'PowerShell') {
      const command = toolInput.command;
      return { result: evaluateShellCommand(state, command, shellFor(toolName)), corrupt: isCorrupt, relocked: didRelock };
    }
    return { result: null, corrupt: isCorrupt, relocked: didRelock };
  });

  if (relocked) {
    appendEvent(home, { type: 'session_relocked', harness: 'claude' });
  }

  if (result && !result.allowed) {
    const suffix = corrupt
      ? ' (a previous Gatekeeper state file was unreadable; treated as locked)'
      : '';
    printJson(denyResponse('PreToolUse', `${result.reason}${suffix}`));
  }
  // allowed (or nothing to evaluate): print nothing, exit 0 — no Gatekeeper
  // decision, Claude Code's normal permission flow proceeds.
}

try {
  main();
} catch (err) {
  process.stderr.write(`gatekeeper pre-tool-use adapter error: ${err && err.stack ? err.stack : err}\n`);
  process.exitCode = 0;
}
