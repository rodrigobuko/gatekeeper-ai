// Protected-file classification and path normalization.
// Kept dependency-free and harness-independent so any adapter can reuse it.
//
// Path handling must depend on the SYNTAX of the string, not on
// process.platform / the host's default `node:path`. Gatekeeper's core is
// harness-independent and its test suite runs on any OS, so a hardcoded
// Windows-style path like "C:\Projects\app\src\a.ts" must normalize
// correctly even when the code executes on Linux/macOS, and a POSIX path
// must normalize correctly even when it executes on Windows. `path.win32`
// and `path.posix` are always both available regardless of host; we just
// have to pick the right one per input instead of trusting the host alias.

import path from 'node:path';

const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_RE = /^\\\\[^\\]+\\[^\\]+/;

// Returns 'win32', 'posix', or null (ambiguous — e.g. a bare relative path
// like "src/a.ts" that contains no OS-specific signal).
function detectPathStyle(value) {
  if (typeof value !== 'string' || value === '') return null;
  if (WINDOWS_DRIVE_RE.test(value) || WINDOWS_UNC_RE.test(value)) return 'win32';
  if (value.startsWith('/')) return 'posix';
  if (value.includes('\\')) return 'win32'; // relative Windows-style, e.g. "src\a.ts"
  return null;
}

// `cwd` is always absolute in real usage, so it's the more reliable signal.
// Falls back to filePath's own signal, then to POSIX as a last resort for
// the (practically unreachable) case where neither gives a clear answer.
export function pickPathModule(filePath, cwd) {
  const style = detectPathStyle(cwd) || detectPathStyle(filePath) || 'posix';
  return style === 'win32' ? path.win32 : path.posix;
}

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
  const mod = pickPathModule(filePath, filePath);
  const basename = mod.basename(filePath);
  const ext = mod.extname(basename).toLowerCase();

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
  const mod = pickPathModule(filePath, cwd);
  const absolute = mod.isAbsolute(filePath) ? filePath : mod.resolve(cwd, filePath);
  let normalized = mod.normalize(absolute).split(mod.sep).join('/');
  // Lower-case a Windows drive letter (C:/... vs c:/...) so comparisons
  // between hook-provided and CLI-provided paths are stable. Do NOT
  // lowercase the rest of the path — case can matter outside Windows.
  normalized = normalized.replace(/^([A-Za-z]):\//, (_, drive) => `${drive.toLowerCase()}:/`);
  return normalized;
}

export function normalizeFilePaths(filePaths, cwd) {
  return filePaths.map((f) => normalizeFilePath(f, cwd));
}
