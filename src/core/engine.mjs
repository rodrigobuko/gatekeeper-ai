// Gatekeeper Core: harness-independent state transitions. Every function
// here takes a plain state object (see state.mjs) and mutates it in place,
// returning a small result describing what happened. Adapters are
// responsible for loading state before, and persisting it after.
//
// This module must never import anything Claude-specific. The Claude Code
// adapter (src/adapters/claude/*) is the only place that speaks the hook
// JSON dialect; everything here speaks plain JS objects.
//
// The unit of work is a STAGE: one approved plan (a challenge), its grant,
// and the implementation under it. A stage ends with `gatekeeper done`, a
// new challenge, or a new session. A stage that actually changed code ends
// with a decision check (the "review"): one question about a real choice
// made in the code, which must pass before the next stage can be granted.

import crypto from 'node:crypto';
import { isProtectedFile, normalizeFilePath } from './files.mjs';
import { classifyCommand } from './shell-policy.mjs';
import { computeComplexity, countDirectoriesCrossed } from './complexity.mjs';
import { captureGitBaseline } from './git-baseline.mjs';
import { fileConceptId, dependencyConceptId, decisionConceptId, conceptKind } from './knowledge.mjs';

export function currentGrant(state) {
  if (!state.grant || !state.challenge) return null;
  if (state.grant.challengeId !== state.challenge.id) return null;
  return state.grant;
}

// Closes the current stage. If its grant was used to change protected code
// and the stage was not a light one, a decision check is left pending.
// Safe to call when there is nothing to close.
export function closeStage(state) {
  const grant = currentGrant(state);
  const workDone = Boolean((grant && grant.used) || (state.challenge && state.challenge.stageWork));
  const tier = state.challenge ? state.challenge.tier : null;
  let reviewOpened = false;
  if (workDone && tier && tier !== 'light') {
    state.review = {
      id: crypto.randomUUID(),
      challengeId: state.challenge.id,
      summary: state.challenge.summary,
      files: state.challenge.files,
      gitBaseline: state.challenge.stageBaseline || state.challenge.gitBaseline || null,
      openedAt: new Date().toISOString(),
      userResponses: 0,
      lastResponseClassification: null,
      failedAttempts: 0,
    };
    reviewOpened = true;
  }
  state.challenge = null;
  state.grant = null;
  return { reviewOpened, workDone };
}

// Call on every hook invocation that carries a harness session id
// (UserPromptSubmit, PreToolUse). A changed session id means a new Claude
// Code process attached to this same working directory, so any leftover
// challenge/grant from a previous process must not silently carry over.
// Work already done under it still owes its decision check.
export function observeSession(state, sessionId) {
  if (!sessionId) return { relocked: false };
  if (state.sessionId && state.sessionId !== sessionId) {
    const hadActiveWork = Boolean(state.challenge || state.grant);
    state.sessionId = sessionId;
    closeStage(state);
    return { relocked: hadActiveWork };
  }
  state.sessionId = sessionId;
  return { relocked: false };
}

export function evaluateFileMutation(state, targetFiles, cwd) {
  const normalizedTargets = targetFiles.map((f) => normalizeFilePath(f, cwd));
  const protectedTargets = normalizedTargets.filter((f) => isProtectedFile(f));

  if (protectedTargets.length === 0) {
    return { allowed: true, code: 'UNPROTECTED_FILE', reason: 'No protected files in this mutation.', protectedTargets };
  }

  if (state.departed) {
    return { allowed: true, code: 'DEPARTED', reason: 'Gatekeeper has explicitly departed for this session.', protectedTargets };
  }

  const grant = currentGrant(state);
  if (!grant) {
    return {
      allowed: false,
      code: 'GATEKEEPER_LOCKED',
      reason: state.review
        ? 'Protected mutation requires an active Gatekeeper grant. A decision check for the previous stage is still pending.'
        : 'Protected mutation requires an active Gatekeeper grant.',
      protectedTargets,
    };
  }

  const grantedSet = new Set(grant.files);
  const outOfScope = protectedTargets.filter((f) => !grantedSet.has(f));
  if (outOfScope.length > 0) {
    return {
      allowed: false,
      code: 'GATEKEEPER_SCOPE',
      reason: `File(s) outside the approved teach-back scope: ${outOfScope.join(', ')}. Call "gatekeeper revise" to extend scope.`,
      protectedTargets,
    };
  }

  grant.used = true;
  return { allowed: true, code: 'GATEKEEPER_GRANTED', reason: 'Covered by the active grant.', protectedTargets };
}

