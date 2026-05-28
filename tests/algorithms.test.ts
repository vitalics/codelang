/**
 * Recursive algorithm tests.
 *
 * Covers: factorial (single recursion), power (two-parameter recursion),
 * and GCD (while-loop with mutable parameter reassignment).
 * These test correct base-case handling, multi-parameter functions,
 * and mutation of function parameters inside loops.
 */

import { describe, it, expect } from 'vitest';
import { compileAndRun } from './helpers/cli.js';

describe('algorithms — factorial', () => {
    it('fact(0)=1, fact(1)=1, fact(5)=120, fact(10)=3628800', () => {
        const { exitCode, stdout } = compileAndRun('factorial.code');
        expect(exitCode).toBe(0);
        expect(stdout).toBe('1\n1\n120\n3628800\n');
    });
});

describe('algorithms — power function', () => {
    it('pow(2,0)=1, pow(2,10)=1024, pow(3,5)=243, pow(10,6)=1000000', () => {
        const { exitCode, stdout } = compileAndRun('pow_fn.code');
        expect(exitCode).toBe(0);
        expect(stdout).toBe('1\n1024\n243\n1000000\n');
    });
});

describe('algorithms — GCD (Euclidean, while loop)', () => {
    it('gcd(48,18)=6, gcd(100,75)=25, gcd(17,5)=1, gcd(7,7)=7', () => {
        const { exitCode, stdout } = compileAndRun('gcd.code');
        expect(exitCode).toBe(0);
        expect(stdout).toBe('6\n25\n1\n7\n');
    });
});
