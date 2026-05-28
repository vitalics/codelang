/**
 * Tests for Higher-Order Functions (HOF):
 *   - fn(T): R function type syntax
 *   - Named parameters in function types: fn(acc: int, val: int): int
 *   - Type aliases for function types: type F = fn(...): R
 *   - Generic function type aliases: type AnyFn<R> = fn(): R
 *   - Lambda expressions fn(params): R { body } as first-class values
 *   - Named function references as first-class values (bare function name)
 *   - fn name: TypeAlias(params) syntax
 *   - Type inference for untyped params from type alias
 *   - Closures: heap-allocated { fn_ptr, env_ptr } fat pointer representation
 *   - Calling through function-typed variables
 *   - const fn purity enforcement (capturing inside const fn → compile error)
 *
 * Fat pointer representation:
 *   { i8*, i8* } — { fn_ptr, env_ptr }
 *   fn_ptr: i8* cast of a concrete function that appends i8* env as last arg
 *   env_ptr: null for non-capturing lambdas, heap struct for closures
 */

import { describe, it, expect } from 'vitest';
import { compileAndRun, compileToIR } from './helpers/cli.js';

const FIXTURE = 'hof.code';

// ── LLVM IR structure ─────────────────────────────────────────────────────────

describe('higher-order functions — IR structure', () => {
    it('function values use fat pointer type { i8*, i8* }', () => {
        const { ir } = compileToIR(FIXTURE);
        // Fat pointer alloca or insertvalue
        expect(ir).toMatch(/\{ i8\*, i8\* \}/);
    });

    it('apply: indirect call emits bitcast + call through fat pointer', () => {
        const { ir } = compileToIR(FIXTURE);
        // indirect call pattern: bitcast i8* %X to T*; call T %Y(...)
        expect(ir).toMatch(/bitcast i8\*/);
        expect(ir).toMatch(/call i32 %/);
    });

    it('lambda emits a private define with env parameter', () => {
        const { ir } = compileToIR(FIXTURE);
        // All lambdas take an i8* %_env trailing parameter
        expect(ir).toMatch(/define private i32 @__lambda_\d+\(i32 %arg\.\d+, i8\* %_env\)/);
    });

    it('non-capturing lambda has null env pointer', () => {
        const { ir } = compileToIR(FIXTURE);
        // Fat pointer for non-capturing: env = null
        expect(ir).toMatch(/insertvalue \{ i8\*, i8\* \}.*i8\* null, 1/);
    });

    it('closure env struct is declared', () => {
        const { ir } = compileToIR(FIXTURE);
        // At least one closure env struct
        expect(ir).toMatch(/%__lambda_\d+_env = type \{/);
    });

    it('closure allocates env with malloc', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/call i8\* @malloc/);
    });

    it('named function reference creates a wrapper', () => {
        const { ir } = compileToIR(FIXTURE);
        // Wrapper for double, square, etc.
        expect(ir).toMatch(/@double__fn_wrap|@square__fn_wrap/);
    });

    it('wrapper function ignores env parameter', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/define private i32 @double__fn_wrap\(i32 %x0, i8\* %_env\)/);
    });

    it('compose lambda captures f and g (env struct with two slots)', () => {
        const { ir } = compileToIR(FIXTURE);
        // The compose closure env has two fat pointer fields: { i8*, i8* }, { i8*, i8* }
        expect(ir).toMatch(/%__lambda_\d+_env = type \{ \{ i8\*, i8\* \}, \{ i8\*, i8\* \} \}/);
    });

    it('makeAdder lambda env has one i32 field', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/%__lambda_\d+_env = type \{ i32 \}/);
    });

    it('clamp lambda env has two i32 fields', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/%__lambda_\d+_env = type \{ i32, i32 \}/);
    });

    it('reduce uses fn-alias typed parameters (ReduceFn)', () => {
        const { ir } = compileToIR(FIXTURE);
        // reduce takes %IntArray* and two fat pointers
        expect(ir).toMatch(/define private i32 @reduce\(%IntArray\* %arg\.\d+, \{ i8\*, i8\* \} %arg\.\d+, i32 %arg\.\d+\)/);
    });

    it('compose takes two fat-pointer parameters (ComposeFn)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/define private \{ i8\*, i8\* \} @compose\(\{ i8\*, i8\* \} %arg\.\d+, \{ i8\*, i8\* \} %arg\.\d+\)/);
    });

    it('filter: bool-returning indirect call emits i1 result', () => {
        const { ir } = compileToIR(FIXTURE);
        // pred(val) returns i1 — the indirect call to pred produces i1
        expect(ir).toMatch(/call i1 %\d+\(i32 %\d+, i8\* %\d+\)/);
    });
});

// ── Runtime behaviour ─────────────────────────────────────────────────────────

