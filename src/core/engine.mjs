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
import { computeComplexity } from './complexity.mjs';

export function currentGrant(state) {
  if (!state.grant || !state.challenge) return null;
  if (state.grant.challengeId !== state.challenge.id) return null;
  return state.grant;
}

// Call on every hook invocation that carries a harness session id
// (UserPromptSubmit, PreToolUse). A changed session id means a new Claude
// Code process attached to this same working directory — any leftover
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

export function evaluateShellCommand(state, command, shell) {
  const classification = classifyCommand(command, shell);

  if (classification === 'trusted-cli') {
    return { allowed: true, code: 'TRUSTED_CLI', reason: 'Trusted Gatekeeper CLI invocation.', classification };
  }

  if (classification !== 'mutation') {
    return {
      allowed: true,
      code: 'SHELL_NOT_FLAGGED',
      reason: 'Command did not match a known mutation pattern (best-effort classifier).',
      classification,
    };
  }

  if (state.departed) {
    return { allowed: true, code: 'DEPARTED', reason: 'Gatekeeper has explicitly departed for this session.', classification };
  }

  const grant = currentGrant(state);
  if (!grant) {
    return {
      allowed: false,
      code: 'GATEKEEPER_LOCKED',
      reason: 'Protected mutation requires an active Gatekeeper grant.',
      classification,
    };
  }

  grant.usedInTurn = true;
  return { allowed: true, code: 'GATEKEEPER_GRANTED', reason: 'Covered by the active grant.', classification };
}

export function createChallenge(state, { summary, files = [], newFiles = [], flags = {}, cwd }) {
  const normalizedFiles = files.map((f) => normalizeFilePath(f, cwd));
  const normalizedNewFiles = newFiles.map((f) => normalizeFilePath(f, cwd));
  const complexity = computeComplexity({
    fileCount: normalizedFiles.length,
    newFileCount: normalizedNewFiles.length,
    flags,
  });

  state.challenge = {
    id: crypto.randomUUID(),
    summary,
    files: normalizedFiles,
    newFiles: normalizedNewFiles,
    flags: {
      newDependency: Boolean(flags.newDependency),
      architectureChange: Boolean(flags.architectureChange),
      schemaChange: Boolean(flags.schemaChange),
      plannedTests: Boolean(flags.plannedTests),
    },
    complexity,
    createdAt: new Date().toISOString(),
    userResponsesAfterChallenge: 0,
    latestResponseEligibleForGrant: false,
    failedTeachbacks: 0,
    overrideAttempts: 0,
  };
  state.grant = null;
  return state.challenge;
}

export function recordUserResponse(state, { isBypass = false } = {}) {
  if (!state.challenge) {
    return { ok: false, error: 'No active challenge to respond to.' };
  }
  state.challenge.userResponsesAfterChallenge += 1;
  if (isBypass) {
    state.challenge.overrideAttempts += 1;
    state.challenge.latestResponseEligibleForGrant = false;
  } else {
    state.challenge.latestResponseEligibleForGrant = true;
  }
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
  if (!state.challenge.latestResponseEligibleForGrant) {
    return {
      ok: false,
      error:
        'GATEKEEPER: grant denied. The latest developer message does not satisfy the active challenge ' +
        '(it may be a bypass attempt, or the challenge changed since the last response).',
    };
  }
  if (!assessment || !assessment.trim()) {
    return { ok: false, error: 'GATEKEEPER: grant denied. An assessment is required.' };
  }

  const attempts = state.challenge.failedTeachbacks + 1;
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

export function reviseChallenge(state, { summary, files = [], newFiles = [], flags = {}, cwd }) {
  const previousChallengeId = state.challenge ? state.challenge.id : null;
  const previousFileCount = state.challenge ? state.challenge.files.length : 0;
  createChallenge(state, { summary, files, newFiles, flags, cwd });
  return { ok: true, previousChallengeId, previousFileCount, challenge: state.challenge };
}

export function resetLock(state) {
  state.challenge = null;
  state.grant = null;
  state.departed = false;
  return { ok: true };
}

export function depart(state) {
  state.departed = true;
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
