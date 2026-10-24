// Per-project knowledge map: what the developer has already shown they
// understand in this project. Gatekeeper only asks about what is NOT here
// yet, so friction drops as the developer learns the codebase.
//
// Three kinds of concept, each with a stable id:
//   file:<path relative to the project>   what this file is for
//   dep:<library name>                    which library, and why this one
//   decision:<slug>                       an architecture or code choice
//
// Each entry keeps one short note (the developer's understanding, as
// summarized by the agent) and when it was learned. No source code, no raw
// prompts. Lives in $GATEKEEPER_HOME, never inside the repository.

import fs from 'node:fs';
import path from 'node:path';
import { ensureHome, sessionKey } from './state.mjs';
import { withFileLock } from './lock.mjs';
import { normalizeFilePath } from './files.mjs';

const KNOWLEDGE_VERSION = 1;
const MAX_NOTE_LENGTH = 200;
const MAX_SLUG_LENGTH = 48;

export const CONCEPT_KINDS = ['file', 'dep', 'decision'];

function knowledgePath(home, cwd) {
  return path.join(home, 'knowledge', `${sessionKey(cwd)}.json`);
}

export function defaultKnowledge() {
  return { version: KNOWLEDGE_VERSION, entries: {} };
}

// An unreadable map is treated as empty: the worst case is being asked
// again about something already understood, never skipping a question.
export function loadKnowledge(home, cwd) {
  const file = knowledgePath(home, cwd);
  if (!fs.existsSync(file)) return defaultKnowledge();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed.entries !== 'object' || parsed.entries === null) return defaultKnowledge();
    return { ...defaultKnowledge(), ...parsed };
  } catch {
    return defaultKnowledge();
  }
}

function saveKnowledge(home, cwd, knowledge) {
  const file = knowledgePath(home, cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(knowledge, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function updateKnowledge(home, cwd, mutate) {
  ensureHome(home);
  const file = knowledgePath(home, cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withFileLock(file, () => {
    const knowledge = loadKnowledge(home, cwd);
    const result = mutate(knowledge);
    saveKnowledge(home, cwd, knowledge);
    return result;
  });
}

function realPathOrSelf(value) {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return value;
  }
}

// Real path of a file that may not exist yet: resolves its nearest
// existing ancestor and keeps the rest as given.
function realPathOfMaybeNewFile(normalized) {
  const parts = normalized.split('/');
  for (let i = parts.length; i > 0; i -= 1) {
    const head = parts.slice(0, i).join('/') || '/';
    try {
      const real = fs.realpathSync.native(head).split(path.sep).join('/');
      return [real, ...parts.slice(i)].join('/');
    } catch {
      // keep walking up
    }
  }
  return normalized;
}

// Paths are stored relative to the project so the map survives a moved
// checkout and reads naturally. Symlinks are resolved on both sides first
// (macOS /var vs /private/var, see state.mjs).
export function fileConceptId(filePath, cwd) {
  const normalized = normalizeFilePath(filePath, cwd);
  const candidates = [normalized, normalizeFilePath(realPathOfMaybeNewFile(normalized), cwd)];
  const prefixes = [normalizeFilePath(cwd, cwd), normalizeFilePath(realPathOrSelf(cwd), cwd)];
  for (const file of candidates) {
    for (const prefix of prefixes) {
      const withSlash = prefix.endsWith('/') ? prefix : `${prefix}/`;
      if (file.toLowerCase().startsWith(withSlash.toLowerCase())) {
        return `file:${file.slice(withSlash.length)}`;
      }
    }
  }
  return `file:${normalized}`;
}

export function dependencyConceptId(name) {
  return `dep:${String(name).trim().toLowerCase()}`;
}

export function decisionConceptId(text) {
  const slug = String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '');
  return `decision:${slug || 'unnamed'}`;
}

export function conceptKind(id) {
  const idx = typeof id === 'string' ? id.indexOf(':') : -1;
  if (idx <= 0) return null;
  const kind = id.slice(0, idx);
  return CONCEPT_KINDS.includes(kind) && id.length > idx + 1 ? kind : null;
}

// Parses one `--learned "<concept id> = <one line note>"` value. The first
// " = " separates id from note, so a Windows path inside the id is safe.
export function parseLearned(value) {
  if (typeof value !== 'string') return null;
  const idx = value.indexOf(' = ');
  if (idx === -1) return null;
  const id = value.slice(0, idx).trim();
  const note = value.slice(idx + 3).trim();
  if (!conceptKind(id) || note === '') return null;
  return { id, note: note.length > MAX_NOTE_LENGTH ? `${note.slice(0, MAX_NOTE_LENGTH - 1)}.` : note };
}

export function knownConceptIds(knowledge) {
  return Object.keys(knowledge.entries);
}

export function learnConcepts(knowledge, items, { challengeId = null } = {}) {
  const now = new Date().toISOString();
  for (const { id, note } of items) {
    const kind = conceptKind(id);
    if (!kind) continue;
    knowledge.entries[id] = { kind, note, learnedAt: now, challengeId };
  }
  return items.length;
}

export function forgetConcept(knowledge, id) {
  if (!Object.prototype.hasOwnProperty.call(knowledge.entries, id)) return false;
  delete knowledge.entries[id];
  return true;
}
