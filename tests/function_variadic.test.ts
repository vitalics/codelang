/**
 * Tests for the variadic Function<A extends Any[], R> = fn(...A): R type alias.
 *
 * Covers:
 *   - Single-argument  Function<[int], int>         backwards-compatible with Function<int, int>
 *   - Two-argument     Function<[int, int], int>     fat pointer calls with 2 int params
 *   - Three-argument   Function<[int, int, int], int>
 *   - Lambda assigned to a multi-arg Function variable
 *   - Callable.call() still works for single-arg specialisations
 *   - Existing stdlib combinators (apply, identity, constant) unchanged
 *
 * IR structure checks verify that multi-param fn-wrap functions are emitted
 * and that call sites pass the right number of arguments.
 *
 * Runtime checks verify the expected output values.
 */

import { describe, it, expect } from 'vitest';
import { compileAndRun, compileToIR } from './helpers/cli.js';

const FIXTURE = 'function_variadic.code';

// ── IR structure ──────────────────────────────────────────────────────────────

describe('Function<A[], R> variadic — IR structure', () => {
    it('add__fn_wrap accepts two i32 params', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/define .* @add__fn_wrap\(i32 %x0, i32 %x1, i8\* %_env\)/);
    });

    it('mul3__fn_wrap accepts three i32 params', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/define .* @mul3__fn_wrap\(i32 %x0, i32 %x1, i32 %x2, i8\* %_env\)/);
    });

    it('two-arg fat-pointer call passes two i32 args + env', () => {
        const { ir } = compileToIR(FIXTURE);
        // call through fat ptr: fn_ptr(i32 val, i32 val, i8* env)
        expect(ir).toMatch(/call i32 %\d+\(i32 \d+, i32 \d+, i8\* %\d+\)/);
    });

    it('three-arg fat-pointer call passes three i32 args + env', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/call i32 %\d+\(i32 \d+, i32 \d+, i32 \d+, i8\* %\d+\)/);
    });

    it('Function variables are still fat pointers { i8*, i8* }', () => {
        const { ir } = compileToIR(FIXTURE);
        // both %g and %h should be { i8*, i8* }
        expect(ir).toMatch(/%g = alloca \{ i8\*, i8\* \}/);
        expect(ir).toMatch(/%h = alloca \{ i8\*, i8\* \}/);
        expect(ir).toMatch(/%triple = alloca \{ i8\*, i8\* \}/);
    });
});

// ── Runtime behaviour ─────────────────────────────────────────────────────────

describe('Function<A[], R> variadic — runtime', () => {
    function lines(): string[] {
        const { stdout } = compileAndRun(FIXTURE);
        return stdout.trim().split('\n');
    }

    it('f(5) where f: Function<[int], int> = double == 10', () => expect(lines()[0]).toBe('10'));
    it('f.call(5) == 10  (Callable protocol, single-arg)', () => expect(lines()[1]).toBe('10'));
    it('g(3, 4) where g: Function<[int, int], int> = add == 7', () => expect(lines()[2]).toBe('7'));
    it('h(6, 7) where h = lambda a*b: Function<[int, int], int> == 42', () =>
        expect(lines()[3]).toBe('42'));
    it('triple(2, 3, 5) where triple: Function<[int, int, int], int> = mul3 == 30', () =>
        expect(lines()[4]).toBe('30'));
    it('apply(double, 8) == 16  (existing single-arg apply unchanged)', () =>
        expect(lines()[5]).toBe('16'));
    it('identity(99) == 99', () => expect(lines()[6]).toBe('99'));
    it('adder(10, 20) lambda two-arg == 30', () => expect(lines()[7]).toBe('30'));

    it('produces exactly 8 lines of output', () =>
        expect(lines()).toHaveLength(8));
    it('exits with code 0', () =>
        expect(compileAndRun(FIXTURE).exitCode).toBe(0));
});
