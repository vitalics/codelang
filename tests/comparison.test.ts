/**
 * Tests for min/max type limits, Cmp/PartialCmp/Ord/PartialOrd protocols,
 * and IEEE 754 special-value constants (Infinity, NegativeInfinity, NaN).
 *
 * Fixtures:
 *  - number_limits.code   — Number.min() / Number.max()
 *  - scalar_limits.code   — Int8/Int32/Int64 static min() / max()
 *  - number_cmp.code      — Number.cmp() / Number.eq() method calls
 *  - point_ord.code       — custom Point type with Ord + Cmp dispatch
 *  - number_special.code  — Number.infinity() / negativeInfinity() / nan()
 *                           + isNaN() / isInfinite() / isFinite() predicates
 */

import { describe, it, expect } from 'vitest';
import { compileToIR, compileAndRun } from './helpers/cli.js';

// ── Number.min / Number.max ───────────────────────────────────────────────────

describe('Number limits — min() and max()', () => {

    it('emits @Number_min static extension method', () => {
        const { ir } = compileToIR('number_limits.code');
        expect(ir).toMatch(/@Number_min/);
    });

    it('emits @Number_max static extension method', () => {
        const { ir } = compileToIR('number_limits.code');
        expect(ir).toMatch(/@Number_max/);
    });

    it('Number.min() calls @number_min_value', () => {
        const { ir } = compileToIR('number_limits.code');
        expect(ir).toMatch(/call %Number\* @number_min_value\(\)/);
    });

    it('Number.max() calls @number_max_value', () => {
        const { ir } = compileToIR('number_limits.code');
        expect(ir).toMatch(/call %Number\* @number_max_value\(\)/);
    });

    it('Number.min() < 0 is true', () => {
        const { stdout } = compileAndRun('number_limits.code');
        const lines = stdout.trim().split('\n');
        expect(lines[0]).toBe('1');
    });

    it('Number.max() > 0 is true', () => {
        const { stdout } = compileAndRun('number_limits.code');
        const lines = stdout.trim().split('\n');
        expect(lines[1]).toBe('2');
    });

    it('Number.min() < Number.max() is true', () => {
        const { stdout } = compileAndRun('number_limits.code');
        const lines = stdout.trim().split('\n');
        expect(lines[2]).toBe('3');
    });

    it('Number.max() > Number.min() is true', () => {
        const { stdout } = compileAndRun('number_limits.code');
        const lines = stdout.trim().split('\n');
        expect(lines[3]).toBe('4');
    });

    it('exits cleanly', () => {
        const { exitCode } = compileAndRun('number_limits.code');
        expect(exitCode).toBe(0);
    });
});

// ── Scalar type limits ────────────────────────────────────────────────────────

describe('Scalar type limits — Int8 / Int32 / Int64', () => {

    it('emits @Int8_min static extension method', () => {
        const { ir } = compileToIR('scalar_limits.code');
        expect(ir).toMatch(/@Int8_min/);
    });

    it('emits @Int32_min static extension method', () => {
        const { ir } = compileToIR('scalar_limits.code');
        expect(ir).toMatch(/@Int32_min/);
    });

    it('emits @Int32_max static extension method', () => {
        const { ir } = compileToIR('scalar_limits.code');
        expect(ir).toMatch(/@Int32_max/);
    });

    it('Int8.min() === -128', () => {
        const { stdout } = compileAndRun('scalar_limits.code');
        expect(stdout.trim().split('\n')[0]).toBe('-128');
    });

    it('Int8.max() === 127', () => {
        const { stdout } = compileAndRun('scalar_limits.code');
        expect(stdout.trim().split('\n')[1]).toBe('127');
    });

    it('Int32.min() < 0 is true', () => {
        const { stdout } = compileAndRun('scalar_limits.code');
        expect(stdout.trim().split('\n')[2]).toBe('1');
    });

    it('Int32.max() > 0 is true', () => {
        const { stdout } = compileAndRun('scalar_limits.code');
        expect(stdout.trim().split('\n')[3]).toBe('2');
    });

    it('Int32.min() < Int32.max() is true', () => {
        const { stdout } = compileAndRun('scalar_limits.code');
        expect(stdout.trim().split('\n')[4]).toBe('3');
    });

    it('Int64.min() < 0 is true', () => {
        const { stdout } = compileAndRun('scalar_limits.code');
        expect(stdout.trim().split('\n')[5]).toBe('4');
    });

    it('Int64.max() > 0 is true', () => {
        const { stdout } = compileAndRun('scalar_limits.code');
        expect(stdout.trim().split('\n')[6]).toBe('5');
    });

    it('exits cleanly', () => {
        const { exitCode } = compileAndRun('scalar_limits.code');
        expect(exitCode).toBe(0);
    });
});

