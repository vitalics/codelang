/**
 * Tests for default parameter values.
 *
 * Syntax variants covered:
 *   fn f(x: int, n: int = 5)   – explicit type + default
 *   fn f(x: int, n = 1)        – type inferred from literal (i32)
 *   fn f(x: int, s = "hi")     – type inferred as string (i8*)
 *   fn f(x: int, b = true)     – type inferred as bool (i1)
 *
 * Semantics: default values are evaluated at the call site (C++ style).
 * Trailing parameters may be omitted; the compiler substitutes the default.
 */

import { describe, it, expect } from 'vitest';
import { compileToIR, compileAndRun } from './helpers/cli.js';

const FIXTURE = 'default_params_test.code';

// ── IR structure ──────────────────────────────────────────────────────────────

describe('default parameters — IR structure', () => {

    it('@power is defined with two i32 parameters', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/define\b.*@power\(i32 %arg\.0, i32 %arg\.1\)/);
    });

    it('call to power(2,3) passes both arguments explicitly', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('call i32 @power(i32 2, i32 3)');
    });

    it('call to power(2) fills missing exp argument with literal 5', () => {
        const { ir } = compileToIR(FIXTURE);
        // Missing argument is substituted at the call site with the default value
        expect(ir).toContain('call i32 @power(i32 2, i32 5)');
    });

    it('@add is defined with two i32 parameters (inferred type for y)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/define\b.*@add\(i32 %arg\.0, i32 %arg\.1\)/);
    });

    it('call to add(10) fills missing y with literal 1', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('call i32 @add(i32 10, i32 1)');
    });

    it('@greet is defined with (i8*, i32) parameters', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/define\b.*@greet\(i8\* %arg\.0, i32 %arg\.1\)/);
    });

    it('call to greet("yo") fills missing times with literal 1', () => {
        const { ir } = compileToIR(FIXTURE);
        // Default i32 1 must appear as the second argument at the call site
        expect(ir).toMatch(/call.*@greet\(.*i32 1\)/);
    });
});

// ── Runtime behaviour ─────────────────────────────────────────────────────────

describe('default parameters — runtime', () => {

    it('exits with code 0', () => {
        const { exitCode } = compileAndRun(FIXTURE);
        expect(exitCode).toBe(0);
    });

    it('produces exactly 6 lines of output', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(stdout.trim().split('\n')).toHaveLength(6);
    });

    it('power(2, 3) == 8  (explicit exponent)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(stdout.trim().split('\n')[0]).toBe('8');
    });

    it('power(2) == 32  (default exponent = 5)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(stdout.trim().split('\n')[1]).toBe('32');
    });

    it('add(10, 3) == 13  (explicit second arg)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(stdout.trim().split('\n')[2]).toBe('13');
    });

    it('add(10) == 11  (default y = 1)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(stdout.trim().split('\n')[3]).toBe('11');
    });

    it('greet("hi", 3) == "hihihi"  (explicit repeat count)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(stdout.trim().split('\n')[4]).toBe('hihihi');
    });

    it('greet("yo") == "yo"  (default times = 1)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(stdout.trim().split('\n')[5]).toBe('yo');
    });
});
