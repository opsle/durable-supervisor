#!/usr/bin/env node

import { main } from '../src/cli.js';
import { loadRuntimeRelease } from '../src/runtime-release.js';

function renderError(error) {
  const prefix = error.classification && !String(error.message).startsWith(`${error.classification}:`)
    ? `${error.classification}: `
    : '';
  return `opsle: ${prefix}${error.message}\n`;
}

try {
  loadRuntimeRelease();
} catch (error) {
  process.stderr.write(renderError(error));
  process.exitCode = 1;
}

if (process.exitCode !== 1) main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(renderError(error));
  process.exitCode = 1;
});