// ── Number.cmp / Number.eq method calls ──────────────────────────────────────

describe('Number — Cmp/PartialCmp/Ord/PartialOrd protocol methods', () => {

    it('emits @Number_cmp extension method definition', () => {
        const { ir } = compileToIR('number_cmp.code');
        expect(ir).toMatch(/define.*@Number_cmp\(%Number\* %self\.0, %Number\* %arg\.0\)/);
    });

    it('emits @Number_partialCmp extension method definition', () => {
        const { ir } = compileToIR('number_cmp.code');
        expect(ir).toMatch(/define.*@Number_partialCmp\(%Number\* %self\.0, %Number\* %arg\.0\)/);
    });

    it('emits @Number_eq extension method definition', () => {
        const { ir } = compileToIR('number_cmp.code');
        expect(ir).toMatch(/define.*@Number_eq\(%Number\* %self\.0, %Number\* %arg\.0\)/);
    });

    it('Number_cmp body calls @number_cmp runtime', () => {
        const { ir } = compileToIR('number_cmp.code');
        expect(ir).toMatch(/call i32 @number_cmp\(%Number\*/);
    });

    it('a.cmp(b) === -1  (5 < 10)', () => {
        const { stdout } = compileAndRun('number_cmp.code');
        expect(stdout.trim().split('\n')[0]).toBe('-1');
    });

    it('b.cmp(a) === 1  (10 > 5)', () => {
        const { stdout } = compileAndRun('number_cmp.code');
        expect(stdout.trim().split('\n')[1]).toBe('1');
    });

    it('a.cmp(c) === 0  (5 == 5)', () => {
        const { stdout } = compileAndRun('number_cmp.code');
        expect(stdout.trim().split('\n')[2]).toBe('0');
    });

    it('a.partialCmp(b) === -1', () => {
        const { stdout } = compileAndRun('number_cmp.code');
        expect(stdout.trim().split('\n')[3]).toBe('-1');
    });

    it('a.eq(c) returns true → prints 1', () => {
        const { stdout } = compileAndRun('number_cmp.code');
        expect(stdout.trim().split('\n')[4]).toBe('1');
    });

    it('sentinel 0 always printed last', () => {
        const { stdout } = compileAndRun('number_cmp.code');
        const lines = stdout.trim().split('\n');
        expect(lines[lines.length - 1]).toBe('0');
    });

    it('exits cleanly', () => {
        const { exitCode } = compileAndRun('number_cmp.code');
        expect(exitCode).toBe(0);
    });
});

// ── Custom Point type with Ord and Cmp ────────────────────────────────────────

describe('Point — Ord (eq) and Cmp (cmp) operator dispatch', () => {

    it('emits @Point_eq extension method definition', () => {
        const { ir } = compileToIR('point_ord.code');
        expect(ir).toMatch(/define.*@Point_eq\(i64 %self\.0, i64 %arg\.0\)/);
    });

    it('emits @Point_cmp extension method definition', () => {
        const { ir } = compileToIR('point_ord.code');
        expect(ir).toMatch(/define.*@Point_cmp\(i64 %self\.0, i64 %arg\.0\)/);
    });

    it('== dispatches to @Point_eq (not icmp)', () => {
        const { ir } = compileToIR('point_ord.code');
        expect(ir).toMatch(/call i1 @Point_eq\(i64/);
    });

    it('< dispatches through @Point_cmp', () => {
        const { ir } = compileToIR('point_ord.code');
        expect(ir).toMatch(/call i32 @Point_cmp\(i64/);
    });

    it('a == b (same coordinates) → prints 1', () => {
        const { stdout } = compileAndRun('point_ord.code');
        expect(stdout.trim().split('\n')[0]).toBe('1');
    });

    it('a != c (different coordinates) → prints 2', () => {
        const { stdout } = compileAndRun('point_ord.code');
        expect(stdout.trim().split('\n')[1]).toBe('2');
    });

    it('c < a (c.x=1 < a.x=3) → prints 3', () => {
        const { stdout } = compileAndRun('point_ord.code');
        expect(stdout.trim().split('\n')[2]).toBe('3');
    });

    it('d > a (d.x=5 > a.x=3) → prints 4', () => {
        const { stdout } = compileAndRun('point_ord.code');
        expect(stdout.trim().split('\n')[3]).toBe('4');
    });

    it('a <= b (equal) → prints 5', () => {
        const { stdout } = compileAndRun('point_ord.code');
        expect(stdout.trim().split('\n')[4]).toBe('5');
    });

    it('a >= c (a.x=3 >= c.x=1) → prints 6', () => {
        const { stdout } = compileAndRun('point_ord.code');
        expect(stdout.trim().split('\n')[5]).toBe('6');
    });

    it('a > e (same x=3, a.y=4 > e.y=1) → prints 7', () => {
        const { stdout } = compileAndRun('point_ord.code');
        expect(stdout.trim().split('\n')[6]).toBe('7');
    });

    it('exits cleanly', () => {
        const { exitCode } = compileAndRun('point_ord.code');
        expect(exitCode).toBe(0);
    });
});

// ── Number IEEE 754 special values ────────────────────────────────────────────

describe('Number — Infinity, NegativeInfinity, NaN', () => {

    // ── IR shape tests ────────────────────────────────────────────────────────

    it('Number.Infinity lowers to @Number_Infinity static call (no parens access)', () => {
        const { ir } = compileToIR('number_special.code');
        // property-style access `Number.Infinity` emits a zero-arg static call
        expect(ir).toMatch(/call %Number\* @Number_Infinity\(\)/);
    });

    it('Number.NegativeInfinity lowers to @Number_NegativeInfinity', () => {
        const { ir } = compileToIR('number_special.code');
        expect(ir).toMatch(/call %Number\* @Number_NegativeInfinity\(\)/);
    });

    it('Number.NaN lowers to @Number_NaN', () => {
        const { ir } = compileToIR('number_special.code');
        expect(ir).toMatch(/call %Number\* @Number_NaN\(\)/);
    });

    it('Number_Infinity body calls @number_infinity runtime', () => {
        const { ir } = compileToIR('number_special.code');
        expect(ir).toMatch(/call %Number\* @number_infinity\(\)/);
    });

    it('Number_NegativeInfinity body calls @number_negative_infinity runtime', () => {
        const { ir } = compileToIR('number_special.code');
        expect(ir).toMatch(/call %Number\* @number_negative_infinity\(\)/);
    });

    it('Number_NaN body calls @number_nan runtime', () => {
        const { ir } = compileToIR('number_special.code');
        expect(ir).toMatch(/call %Number\* @number_nan\(\)/);
    });

    // ── Runtime semantics ─────────────────────────────────────────────────────

    it('Number.Infinity > 0 is true → prints 1', () => {
        const { stdout } = compileAndRun('number_special.code');
        expect(stdout.trim().split('\n')[0]).toBe('1');
    });

    it('Number.NegativeInfinity < 0 is true → prints 2', () => {
        const { stdout } = compileAndRun('number_special.code');
        expect(stdout.trim().split('\n')[1]).toBe('2');
    });

    it('Number.Infinity > Number.NegativeInfinity → prints 3', () => {
        const { stdout } = compileAndRun('number_special.code');
        expect(stdout.trim().split('\n')[2]).toBe('3');
    });

    it('inf.isInfinite() === 1', () => {
        const { stdout } = compileAndRun('number_special.code');
        expect(stdout.trim().split('\n')[3]).toBe('1');
    });

    it('negInf.isInfinite() === 1', () => {
        const { stdout } = compileAndRun('number_special.code');
        expect(stdout.trim().split('\n')[4]).toBe('1');
    });

    it('finite.isFinite() === 1', () => {
        const { stdout } = compileAndRun('number_special.code');
        expect(stdout.trim().split('\n')[5]).toBe('1');
    });

    it('nan.isFinite() === 0', () => {
        const { stdout } = compileAndRun('number_special.code');
        expect(stdout.trim().split('\n')[6]).toBe('0');
    });

    it('nan.isNaN() === 1', () => {
        const { stdout } = compileAndRun('number_special.code');
        expect(stdout.trim().split('\n')[7]).toBe('1');
    });

    it('inf.isNaN() === 0', () => {
        const { stdout } = compileAndRun('number_special.code');
        expect(stdout.trim().split('\n')[8]).toBe('0');
    });

    it('finite.isNaN() === 0', () => {
        const { stdout } = compileAndRun('number_special.code');
        expect(stdout.trim().split('\n')[9]).toBe('0');
    });

    it('inf.isFinite() === 0', () => {
        const { stdout } = compileAndRun('number_special.code');
        expect(stdout.trim().split('\n')[10]).toBe('0');
    });

    it('negInf == Number.min() is true → prints 4', () => {
        const { stdout } = compileAndRun('number_special.code');
        expect(stdout.trim().split('\n')[11]).toBe('4');
    });

    it('inf == Number.max() is true → prints 5', () => {
        const { stdout } = compileAndRun('number_special.code');
        expect(stdout.trim().split('\n')[12]).toBe('5');
    });

    it('exits cleanly', () => {
        const { exitCode } = compileAndRun('number_special.code');
        expect(exitCode).toBe(0);
    });
});
