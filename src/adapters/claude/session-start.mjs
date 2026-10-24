#!/usr/bin/env node
// SessionStart hook adapter (hardening P1.3). Fires on startup, resume,
// /clear, compact, and fork (input.reason).
//
// IMPORTANT, verified limitation: the current Claude Code hook API lets
// SessionStart return `systemMessage`, which is shown to the HUMAN in the
// terminal UI, it is explicitly NOT inserted into the conversation the
// model reads (unlike UserPromptSubmit's plain-stdout-as-context). So this
// hook cannot give the MODEL a memory of the active challenge back after a
// compaction/resume; it can only remind the developer. Do not pretend
// otherwise. The mechanical guarantees (locked/scope) do not depend on the
// model remembering anyway, state lives on disk, and the next protected
// mutation attempt re-states the lock reason via PreToolUse regardless of
// what the model does or doesn't recall.

import { resolveHome, loadState } from '../../core/state.mjs';
import { currentGrant } from '../../core/engine.mjs';
import { readStdinJson, printJson } from './normalize.mjs';

function main() {
  const input = readStdinJson();
  const cwd = input.cwd || process.cwd();
  const home = resolveHome();

  const { state } = loadState(home, cwd);
  const grant = currentGrant(state);

  let message = null;
  if (grant) {
    message = `Gatekeeper: gate GRANTED for "${state.challenge.summary}" (${grant.files.length} files).`;
  } else if (state.challenge) {
    message = `Gatekeeper: gate LOCKED, awaiting teach-back for "${state.challenge.summary}" (${state.challenge.files.length} files).`;
  } else if (state.review) {
    message = `Gatekeeper: decision check pending for "${state.review.summary}". It comes before the next stage.`;
  } else if (state.departed) {
    message = 'Gatekeeper: this directory is unguarded (explicit departure).';
  }
  // Nothing to say for a plain fresh/no-challenge session, stay silent.

  if (message) {
    printJson({ systemMessage: message });
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`gatekeeper session-start adapter error: ${err && err.stack ? err.stack : err}\n`);
  process.exitCode = 0;
}
