#!/usr/bin/env node
// Gatekeeper CLI. This is the only mechanical way to move the gate between
// LOCKED and GRANTED, Claude follows the gate skill's instructions to call
// it, but the *decisions* it enforces (a real later human message, a
// non-empty assessment, matching scope) are checked here in code, not left
// to model obedience (directive section 14).
//
// State is keyed by the current working directory (see core/state.mjs for
// why). Run every subcommand from the project directory it concerns.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

import { resolveHome, loadState, withStateLock, statePath } from '../core/state.mjs';
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
import { computeChangeShape } from '../core/git-baseline.mjs';

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

// A flag repeated across separate `--name value` occurrences accumulates
// (e.g. `--must-not-change "a" --must-not-change "b"` -> ["a", "b"]) rather
// than the last one winning, needed for optional repeatable flags like
// --must-not-change / --assumption (hardening section 8).
function setFlag(flags, name, values) {
  const value = values.length === 0 ? true : values.length === 1 ? values[0] : values;
  if (Object.prototype.hasOwnProperty.call(flags, name)) {
    const existing = Array.isArray(flags[name]) ? flags[name] : [flags[name]];
    const incoming = Array.isArray(value) ? value : [value];
    flags[name] = [...existing, ...incoming];
  } else {
    flags[name] = value;
  }
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
      setFlag(flags, name, values);
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
  const newExports = flags['new-exports'];
  return {
    newDependency: Boolean(flags['new-dependency']),
    architectureChange: Boolean(flags['architecture-change']),
    schemaChange: Boolean(flags['schema-change']),
    plannedTests: Boolean(flags['planned-tests']),
    newExportCount: newExports !== undefined ? Number(newExports) : 0,
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
      mustNotChange: toArray(flags['must-not-change']),
      assumptions: toArray(flags.assumption),
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

  const contractLines = [];
  if (challenge.mustNotChange.length > 0) {
    contractLines.push('Must remain true:', ...challenge.mustNotChange.map((s) => `- ${s}`), '');
  }
  if (challenge.assumptions.length > 0) {
    contractLines.push('Key assumption:', ...challenge.assumptions.map((s) => `- ${s}`), '');
  }

  process.stdout.write(
    [
      'GATEKEEPER',
      '',
      `Challenge registered (${challenge.id.slice(0, 8)}).`,
      `Files (${challenge.files.length}): ${challenge.files.join(', ')}`,
      `Complexity: ${describeComplexity(challenge.complexity)}`,
      '',
      ...contractLines,
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
      mustNotChange: toArray(flags['must-not-change']),
      assumptions: toArray(flags.assumption),
    }),
  );

  updateStats(home, (stats) => {
    // A revision opens a genuinely new challenge (new id, reset counters),
    // so it counts as a gate faced too, keeps gatesPassed <= gatesFaced.
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

// P1.4: stable, machine-readable status for status-line/IDE integrations
// and debug tooling. No secrets, no full prompts, the same compact-metadata
// discipline as history.mjs.
function statusToJson(state, corrupt) {
  const grant = currentGrant(state);
  let phase = 'locked';
  if (state.departed) phase = 'departed';
  else if (grant) phase = 'granted';
  else if (state.challenge) phase = 'challenge';

  return {
    version: 1,
    phase,
    corrupt,
    challengeId: state.challenge ? state.challenge.id : null,
    summary: state.challenge ? state.challenge.summary : null,
    fileCount: state.challenge ? state.challenge.files.length : grant ? grant.files.length : 0,
    responses: state.challenge ? state.challenge.userResponsesAfterChallenge : 0,
    latestResponseEligibleForGrant: state.challenge ? state.challenge.latestResponseEligibleForGrant : false,
    failedTeachbacks: state.challenge ? state.challenge.failedTeachbacks : 0,
    overrideAttempts: state.challenge ? state.challenge.overrideAttempts : 0,
    requiresSimplicityChallenge: state.challenge ? state.challenge.complexity.requiresSimplicityChallenge : false,
    grantedAt: grant ? grant.grantedAt : null,
    departurePending: Boolean(state.departure && state.departure.pending),
    departureConfirmed: Boolean(state.departure && state.departure.confirmedByUser),
  };
}

function cmdStatus(home, cwd, flags) {
  const { state, corrupt } = loadState(home, cwd);

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(statusToJson(state, corrupt))}\n`);
    return;
  }

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
    if (state.challenge.mustNotChange.length > 0) {
      lines.push(`Must remain true: ${state.challenge.mustNotChange.join(' | ')}`);
    }
    if (state.challenge.assumptions.length > 0) {
      lines.push(`Key assumption(s): ${state.challenge.assumptions.join(' | ')}`);
    }
  } else {
    lines.push('Phase: LOCKED (no active challenge)');
  }
  if (state.departure && state.departure.pending) {
    lines.push('', `Departure requested, awaiting confirmation phrase (confirmed: ${state.departure.confirmedByUser}).`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

// Section 9 diagnostic: on-demand change-shape summary since the challenge
// opened. Nothing here is persisted, it's computed fresh from git each
// time. This is groundwork for a future pre-push gate, not one itself: it
// only reports, it never denies anything.
function cmdDiff(home, cwd, flags) {
  const { state } = loadState(home, cwd);
  if (!state.challenge) {
    return fail('gatekeeper diff: no active challenge for this directory.');
  }
  if (!state.challenge.gitBaseline) {
    return fail('gatekeeper diff: no Git baseline was captured for this challenge (not a Git repo at challenge time?).');
  }

  const grant = currentGrant(state);
  const approvedFiles = grant ? grant.files : state.challenge.files;
  const shape = computeChangeShape(cwd, state.challenge.gitBaseline, approvedFiles);
  if (!shape) {
    return fail('gatekeeper diff: could not compute a diff (is Git still available in this directory?).');
  }

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(shape)}\n`);
    return;
  }

  const lines = [
    'GATEKEEPER DIFF',
    '',
    `Since challenge opened at ${shape.headShaAtChallenge.slice(0, 8)}:`,
    `${shape.changedCount} file(s) changed.${shape.statSummary ? ` ${shape.statSummary.trim()}` : ''}`,
  ];
  for (const entry of shape.changedFiles) {
    lines.push(`  ${entry.status}\t${entry.path}`);
  }
  if (shape.outOfScopeProtected.length > 0) {
    lines.push('', 'WARNING: protected files changed outside the approved scope:');
    for (const f of shape.outOfScopeProtected) lines.push(`  ${f}`);
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
      return `Gate passed on attempt ${entry.attempt}: ${entry.fileCount} files`;
    case 'teachback_rejected':
      return `Teach-back insufficient: ${entry.reason || 'no reason recorded'}`;
    case 'override_attempt':
      return 'Override attempt: gate remained locked';
    case 'challenge_started':
      return `Challenge started: ${entry.fileCount} files`;
    case 'plan_revised':
      return `Plan revised: ${entry.summary || `${entry.fileCount} files`}`;
    case 'departure':
      return 'Explicit departure: Gatekeeper left unguarded';
    case 'reset':
      return 'Session reset: gate locked';
    case 'session_relocked':
      return `Gate re-locked: ${entry.reason || 'new session detected'}`;
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

// Safe environment diagnostics for pilot bug reports (section 14). Never
// prints tokens, API keys, full prompts, source code, or full filesystem
// paths beyond what's needed to confirm the plugin is wired up.
function tryCommandVersion(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000 }).trim().split('\n')[0];
  } catch {
    return null;
  }
}

