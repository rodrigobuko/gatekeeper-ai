// Deterministic complexity heuristic. It asks a question; it never decides
// the design is wrong, and it never outputs a score (directive section 17 /
// hardening section 10). Signals only, the skill turns a triggered signal
// into a specific question ("this crosses four modules, which of them
// actually needs to change?"), not a verdict.

const DIRECTORIES_CROSSED_THRESHOLD = 4;
const NEW_EXPORTS_THRESHOLD = 3;

export function computeComplexity({
  fileCount = 0,
  newFileCount = 0,
  directoriesCrossed = 0,
  newExportCount = 0,
  flags = {},
} = {}) {
  const { newDependency = false, architectureChange = false, schemaChange = false } = flags;

  let level = 'normal';
  if (fileCount >= 9) level = 'high';
  else if (fileCount >= 5) level = 'simplicity';

  const forcedBySignal = Boolean(
    newDependency ||
      architectureChange ||
      schemaChange ||
      newFileCount >= 3 ||
      directoriesCrossed >= DIRECTORIES_CROSSED_THRESHOLD ||
      newExportCount >= NEW_EXPORTS_THRESHOLD,
  );

  const requiresSimplicityChallenge = level !== 'normal' || forcedBySignal;

  return {
    level: level === 'normal' && forcedBySignal ? 'simplicity' : level,
    requiresSimplicityChallenge,
    signals: {
      fileCountBand: fileCount >= 9 ? '9+' : fileCount >= 5 ? '5-8' : '1-4',
      newDependency: Boolean(newDependency),
      architectureChange: Boolean(architectureChange),
      schemaChange: Boolean(schemaChange),
      manyNewFiles: newFileCount >= 3,
      manyDirectoriesCrossed: directoriesCrossed >= DIRECTORIES_CROSSED_THRESHOLD,
      directoriesCrossed,
      manyNewExports: newExportCount >= NEW_EXPORTS_THRESHOLD,
      newExportCount,
    },
  };
}

// Counts distinct parent directories among a set of already-normalized
// (forward-slash) file paths. Purely path-based, no code parsing, no AST.
export function countDirectoriesCrossed(normalizedFiles) {
  const dirs = new Set();
  for (const f of normalizedFiles) {
    const idx = f.lastIndexOf('/');
    dirs.add(idx === -1 ? '' : f.slice(0, idx));
  }
  return dirs.size;
}
