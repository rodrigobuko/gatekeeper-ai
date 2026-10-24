#!/usr/bin/env node
// Cross-platform test runner entry point. `node --test tests/` is not
// reliable across every Node/npm/shell combination (npm's argv handling and
// some Node versions resolve a bare directory argument as a module
// specifier rather than a directory to scan, this is the exact failure
// the public-pilot audit reproduced). Discovering files ourselves and
// passing an explicit file list to `--test` removes that ambiguity, and
// avoids depending on shell glob expansion (which differs between
// PowerShell, cmd, and POSIX shells).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testsRoot = path.join(__dirname, '..', 'tests');

function discover(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...discover(full));
    } else if (entry.isFile() && entry.name.endsWith('.test.mjs')) {
      found.push(full);
    }
  }
  return found;
}

const files = discover(testsRoot).sort((a, b) => a.localeCompare(b));

if (files.length === 0) {
  process.stderr.write(`No *.test.mjs files found under ${testsRoot}\n`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
