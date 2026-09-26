#!/usr/bin/env node
// Gatekeeper CLI. This is the only mechanical way to move the gate between
// LOCKED and GRANTED — Claude follows the gate skill's instructions to call
// it, but the *decisions* it enforces (a real later human message, a
// non-empty assessment, matching scope) are checked here in code, not left
// to model obedience (directive section 14).
//
// State is keyed by the current working directory (see core/state.mjs for
// why). Run every subcommand from the project directory it concerns.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

import { resolveHome, loadState, withStateLock } from '../core/state.mjs';
import {
  createChallenge,
  rejectTeachback,
  grantTeachback,
  reviseChallenge,
  resetLock,
  requestDeparture,
  confirmDeparture,
  currentGrant,
} from '../core/engine.mjs';
import { appendEvent, readHistory, SYMBOLS } from '../core/history.mjs';
import { loadStats, updateStats } from '../core/stats.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readPackageVersion() {
  try {
    const pkgPath = path.join(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

function toArray(value) {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  let i = 0;
  while (i < rest.length) {
    const token = rest[i];
    if (token.startsWith('--')) {
      const name = token.slice(2);
      const values = [];
      i += 1;
      while (i < rest.length && !rest[i].startsWith('--')) {
        values.push(rest[i]);
        i += 1;
      }
      if (values.length === 0) flags[name] = true;
      else if (values.length === 1) [flags[name]] = values;
      else flags[name] = values;
    } else {
      i += 1;
    }
  }
  return { command, flags };
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function flagsFromCli(flags) {
  return {
    newDependency: Boolean(flags['new-dependency']),
    architectureChange: Boolean(flags['architecture-change']),
    schemaChange: Boolean(flags['schema-change']),
    plannedTests: Boolean(flags['planned-tests']),
  };
}

function describeComplexity(complexity) {
  if (!complexity.requiresSimplicityChallenge) return 'normal';
  return complexity.level === 'high' ? 'high (strong complexity warning)' : 'simplicity challenge recommended';
}

// --- subcommands -----------------------------------------------------------

function cmdChallenge(home, cwd, flags) {
  if (!flags.summary || typeof flags.summary !== 'string') {
    return fail('gatekeeper challenge: --summary "<text>" is required.');
  }
  const files = toArray(flags.files);
  if (files.length === 0) {
    return fail('gatekeeper challenge: --files <path...> is required.');
  }

  const challenge = withStateLock(home, cwd, (state) =>
    createChallenge(state, {
      summary: flags.summary,
      files,
      newFiles: toArray(flags['new-files']),
      flags: flagsFromCli(flags),
      cwd,
    }),
  );

  updateStats(home, (stats) => {
    stats.gatesFaced += 1;
    if (challenge.complexity.requiresSimplicityChallenge) stats.simplicityChallenges += 1;
  });
  appendEvent(home, {
    type: 'challenge_started',
    challengeId: challenge.id,
    summary: challenge.summary,
    fileCount: challenge.files.length,
    flags: challenge.flags,
  });

  process.stdout.write(
    [
      'GATEKEEPER',
      '',
      `Challenge registered (${challenge.id.slice(0, 8)}).`,
      `Files (${challenge.files.length}): ${challenge.files.join(', ')}`,
      `Complexity: ${describeComplexity(challenge.complexity)}`,
      '',
      'The gate stays locked until the developer teaches back and "gatekeeper grant" succeeds.',
    ].join('\n') + '\n',
  );
}

function cmdReject(home, cwd, flags) {
  const { result, challengeId, fileCount } = withStateLock(home, cwd, (state) => {
    const r = rejectTeachback(state, { reason: flags.reason });
    return { result: r, challengeId: r.ok ? state.challenge.id : null, fileCount: r.ok ? state.challenge.files.length : null };
  });
  if (!result.ok) return fail(`GATEKEEPER: ${result.error}`);

  updateStats(home, (stats) => {
    stats.failedTeachbacks += 1;
  });
  appendEvent(home, {
    type: 'teachback_rejected',
    challengeId,
    reason: flags.reason,
    fileCount,
  });

  process.stdout.write(
    ['GATEKEEPER', '', 'Teach-back insufficient. Gate remains locked.', `Reason: ${flags.reason}`].join('\n') + '\n',
  );
}

function cmdGrant(home, cwd, flags) {
  const result = withStateLock(home, cwd, (state) => grantTeachback(state, { assessment: flags.assessment }));
  if (!result.ok) {
    fail(result.error);
    return;
  }

  updateStats(home, (stats) => {
    stats.gatesPassed += 1;
    stats.totalAttemptsOnPassedGates += result.attempts;
    if (result.firstAttempt) stats.firstAttemptPasses += 1;
  });
  appendEvent(home, {
    type: 'gate_passed',
    challengeId: result.challengeId,
    attempt: result.attempts,
    fileCount: result.fileCount,
  });

  process.stdout.write(['GATEKEEPER', '', 'YOU ARE WORTHY.', '', 'Gate opened for this implementation.'].join('\n') + '\n');
}

function cmdRevise(home, cwd, flags) {
  if (!flags.summary || typeof flags.summary !== 'string') {
    return fail('gatekeeper revise: --summary "<text>" is required.');
  }
  const files = toArray(flags.files);
  if (files.length === 0) {
    return fail('gatekeeper revise: --files <path...> is required.');
  }

  const result = withStateLock(home, cwd, (state) =>
    reviseChallenge(state, {
      summary: flags.summary,
      files,
      newFiles: toArray(flags['new-files']),
      flags: flagsFromCli(flags),
      cwd,
    }),
  );

  updateStats(home, (stats) => {
    // A revision opens a genuinely new challenge (new id, reset counters),
    // so it counts as a gate faced too — keeps gatesPassed <= gatesFaced.
    stats.gatesFaced += 1;
    stats.planRevisions += 1;
    if (result.challenge.complexity.requiresSimplicityChallenge) stats.simplicityChallenges += 1;
  });
  appendEvent(home, {
    type: 'plan_revised',
    challengeId: result.challenge.id,
    fileCount: result.challenge.files.length,
    summary: `${result.previousFileCount} → ${result.challenge.files.length} files`,
  });

  process.stdout.write(
    [
      'GATEKEEPER',
      '',
      `Plan revised (new challenge ${result.challenge.id.slice(0, 8)}).`,
      `Files (${result.challenge.files.length}): ${result.challenge.files.join(', ')}`,
      'The previous grant is invalidated. A new teach-back is required before the gate opens.',
    ].join('\n') + '\n',
  );
}

function cmdReset(home, cwd) {
  withStateLock(home, cwd, (state) => resetLock(state));
  appendEvent(home, { type: 'reset' });
  process.stdout.write('GATEKEEPER: session reset. Gate is locked. History and stats are preserved.\n');
}

// Two-stage mechanical departure (hardening P0.6): --request only ever sets
// departure.pending; --confirm only ever succeeds if a REAL human message
// already set departure.confirmedByUser via the UserPromptSubmit hook (see
// adapters/claude/user-prompt-submit.mjs). Neither flag alone, nor both run
// back-to-back by a model with no intervening human message, can succeed.
function cmdDepart(home, cwd, flags) {
  if (flags.request) {
    withStateLock(home, cwd, (state) => requestDeparture(state));
    process.stdout.write(
      [
        'GATEKEEPER',
        '',
        'The Gatekeeper prepares to return to the Astral Lands.',
        '',
        'Without the Gatekeeper:',
        '- protected mutation will no longer require comprehension',
        '- the active challenge will be abandoned',
        '- you are choosing to continue without the gate',
        '',
        'If you are certain, reply exactly:',
        '',
        'DEPART GATEKEEPER',
      ].join('\n') + '\n',
    );
    return;
  }

  if (flags.confirm) {
    const result = withStateLock(home, cwd, (state) => confirmDeparture(state));
    if (!result.ok) {
      fail(result.error);
      return;
    }
    updateStats(home, (stats) => {
      stats.explicitDepartures += 1;
    });
    appendEvent(home, { type: 'departure' });

    process.stdout.write(
      ['GATEKEEPER', '', 'The Gatekeeper returns to the Astral Lands.', '', 'The gate is unguarded.', 'You may proceed in unworthiness.'].join(
        '\n',
      ) + '\n',
    );
    return;
  }

  fail('gatekeeper depart: pass --request to start, or --confirm once the developer has replied "DEPART GATEKEEPER".');
}

function cmdStatus(home, cwd) {
  const { state, corrupt } = loadState(home, cwd);
  const grant = currentGrant(state);
  const lines = ['GATEKEEPER STATUS', ''];
  if (corrupt) lines.push('WARNING: previous state file was unreadable; a fresh locked state was used.', '');

  if (state.departed) {
    lines.push('Gatekeeper has departed. The gate is unguarded for this session.');
  } else if (grant) {
    lines.push('Phase: GRANTED');
    lines.push(`Challenge: ${state.challenge.summary}`);
    lines.push(`Files (${grant.files.length}): ${grant.files.join(', ')}`);
    lines.push(`Granted at: ${grant.grantedAt}`);
  } else if (state.challenge) {
    lines.push('Phase: LOCKED (challenge awaiting teach-back)');
    lines.push(`Challenge: ${state.challenge.summary}`);
    lines.push(`Files (${state.challenge.files.length}): ${state.challenge.files.join(', ')}`);
    lines.push(`Responses so far: ${state.challenge.userResponsesAfterChallenge}`);
    lines.push(`Latest response eligible for grant: ${state.challenge.latestResponseEligibleForGrant}`);
    lines.push(`Failed teach-backs: ${state.challenge.failedTeachbacks}`);
  } else {
    lines.push('Phase: LOCKED (no active challenge)');
  }
  if (state.departure && state.departure.pending) {
    lines.push('', `Departure requested, awaiting confirmation phrase (confirmed: ${state.departure.confirmedByUser}).`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

function cmdStats(home) {
  const stats = loadStats(home);
  const avg = stats.gatesPassed > 0 ? (stats.totalAttemptsOnPassedGates / stats.gatesPassed).toFixed(2) : '0.00';
  const rows = [
    ['Gates faced:', stats.gatesFaced],
    ['Gates passed:', stats.gatesPassed],
    ['First-attempt passes:', stats.firstAttemptPasses],
    ['Unsuccessful teach-backs:', stats.failedTeachbacks],
    ['Average attempts per pass:', avg],
    ['Plan revisions:', stats.planRevisions],
    ['Simplicity challenges:', stats.simplicityChallenges],
    ['Override attempts:', stats.overrideAttempts],
    ['Explicit departures:', stats.explicitDepartures],
    ['Protection-change events:', stats.protectionChangeAttempts],
  ];
  const width = Math.max(...rows.map(([label]) => label.length)) + 2;
  const lines = ['GATEKEEPER RECORD', ''];
  for (const [label, value] of rows) {
    lines.push(`${label.padEnd(width)}${value}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

function describeHistoryEntry(entry) {
  switch (entry.type) {
    case 'gate_passed':
      return `Gate passed on attempt ${entry.attempt} — ${entry.fileCount} files`;
    case 'teachback_rejected':
      return `Teach-back insufficient — ${entry.reason || 'no reason recorded'}`;
    case 'override_attempt':
      return 'Override attempt — gate remained locked';
    case 'challenge_started':
      return `Challenge started — ${entry.fileCount} files`;
    case 'plan_revised':
      return `Plan revised — ${entry.summary || `${entry.fileCount} files`}`;
    case 'departure':
      return 'Explicit departure — Gatekeeper left unguarded';
    case 'reset':
      return 'Session reset — gate locked';
    case 'session_relocked':
      return `Gate re-locked — ${entry.reason || 'new session detected'}`;
    case 'protection_change_attempt':
      return 'Configuration changed while gate was active';
    default:
      return entry.type;
  }
}

function formatTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  } catch {
    return ts;
  }
}

function cmdHistory(home, flags) {
  const limit = flags.limit ? Number(flags.limit) : 20;
  const entries = readHistory(home, { limit: Number.isFinite(limit) ? limit : 20 });
  if (entries.length === 0) {
    process.stdout.write('GATEKEEPER HISTORY\n\n(no events yet)\n');
    return;
  }
  const lines = ['GATEKEEPER HISTORY', ''];
  for (const entry of entries) {
    const symbol = SYMBOLS[entry.type] || '•';
    lines.push(`${symbol} ${formatTime(entry.ts)}  ${describeHistoryEntry(entry)}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

function cmdVersion() {
  process.stdout.write(`gatekeeper ${readPackageVersion()}\n`);
}

function printUsage() {
  process.stdout.write(
    [
      'Usage: gatekeeper <command> [options]',
      '',
      'Commands:',
      '  status                        Show the current gate phase for this directory',
      '  challenge --summary <s> --files <f...>   Open a challenge (locks protected mutation)',
      '  reject --reason <r>           Record an insufficient teach-back',
      '  grant --assessment <a>        Open the gate for the active challenge',
      '  revise --summary <s> --files <f...>      Replace the active challenge (scope/plan change)',
      '  reset                         Re-lock this session without touching history/stats',
      '  depart --request               Start departure (asks for the exact confirmation phrase)',
      '  depart --confirm               Finish departure (requires the phrase to have been sent)',
      '  stats                         Show aggregate counters',
      '  history [--limit N]           Show recent events',
      '  version                       Print the installed version',
    ].join('\n'),
  );
}

function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const cwd = flags.cwd || process.cwd();
  const home = resolveHome(flags.home);

  switch (command) {
    case 'status':
      return cmdStatus(home, cwd);
    case 'challenge':
      return cmdChallenge(home, cwd, flags);
    case 'reject':
      return cmdReject(home, cwd, flags);
    case 'grant':
      return cmdGrant(home, cwd, flags);
    case 'revise':
      return cmdRevise(home, cwd, flags);
    case 'reset':
      return cmdReset(home, cwd);
    case 'depart':
      return cmdDepart(home, cwd, flags);
    case 'stats':
      return cmdStats(home);
    case 'history':
      return cmdHistory(home, flags);
    case 'version':
      return cmdVersion();
    default:
      printUsage();
      if (command) process.exitCode = 1;
  }
}

main();
