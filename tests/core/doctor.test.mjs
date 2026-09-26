import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempHome, makeTempProject, runCli } from '../helpers.mjs';

test('gatekeeper doctor reports safe environment diagnostics', () => {
  const home = makeTempHome();
  const cwd = makeTempProject();
  const result = runCli(['doctor'], { cwd, home });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /GATEKEEPER DOCTOR/);
  assert.match(result.stdout, /Node version:/);
  assert.match(result.stdout, /Gate phase:\s+locked/);
});

test('gatekeeper doctor --json is valid JSON with no secrets', () => {
  const home = makeTempHome();
  const cwd = makeTempProject();
  const result = runCli(['doctor', '--json'], { cwd, home });
  const report = JSON.parse(result.stdout);
  assert.equal(report.gatePhase, 'locked');
  assert.equal(typeof report.nodeVersion, 'string');
  const serialized = JSON.stringify(report).toLowerCase();
  for (const forbidden of ['token', 'api_key', 'apikey', 'password', 'secret']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test('gatekeeper doctor reflects an active challenge', () => {
  const home = makeTempHome();
  const cwd = makeTempProject();
  runCli(['challenge', '--summary', 'x', '--files', `${cwd}/src/a.ts`], { cwd, home });
  const report = JSON.parse(runCli(['doctor', '--json'], { cwd, home }).stdout);
  assert.equal(report.gatePhase, 'challenge');
  assert.equal(report.statePathExists, true);
});
