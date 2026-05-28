/**
 * While-loop edge-case tests.
 *
 * Covers: zero-iteration loops (condition false from the start),
 * accumulator pattern, countdown, and nested loops.
 * These catch off-by-one errors in loop condition evaluation and
 * incorrect loop variable scoping.
 */

import { describe, it, expect } from 'vitest';
import { compileAndRun } from './helpers/cli.js';

describe('loops — zero iterations', () => {
    it('while body never executes when condition is initially false', () => {
        const { exitCode, stdout } = compileAndRun('while_zero_iters.code');
        expect(exitCode).toBe(0);
        expect(stdout).toBe('0\n');
    });
});

describe('loops — accumulator', () => {
    it('sum 1..10 = 55', () => {
        const { exitCode, stdout } = compileAndRun('while_sum.code');
        expect(exitCode).toBe(0);
        expect(stdout).toBe('55\n');
    });
});

describe('loops — countdown (print inside loop)', () => {
    it('prints 5 4 3 2 1 on separate lines', () => {
        const { exitCode, stdout } = compileAndRun('while_countdown.code');
        expect(exitCode).toBe(0);
        expect(stdout).toBe('5\n4\n3\n2\n1\n');
    });
});

describe('loops — nested while', () => {
    it('counts 6 pairs (i,j) with 1≤i<j≤4', () => {
        const { exitCode, stdout } = compileAndRun('while_nested.code');
        expect(exitCode).toBe(0);
        expect(stdout).toBe('6\n');
    });
});
