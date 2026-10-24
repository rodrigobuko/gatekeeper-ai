// Lightweight local Git baseline (hardening section 9). Captured once when
// a challenge opens, for change-shape verification later, never for
// semantic grading, and never storing a full diff persistently. This is
// groundwork for a future pre-push gate (roadmap), not one itself.
//
// Uses `git` as a plain external tool the same way any dev workflow would;
// this is not Claude-specific, so it stays in core. Every call tolerates
// git being absent or the directory not being a repo, this feature is
// best-effort and silent when unavailable, never a hard requirement.

import { execFileSync } from 'node:child_process';
import { isProtectedFile, normalizeFilePath } from './files.mjs';

function runGit(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

// Compact metadata only: the current commit and the count (not content) of
// already-dirty files, so a later diagnostic can tell "changed since the
// challenge opened" apart from "was already uncommitted beforehand".
export function captureGitBaseline(cwd) {
  const headSha = runGit(['rev-parse', 'HEAD'], cwd);
  if (!headSha) return null; // not a git repo, no commits yet, or git unavailable

  const statusOutput = runGit(['status', '--porcelain'], cwd) || '';
  const dirtyCount = statusOutput === '' ? 0 : statusOutput.split('\n').length;

  return { headSha, dirtyAtBaseline: dirtyCount };
}

// On-demand change-shape summary (never persisted). Returns null when there
// is no baseline (not a git repo at challenge time) or git is unavailable
// now. `approvedFiles` is the current grant's file list, if any, used only
// to flag protected files that changed outside it, a diagnostic signal,
// not an enforcement mechanism (the real enforcement is PreToolUse).
export function computeChangeShape(cwd, baseline, approvedFiles = []) {
  if (!baseline || !baseline.headSha) return null;

  const stat = runGit(['diff', '--stat', baseline.headSha, '--'], cwd);
  const nameStatus = runGit(['diff', '--name-status', baseline.headSha, '--'], cwd);
  if (stat === null || nameStatus === null) return null; // git no longer available/valid

  const approvedSet = new Set(approvedFiles);
  const changedFiles = nameStatus
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split('\t');
      return { status, path: rest.join('\t') };
    });

  const untracked = (runGit(['ls-files', '--others', '--exclude-standard'], cwd) || '')
    .split('\n')
    .filter(Boolean)
    .map((p) => ({ status: '??', path: p }));

  const all = [...changedFiles, ...untracked];

  const outOfScopeProtected = all
    .map((entry) => normalizeFilePath(entry.path, cwd))
    .filter((normalized) => isProtectedFile(normalized) && !approvedSet.has(normalized));

  return {
    headShaAtChallenge: baseline.headSha,
    changedCount: all.length,
    changedFiles: all,
    outOfScopeProtected,
    statSummary: stat.split('\n').pop() || '', // git's own last "N files changed, X insertions..." line
  };
}
