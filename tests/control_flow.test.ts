/**
 * Control-flow edge-case tests.
 *
 * Covers: functions with multiple early-return paths triggered by
 * sequential conditions (simulating if-else-if chains).
 * Tests that the IR merge blocks are generated correctly and that
 * early returns do not fall through to subsequent code.
 */

import { describe, it, expect } from 'vitest';
import { compileAndRun, compileToIR } from './helpers/cli.js';

describe('control flow — multiple return paths', () => {
    it('classify() returns "negative", "zero", "positive" correctly', () => {
        const { exitCode, stdout } = compileAndRun('multi_return.code');
        expect(exitCode).toBe(0);
        expect(stdout).toBe('negative\nzero\npositive\n');
    });

    it('IR has at least 2 conditional branches for 2 if-statements', () => {
        const { ir } = compileToIR('multi_return.code');
        const brCount = (ir.match(/br i1/g) ?? []).length;
        // classify has 2 if-statements → at least 2 br i1 instructions
        expect(brCount).toBeGreaterThanOrEqual(2);
    });
});
