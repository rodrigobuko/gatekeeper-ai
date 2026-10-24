import test from 'node:test';
import assert from 'node:assert/strict';
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
