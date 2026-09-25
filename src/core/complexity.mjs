// Deterministic complexity heuristic. It asks a question; it never decides
// the design is wrong. See directive section 17.

export function computeComplexity({ fileCount = 0, newFileCount = 0, flags = {} } = {}) {
  const { newDependency = false, architectureChange = false, schemaChange = false } = flags;

  let level = 'normal';
  if (fileCount >= 9) level = 'high';
  else if (fileCount >= 5) level = 'simplicity';

  const forcedBySignal = Boolean(newDependency || architectureChange || schemaChange || newFileCount >= 3);

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
    },
  };
}
