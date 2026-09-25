// Translates between Claude Code's hook JSON dialect and Gatekeeper Core's
// harness-independent shapes. This is the ONLY file that should know field
// names like `tool_input.file_path` or `permissionDecisionReason` — if a
// future Claude Code version renames a field, this is where the fix goes.

import fs from 'node:fs';

export function readStdinJson() {
  const raw = fs.readFileSync(0, 'utf8');
  return JSON.parse(raw);
}

export function extractTargetFiles(toolName, toolInput) {
  if (!toolInput) return [];
  if (toolName === 'Edit' || toolName === 'Write') {
    const f = toolInput.file_path || toolInput.path;
    return f ? [f] : [];
  }
  if (toolName === 'MultiEdit' && Array.isArray(toolInput.edits)) {
    const f = toolInput.file_path || toolInput.path;
    return f ? [f] : [];
  }
  return [];
}

export function shellFor(toolName) {
  return toolName === 'PowerShell' ? 'powershell' : 'bash';
}

export function denyResponse(hookEventName, reason) {
  return {
    hookSpecificOutput: {
      hookEventName,
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

export function allowResponse(hookEventName) {
  // Gatekeeper controls its own gate; it should not force-allow and thereby
  // bypass Claude Code's normal permission system (directive section 8).
  // Returning nothing lets the normal permission flow proceed untouched.
  return null;
}

export function userPromptAllow() {
  return null;
}

export function userPromptDeny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      decision: 'deny',
      reason,
    },
  };
}

export function printJson(value) {
  if (value === null || value === undefined) return;
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
