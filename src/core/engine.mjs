// Gatekeeper Core: harness-independent state transitions. Every function
// here takes a plain state object (see state.mjs) and mutates it in place,
// returning a small result describing what happened. Adapters are
// responsible for loading state before, and persisting it after.
//
// This module must never import anything Claude-specific. The Claude Code
// adapter (src/adapters/claude/*) is the only place that speaks the hook
// JSON dialect; everything here speaks plain JS objects.

import crypto from 'node:crypto';
import { isProtectedFile, normalizeFilePath } from './files.mjs';
import { classifyCommand } from './shell-policy.mjs';
import { computeComplexity, countDirectoriesCrossed } from './complexity.mjs';
import { captureGitBaseline } from './git-baseline.mjs';

export function currentGrant(state) {
  if (!state.grant || !state.challenge) return null;
  if (state.grant.challengeId !== state.challenge.id) return null;
  return state.grant;
}

// Call on every hook invocation that carries a harness session id
// (UserPromptSubmit, PreToolUse). A changed session id means a new Claude
// Code process attached to this same working directory, any leftover
// challenge/grant from a previous process must not silently carry over.
export function observeSession(state, sessionId) {
  if (!sessionId) return { relocked: false };
  if (state.sessionId && state.sessionId !== sessionId) {
    const hadActiveWork = Boolean(state.challenge || state.grant);
    state.sessionId = sessionId;
    state.challenge = null;
    state.grant = null;
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
      reason: 'Protected mutation requires an active Gatekeeper grant.',
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

  grant.usedInTurn = true;
  return { allowed: true, code: 'GATEKEEPER_GRANTED', reason: 'Covered by the active grant.', protectedTargets };
}

// LOCKED policy (hardening P0.4): trusted-cli/read/test -> allow,
// mutation/unknown -> deny. A locked gate that let arbitrary unclassified
// shell commands through was too weak for the stated guarantee, e.g.
// `python mutate.py`, `git checkout -- f`, `curl -o f url` were previously
// unclassified and silently allowed. Once GRANTED, shell mutation remains
// allowed outright (best-effort, not scope-checked) as before; this policy
// only tightens the LOCKED case.
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
    if (classification === 'mutation') grant.usedInTurn = true;
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

export function createChallenge(state, { summary, files = [], newFiles = [], flags = {}, cwd, mustNotChange = [], assumptions = [] }) {
  const normalizedFiles = files.map((f) => normalizeFilePath(f, cwd));
  const normalizedNewFiles = newFiles.map((f) => normalizeFilePath(f, cwd));
  const newExportCount = Number.isFinite(flags.newExportCount) ? flags.newExportCount : 0;
  const complexity = computeComplexity({
    fileCount: normalizedFiles.length,
    newFileCount: normalizedNewFiles.length,
    directoriesCrossed: countDirectoriesCrossed(normalizedFiles),
    newExportCount,
    flags,
  });

  state.challenge = {
    id: crypto.randomUUID(),
    summary,
    files: normalizedFiles,
    newFiles: normalizedNewFiles,
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
    createdAt: new Date().toISOString(),
    userResponsesAfterChallenge: 0,
    latestResponseEligibleForGrant: false,
    lastResponseClassification: null,
    failedTeachbacks: 0,
    overrideAttempts: 0,
    hasBeenGranted: false,
  };
  state.grant = null;
  return state.challenge;
}

// `classification` is one of bypass/passive_approval/help_request/
// teachback_candidate/other (see bypass.mjs). Only teachback_candidate is
// mechanically grant-eligible (hardening P0.5), a help request or passive
// approval must never make `grant` mechanically possible, no matter how
// the model judges it, because "assistance counted as an answer" is
// exactly the failure this classifier exists to prevent.
export function recordUserResponse(state, { classification = 'other' } = {}) {
  if (!state.challenge) {
    return { ok: false, error: 'No active challenge to respond to.' };
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

// P1.2 grant-lifetime decision: kept per-turn revocation (revokeGrantIfUsed,
// called from Stop) as the conservative default, see README for the
// alternative considered and why it was rejected. The one relaxation made
// here targets its main usability cost: a multi-turn implementation of the
// SAME, unchanged, already-explained challenge would otherwise need a full
// fresh comprehension check on every single turn. Once a challenge has been
// granted once (a real teachback_candidate response was required for that),
// a later re-grant for that SAME challenge id only requires a real human
// message that isn't a bypass attempt, not a full re-explanation. This
// never weakens the original guarantee (bypass still always fails, and a
// brand-new challenge/revise always resets `hasBeenGranted` to false, so an
// unrelated task can never inherit a lightweight re-grant), and it never
// skips the human-turn requirement (a message must still have been sent).
export function grantTeachback(state, { assessment }) {
  if (!state.challenge) {
    return { ok: false, error: 'GATEKEEPER: grant denied. There is no active challenge for this session.' };
  }
  if (state.challenge.userResponsesAfterChallenge < 1) {
    return {
      ok: false,
      error: 'GATEKEEPER: grant denied.\nThe developer has not responded to the active challenge.',
    };
  }

  const isContinuation = state.challenge.hasBeenGranted === true;
  const seen = state.challenge.lastResponseClassification;
  const eligible = isContinuation ? seen !== 'bypass' : state.challenge.latestResponseEligibleForGrant;

  if (!eligible) {
    const hint =
      seen === 'bypass'
        ? 'it looked like a bypass attempt'
        : seen === 'passive_approval'
          ? 'it looked like passive approval ("looks good", "go ahead", ...), not an explanation'
          : seen === 'help_request'
            ? 'it looked like a help request, not an explanation, assistance does not count as an answer'
            : 'it did not look like a substantive explanation';
    return {
      ok: false,
      error: `GATEKEEPER: grant denied. The latest developer message does not satisfy the active challenge (${hint}).`,
    };
  }
  if (!assessment || !assessment.trim()) {
    return { ok: false, error: 'GATEKEEPER: grant denied. An assessment is required.' };
  }

  const attempts = state.challenge.failedTeachbacks + 1;
  state.challenge.hasBeenGranted = true;
  state.grant = {
    challengeId: state.challenge.id,
    files: state.challenge.files,
    assessment: assessment.trim(),
    grantedAt: new Date().toISOString(),
    usedInTurn: false,
  };

  return {
    ok: true,
    grant: state.grant,
    challengeId: state.challenge.id,
    fileCount: state.challenge.files.length,
    firstAttempt: state.challenge.failedTeachbacks === 0,
    attempts,
  };
}

export function reviseChallenge(state, { summary, files = [], newFiles = [], flags = {}, cwd, mustNotChange = [], assumptions = [] }) {
  const previousChallengeId = state.challenge ? state.challenge.id : null;
  const previousFileCount = state.challenge ? state.challenge.files.length : 0;
  createChallenge(state, { summary, files, newFiles, flags, cwd, mustNotChange, assumptions });
  return { ok: true, previousChallengeId, previousFileCount, challenge: state.challenge };
}

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
  return { ok: true };
}

// Called from the Stop hook. If the active grant was used to perform a
// protected mutation during the turn that just ended, revoke it so
// unrelated next work cannot silently inherit it (directive section 19).
export function revokeGrantIfUsed(state) {
  const grant = currentGrant(state);
  if (!grant || !grant.usedInTurn) {
    return { revoked: false };
  }
  const challengeId = grant.challengeId;
  state.grant = null;
  return { revoked: true, challengeId };
}
