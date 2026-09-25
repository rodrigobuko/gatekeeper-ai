#!/usr/bin/env node
// ConfigChange hook adapter — best-effort defense in depth (directive
// section 21). Claude Code fires this event on every settings/skills
// change with no per-hook matcher, and its exact payload shape for "what
// changed" is not something this v0.1 relies on. So this adapter does NOT
// attempt to parse a diff or decide whether the change specifically
// touched Gatekeeper's own hooks/skills — that would be guessing at an
// unconfirmed schema and pretending to a precision we don't have.
//
// What it DOES do: record that a configuration change happened at all,
// as a coarse audit trail entry, while an active challenge or grant
// exists. This can never block anything (ConfigChange has no permission
// decision to make), and it purposefully never blocks or nags outside an
// active gate, per "do not create hostile persistence or block unrelated
// configuration."

import { resolveHome, loadState, saveState } from '../../core/state.mjs';
import { appendEvent } from '../../core/history.mjs';
import { updateStats } from '../../core/stats.mjs';
import { readStdinJson } from './normalize.mjs';

function main() {
  let input = {};
  try {
    input = readStdinJson();
  } catch {
    return; // nothing to audit if we can't even parse the event
  }

  const cwd = input.cwd || process.cwd();
  const home = resolveHome();
  const { state } = loadState(home, cwd);

  const hasActiveGate = Boolean(state.challenge || state.grant);
  if (hasActiveGate) {
    updateStats(home, (stats) => {
      stats.protectionChangeAttempts += 1;
    });
    appendEvent(home, {
      type: 'protection_change_attempt',
      harness: 'claude',
      reason: 'Configuration changed while a Gatekeeper challenge/grant was active.',
    });
  }

  saveState(home, cwd, state);
}

try {
  main();
} catch (err) {
  process.stderr.write(`gatekeeper config-change adapter error: ${err && err.stack ? err.stack : err}\n`);
  process.exitCode = 0;
}
