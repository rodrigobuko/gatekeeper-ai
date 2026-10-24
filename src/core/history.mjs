// Append-only, bounded-retention event log. Stores compact metadata only,
// never full prompts, full assistant messages, or source code (directive
// section 12). Each entry is one NDJSON line so it can be tailed cheaply.

import fs from 'node:fs';
import path from 'node:path';
import { ensureHome } from './state.mjs';
import { withFileLock } from './lock.mjs';

const MAX_ENTRIES = 2000;

export const SYMBOLS = {
  gate_passed: '✓', // check
  teachback_rejected: '×', // times
  override_attempt: '⚔', // crossed swords
  challenge_started: '◇', // diamond
  plan_revised: '↻', // clockwise arrow
  departure: '✦', // sparkle
  session_relocked: '↺', // counterclockwise arrow
  reset: '↺',
  protection_change_attempt: '⚠', // warning
};

function historyPath(home) {
  return path.join(home, 'history.ndjson');
}

// Keeps the payload to compact, non-sensitive metadata. Callers pass already
// short strings; this just enforces a hard cap so a careless caller can't
// accidentally dump a full message into history.
function clampString(value, maxLen = 160) {
  if (typeof value !== 'string') return undefined;
  return value.length > maxLen ? `${value.slice(0, maxLen - 1)}…` : value;
}

// Locked (hardening P1.1): the append itself is a single small write, but
// rotation reads the whole file and rewrites it, which could otherwise
// interleave with a concurrent process's append and drop a line.
export function appendEvent(home, event) {
  ensureHome(home);
  const file = historyPath(home);
  return withFileLock(file, () => {
    const entry = {
      ts: new Date().toISOString(),
      type: event.type,
      harness: event.harness ?? 'claude',
      attempt: event.attempt,
      fileCount: event.fileCount,
      challengeId: event.challengeId,
      summary: clampString(event.summary),
      reason: clampString(event.reason),
      flags: event.flags,
    };
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
    rotateIfNeeded(home);
    return entry;
  });
}

function rotateIfNeeded(home) {
  const file = historyPath(home);
  let lines;
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return;
  }
  if (lines.length <= MAX_ENTRIES) return;
  const trimmed = lines.slice(lines.length - MAX_ENTRIES);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${trimmed.join('\n')}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export function readHistory(home, { limit = 20 } = {}) {
  const file = historyPath(home);
  let lines;
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
  const entries = lines
    .slice(-limit)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return entries.reverse(); // newest first, matching directive's example output
}
