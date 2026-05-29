#!/usr/bin/env node
/**
 * debugger/src/index.ts — CodeLang DAP adapter entry point.
 *
 * Launched by VS Code / Zed as the "debugAdapterExecutable".
 * Communicates via stdin/stdout using the DAP wire format.
 */

import { CodeLangDapAdapter } from './adapter.js';

// Prevent Node.js from adding extra output to stdout (which would corrupt DAP framing)
process.stdout.setDefaultEncoding('utf-8');
process.stdin.setEncoding('utf-8');

const adapter = new CodeLangDapAdapter(process.stdin, process.stdout);
adapter.start();

// Keep the process alive (the adapter drives its own lifecycle)
process.on('uncaughtException', (err) => {
    process.stderr.write(`[codelang-dap] uncaught exception: ${err.stack ?? err}\n`);
});
process.on('unhandledRejection', (reason) => {
    process.stderr.write(`[codelang-dap] unhandled rejection: ${reason}\n`);
});