describe('higher-order functions — runtime', () => {
    function lines(): string[] {
        const { stdout } = compileAndRun(FIXTURE);
        return stdout.trim().split('\n');
    }

    // ── 1. apply with named function references ───────────────────────────────
    it('apply(double, 5) == 10', () => {
        expect(lines()[0]).toBe('10');
    });

    it('apply(square, 5) == 25', () => {
        expect(lines()[1]).toBe('25');
    });

    // ── 2. lambda as first-class value ────────────────────────────────────────
    it('apply(triple, 4) == 12 — lambda stored in const', () => {
        expect(lines()[2]).toBe('12');
    });

    // ── 3. call through variable ──────────────────────────────────────────────
    it('op(7) == 14 — named fn ref stored in variable', () => {
        expect(lines()[3]).toBe('14');
    });

    // ── 4. compose ────────────────────────────────────────────────────────────
    it('doubleThenSquare(3) == 36 — compose(square, double)(3)', () => {
        expect(lines()[4]).toBe('36');
    });

    it('squareThenDouble(3) == 18 — compose(double, square)(3)', () => {
        expect(lines()[5]).toBe('18');
    });

    // ── 5. map ────────────────────────────────────────────────────────────────
    it('map(nums, double) == [2, 4, 6, 8, 10]', () => {
        expect(lines()[6]).toBe('[2, 4, 6, 8, 10]');
    });

    it('map(nums, square) == [1, 4, 9, 16, 25]', () => {
        expect(lines()[7]).toBe('[1, 4, 9, 16, 25]');
    });

    it('map(nums, inline lambda x+1) == [2, 3, 4, 5, 6]', () => {
        expect(lines()[8]).toBe('[2, 3, 4, 5, 6]');
    });

    // ── 6. filter ─────────────────────────────────────────────────────────────
    it('filter(nums, isEven) == [2, 4]', () => {
        expect(lines()[9]).toBe('[2, 4]');
    });

    it('filter(nums, inline odd predicate) == [1, 3, 5]', () => {
        expect(lines()[10]).toBe('[1, 3, 5]');
    });

    // ── 7. reduce ─────────────────────────────────────────────────────────────
    it('reduce(nums, add, 0) == 15', () => {
        expect(lines()[11]).toBe('15');
    });

    it('reduce(nums, mul, 1) == 120', () => {
        expect(lines()[12]).toBe('120');
    });

    // ── 8. partial application (makeAdder) ────────────────────────────────────
    it('add5(3) == 8 — closure captures n=5', () => {
        expect(lines()[13]).toBe('8');
    });

    it('add5(10) == 15 — same closure reused', () => {
        expect(lines()[14]).toBe('15');
    });

    it('times3(4) == 12 — makeMultiplier closure', () => {
        expect(lines()[15]).toBe('12');
    });

    // ── 9. independent closures capture different values ──────────────────────
    it('add1(0) == 1 — independent closure with n=1', () => {
        expect(lines()[16]).toBe('1');
    });

    it('add100(0) == 100 — independent closure with n=100', () => {
        expect(lines()[17]).toBe('100');
    });

    // ── 10. clamp: closure over two captured variables ────────────────────────
    it('clamp0to10(-5) == 0 — below lower bound', () => {
        expect(lines()[18]).toBe('0');
    });

    it('clamp0to10(5) == 5 — within range', () => {
        expect(lines()[19]).toBe('5');
    });

    it('clamp0to10(99) == 10 — above upper bound', () => {
        expect(lines()[20]).toBe('10');
    });

    // ── 11. pipeline: filter → map → reduce ──────────────────────────────────
    it('reduce(map(filter(values, isEven), square), add, 0) == 220', () => {
        // [1..10] → filter even → [2,4,6,8,10] → square → [4,16,36,64,100] → sum = 220
        expect(lines()[21]).toBe('220');
    });

    // ── general ───────────────────────────────────────────────────────────────
    it('produces exactly 22 lines of output', () => {
        expect(lines()).toHaveLength(22);
    });

    it('exits with code 0', () => {
        const { exitCode } = compileAndRun(FIXTURE);
        expect(exitCode).toBe(0);
    });
});

// ── Purity enforcement ────────────────────────────────────────────────────────

describe('higher-order functions — const fn purity', () => {
    it('lambda in regular fn that captures outer var compiles fine', () => {
        // makeAdder, makeMultiplier, clamp — all closures inside regular fns
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/%__lambda_\d+_env = type \{ i32 \}/);
    });
});

// ── Array literal syntax ──────────────────────────────────────────────────────

describe('higher-order functions — array literal syntax', () => {
    it('[1, 2, 3, 4, 5] emits intarray_new + push calls', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/call %IntArray\* @intarray_new\(\)/);
        expect(ir).toMatch(/call void @IntArray_push/);
    });

    it('array literal produces correct elements via runtime', () => {
        // Indirectly verified: map/filter/reduce all operate on [1,2,3,4,5]
        // and produce correct results checked above.
        const { stdout } = compileAndRun(FIXTURE);
        expect(stdout).toContain('[2, 4, 6, 8, 10]');
    });
});

// ── Comparison operators in expression context ────────────────────────────────

describe('higher-order functions — comparison as expression', () => {
    it('x % 2 == 0 compiles to icmp instruction in expression position', () => {
        const { ir } = compileToIR(FIXTURE);
        // isEven uses == in return statement → BinaryExpr comparison
        expect(ir).toMatch(/icmp eq i32/);
    });

    it('x % 2 != 0 compiles to icmp ne instruction', () => {
        const { ir } = compileToIR(FIXTURE);
        // inline odd predicate `x % 2 != 0` — int type uses icmp ne directly
        expect(ir).toMatch(/icmp ne i32/);
    });
});
