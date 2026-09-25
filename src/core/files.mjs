// Protected-file classification and path normalization.
// Kept dependency-free and harness-independent so any adapter can reuse it.

import path from 'node:path';

const PROTECTED_EXTENSIONS = new Set([
  '.js', '.jsx', '.mjs', '.cjs',
  '.ts', '.tsx',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt', '.kts',
  '.cs',
  '.c', '.cc', '.cpp', '.cxx', '.h', '.hpp',
  '.swift',
  '.rb',
  '.php',
  '.ex', '.exs',
  '.lua',
  '.gd',
  '.sql',
  '.sh', '.bash', '.zsh',
  '.ps1',
  '.vue', '.svelte',
  '.tf',
  '.yaml', '.yml',
]);

// Filenames/globs matched case-insensitively against the basename.
// Kept simple (exact name, or prefix*, or *suffix) rather than a full glob
// engine, since every entry below only needs one of those three shapes.
const PROTECTED_BASENAME_PATTERNS = [
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'tsconfig*.json',
  'Dockerfile*',
  'docker-compose*.yml',
  'docker-compose*.yaml',
  '*.csproj',
  '*.sln',
  'Cargo.toml',
  'Cargo.lock',
  'go.mod',
  'go.sum',
  'pyproject.toml',
  'requirements*.txt',
  'Gemfile',
  'Makefile',
];

// Explicitly unprotected regardless of any pattern above. Lets Claude write
// a plan/spec without opening the implementation gate.
const UNPROTECTED_EXTENSIONS = new Set(['.md', '.txt']);

function matchesBasenamePattern(basename, pattern) {
  const lower = basename.toLowerCase();
  const p = pattern.toLowerCase();
  if (!p.includes('*')) return lower === p;
  if (p.startsWith('*') && !p.endsWith('*')) return lower.endsWith(p.slice(1));
  if (p.endsWith('*') && !p.startsWith('*')) return lower.startsWith(p.slice(0, -1));
  if (p.startsWith('*') && p.endsWith('*')) return lower.includes(p.slice(1, -1));
  // "tsconfig*.json" style: prefix + '*' + suffix
  const starIndex = p.indexOf('*');
  const prefix = p.slice(0, starIndex);
  const suffix = p.slice(starIndex + 1);
  return lower.startsWith(prefix) && lower.endsWith(suffix) && lower.length >= prefix.length + suffix.length;
}

export function isProtectedFile(filePath) {
  const basename = path.basename(filePath);
  const ext = path.extname(basename).toLowerCase();

  // A named pattern (e.g. "requirements*.txt") is a deliberate exception and
  // must win even though its extension is normally unprotected documentation.
  if (PROTECTED_BASENAME_PATTERNS.some((pattern) => matchesBasenamePattern(basename, pattern))) {
    return true;
  }

  if (UNPROTECTED_EXTENSIONS.has(ext)) return false;

  return PROTECTED_EXTENSIONS.has(ext);
}

// Normalizes a file path for stable cross-platform comparison: resolves it
// to an absolute path against cwd, lower-cases the drive letter on Windows,
// and always uses forward slashes.
export function normalizeFilePath(filePath, cwd) {
  const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
  let normalized = path.normalize(absolute).split(path.sep).join('/');
  // Lower-case a Windows drive letter (C:/... vs c:/...) so comparisons
  // between hook-provided and CLI-provided paths are stable.
  normalized = normalized.replace(/^([A-Za-z]):\//, (_, drive) => `${drive.toLowerCase()}:/`);
  return normalized;
}

export function normalizeFilePaths(filePaths, cwd) {
  return filePaths.map((f) => normalizeFilePath(f, cwd));
}
