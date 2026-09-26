// Concurrency test worker (see ../lock.test.mjs). Increments a counter in
// either the shared stats file or the cwd-scoped state file, once, via the
// locked read-modify-write helpers under test.
import { updateStats } from '../../../src/core/stats.mjs';
import { withStateLock } from '../../../src/core/state.mjs';

const target = process.argv[2];
const home = process.env.GATEKEEPER_HOME;
const cwd = process.cwd();

if (target === 'stats') {
  updateStats(home, (stats) => {
    stats.gatesFaced += 1;
  });
} else if (target === 'state') {
  withStateLock(home, cwd, (state) => {
    state.counter = (state.counter || 0) + 1;
  });
} else {
  throw new Error(`unknown target: ${target}`);
}
