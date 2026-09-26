import test from 'node:test';
import assert from 'node:assert/strict';
import { isProtectedFile, normalizeFilePath } from '../../src/core/files.mjs';

test('protects common source extensions', () => {
  assert.equal(isProtectedFile('src/auth.ts'), true);
  assert.equal(isProtectedFile('Program.cs'), true);
  assert.equal(isProtectedFile('main.go'), true);
  assert.equal(isProtectedFile('script.sh'), true);
});

test('protects known config/infra filenames', () => {
  assert.equal(isProtectedFile('package.json'), true);
  assert.equal(isProtectedFile('Dockerfile'), true);
  assert.equal(isProtectedFile('Dockerfile.prod'), true);
  assert.equal(isProtectedFile('docker-compose.yml'), true);
  assert.equal(isProtectedFile('tsconfig.build.json'), true);
  assert.equal(isProtectedFile('requirements-dev.txt'), true);
  assert.equal(isProtectedFile('Cargo.toml'), true);
});

test('leaves documentation unprotected by default', () => {
  assert.equal(isProtectedFile('README.md'), false);
  assert.equal(isProtectedFile('NOTES.txt'), false);
});

test('leaves unrelated files unprotected', () => {
  assert.equal(isProtectedFile('image.png'), false);
  assert.equal(isProtectedFile('data.csv'), false);
});

// These hardcode a specific path style deliberately and must pass
// regardless of which OS actually runs the test suite (P0.2): path
// handling is chosen from the string's own syntax, not from
// process.platform / the host's default node:path.

test('normalizes a POSIX relative path against a POSIX cwd, on any host', () => {
  const cwd = '/home/dev/project';
  const relative = normalizeFilePath('src/a.ts', cwd);
  const absolute = normalizeFilePath('/home/dev/project/src/a.ts', cwd);
  assert.equal(relative, absolute);
  assert.equal(relative, '/home/dev/project/src/a.ts');
});

test('normalizes Windows-style absolute paths consistently, on any host', () => {
  const a = normalizeFilePath('C:\\Projects\\app\\src\\auth.ts', 'C:\\Projects\\app');
  const b = normalizeFilePath('c:/Projects/app/src/auth.ts', 'C:\\Projects\\app');
  assert.equal(a, b);
  assert.equal(a, 'c:/Projects/app/src/auth.ts');
});

test('normalizes a Windows-style relative path against a Windows-style cwd, on any host', () => {
  const result = normalizeFilePath('src\\a.ts', 'C:\\Projects\\app');
  assert.equal(result, 'c:/Projects/app/src/a.ts');
});

test('normalizes a forward-slash relative path against a Windows-style cwd, on any host', () => {
  const result = normalizeFilePath('src/a.ts', 'C:\\Projects\\app');
  assert.equal(result, 'c:/Projects/app/src/a.ts');
});

test('handles a UNC path reasonably, on any host', () => {
  const result = normalizeFilePath('\\\\server\\share\\project\\src\\a.ts', '\\\\server\\share\\project');
  assert.match(result, /^\/\/server\/share\/project\/src\/a\.ts$/);
});

test('isProtectedFile recognizes a Windows-style basename, on any host', () => {
  assert.equal(isProtectedFile('C:\\Projects\\app\\Dockerfile'), true);
  assert.equal(isProtectedFile('C:\\Projects\\app\\src\\auth.ts'), true);
  assert.equal(isProtectedFile('C:\\Projects\\app\\README.md'), false);
});
