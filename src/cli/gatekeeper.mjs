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
  startChallenge,
  validateChallengeInput,
  rejectTeachback,
  grantTeachback,
  reviseChallenge,
  finishStage,
  passReview,
  failReview,
  resetLock,
  requestDeparture,
  confirmDeparture,
  currentGrant,
} from '../core/engine.mjs';
import { appendEvent, readHistory, SYMBOLS } from '../core/history.mjs';
import { loadStats, updateStats } from '../core/stats.mjs';
import { computeChangeShape } from '../core/git-baseline.mjs';
import {
  loadKnowledge,
  updateKnowledge,
  knownConceptIds,
  learnConcepts,
  forgetConcept,
  parseLearned,
  CONCEPT_KINDS,
} from '../core/knowledge.mjs';

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

// `--new-dependency` carries the library names; a bare flag (no names) is
// kept as `true` only so validation can reject it with a clear message.
function dependencyNames(flags) {
  return toArray(flags['new-dependency']).filter((v) => typeof v === 'string');
}

// Shared by challenge and revise: reads the plan flags and the project's
// knowledge map, validates, and returns the options for the engine.
function planOptionsFromCli(home, cwd, flags, commandName) {
  if (!flags.summary || typeof flags.summary !== 'string') {
    return { error: `gatekeeper ${commandName}: --summary "<text>" is required.` };
  }
  const files = toArray(flags.files);
  if (files.length === 0 && toArray(flags['new-files']).length === 0) {
    return { error: `gatekeeper ${commandName}: --files <path...> is required.` };
  }
  const planFlags = flagsFromCli(flags);
  const dependencies = dependencyNames(flags);
  const decisions = toArray(flags.decision).filter((v) => typeof v === 'string');
  const validation = validateChallengeInput({ flags: planFlags, dependencies, decisions });
  if (!validation.ok) return { error: `gatekeeper ${commandName}: ${validation.error}` };

  return {
    options: {
      summary: flags.summary,
      files,
      newFiles: toArray(flags['new-files']),
      flags: planFlags,
      cwd,
      mustNotChange: toArray(flags['must-not-change']),
      assumptions: toArray(flags.assumption),
      dependencies,
      uses: toArray(flags.uses).filter((v) => typeof v === 'string'),
      decisions,
      knownConcepts: knownConceptIds(loadKnowledge(home, cwd)),
    },
  };
}

const TIER_TEXT = {
  light: 'LIGHT. Nothing new to learn here. One sentence from the developer, in their own words, is enough.',
  standard: 'STANDARD. Ask one strong question that covers what the developer does not know yet.',
  deep: 'DEEP. Run the simplicity challenge first, then ask about what the developer does not know yet.',
};

function planLines(challenge) {
  const known = challenge.concepts.filter((id) => !challenge.requiredConcepts.includes(id));
  const lines = [
    `Files (${challenge.files.length}): ${challenge.files.join(', ')}`,
    `Complexity: ${describeComplexity(challenge.complexity)}`,
    `Gate: ${TIER_TEXT[challenge.tier]}`,
    '',
  ];
  if (challenge.requiredConcepts.length > 0) {
    lines.push('Not yet understood by the developer (ask about these):');
    for (const id of challenge.requiredConcepts) lines.push(`- ${id}`);
    lines.push('');
  }
  if (known.length > 0) {
    lines.push(`Already understood (do not ask again): ${known.join(', ')}`, '');
  }
  return lines;
}

function reviewOpenedLines() {
  return [
    'The previous stage changed code, so its decision check is now pending.',
    'Ask that first: "gatekeeper status" shows it, "gatekeeper review" records it.',
    '',
  ];
}

// --- subcommands -----------------------------------------------------------

function cmdChallenge(home, cwd, flags) {
  const { options, error } = planOptionsFromCli(home, cwd, flags, 'challenge');
  if (error) return fail(error);

  const { challenge, reviewOpened } = withStateLock(home, cwd, (state) => startChallenge(state, options));

  updateStats(home, (stats) => {
    stats.gatesFaced += 1;
    if (challenge.complexity.requiresSimplicityChallenge) stats.simplicityChallenges += 1;
    if (challenge.tier === 'light') stats.lightGates += 1;
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
      ...planLines(challenge),
      ...contractLines,
      ...(reviewOpened ? reviewOpenedLines() : []),
      'The gate stays locked until the developer teaches back and "gatekeeper grant" succeeds.',
    ].join('\n') + '\n',
  );
}