// Package manager commands that add a library. Shell mutation is not
// scope-checked once granted, so this is the one place a new dependency
// could otherwise slip in without the developer ever being asked about it.
const PACKAGE_ADD_RE = [
  /\b(?:npm|pnpm|bun)\s+(?:i|install|add)\b/i,
  /\byarn\s+add\b/i,
  /\bpip3?\s+install\b/i,
  /\bpython3?\s+-m\s+pip\s+install\b/i,
  /\b(?:poetry|uv|pdm|cargo)\s+add\b/i,
  /\buv\s+pip\s+install\b/i,
  /\bgo\s+get\b/i,
  /\bgem\s+install\b/i,
  /\bbundle\s+add\b/i,
  /\bcomposer\s+require\b/i,
  /\bdotnet\s+add\b[\s\S]*\bpackage\b/i,
];

// True only when a package NAME is given. `npm install` alone, or
// `pip install -r requirements.txt`, just restores what is already declared.
export function addsPackage(command) {
  if (typeof command !== 'string') return false;
  for (const re of PACKAGE_ADD_RE) {
    const match = re.exec(command);
    if (!match) continue;
    const tokens = command.slice(match.index + match[0].length).split(/[\s;&|]+/).filter(Boolean);
    let skipNext = false;
    for (const token of tokens) {
      if (skipNext) {
        skipNext = false;
        continue;
      }
      if (/^(?:-r|--requirement|-c|--constraint|-e|--editable)$/.test(token)) {
        skipNext = true;
        continue;
      }
      if (token.startsWith('-')) continue;
      if (token === '.' || token === 'package') continue;
      return true;
    }
  }
  return false;
}

// LOCKED policy (hardening P0.4): trusted-cli/read/test -> allow,
// mutation/unknown -> deny. A locked gate that let arbitrary unclassified
// shell commands through was too weak for the stated guarantee, e.g.
// `python mutate.py`, `git checkout -- f`, `curl -o f url` were previously
// unclassified and silently allowed. Once GRANTED, shell mutation remains
// allowed outright (best-effort, not scope-checked), except adding a
// package the approved plan never declared.
export function evaluateShellCommand(state, command, shell) {
  const classification = classifyCommand(command, shell);

  if (classification === 'trusted-cli') {
    return { allowed: true, code: 'TRUSTED_CLI', reason: 'Trusted Gatekeeper CLI invocation.', classification };
  }

  if (state.departed) {
    return { allowed: true, code: 'DEPARTED', reason: 'Gatekeeper has explicitly departed for this session.', classification };
  }

  const grant = currentGrant(state);

  if (grant) {
    if (addsPackage(command) && (state.challenge.dependencies || []).length === 0) {
      return {
        allowed: false,
        code: 'GATEKEEPER_DEPENDENCY',
        reason:
          'This command adds a library, but the approved plan declares no new dependency. ' +
          'Run "gatekeeper revise ... --new-dependency <name>" so the developer is asked why this library.',
        classification,
      };
    }
    if (classification === 'mutation' || classification === 'unknown') grant.used = true;
    return { allowed: true, code: 'GATEKEEPER_GRANTED', reason: 'Covered by the active grant.', classification };
  }

  if (classification === 'read' || classification === 'test') {
    return { allowed: true, code: 'SHELL_SAFE', reason: 'Recognized read-only or test/check command.', classification };
  }

  if (classification === 'mutation') {
    return {
      allowed: false,
      code: 'GATEKEEPER_LOCKED',
      reason: 'Protected mutation requires an active Gatekeeper grant.',
      classification,
    };
  }

  return {
    allowed: false,
    code: 'GATEKEEPER_SHELL_UNKNOWN',
    reason:
      'This command is not classified as read-only while the gate is locked. ' +
      'Use a clearly read-only command, or pass the Gatekeeper challenge before running it.',
    classification,
  };
}

// Checked before a challenge is created. Architecture and schema changes
// are exactly the choices the developer must be able to argue for, so they
// have to be named as decisions; a new dependency has to be named so the
// developer can be asked why that library.
export function validateChallengeInput({ flags = {}, dependencies = [], decisions = [] }) {
  if (flags.newDependency && dependencies.length === 0) {
    return { ok: false, error: '--new-dependency needs the library name(s), e.g. --new-dependency redis.' };
  }
  if ((flags.architectureChange || flags.schemaChange) && decisions.length === 0) {
    return {
      ok: false,
      error: 'An architecture or schema change needs at least one --decision "<the choice and its alternative>".',
    };
  }
  return { ok: true };
}

