/**
 * Array-type-syntax tests.
 *
 * Exercises the new array shorthand notation in struct field declarations:
 *
 *   data: int[]                             — dynamic array (sugar for IntArray)
 *   data: string[]                          — dynamic string array (sugar for StringArray)
 *   data: int[N]                            — fixed-size embedded array ([N x i32])
 *   const data: int[N]                      — read-only fixed-size array (zero-initialised)
 *   const data: int[N; v0,...] = [v0,...]   — value-typed fixed array
 *
 * Each case verifies both runtime behaviour and LLVM IR structure where relevant.
 */

import { describe, it, expect } from 'vitest';
import { compileAndRun, compileToIR, compileExpectError } from './helpers/cli.js';

// ── Dynamic array shorthand — int[] ──────────────────────────────────────────

describe('array type syntax — int[] (dynamic)', () => {
    it('int[] field compiles and the struct behaves like IntArray', () => {
        const { exitCode, stdout } = compileAndRun('array_type_dynamic.code');
        expect(exitCode).toBe(0);
        expect(stdout).toBe('3\n');
    });

    it('int[] field emits %IntArray* in the struct LLVM type', () => {
        const { ir } = compileToIR('array_type_dynamic.code');
        // The Stack struct should have an IntArray* field
        expect(ir).toMatch(/%Stack = type \{ %IntArray\*/);
    });

    it('string[] field emits %StringArray* in the struct LLVM type', () => {
        const { ir } = compileToIR('array_type_string_dynamic.code');
        expect(ir).toMatch(/%Messages = type \{ %StringArray\*/);
    });

    it('string[] struct works at runtime (push and length)', () => {
        const { exitCode, stdout } = compileAndRun('array_type_string_dynamic.code');
        expect(exitCode).toBe(0);
        expect(stdout).toBe('2\n');
    });
});

// ── Fixed-size array — int[N] ─────────────────────────────────────────────────

describe('array type syntax — int[N] (fixed-size)', () => {
    it('int[N] field compiles and struct methods work correctly', () => {
        const { exitCode, stdout } = compileAndRun('array_type_fixed.code');
        expect(exitCode).toBe(0);
        expect(stdout).toBe('4\n');
    });

    it('int[N] field emits [N x i32] in the struct LLVM type', () => {
        const { ir } = compileToIR('array_type_fixed.code');
        expect(ir).toMatch(/%FixedBuffer = type \{ \[4 x i32\]/);
    });

    it('unspecified int[N] field is zero-initialised in a struct literal', () => {
        const { ir } = compileToIR('array_type_fixed.code');
        // The struct literal Self { capacity: 4 } should store zeroinitializer for the array
        expect(ir).toMatch(/store \[4 x i32\] zeroinitializer/);
    });

    it('int[1] edge case: emits [1 x i32] in the struct LLVM type', () => {
        const { ir } = compileToIR('array_type_size1.code');
        expect(ir).toMatch(/%Single = type \{ \[1 x i32\]/);
    });

    it('int[1] edge case: struct compiles and runtime works correctly', () => {
        const { exitCode, stdout } = compileAndRun('array_type_size1.code');
        expect(exitCode).toBe(0);
        expect(stdout).toBe('99\n');
    });

    it('struct with two fixed-size array fields has both arrays in the LLVM type', () => {
        const { ir } = compileToIR('array_type_two_arrays.code');
        expect(ir).toMatch(/%Pair = type \{ \[3 x i32\], \[4 x i32\]/);
    });

    it('struct with two fixed-size array fields compiles and runs correctly', () => {
        const { exitCode, stdout } = compileAndRun('array_type_two_arrays.code');
        expect(exitCode).toBe(0);
        expect(stdout).toBe('7\n');
    });

    it('GEP to non-array fields is correct when array fields precede them (multi-field)', () => {
        const { ir } = compileToIR('array_type_multi_field.code');
        // Stats struct: data[5] at index 0, count at index 1, total at index 2
        expect(ir).toMatch(/%Stats = type \{ \[5 x i32\]/);
    });

    it('multi-field struct: getCount and getTotal return correct values at runtime', () => {
        const { exitCode, stdout } = compileAndRun('array_type_multi_field.code');
        expect(exitCode).toBe(0);
        expect(stdout).toBe('3\n60\n');
    });

    it('auto-generated constructor excludes array params from its signature', () => {
        const { ir } = compileToIR('array_type_auto_constructor.code');
        // Ring struct has data: int[8], head: int, tail: int
        expect(ir).toMatch(/%Ring = type \{ \[8 x i32\]/);
    });

    it('struct with auto-generated constructor (no explicit new) works at runtime', () => {
        const { exitCode, stdout } = compileAndRun('array_type_auto_constructor.code');
        expect(exitCode).toBe(0);
        expect(stdout).toBe('0\n');
    });
});

// ── Const fixed-size array — const int[N] ────────────────────────────────────

describe('array type syntax — const int[N] (read-only fixed-size)', () => {
    it('const int[N] field compiles and non-array fields work', () => {
        const { exitCode, stdout } = compileAndRun('array_type_const_fixed.code');
        expect(exitCode).toBe(0);
        expect(stdout).toBe('42\n');
    });

    it('const int[N] field emits [N x i32] in the struct LLVM type', () => {
        const { ir } = compileToIR('array_type_const_fixed.code');
        expect(ir).toMatch(/%Counters = type \{ \[3 x i32\]/);
    });

    it('const int[N] without initializer uses zeroinitializer', () => {
        const { ir } = compileToIR('array_type_const_fixed.code');
        expect(ir).toMatch(/store \[3 x i32\] zeroinitializer/);
    });
});

// ── Value-typed fixed array — const int[N; v,...] = [...] ────────────────────

describe('array type syntax — const int[N; v,...] = [...] (value-typed)', () => {
    it('value-typed array field compiles and runtime is correct', () => {
        const { exitCode, stdout } = compileAndRun('array_type_value_typed.code');
        expect(exitCode).toBe(0);
        expect(stdout).toBe('7\n');
    });

    it('value-typed array field stores the declared values in the IR', () => {
        const { ir } = compileToIR('array_type_value_typed.code');
        // The struct literal should store the declared values [10, 20, 30]
        expect(ir).toMatch(/store \[3 x i32\] \[i32 10, i32 20, i32 30\]/);
    });

    it('large value-typed array (5 elements, powers of 2) compiles and runs correctly', () => {
        const { exitCode, stdout } = compileAndRun('array_type_value_large.code');
        expect(exitCode).toBe(0);
        expect(stdout).toBe('42\n');
    });

    it('large value-typed array stores all 5 power-of-2 values in the IR', () => {
        const { ir } = compileToIR('array_type_value_large.code');
        expect(ir).toMatch(/store \[5 x i32\] \[i32 1, i32 2, i32 4, i32 8, i32 16\]/);
    });
});

// ── Error cases ───────────────────────────────────────────────────────────────

describe('array type syntax — error cases', () => {
    it('count mismatch: exits with code 1', () => {
        const result = compileExpectError('array_type_count_mismatch.code');
        expect(result.exitCode).toBe(1);
    });

    it('count mismatch: error message reports the sizes', () => {
        const result = compileExpectError('array_type_count_mismatch.code');
        // e.g. "type specifies 3 values but initializer has 2"
        expect(result.stderr).toMatch(/specifies \d+ values but initializer has \d+/i);
    });

    it('missing initializer: exits with code 1', () => {
        const result = compileExpectError('array_type_missing_init.code');
        expect(result.exitCode).toBe(1);
    });

    it('missing initializer: error message mentions initializer', () => {
        const result = compileExpectError('array_type_missing_init.code');
        expect(result.stderr).toMatch(/initializer/i);
    });

    it('non-const with typeValues: exits with code 1', () => {
        const result = compileExpectError('array_type_non_const_typevals.code');
        expect(result.exitCode).toBe(1);
    });

    it('non-const with typeValues: error message mentions const', () => {
        const result = compileExpectError('array_type_non_const_typevals.code');
        expect(result.stderr).toMatch(/const/i);
    });

    it('value mismatch: exits with code 1', () => {
        const result = compileExpectError('array_type_value_mismatch.code');
        expect(result.exitCode).toBe(1);
    });

    it('value mismatch: error message mentions mismatch', () => {
        const result = compileExpectError('array_type_value_mismatch.code');
        expect(result.stderr).toMatch(/mismatch/i);
    });
});
