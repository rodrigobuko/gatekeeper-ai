// Best-effort Bash/PowerShell command classifier.
//
// This is explicitly NOT a real shell parser (directive section 10). It
// pattern-matches the raw command string. That means it can be fooled by
// sufficiently creative quoting or chaining, and it can occasionally flag a
// read-only command that happens to contain a mutation-shaped substring
// (e.g. a search pattern containing ">"). Document this as a known
// limitation rather than pretending otherwise.
//
// Policy while LOCKED (hardening pass, see HARDENING_PILOT_DIRECTIVE P0.4):
//   trusted Gatekeeper CLI -> allow
//   known read-only        -> allow
//   known test/check       -> allow
//   known mutation         -> deny
//   unknown                -> deny by default (was previously allow, this
//                              was a real bypass: `python mutate.py`,
//                              `git checkout -- f`, `curl -o f url`, etc.
//                              were unclassified and silently let through)
// Policy once GRANTED: unchanged, shell mutation is allowed outright
// (best-effort, not scope-checked; see engine.mjs), since the developer has
// already passed the teach-back for this challenge.

const READ_ONLY_PATTERNS = [
  /^\s*pwd\b/i,
  /\bGet-Location\b/i,
  /^\s*ls\b/i,
  /^\s*dir\b/i,
  /\bGet-ChildItem\b/i,
  /^\s*find\b/i,
  /^\s*rg\b/i,
  /^\s*grep\b/i,
  /\bSelect-String\b/i,
  /^\s*cat\b(?!.*>)/i,
  /\bGet-Content\b(?!.*(Set-Content|Add-Content))/i,
  /^\s*head\b/i,
  /^\s*tail\b/i,
  /\bgit\s+status\b/i,
  /\bgit\s+diff\b/i,
  /\bgit\s+log\b/i,
  /\bgit\s+show\b/i,
  /\bgit\s+branch\b/i,
  /\bgit\s+rev-parse\b/i,
  /\bgit\s+ls-files\b/i,
];

const TEST_PATTERNS = [
  /\bnpm\s+test\b/i,
  /\bnpm\s+run\s+test\b/i,
  /\bnpm\s+run\s+lint\b/i,
  /\bnpm\s+run\s+typecheck\b/i,
  /\bpnpm\s+test\b/i,
  /\byarn\s+test\b/i,
  /\bpytest\b/i,
  /\bgo\s+test\b/i,
  /\bcargo\s+test\b/i,
  /\bdotnet\s+test\b/i,
];

// Shared across both shells: an actual redirect operator is a mutation
// regardless of which interpreter runs it.
const REDIRECT_PATTERN = /(^|[^>])>>?(?!>)/;

// Generic shell-within-a-shell escape hatches. These can run arbitrary code
// (including a mutation) inside their argument, so they're treated as
// mutation-capable outright rather than trying to parse what's inside them.
const NESTED_SHELL_PATTERNS = [
  /\bpowershell(\.exe)?\b[^\n]*-command\b/i,
  /\bpwsh\b[^\n]*-command\b/i,
  /\bcmd(\.exe)?\b[^\n]*\/c\b/i,
  /\bbash\b[^\n]*-c\b/i,
  /^\s*sh\b[^\n]*-c\b/i,
];

