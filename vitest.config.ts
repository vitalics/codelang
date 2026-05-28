import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Run each test file in a separate child process — more stable for
        // tests that spawn their own subprocesses (clang, native binaries).
        pool: 'forks',

        // Cap parallel workers so we don't overwhelm the machine with
        // simultaneous clang/lli invocations (causes flaky timeouts).
        poolOptions: {
            forks: {
                minForks: 1,
                maxForks: 6,
            },
        },

        // Clang compilation can take a few seconds on a cold build.
        testTimeout: 60_000,

        // beforeAll hooks compile multiple fixtures — allow enough time even on
        // a cold build where clang needs to link the runtime from scratch.
        hookTimeout: 300_000,

        // Print each test name as it runs so progress is visible.
        reporter: 'verbose',

        include: ['tests/**/*.test.ts'],
    },
});
