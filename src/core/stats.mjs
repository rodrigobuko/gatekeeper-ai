// Aggregate counters only. Never a human comprehension/skill score
// (directive section 2.5 / 22 — this is a workflow gate, not a ranking).

import fs from 'node:fs';
import path from 'node:path';
import { ensureHome } from './state.mjs';
import { withFileLock } from './lock.mjs';

const STATS_VERSION = 1;

function statsPath(home) {
  return path.join(home, 'profile.json');
}

export function defaultStats() {
  return {
    version: STATS_VERSION,
    gatesFaced: 0,
    gatesPassed: 0,
    firstAttemptPasses: 0,
    failedTeachbacks: 0,
    totalAttemptsOnPassedGates: 0,
    planRevisions: 0,
    simplicityChallenges: 0,
    overrideAttempts: 0,
    explicitDepartures: 0,
    protectionChangeAttempts: 0,
  };
}

export function loadStats(home) {
  const file = statsPath(home);
  if (!fs.existsSync(file)) return defaultStats();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...defaultStats(), ...parsed };
  } catch {
    return defaultStats();
  }
}

export function saveStats(home, stats) {
  ensureHome(home);
  const file = statsPath(home);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(stats, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return stats;
}

// Loads, applies `mutate` in place, persists, and returns the updated
// stats. Locked (hardening P1.1) so two hook processes bumping counters at
// the same time can't drop one side's increment.
export function updateStats(home, mutate) {
  ensureHome(home);
  return withFileLock(statsPath(home), () => {
    const stats = loadStats(home);
    mutate(stats);
    return saveStats(home, stats);
  });
}
