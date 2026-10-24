#!/usr/bin/env node
// Stop hook adapter. Never forces continuation (no recursion risk), it
// only does bookkeeping: if the active grant was used to perform a
// protected mutation during the turn that just ended, revoke it so
// unrelated next work cannot silently inherit it (directive section 19).
//
// Conservative choice, documented in the README: revocation is per-turn,
// not per-challenge. A multi-turn implementation under the same approved
// scope will re-request a grant on its next protected mutation; the skill
// explains this is a quick "still building the same approved thing?"
// confirmation, not a full new teach-back, as long as the challenge itself
// hasn't changed.

import { resolveHome, withStateLock } from '../../core/state.mjs';
import { revokeGrantIfUsed } from '../../core/engine.mjs';
import { appendEvent } from '../../core/history.mjs';
import { readStdinJson } from './normalize.mjs';

function main() {
  const input = readStdinJson();
  const cwd = input.cwd || process.cwd();
  const home = resolveHome();

  const { revoked, challengeId } = withStateLock(home, cwd, (state) => revokeGrantIfUsed(state));

  if (revoked) {
    appendEvent(home, { type: 'session_relocked', harness: 'claude', challengeId, reason: 'grant used, turn ended' });
  }
  // Always allow the normal stop; never emit a "continue" decision here.
}

try {
  main();
} catch (err) {
  process.stderr.write(`gatekeeper stop adapter error: ${err && err.stack ? err.stack : err}\n`);
  process.exitCode = 0;
}
