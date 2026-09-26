import test from 'node:test';
import assert from 'node:assert/strict';
import { computeComplexity, countDirectoriesCrossed } from '../../src/core/complexity.mjs';

test('1-4 files is normal complexity', () => {
  const c = computeComplexity({ fileCount: 3, newFileCount: 0, flags: {} });
  assert.equal(c.level, 'normal');
  assert.equal(c.requiresSimplicityChallenge, false);
});

test('5-8 files requires a simplicity challenge', () => {
  const c = computeComplexity({ fileCount: 6, newFileCount: 0, flags: {} });
  assert.equal(c.level, 'simplicity');
  assert.equal(c.requiresSimplicityChallenge, true);
});

test('9+ files is a high complexity warning', () => {
  const c = computeComplexity({ fileCount: 10, newFileCount: 0, flags: {} });
  assert.equal(c.level, 'high');
  assert.equal(c.requiresSimplicityChallenge, true);
});

test('architecture change forces a simplicity challenge below the file threshold', () => {
  const c = computeComplexity({ fileCount: 2, newFileCount: 0, flags: { architectureChange: true } });
  assert.equal(c.requiresSimplicityChallenge, true);
});

test('schema change forces a simplicity challenge below the file threshold', () => {
  const c = computeComplexity({ fileCount: 1, newFileCount: 0, flags: { schemaChange: true } });
  assert.equal(c.requiresSimplicityChallenge, true);
});

test('new dependency forces a simplicity challenge below the file threshold', () => {
  const c = computeComplexity({ fileCount: 1, newFileCount: 0, flags: { newDependency: true } });
  assert.equal(c.requiresSimplicityChallenge, true);
});

test('3+ new files forces a simplicity challenge below the file threshold', () => {
  const c = computeComplexity({ fileCount: 3, newFileCount: 3, flags: {} });
  assert.equal(c.requiresSimplicityChallenge, true);
});

test('the heuristic never claims the design is wrong, only that it needs a question', () => {
  const c = computeComplexity({ fileCount: 9, newFileCount: 0, flags: {} });
  assert.equal(typeof c.requiresSimplicityChallenge, 'boolean');
  assert.ok(!('verdict' in c));
  assert.ok(!('rejected' in c));
  assert.ok(!('score' in c));
});

test('crossing 4+ directories forces a simplicity challenge below the file threshold', () => {
  const c = computeComplexity({ fileCount: 4, newFileCount: 0, directoriesCrossed: 4, flags: {} });
  assert.equal(c.requiresSimplicityChallenge, true);
  assert.equal(c.signals.manyDirectoriesCrossed, true);
});

test('3+ new public exports forces a simplicity challenge below the file threshold', () => {
  const c = computeComplexity({ fileCount: 1, newFileCount: 0, newExportCount: 3, flags: {} });
  assert.equal(c.requiresSimplicityChallenge, true);
  assert.equal(c.signals.manyNewExports, true);
});

test('countDirectoriesCrossed counts distinct parent directories, path-based only', () => {
  const files = ['/a/b/x.ts', '/a/b/y.ts', '/a/c/z.ts', '/d/w.ts'];
  assert.equal(countDirectoriesCrossed(files), 3);
});