// Each `--learned "<concept id> = <note>"` value, parsed. Returns
// { learned } or { error }.
function learnedFromCli(flags, commandName) {
  const values = toArray(flags.learned).filter((v) => typeof v === 'string');
  const learned = [];
  for (const value of values) {
    const parsed = parseLearned(value);
    if (!parsed) {
      return {
        error: `gatekeeper ${commandName}: could not read --learned "${value}". Use --learned "<id> = <what the developer explained>", with an id like file:src/a.ts, dep:redis or decision:cache-the-promise.`,
      };
    }
    learned.push(parsed);
  }
  return { learned };
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

function knowledgeLine(learned) {
  if (learned.length === 0) return [];
  return ['', `Added to the knowledge map: ${learned.map((l) => l.id).join(', ')}`];
}

function cmdGrant(home, cwd, flags) {
  const { learned, error } = learnedFromCli(flags, 'grant');
  if (error) return fail(error);

  const result = withStateLock(home, cwd, (state) => grantTeachback(state, { assessment: flags.assessment, learned }));
  if (!result.ok) {
    fail(result.error);
    return;
  }

  if (learned.length > 0) {
    updateKnowledge(home, cwd, (knowledge) => learnConcepts(knowledge, learned, { challengeId: result.challengeId }));
  }
  updateStats(home, (stats) => {
    stats.gatesPassed += 1;
    stats.totalAttemptsOnPassedGates += result.attempts;
    if (result.firstAttempt) stats.firstAttemptPasses += 1;
    stats.conceptsLearned += learned.length;
  });
  appendEvent(home, {
    type: 'gate_passed',
    challengeId: result.challengeId,
    attempt: result.attempts,
    fileCount: result.fileCount,
    learnedCount: learned.length,
  });

  process.stdout.write(
    [
      'GATEKEEPER',
      '',
      'YOU ARE WORTHY.',
      '',
      'Gate opened for this implementation.',
      ...knowledgeLine(learned),
      '',
      'The gate stays open for this whole stage. Run "gatekeeper done" when the stage is finished.',
    ].join('\n') + '\n',
  );
}

function cmdRevise(home, cwd, flags) {
  const { options, error } = planOptionsFromCli(home, cwd, flags, 'revise');
  if (error) return fail(error);

  const result = withStateLock(home, cwd, (state) => reviseChallenge(state, options));

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
      ...planLines(result.challenge),
      'The previous grant is invalidated. Ask only about what changed; what the developer already explained stays known.',
    ].join('\n') + '\n',
  );
}

