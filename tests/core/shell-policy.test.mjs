import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCommand, isMutationCommand, isTrustedGatekeeperInvocation } from '../../src/core/shell-policy.mjs';

test('classifies common read-only bash commands as safe', () => {
  for (const cmd of ['git status', 'git diff', 'git log', 'rg TODO', 'cat README.md', 'pwd']) {
    assert.equal(isMutationCommand(cmd, 'bash'), false, cmd);
  }
});

test('classifies test/lint/check commands as safe', () => {
  for (const cmd of ['npm test', 'npm run lint', 'pytest', 'cargo test', 'go test ./...']) {
    assert.equal(isMutationCommand(cmd, 'bash'), false, cmd);
  }
});

test('classifies obvious bash mutation commands as mutation', () => {
  for (const cmd of [
    'echo "x" >> src/a.ts',
    'echo "x" > src/a.ts',
    'sed -i "s/a/b/" src/a.ts',
    'rm src/a.ts',
    'git apply patch.diff',
    'touch src/new.ts',
  ]) {
    assert.equal(isMutationCommand(cmd, 'bash'), true, cmd);
  }
});

test('classifies obvious PowerShell mutation commands as mutation', () => {
  for (const cmd of [
    'Set-Content src/a.ts "x"',
    'Add-Content .\\src\\user-service.js "// bypass"',
    'Remove-Item src/a.ts',
    'New-Item src/new.ts',
  ]) {
    assert.equal(isMutationCommand(cmd, 'powershell'), true, cmd);
  }
});

test('classifies common read-only PowerShell commands as safe', () => {
  for (const cmd of ['Get-ChildItem', 'Get-Content src/a.ts', 'Get-Location']) {
    assert.equal(isMutationCommand(cmd, 'powershell'), false, cmd);
  }
});

test('recognizes the trusted gatekeeper CLI invocation shapes', () => {
  assert.equal(isTrustedGatekeeperInvocation('gatekeeper status'), true);
  assert.equal(isTrustedGatekeeperInvocation('gatekeeper challenge --summary "x" --files a.ts'), true);
  assert.equal(isTrustedGatekeeperInvocation('node ./src/cli/gatekeeper.mjs grant --assessment "x"'), true);
  assert.equal(classifyCommand('gatekeeper grant --assessment "x"', 'bash'), 'trusted-cli');
});

test('does not treat an unrelated command containing the word gatekeeper as trusted', () => {
  assert.equal(isTrustedGatekeeperInvocation('rm -rf gatekeeper-notes.txt'), false);
});

// P0.3 regression: a trusted CLI call chained with a real mutation must
// never classify as trusted-cli, in either shell.
test('rejects a trusted-CLI invocation chained with a mutation (bash)', () => {
  for (const cmd of [
    'gatekeeper status && echo hacked > src/a.ts',
    'gatekeeper status; rm -f src/a.ts',
    'node /path/gatekeeper.mjs status && rm -rf src',
    'gatekeeper status > src/a.ts',
    'gatekeeper status; gatekeeper status && rm -f src/a.ts',
    'echo x ; gatekeeper status ; rm src/a.ts',
  ]) {
    assert.equal(isTrustedGatekeeperInvocation(cmd), false, cmd);
    assert.notEqual(classifyCommand(cmd, 'bash'), 'trusted-cli', cmd);
  }
});

test('rejects a trusted-CLI invocation chained with a mutation (powershell)', () => {
  for (const cmd of [
    'gatekeeper status; Set-Content .\\src\\a.ts "x"',
    'gatekeeper status | Set-Content .\\src\\a.ts',
  ]) {
    assert.equal(isTrustedGatekeeperInvocation(cmd), false, cmd);
    assert.notEqual(classifyCommand(cmd, 'powershell'), 'trusted-cli', cmd);
  }
});

test('still trusts realistic multi-argument CLI invocations, including quoted special characters', () => {
  for (const cmd of [
    'gatekeeper status',
    'gatekeeper challenge --summary "Add cache" --files src/a.ts',
    'gatekeeper grant --assessment "Developer explained the flow."',
    'node /exact/plugin/path/src/cli/gatekeeper.mjs status',
    'gatekeeper challenge --summary "Fix a; b: c > d | e" --files src/a.ts src/b.ts',
    'gatekeeper revise --summary "x" --files a.ts --new-dependency',
    'gatekeeper depart --confirm',
  ]) {
    assert.equal(isTrustedGatekeeperInvocation(cmd), true, cmd);
    assert.equal(classifyCommand(cmd, 'bash'), 'trusted-cli', cmd);
  }
});

// P0.4 regression: previously-unclassified mutation routes must not be
// silently allowed while locked (see engine.test.mjs for the LOCKED-state
// deny assertions; this file only asserts the classifier's own output).
test('classifies common generic-mutation-tool invocations as mutation, not unknown', () => {
  for (const cmd of ['git checkout -- src/a.ts', 'git restore src/a.ts', 'curl https://x/f -o src/a.ts']) {
    assert.equal(classifyCommand(cmd, 'bash'), 'mutation', cmd);
  }
  for (const cmd of ['Invoke-WebRequest https://x/f -OutFile src\\a.ts', 'powershell -Command "Set-Content src\\a.ts x"']) {
    assert.equal(classifyCommand(cmd, 'powershell'), 'mutation', cmd);
  }
});

test('leaves genuinely unrecognized commands as unknown (the engine, not the classifier, decides the locked-state default)', () => {
  assert.equal(classifyCommand('python mutate.py', 'bash'), 'unknown');
  assert.equal(classifyCommand('node mutate.js', 'bash'), 'unknown');
});
