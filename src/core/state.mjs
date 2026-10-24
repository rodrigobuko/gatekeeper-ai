// Persistence for Gatekeeper session state. State lives outside the user's
// repository (directive section 12) so it never gets committed and never
// leaks into diffs the developer or a teammate reviews.
//
// State is keyed by the working directory rather than Claude Code's
// internal session id. This is a deliberate adapter-independent choice: the
// CLI (invoked as a plain Bash command) has no reliable way to learn the
// harness's session id, but it always knows its own cwd, and that matches
// how a developer thinks about "the project I'm gated on" anyway.
// True session identity (for the "no cross-session reuse" guarantee) is
// layered on top inside engine.observeSession(), using the session id that
// hook adapters *do* receive.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pickPathModule } from './files.mjs';
import { withFileLock } from './lock.mjs';

const STATE_VERSION = 1;

export function resolveHome(explicitHome) {
  return explicitHome || process.env.GATEKEEPER_HOME || path.join(os.homedir(), '.gatekeeper');
}

// Syntax-based, not host-based (see files.mjs), a Windows-style cwd must
// key consistently even when this code runs on a POSIX test/CI host.
function normalizeCwdForKey(cwd) {
  const mod = pickPathModule(cwd, cwd);
  let normalized = mod.resolve(cwd).split(mod.sep).join('/');
  normalized = normalized.replace(/^([A-Za-z]):\//, (_, drive) => `${drive.toLowerCase()}:/`);
  return normalized.toLowerCase();
}

export function sessionKey(cwd) {
  return crypto.createHash('sha256').update(normalizeCwdForKey(cwd)).digest('hex').slice(0, 20);
}

function sessionsDir(home) {
  return path.join(home, 'sessions');
}

export function statePath(home, cwd) {
  return path.join(sessionsDir(home), `${sessionKey(cwd)}.json`);
}

export function ensureHome(home) {
  fs.mkdirSync(sessionsDir(home), { recursive: true });
}

export function defaultState(cwd) {
  const now = new Date().toISOString();
  return {
    version: STATE_VERSION,
    cwd,
    sessionId: null,
    challenge: null,
    grant: null,
    departed: false,
    departure: null,
    createdAt: now,
    updatedAt: now,
  };
}

function isPlausibleState(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.version === 'number' &&
    (value.challenge === null || typeof value.challenge === 'object') &&
    (value.grant === null || typeof value.grant === 'object')
  );
}

// Returns { state, corrupt }. `corrupt: true` means the on-disk file exists
// but could not be trusted (bad JSON or an unrecognized shape). Callers
// enforcing a protected mutation MUST treat corrupt as locked (fail closed,
// directive section 12); callers doing read-only reporting may show a
// warning instead of crashing.
export function loadState(home, cwd) {
  const file = statePath(home, cwd);
  if (!fs.existsSync(file)) {
    return { state: defaultState(cwd), corrupt: false };
  }
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { state: defaultState(cwd), corrupt: true };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!isPlausibleState(parsed)) {
      return { state: defaultState(cwd), corrupt: true };
    }
    return { state: parsed, corrupt: false };
  } catch {
    return { state: defaultState(cwd), corrupt: true };
  }
}

export function saveState(home, cwd, state) {
  ensureHome(home);
  const file = statePath(home, cwd);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const next = { ...state, updatedAt: new Date().toISOString() };
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, file); // atomic replace on POSIX and Windows (libuv MoveFileEx)
  return next;
}

// Runs the whole load -> mutate -> save cycle as one locked transaction
// (hardening P1.1), so two hook processes racing for the same directory
// can't interleave a read-modify-write. `fn(state, corrupt)` mutates
// `state` in place; its return value is passed through. The lock lives
// next to the state file itself, so it's automatically per-directory too.
export function withStateLock(home, cwd, fn) {
  ensureHome(home);
  return withFileLock(statePath(home, cwd), () => {
    const { state, corrupt } = loadState(home, cwd);
    const result = fn(state, corrupt);
    saveState(home, cwd, state);
    return result;
  });
}