function collectDoctorReport(home, cwd) {
  const { state, corrupt } = loadState(home, cwd);
  const grant = currentGrant(state);
  let phase = 'locked';
  if (state.departed) phase = 'departed';
  else if (grant) phase = 'granted';
  else if (state.challenge) phase = 'challenge';

  const file = statePath(home, cwd);
  let stateReadable = true;
  try {
    if (fs.existsSync(file)) fs.accessSync(file, fs.constants.R_OK);
  } catch {
    stateReadable = false;
  }

  let historyWritable = true;
  try {
    fs.mkdirSync(home, { recursive: true });
    fs.accessSync(home, fs.constants.W_OK);
  } catch {
    historyWritable = false;
  }

  const isGitRepo = fs.existsSync(path.join(cwd, '.git'));
  const hooksConfigPath = path.join(__dirname, '..', '..', 'hooks', 'hooks.json');
  const hooksConfigPresent = fs.existsSync(hooksConfigPath);

  return {
    gatekeeperVersion: readPackageVersion(),
    nodeVersion: process.version,
    platform: `${os.platform()} ${os.release()} (${os.arch()})`,
    cwd,
    isGitRepo,
    gatePhase: phase,
    statePathExists: fs.existsSync(file),
    stateReadable,
    stateCorrupt: corrupt,
    gatekeeperHome: home,
    historyWritable,
    hooksConfigPresent,
    claudeCliVersion: tryCommandVersion('claude', ['--version']),
  };
}