// Every concept this plan touches: the files it edits or creates, the
// libraries it adds or relies on, and the decisions it makes.
function conceptsForPlan({ files, newFiles, dependencies, uses, decisions, cwd }) {
  const ids = new Set();
  for (const f of [...files, ...newFiles]) {
    if (isProtectedFile(f)) ids.add(fileConceptId(f, cwd));
  }
  for (const d of [...dependencies, ...uses]) ids.add(dependencyConceptId(d));
  for (const d of decisions) ids.add(decisionConceptId(d));
  return [...ids];
}

// Light: nothing new to learn and nothing structural. One sentence from the
// developer is enough. Deep: the plan is big or structural, so the skill
// adds a simplicity challenge. Standard: everything else.
function tierFor({ requiredConcepts, complexity, flags }) {
  const structural = flags.newDependency || flags.architectureChange || flags.schemaChange;
  if (complexity.requiresSimplicityChallenge) return 'deep';
  if (requiredConcepts.length === 0 && !structural) return 'light';
  return 'standard';
}

export function createChallenge(
  state,
  {
    summary,
    files = [],
    newFiles = [],
    flags = {},
    cwd,
    mustNotChange = [],
    assumptions = [],
    dependencies = [],
    uses = [],
    decisions = [],
    knownConcepts = [],
    carryStageWork = false,
    stageBaseline = null,
  },
) {
  const normalizedFiles = files.map((f) => normalizeFilePath(f, cwd));
  const normalizedNewFiles = newFiles.map((f) => normalizeFilePath(f, cwd));
  for (const f of normalizedNewFiles) {
    if (!normalizedFiles.includes(f)) normalizedFiles.push(f);
  }
  const newExportCount = Number.isFinite(flags.newExportCount) ? flags.newExportCount : 0;
  const complexity = computeComplexity({
    fileCount: normalizedFiles.length,
    newFileCount: normalizedNewFiles.length,
    directoriesCrossed: countDirectoriesCrossed(normalizedFiles),
    newExportCount,
    flags,
  });

  const cleanDecisions = decisions.filter(Boolean);
  const concepts = conceptsForPlan({
    files: normalizedFiles,
    newFiles: [],
    dependencies,
    uses,
    decisions: cleanDecisions,
    cwd,
  });
  const known = new Set(knownConcepts);
  const requiredConcepts = concepts.filter((id) => !known.has(id));
  const tier = tierFor({ requiredConcepts, complexity, flags });

  state.challenge = {
    id: crypto.randomUUID(),
    summary,
    files: normalizedFiles,
    newFiles: normalizedNewFiles,
    dependencies: dependencies.filter(Boolean),
    uses: uses.filter(Boolean),
    decisions: cleanDecisions.map((text) => ({ id: decisionConceptId(text), text })),
    concepts,
    requiredConcepts,
    tier,
    // Compact task contract (hardening section 8): optional, only as much
    // as needed to give semantic plan drift a concrete object to check
    // against. Never a substitute for a full spec, just enough that "an
    // approved assumption became false" has something specific to point at.
    mustNotChange: Array.isArray(mustNotChange) ? mustNotChange.filter(Boolean) : [],
    assumptions: Array.isArray(assumptions) ? assumptions.filter(Boolean) : [],
    flags: {
      newDependency: Boolean(flags.newDependency),
      architectureChange: Boolean(flags.architectureChange),
      schemaChange: Boolean(flags.schemaChange),
      plannedTests: Boolean(flags.plannedTests),
    },
    complexity,
    // Section 9: a cheap local Git baseline, captured once at challenge
    // time, for change-shape verification later (`gatekeeper diff`), not
    // semantic grading, and never a full diff stored to disk.
    gitBaseline: captureGitBaseline(cwd),
    // Where the whole stage started, kept across revisions so the decision
    // check can look at everything the stage changed.
    stageBaseline,
    createdAt: new Date().toISOString(),
    stageWork: Boolean(carryStageWork),
    userResponsesAfterChallenge: 0,
    latestResponseEligibleForGrant: false,
    lastResponseClassification: null,
    failedTeachbacks: 0,
    overrideAttempts: 0,
  };
  state.grant = null;
  return state.challenge;
}

// A new plan starts a new stage, so whatever stage was open is closed
// first (and owes its decision check if it changed code).
export function startChallenge(state, options) {
  const { reviewOpened } = closeStage(state);
  const challenge = createChallenge(state, options);
  return { challenge, reviewOpened };
}

