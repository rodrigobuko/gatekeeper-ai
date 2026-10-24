import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  fileConceptId,
  dependencyConceptId,
  decisionConceptId,
  parseLearned,
  loadKnowledge,
  updateKnowledge,
  learnConcepts,
  forgetConcept,
  knownConceptIds,
} from '../../src/core/knowledge.mjs';
import { makeTempHome, makeTempProject } from '../helpers.mjs';

test('file concepts are relative to the project, on POSIX and Windows paths', () => {
  assert.equal(fileConceptId('/home/dev/app/src/a.ts', '/home/dev/app'), 'file:src/a.ts');
  assert.equal(fileConceptId('src/a.ts', '/home/dev/app'), 'file:src/a.ts');
  assert.equal(fileConceptId('C:\\Projects\\app\\src\\a.ts', 'C:\\Projects\\app'), 'file:src/a.ts');
});

test('a file reached through a symlinked project gets the same id (macOS /var -> /private/var)', () => {
  const real = makeTempProject();
  const link = `${real}-link`;
  fs.symlinkSync(real, link, 'junction');
  // The CLI runs in the real path; the plan names files through the link,
  // and a new file does not exist yet.
  assert.equal(fileConceptId(`${link}/src/new-file.ts`, real), 'file:src/new-file.ts');
  assert.equal(fileConceptId(`${real}/src/new-file.ts`, link), 'file:src/new-file.ts');
});

test('dependency and decision ids are stable and readable', () => {
  assert.equal(dependencyConceptId(' Redis '), 'dep:redis');
  assert.equal(decisionConceptId('Guardar a Promise, não o valor'), 'decision:guardar-a-promise-nao-o-valor');
});

test('parseLearned splits on " = " and rejects bad input', () => {
  assert.deepEqual(parseLearned('dep:redis = shared cache between workers'), { id: 'dep:redis', note: 'shared cache between workers' });
  assert.deepEqual(parseLearned('file:c:/x/a.ts = a = b'), { id: 'file:c:/x/a.ts', note: 'a = b' });
  assert.equal(parseLearned('redis = no kind'), null);
  assert.equal(parseLearned('dep:redis'), null);
  assert.equal(parseLearned('dep:redis = '), null);
});

test('learned concepts persist per project, and can be forgotten', () => {
  const home = makeTempHome();
  const cwd = makeTempProject();
  const other = makeTempProject();
  updateKnowledge(home, cwd, (k) => learnConcepts(k, [{ id: 'dep:redis', note: 'shared cache' }]));
  assert.deepEqual(knownConceptIds(loadKnowledge(home, cwd)), ['dep:redis']);
  assert.deepEqual(knownConceptIds(loadKnowledge(home, other)), []);
  assert.equal(updateKnowledge(home, cwd, (k) => forgetConcept(k, 'dep:redis')), true);
  assert.deepEqual(knownConceptIds(loadKnowledge(home, cwd)), []);
});
