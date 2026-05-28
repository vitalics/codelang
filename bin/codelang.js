#!/usr/bin/env node
// Entry point for the `codelang` CLI binary.
// The compiled TypeScript lives in `out/cli/main.js`.
import('../out/cli/main.js').then(m => m.default());
