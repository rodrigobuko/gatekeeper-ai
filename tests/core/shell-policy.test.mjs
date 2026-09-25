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
