/**
 * Tests for stdlib/function.code
 *
 * Covers:
 *   - type Function<A, R> = fn(A): R  — generic single-argument function alias
 *   - fn apply<A, R>(f, x)            — call through fat pointer
 *   - fn compose<A, B, C>(f, g)       — right-to-left composition
 *   - fn pipe<A, B, C>(g, f)          — left-to-right pipeline
 *   - fn identity<T>(x)               — identity combinator
 *   - fn constant<T>(value)           — constant-function combinator
 *
 * IR structure checks verify that the generic specialisations are emitted with
 * the correct mangled names and fat-pointer types.
 *
 * Runtime checks verify the expected output values.
 */

import { describe, it, expect } from 'vitest';
import { compileAndRun, compileToIR } from './helpers/cli.js';

const FIXTURE = 'function_stdlib.code';

// ── IR structure ──────────────────────────────────────────────────────────────

describe('stdlib/function — IR structure', () => {
    it('apply is specialised as apply_i32_i32', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/define .* @apply_i32_i32\(\{ i8\*, i8\* \}/);
    });

    it('compose is specialised with concrete int types', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/define .* @compose_i32_i32_i32\(/);
    });

    it('pipe is specialised with concrete int types', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/define .* @pipe_i32_i32_i32\(/);
    });

    it('identity is specialised as identity_i32', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/define .* @identity_i32\(i32/);
    });

    it('constant is specialised as constant_i32', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/define .* @constant_i32\(i32/);
    });

    it('Function<int,int> variable uses fat pointer { i8*, i8* }', () => {
        const { ir } = compileToIR(FIXTURE);
        // const f: Function<int, int> = double  →  alloca { i8*, i8* }
        expect(ir).toMatch(/%f = alloca \{ i8\*, i8\* \}/);
    });

    it('compose closure env holds two fat-pointer slots', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/%__lambda_\d+_env = type \{ \{ i8\*, i8\* \}, \{ i8\*, i8\* \} \}/);
    });

    it('constant closure env holds one captured-value slot', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/%__lambda_\d+_env = type \{ i32 \}/);
    });
});

// ── Runtime behaviour ─────────────────────────────────────────────────────────

describe('stdlib/function — runtime', () => {
    function lines(): string[] {
        const { stdout } = compileAndRun(FIXTURE);
        return stdout.trim().split('\n');
    }

    // apply
    it('apply(double, 5) == 10', () => expect(lines()[0]).toBe('10'));
    it('apply(square, 4) == 16', () => expect(lines()[1]).toBe('16'));
    it('apply(inc, 99) == 100',   () => expect(lines()[2]).toBe('100'));
    it('apply(cube_lambda, 3) == 27', () => expect(lines()[3]).toBe('27'));

    // Function<A,R> type alias used as variable annotation
    it('apply(f: Function<int,int>, 6) == 12', () => expect(lines()[4]).toBe('12'));

    // compose (right-to-left)
    it('compose(square, double)(3) == 36  — double first, then square', () =>
        expect(lines()[5]).toBe('36'));
    it('compose(double, square)(3) == 18  — square first, then double', () =>
        expect(lines()[6]).toBe('18'));

    // pipe (left-to-right)
    it('pipe(double, square)(3) == 36  — same as compose(square, double)', () =>
        expect(lines()[7]).toBe('36'));
    it('pipe(square, double)(3) == 18  — same as compose(double, square)', () =>
        expect(lines()[8]).toBe('18'));

    // identity
    it('identity(0) == 0',   () => expect(lines()[9]).toBe('0'));
    it('identity(42) == 42', () => expect(lines()[10]).toBe('42'));

    // constant
    it('constant(7)(0)   == 7', () => expect(lines()[11]).toBe('7'));
    it('constant(7)(999) == 7', () => expect(lines()[12]).toBe('7'));
    it('constant(-1)(100) == -1', () => expect(lines()[13]).toBe('-1'));

    // general
    it('produces exactly 14 lines of output', () =>
        expect(lines()).toHaveLength(14));
    it('exits with code 0', () =>
        expect(compileAndRun(FIXTURE).exitCode).toBe(0));
});