function cmdDoctor(home, cwd, flags) {
  const report = collectDoctorReport(home, cwd);

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const lines = [
    'GATEKEEPER DOCTOR',
    '',
    `Gatekeeper version:     ${report.gatekeeperVersion}`,
    `Node version:           ${report.nodeVersion}`,
    `Platform:               ${report.platform}`,
    `Claude CLI version:     ${report.claudeCliVersion || 'not found on PATH'}`,
    `Current directory:      ${report.cwd}`,
    `Is a Git repo:          ${report.isGitRepo}`,
    `Gate phase:             ${report.gatePhase}`,
    `GATEKEEPER_HOME:        ${report.gatekeeperHome}`,
    `State file exists:      ${report.statePathExists}`,
    `State readable:         ${report.stateReadable}`,
    `State was corrupt:      ${report.stateCorrupt}`,
    `History dir writable:   ${report.historyWritable}`,
    `Plugin hooks.json found: ${report.hooksConfigPresent}`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

function printUsage() {
  process.stdout.write(
    [
      'Usage: gatekeeper <command> [options]',
      '',
      'Commands:',
      '  status [--json]                Show the current gate phase for this directory',
      '  doctor [--json]                 Safe environment diagnostics for bug reports',
      '  challenge --summary <s> --files <f...>   Open a challenge (locks protected mutation)',
      '  reject --reason <r>           Record an insufficient teach-back',
      '  grant --assessment <a>        Open the gate for the active challenge',
      '  revise --summary <s> --files <f...>      Replace the active challenge (scope/plan change)',
      '  reset                         Re-lock this session without touching history/stats',
      '  depart --request               Start departure (asks for the exact confirmation phrase)',
      '  depart --confirm               Finish departure (requires the phrase to have been sent)',
      '  diff [--json]                   Show files changed since the challenge opened (Git-based)',
      '  stats                         Show aggregate counters',
      '  history [--limit N]           Show recent events',
      '  version                       Print the installed version',
      '',
      'challenge/revise also accept: --new-files <f...> --new-dependency --architecture-change',
      '  --schema-change --planned-tests --new-exports <n> --must-not-change "<text>" (repeatable)',
      '  --assumption "<text>" (repeatable)',
    ].join('\n'),
  );
}

function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const cwd = flags.cwd || process.cwd();
  const home = resolveHome(flags.home);

  switch (command) {
    case 'status':
      return cmdStatus(home, cwd, flags);
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
    case 'diff':
      return cmdDiff(home, cwd, flags);
    case 'stats':
      return cmdStats(home);
    case 'history':
      return cmdHistory(home, flags);
    case 'version':
      return cmdVersion();
    case 'doctor':
      return cmdDoctor(home, cwd, flags);
    default:
      printUsage();
      if (command) process.exitCode = 1;
  }
}

main();