function cmdDone(home, cwd) {
  const result = withStateLock(home, cwd, (state) => finishStage(state));
  if (!result.ok) return fail(result.error);

  appendEvent(home, { type: 'stage_finished', summary: result.summary, reviewOpened: result.reviewOpened });

  const lines = ['GATEKEEPER', '', `Stage finished: ${result.summary}`, ''];
  if (result.reviewOpened) {
    lines.push(
      'Decision check pending. Pick ONE real choice you made in the code of this stage, one that had an',
      'alternative (a library, a data structure, where the logic lives, how errors are handled), and ask',
      'the developer to explain or argue for it. "gatekeeper diff" shows what changed.',
      '',
      'The next stage cannot be granted until "gatekeeper review --pass" succeeds.',
    );
  } else {
    lines.push('No decision check needed for this stage. The gate is locked again.');
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

function cmdReview(home, cwd, flags) {
  if (flags.fail) {
    const result = withStateLock(home, cwd, (state) => failReview(state, { reason: flags.reason }));
    if (!result.ok) return fail(result.error);
    updateStats(home, (stats) => {
      stats.decisionChecksFailed += 1;
    });
    appendEvent(home, { type: 'review_failed', reason: flags.reason });
    process.stdout.write(
      ['GATEKEEPER', '', 'Decision check not passed yet. The next stage stays locked.', `Reason: ${flags.reason}`].join('\n') + '\n',
    );
    return;
  }

  if (flags.pass) {
    const { learned, error } = learnedFromCli(flags, 'review');
    if (error) return fail(error);
    const result = withStateLock(home, cwd, (state) => passReview(state, { learned }));
    if (!result.ok) return fail(result.error);

    updateKnowledge(home, cwd, (knowledge) => learnConcepts(knowledge, learned, { challengeId: result.review.challengeId }));
    updateStats(home, (stats) => {
      stats.decisionChecksPassed += 1;
      stats.conceptsLearned += learned.length;
    });
    appendEvent(home, { type: 'review_passed', attempt: result.attempts, learnedCount: learned.length });
    process.stdout.write(
      ['GATEKEEPER', '', 'Decision check passed. The developer can argue for this code.', ...knowledgeLine(learned)].join('\n') + '\n',
    );
    return;
  }

  fail('gatekeeper review: pass --pass --learned "decision:<name> = <note>", or --fail --reason "<what is missing>".');
}

function cmdKnowledge(home, cwd, flags) {
  const knowledge = loadKnowledge(home, cwd);
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(knowledge)}\n`);
    return;
  }
  const ids = Object.keys(knowledge.entries).sort();
  const lines = ['GATEKEEPER KNOWLEDGE MAP', ''];
  if (ids.length === 0) {
    lines.push('(nothing yet: every file, library and decision is still new)');
  }
  const titles = { file: 'Files', dep: 'Libraries', decision: 'Decisions' };
  for (const kind of CONCEPT_KINDS) {
    const ofKind = ids.filter((id) => knowledge.entries[id].kind === kind);
    if (ofKind.length === 0) continue;
    lines.push(`${titles[kind]}:`);
    for (const id of ofKind) lines.push(`  ${id.slice(kind.length + 1)}: ${knowledge.entries[id].note}`);
    lines.push('');
  }
  process.stdout.write(`${lines.join('\n').trimEnd()}\n`);
}

function cmdForget(home, cwd, flags) {
  const id = typeof flags.concept === 'string' ? flags.concept : null;
  if (!id) return fail('gatekeeper forget: --concept <id> is required, e.g. --concept dep:redis.');
  const removed = updateKnowledge(home, cwd, (knowledge) => forgetConcept(knowledge, id));
  if (!removed) return fail(`gatekeeper forget: "${id}" is not in the knowledge map.`);
  process.stdout.write(`GATEKEEPER: "${id}" removed from the knowledge map. It will be asked about again.\n`);
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
    tier: state.challenge ? state.challenge.tier || null : null,
    requiredConcepts: state.challenge ? state.challenge.requiredConcepts || [] : [],
    reviewPending: Boolean(state.review),
    reviewSummary: state.review ? state.review.summary : null,
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
    if (state.challenge.tier) lines.push(`Gate: ${state.challenge.tier}`);
    if ((state.challenge.requiredConcepts || []).length > 0) {
      lines.push(`Not yet understood: ${state.challenge.requiredConcepts.join(', ')}`);
    }
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
  if (state.review) {
    lines.push('', `Decision check pending for the previous stage: ${state.review.summary}`);
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
// While a decision check is pending, it shows the whole finished stage.
function cmdDiff(home, cwd, flags) {
  const { state } = loadState(home, cwd);
  const source = state.challenge || state.review;
  if (!source) {
    return fail('gatekeeper diff: no active challenge for this directory.');
  }
  if (!source.gitBaseline) {
    return fail('gatekeeper diff: no Git baseline was captured for this challenge (not a Git repo at challenge time?).');
  }

  const grant = currentGrant(state);
  const approvedFiles = grant ? grant.files : source.files;
  const shape = computeChangeShape(cwd, source.gitBaseline, approvedFiles);
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
    ['Light gates:', stats.lightGates],
    ['Concepts learned:', stats.conceptsLearned],
    ['Decision checks passed:', stats.decisionChecksPassed],
    ['Decision checks retried:', stats.decisionChecksFailed],
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
    case 'stage_finished':
      return `Stage finished${entry.reviewOpened ? ', decision check pending' : ''}`;
    case 'review_passed':
      return `Decision check passed on attempt ${entry.attempt}`;
    case 'review_failed':
      return `Decision check not passed yet: ${entry.reason || 'no reason recorded'}`;
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
      '  done                          Finish the current stage (may open a decision check)',
      '  review --pass --learned <l>    Record a passed decision check',
      '  review --fail --reason <r>     Record a decision check answer that was not enough',
      '  knowledge [--json]            Show what the developer already understands here',
      '  forget --concept <id>         Remove one item so it is asked about again',
      '  reset                         Re-lock this session without touching history/stats',
      '  depart --request               Start departure (asks for the exact confirmation phrase)',
      '  depart --confirm               Finish departure (requires the phrase to have been sent)',
      '  diff [--json]                   Show files changed since the challenge opened (Git-based)',
      '  stats                         Show aggregate counters',
      '  history [--limit N]           Show recent events',
      '  version                       Print the installed version',
      '',
      'challenge/revise also accept: --new-files <f...> --new-dependency <name...> --uses <name...>',
      '  --decision "<text>" (repeatable) --architecture-change --schema-change --planned-tests',
      '  --new-exports <n> --must-not-change "<text>" (repeatable) --assumption "<text>" (repeatable)',
      'grant also accepts: --learned "<concept id> = <note>" (repeatable)',
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
    case 'done':
      return cmdDone(home, cwd);
    case 'review':
      return cmdReview(home, cwd, flags);
    case 'knowledge':
      return cmdKnowledge(home, cwd, flags);
    case 'forget':
      return cmdForget(home, cwd, flags);
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