const BASH_MUTATION_PATTERNS = [
  REDIRECT_PATTERN,
  /\btee\b/i,
  /\bsed\b[^|;&\n]*-i\b/i,
  /\bperl\b[^|;&\n]*-pi\b/i,
  /\brm\b/i,
  /\bmv\b/i,
  /\bcp\b/i,
  /\btouch\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bgit\s+apply\b/i,
  /\bgit\s+checkout\b/i,
  /\bgit\s+restore\b/i,
  /\bpatch\b/i,
  /\bcurl\b[^\n]*(-o\b|--output\b)/i,
  /\bwget\b[^\n]*(-O\b|--output-document\b)/i,
  /\bpython3?\s+-c\b[\s\S]*(write|open\()/i,
  /\bnode\s+-e\b[\s\S]*(writeFile|fs\.write)/i,
  ...NESTED_SHELL_PATTERNS,
];

const POWERSHELL_MUTATION_PATTERNS = [
  REDIRECT_PATTERN,
  /\bSet-Content\b/i,
  /\bAdd-Content\b/i,
  /\bOut-File\b/i,
  /\bNew-Item\b/i,
  /\bRemove-Item\b/i,
  /\bMove-Item\b/i,
  /\bCopy-Item\b/i,
  /\bRename-Item\b/i,
  /\bSet-Item\b/i,
  /\bTee-Object\b/i,
  /\[IO\.File\]::WriteAllText/i,
  /\[IO\.File\]::AppendAllText/i,
  /\bInvoke-WebRequest\b/i,
  /\bIwr\b/i,
  /\bgit\s+checkout\b/i,
  /\bgit\s+restore\b/i,
  ...NESTED_SHELL_PATTERNS,
];

function mutationPatternsFor(shell) {
  return shell === 'powershell' ? POWERSHELL_MUTATION_PATTERNS : BASH_MUTATION_PATTERNS;
}

// ---------------------------------------------------------------------------
// Trusted Gatekeeper CLI invocation (directive section 24 / hardening P0.3)
//
// A command is trusted ONLY when the ENTIRE command is one of the exact
// supported invocation shapes, never merely because it *contains* the word
// "gatekeeper" or a path ending in gatekeeper.mjs somewhere. Two things are
// required together:
//   1. no unquoted shell control/chaining operator anywhere in the string
//      (;  &&  ||  |  &  >  >>  <  newline  backtick  $(...) ), so a
//      command can't smuggle a second command past the trust check; quoted
//      argument values (inside '...' or "...") are exempt, since e.g.
//      --summary "fix a; b" is a legitimate argument, not chaining.
//   2. the whole trimmed string matches `gatekeeper <subcommand> ...` or
//      `node <path ending in gatekeeper.mjs> <subcommand> ...`.
// Both checks must pass. This intentionally rejects
// `gatekeeper status && rm file`, `gatekeeper status; rm file`,
// `gatekeeper status > f`, and `gatekeeper status | x`, all real bypasses
// found during the public-pilot security audit.

const CLI_SUBCOMMANDS = [
  'status',
  'challenge',
  'reject',
  'grant',
  'revise',
  'reset',
  'depart',
  'stats',
  'history',
  'version',
  'doctor',
  'diff',
  'done',
  'review',
  'knowledge',
  'forget',
];
const SUBCOMMAND_ALT = CLI_SUBCOMMANDS.join('|');

const BARE_INVOCATION_RE = new RegExp(`^gatekeeper\\s+(?:${SUBCOMMAND_ALT})(?:\\s+[\\s\\S]*)?$`, 'i');
const NODE_INVOCATION_RE = new RegExp(
  `^node(?:\\.exe)?\\s+(?:"[^"]*gatekeeper\\.mjs"|'[^']*gatekeeper\\.mjs'|[^\\s"']*gatekeeper\\.mjs)\\s+(?:${SUBCOMMAND_ALT})(?:\\s+[\\s\\S]*)?$`,
  'i',
);

function containsUnquotedShellControl(command) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (c === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (c === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) continue;

    if (c === ';' || c === '|' || c === '&' || c === '>' || c === '<' || c === '`') return true;
    if (c === '\n' || c === '\r') return true;
    if (c === '$' && command[i + 1] === '(') return true;
  }
  return false;
}

export function isTrustedGatekeeperInvocation(command) {
  if (typeof command !== 'string') return false;
  const trimmed = command.trim();
  if (trimmed === '') return false;
  if (containsUnquotedShellControl(trimmed)) return false;
  return BARE_INVOCATION_RE.test(trimmed) || NODE_INVOCATION_RE.test(trimmed);
}

export function classifyCommand(command, shell = 'bash') {
  if (typeof command !== 'string' || command.trim() === '') {
    return 'unknown';
  }

  if (isTrustedGatekeeperInvocation(command)) {
    return 'trusted-cli';
  }

  const mutationPatterns = mutationPatternsFor(shell);
  if (mutationPatterns.some((pattern) => pattern.test(command))) {
    return 'mutation';
  }

  if (TEST_PATTERNS.some((pattern) => pattern.test(command))) {
    return 'test';
  }

  if (READ_ONLY_PATTERNS.some((pattern) => pattern.test(command))) {
    return 'read';
  }

  return 'unknown';
}

export function isMutationCommand(command, shell = 'bash') {
  return classifyCommand(command, shell) === 'mutation';
}
