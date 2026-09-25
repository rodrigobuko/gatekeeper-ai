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

test('normalizes a relative path against cwd consistently with an equivalent absolute path', () => {
  const sep = process.platform === 'win32' ? '\\' : '/';
  const cwd = process.platform === 'win32' ? 'C:\\home\\dev\\project' : '/home/dev/project';
  const relative = normalizeFilePath('src/a.ts', cwd);
  const absolute = normalizeFilePath(`${cwd}${sep}src/a.ts`, cwd);
  assert.equal(relative, absolute);
  assert.ok(relative.endsWith('/home/dev/project/src/a.ts'));
});

test('normalizes Windows-style absolute paths consistently', () => {
  const a = normalizeFilePath('C:\\Projects\\app\\src\\auth.ts', 'C:\\Projects\\app');
  const b = normalizeFilePath('c:/Projects/app/src/auth.ts', 'C:\\Projects\\app');
  assert.equal(a, b);
  assert.equal(a, 'c:/Projects/app/src/auth.ts');
});
