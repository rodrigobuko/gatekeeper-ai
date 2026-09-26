import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { captureGitBaseline, computeChangeShape } from '../../src/core/git-baseline.mjs';
import { normalizeFilePath } from '../../src/core/files.mjs';
import { makeTempProject } from '../helpers.mjs';

function git(args, cwd) {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function initRepo(cwd) {
  git(['init', '-q', '-b', 'main'], cwd);
  git(['config', 'user.email', 'test@example.com'], cwd);
  git(['config', 'user.name', 'Test'], cwd);
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src', 'a.ts'), 'export const a = 1;\n');
  git(['add', '-A'], cwd);
  git(['commit', '-q', '-m', 'initial'], cwd);
}

test('captureGitBaseline returns null outside a Git repo', () => {
  const cwd = makeTempProject();
  assert.equal(captureGitBaseline(cwd), null);
});

test('captureGitBaseline returns a HEAD sha inside a Git repo', () => {
  const cwd = makeTempProject();
  initRepo(cwd);
  const baseline = captureGitBaseline(cwd);
  assert.ok(baseline);
  assert.match(baseline.headSha, /^[0-9a-f]{40}$/);
  assert.equal(baseline.dirtyAtBaseline, 0);
});

test('computeChangeShape reports files changed since the baseline, and flags out-of-scope protected files', () => {
  const cwd = makeTempProject();
  initRepo(cwd);
  const baseline = captureGitBaseline(cwd);

  fs.writeFileSync(path.join(cwd, 'src', 'a.ts'), 'export const a = 2;\n'); // approved change
  fs.writeFileSync(path.join(cwd, 'src', 'b.ts'), 'export const b = 1;\n'); // NOT approved

  const approvedFiles = [normalizeFilePath(path.join(cwd, 'src', 'a.ts'), cwd)];
  const shape = computeChangeShape(cwd, baseline, approvedFiles);

  assert.ok(shape);
  assert.equal(shape.changedCount, 2);
  assert.equal(shape.outOfScopeProtected.length, 1);
  assert.match(shape.outOfScopeProtected[0], /b\.ts$/);
});

test('computeChangeShape returns null without a baseline', () => {
  const cwd = makeTempProject();
  assert.equal(computeChangeShape(cwd, null, []), null);
});