// `classification` is one of bypass/passive_approval/help_request/
// teachback_candidate/other (see bypass.mjs). Only teachback_candidate is
// mechanically grant-eligible for a standard or deep gate (hardening P0.5):
// a help request or passive approval must never make `grant` mechanically
// possible, no matter how the model judges it. The same message is also
// recorded against a pending decision check.
export function recordUserResponse(state, { classification = 'other' } = {}) {
  if (state.review) {
    state.review.userResponses += 1;
    state.review.lastResponseClassification = classification;
  }
  if (!state.challenge) {
    return { ok: Boolean(state.review), error: state.review ? undefined : 'No active challenge to respond to.' };
  }
  state.challenge.userResponsesAfterChallenge += 1;
  state.challenge.lastResponseClassification = classification;
  if (classification === 'bypass') {
    state.challenge.overrideAttempts += 1;
  }
  state.challenge.latestResponseEligibleForGrant = classification === 'teachback_candidate';
  return { ok: true, challenge: state.challenge };
}

export function rejectTeachback(state, { reason }) {
  if (!state.challenge) {
    return { ok: false, error: 'No active challenge to reject.' };
  }
  if (!reason || !reason.trim()) {
    return { ok: false, error: 'A rejection reason is required.' };
  }
  state.challenge.failedTeachbacks += 1;
  state.challenge.latestResponseEligibleForGrant = false;
  return { ok: true, challenge: state.challenge };
}

const NOT_AN_ANSWER = new Set(['bypass', 'passive_approval', 'help_request']);

function ineligibleHint(seen) {
  if (seen === 'bypass') return 'it looked like a bypass attempt';
  if (seen === 'passive_approval') return 'it looked like passive approval ("looks good", "go ahead", ...), not an explanation';
  if (seen === 'help_request') return 'it looked like a help request, not an explanation. Assistance does not count as an answer';
  return 'it did not look like a substantive explanation';
}

// `learned` is a list of { id, note } (see knowledge.parseLearned). Every
// concept the developer did not already know must be covered, so nothing
// new enters the codebase without the developer having explained it.
export function grantTeachback(state, { assessment, learned = [] } = {}) {
  if (!state.challenge) {
    return { ok: false, error: 'GATEKEEPER: grant denied. There is no active challenge for this session.' };
  }
  if (state.review) {
    return {
      ok: false,
      error:
        'GATEKEEPER: grant denied.\nThe decision check for the previous stage is still pending. ' +
        'Ask it and run "gatekeeper review --pass" first.',
    };
  }
  if (state.challenge.userResponsesAfterChallenge < 1) {
    return {
      ok: false,
      error: 'GATEKEEPER: grant denied.\nThe developer has not responded to the active challenge.',
    };
  }

  const seen = state.challenge.lastResponseClassification;
  const eligible =
    state.challenge.tier === 'light' ? !NOT_AN_ANSWER.has(seen) : state.challenge.latestResponseEligibleForGrant;
  if (!eligible) {
    return {
      ok: false,
      error: `GATEKEEPER: grant denied. The latest developer message does not satisfy the active challenge (${ineligibleHint(seen)}).`,
    };
  }
  if (!assessment || !assessment.trim()) {
    return { ok: false, error: 'GATEKEEPER: grant denied. An assessment is required.' };
  }

  const planConcepts = new Set(state.challenge.concepts || []);
  const unknownIds = learned.map((l) => l.id).filter((id) => !planConcepts.has(id));
  if (unknownIds.length > 0) {
    return {
      ok: false,
      error: `GATEKEEPER: grant denied. Not part of this plan: ${unknownIds.join(', ')}. Plan concepts: ${(state.challenge.concepts || []).join(', ')}.`,
    };
  }
  const covered = new Set(learned.map((l) => l.id));
  const missing = (state.challenge.requiredConcepts || []).filter((id) => !covered.has(id));
  if (missing.length > 0) {
    return {
      ok: false,
      error:
        `GATEKEEPER: grant denied. The developer has not yet shown understanding of: ${missing.join(', ')}.\n` +
        'Ask about them, then pass each one as --learned "<id> = <what the developer explained>".',
    };
  }

  const attempts = state.challenge.failedTeachbacks + 1;
  state.grant = {
    challengeId: state.challenge.id,
    files: state.challenge.files,
    assessment: assessment.trim(),
    grantedAt: new Date().toISOString(),
    used: false,
  };

  return {
    ok: true,
    grant: state.grant,
    challengeId: state.challenge.id,
    fileCount: state.challenge.files.length,
    tier: state.challenge.tier,
    learned,
    firstAttempt: state.challenge.failedTeachbacks === 0,
    attempts,
  };
}

