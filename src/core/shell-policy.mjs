// Best-effort Bash/PowerShell command classifier.
//
// This is explicitly NOT a real shell parser (directive section 10). It
// pattern-matches the raw command string. That means it can be fooled by
// sufficiently creative quoting or chaining, and it can occasionally flag a
// read-only command that happens to contain a mutation-shaped substring
// (e.g. a search pattern containing ">"). Document this as a known
// limitation rather than pretending otherwise.

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
  /\bpatch\b/i,
  /\bpython3?\s+-c\b[\s\S]*(write|open\()/i,
  /\bnode\s+-e\b[\s\S]*(writeFile|fs\.write)/i,
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
];

function mutationPatternsFor(shell) {
  return shell === 'powershell' ? POWERSHELL_MUTATION_PATTERNS : BASH_MUTATION_PATTERNS;
}

// The gatekeeper CLI's own writes to ~/.gatekeeper must never be blocked by
// its own shell policy (directive section 24). This matches only the two
// trusted invocation shapes the skill and hooks are instructed to use:
// the bare `gatekeeper` binary, or `node <path ending in gatekeeper.mjs>`.
const TRUSTED_CLI_PATTERN = /(^|[\s"'])(gatekeeper|node(\.exe)?\s+["']?[^"'\s]*[\\/]gatekeeper\.mjs)(["'\s]|$)/i;

export function isTrustedGatekeeperInvocation(command) {
  if (typeof command !== 'string') return false;
  return TRUSTED_CLI_PATTERN.test(command.trim());
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