// A revision continues the same stage with a new plan. Work already done
// under the old grant still counts toward the stage's decision check, and
// concepts the developer just learned are already in `knownConcepts`, so
// only what is genuinely new in the revision is asked about.
export function reviseChallenge(state, options) {
  const previousChallengeId = state.challenge ? state.challenge.id : null;
  const previousFileCount = state.challenge ? state.challenge.files.length : 0;
  const grant = currentGrant(state);
  const carryStageWork = Boolean((grant && grant.used) || (state.challenge && state.challenge.stageWork));
  const stageBaseline = state.challenge ? state.challenge.stageBaseline || state.challenge.gitBaseline || null : null;
  createChallenge(state, { ...options, carryStageWork, stageBaseline });
  return { ok: true, previousChallengeId, previousFileCount, challenge: state.challenge };
}

// `gatekeeper done`: the agent finished the approved stage.
export function finishStage(state) {
  if (!state.challenge) {
    return { ok: false, error: 'GATEKEEPER: nothing to finish. There is no active stage.' };
  }
  const summary = state.challenge.summary;
  const { reviewOpened, workDone } = closeStage(state);
  return { ok: true, summary, reviewOpened, workDone };
}

export function passReview(state, { learned = [] } = {}) {
  if (!state.review) {
    return { ok: false, error: 'GATEKEEPER: no decision check is pending.' };
  }
  if (state.review.userResponses < 1) {
    return { ok: false, error: 'GATEKEEPER: review denied.\nThe developer has not answered the decision check yet.' };
  }
  if (state.review.lastResponseClassification !== 'teachback_candidate') {
    return {
      ok: false,
      error: `GATEKEEPER: review denied. The latest developer message does not answer the decision check (${ineligibleHint(state.review.lastResponseClassification)}).`,
    };
  }
  const decisions = learned.filter((l) => conceptKind(l.id) === 'decision');
  if (decisions.length === 0) {
    return {
      ok: false,
      error: 'GATEKEEPER: review denied. Name the decision that was explained: --learned "decision:<name> = <what the developer explained>".',
    };
  }
  const review = state.review;
  state.review = null;
  return { ok: true, review, learned, attempts: review.failedAttempts + 1 };
}

export function failReview(state, { reason }) {
  if (!state.review) {
    return { ok: false, error: 'GATEKEEPER: no decision check is pending.' };
  }
  if (!reason || !reason.trim()) {
    return { ok: false, error: 'A reason is required.' };
  }
  state.review.failedAttempts += 1;
  state.review.lastResponseClassification = null;
  return { ok: true, review: state.review };
}

// Re-locks the current stage. A pending decision check is kept on purpose:
// reset is not a way to skip understanding code that was already written.
export function resetLock(state) {
  state.challenge = null;
  state.grant = null;
  state.departed = false;
  state.departure = null;
  return { ok: true };
}

// Two-stage mechanical departure (hardening P0.6). `depart --confirm` used
// to be mechanically sufficient by itself, with only the model instructed
// not to call it prematurely, too weak given Gatekeeper's anti-bypass
// promise. Now:
//   1. requestDeparture() sets departure.pending = true. This is the only
//      thing a CLI/model call can do on its own.
//   2. Only the UserPromptSubmit hook, observing a REAL human message that
//      contains the exact confirmation phrase, may set
//      departure.confirmedByUser = true (see adapters/claude/
//      user-prompt-submit.mjs). A model calling the CLI cannot create this.
//   3. confirmDeparture() (the CLI's `depart --confirm`) only succeeds when
//      BOTH departure.pending and departure.confirmedByUser are true.
export function requestDeparture(state) {
  state.departure = { pending: true, confirmedByUser: false, requestedAt: new Date().toISOString() };
  return { ok: true };
}

export function confirmDeparture(state) {
  if (!state.departure || !state.departure.pending) {
    return {
      ok: false,
      error: 'GATEKEEPER: departure denied. No pending departure request (run "gatekeeper depart --request" first).',
    };
  }
  if (!state.departure.confirmedByUser) {
    return {
      ok: false,
      error:
        'GATEKEEPER: departure denied. The developer has not sent a message containing the exact ' +
        'confirmation phrase yet.',
    };
  }
  state.departed = true;
  state.departure = null;
  state.challenge = null;
  state.grant = null;
  state.review = null;
  return { ok: true };
}
