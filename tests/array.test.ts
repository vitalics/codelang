/**
 * Tests for stdlib/array.code — IntArray
 *
 * Covers four layers:
 *  1. IR structure  — %IntArray = type opaque, declare signatures
 *  2. Basic access  — new, with, length, get, at, set, first, last
 *  3. Mutation      — push, pop, unshift, shift, fill, reverse, sort
 *  4. Search        — indexOf, lastIndexOf, includes
 *  5. Extraction    — slice, sliceFrom, clone, concat
 *  6. Output        — print (intarray_print dispatch), toString, join
 *  7. Disposable    — using / auto-dispose
 *
 * All fixtures live in tests/fixtures/valid/.
 */

import { describe, it, expect } from 'vitest';
import { compileToIR, compileAndRun } from './helpers/cli.js';

// ── Fixture names ─────────────────────────────────────────────────────────────

const BASIC   = 'array_basic.code';
const MUTATE  = 'array_mutation.code';
const SEARCH  = 'array_search.code';
const SLICE   = 'array_slice.code';
const PRINT   = 'array_print.code';
const DISPOSE = 'array_dispose.code';
const IR      = 'array_ir.code';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Split stdout into trimmed, non-empty lines. */
function lines(stdout: string): string[] {
    return stdout.trim().split('\n');
}

// =============================================================================
// 1. IR — opaque type declaration and extern signatures
// =============================================================================

describe('IntArray — IR structure', () => {

    it('emits %IntArray = type opaque forward declaration', () => {
        const { ir } = compileToIR(IR);
        expect(ir).toContain('%IntArray = type opaque');
    });

    it('declares intarray_new  : %IntArray* ()', () => {
        const { ir } = compileToIR(IR);
        expect(ir).toContain('declare %IntArray* @intarray_new()');
    });

    it('declares intarray_with  : %IntArray* (i32, i32)', () => {
        const { ir } = compileToIR(BASIC);
        expect(ir).toContain('declare %IntArray* @intarray_with(i32, i32)');
    });

    it('declares intarray_free  : void (%IntArray*)', () => {
        const { ir } = compileToIR(IR);
        expect(ir).toContain('declare void @intarray_free(%IntArray*)');
    });

    it('declares intarray_length : i32 (%IntArray*)', () => {
        const { ir } = compileToIR(IR);
        expect(ir).toContain('declare i32 @intarray_length(%IntArray*)');
    });

    it('declares intarray_get   : i32 (%IntArray*, i32)', () => {
        const { ir } = compileToIR(IR);
        expect(ir).toContain('declare i32 @intarray_get(%IntArray*, i32)');
    });

    it('declares intarray_at    : i32 (%IntArray*, i32)', () => {
        const { ir } = compileToIR(BASIC);
        expect(ir).toContain('declare i32 @intarray_at(%IntArray*, i32)');
    });

    it('declares intarray_set   : void (%IntArray*, i32, i32)', () => {
        const { ir } = compileToIR(BASIC);
        expect(ir).toContain('declare void @intarray_set(%IntArray*, i32, i32)');
    });

    it('declares intarray_push  : void (%IntArray*, i32)', () => {
        const { ir } = compileToIR(IR);
        expect(ir).toContain('declare void @intarray_push(%IntArray*, i32)');
    });

    it('declares intarray_pop   : i32 (%IntArray*)', () => {
        const { ir } = compileToIR(MUTATE);
        expect(ir).toContain('declare i32 @intarray_pop(%IntArray*)');
    });

    it('declares intarray_sort  : void (%IntArray*)', () => {
        const { ir } = compileToIR(MUTATE);
        expect(ir).toContain('declare void @intarray_sort(%IntArray*)');
    });

    it('declares intarray_reverse : void (%IntArray*)', () => {
        const { ir } = compileToIR(MUTATE);
        expect(ir).toContain('declare void @intarray_reverse(%IntArray*)');
    });

    it('declares intarray_index_of      : i32 (%IntArray*, i32)', () => {
        const { ir } = compileToIR(SEARCH);
        expect(ir).toContain('declare i32 @intarray_index_of(%IntArray*, i32)');
    });

    it('declares intarray_last_index_of : i32 (%IntArray*, i32)', () => {
        const { ir } = compileToIR(SEARCH);
        expect(ir).toContain('declare i32 @intarray_last_index_of(%IntArray*, i32)');
    });

    it('declares intarray_slice     : %IntArray* (%IntArray*, i32, i32)', () => {
        const { ir } = compileToIR(SLICE);
        expect(ir).toContain('declare %IntArray* @intarray_slice(%IntArray*, i32, i32)');
    });

    it('declares intarray_concat    : %IntArray* (%IntArray*, %IntArray*)', () => {
        const { ir } = compileToIR(SLICE);
        expect(ir).toContain('declare %IntArray* @intarray_concat(%IntArray*, %IntArray*)');
    });

    it('declares intarray_to_string : i8* (%IntArray*)', () => {
        const { ir } = compileToIR(PRINT);
        expect(ir).toContain('declare i8* @intarray_to_string(%IntArray*)');
    });

    it('declares intarray_join      : i8* (%IntArray*, i8*)', () => {
        const { ir } = compileToIR(PRINT);
        expect(ir).toContain('declare i8* @intarray_join(%IntArray*, i8*)');
    });

    it('IR: intarray_new is called to construct an empty array', () => {
        const { ir } = compileToIR(IR);
        expect(ir).toMatch(/call %IntArray\* @intarray_new\(\)/);
    });

    it('IR: intarray_push is called with (%IntArray*, i32)', () => {
        const { ir } = compileToIR(IR);
        expect(ir).toMatch(/call void @intarray_push\(%IntArray\* .+, i32 .+\)/);
    });

    it('IR: intarray_length returns i32', () => {
        const { ir } = compileToIR(IR);
        expect(ir).toMatch(/call i32 @intarray_length\(%IntArray\*/);
    });
});

// =============================================================================
// 2. Basic access (runtime)
// =============================================================================

describe('IntArray — basic access (runtime)', () => {

    it('length() of [10, 20, 30] is 3', () => {
        const { stdout } = compileAndRun(BASIC);
        expect(lines(stdout)[0]).toBe('3');
    });

    it('get(0) returns first element', () => {
        const { stdout } = compileAndRun(BASIC);
        expect(lines(stdout)[1]).toBe('10');
    });

    it('get(1) returns second element', () => {
        const { stdout } = compileAndRun(BASIC);
        expect(lines(stdout)[2]).toBe('20');
    });

    it('get(2) returns last element', () => {
        const { stdout } = compileAndRun(BASIC);
        expect(lines(stdout)[3]).toBe('30');
    });

    it('at(0) is the same as get(0)', () => {
        const { stdout } = compileAndRun(BASIC);
        expect(lines(stdout)[4]).toBe('10');
    });

    it('at(-1) returns the last element (negative index)', () => {
        const { stdout } = compileAndRun(BASIC);
        expect(lines(stdout)[5]).toBe('30');
    });

    it('at(-2) returns the second-to-last element', () => {
        const { stdout } = compileAndRun(BASIC);
        expect(lines(stdout)[6]).toBe('20');
    });

    it('first() returns the first element', () => {
        const { stdout } = compileAndRun(BASIC);
        expect(lines(stdout)[7]).toBe('10');
    });

    it('last() returns the last element', () => {
        const { stdout } = compileAndRun(BASIC);
        expect(lines(stdout)[8]).toBe('30');
    });

    it('IntArray.with(5, 7) creates an array of 5 sevens', () => {
        const { stdout } = compileAndRun(BASIC);
        expect(lines(stdout)[9]).toBe('5');   // length
        expect(lines(stdout)[10]).toBe('7');  // first element
        expect(lines(stdout)[11]).toBe('7');  // last element
    });

    it('set(2, 99) mutates the element at index 2', () => {
        const { stdout } = compileAndRun(BASIC);
        expect(lines(stdout)[12]).toBe('99');
    });

    it('exits with code 0', () => {
        const { exitCode } = compileAndRun(BASIC);
        expect(exitCode).toBe(0);
    });

    it('produces exactly 13 lines of output', () => {
        const { stdout } = compileAndRun(BASIC);
        expect(lines(stdout)).toHaveLength(13);
    });
});

// =============================================================================
// 3. Mutation (runtime)
// =============================================================================

describe('IntArray — mutation (runtime)', () => {

    it('pop() returns and removes the last element', () => {
        const { stdout } = compileAndRun(MUTATE);
        expect(lines(stdout)[0]).toBe('5');   // popped value
        expect(lines(stdout)[1]).toBe('4');   // new length
    });

    it('unshift(0) prepends an element (O(n))', () => {
        const { stdout } = compileAndRun(MUTATE);
        expect(lines(stdout)[2]).toBe('0');   // new first element
        expect(lines(stdout)[3]).toBe('5');   // new length
    });

    it('shift() removes and returns the first element', () => {
        const { stdout } = compileAndRun(MUTATE);
        expect(lines(stdout)[4]).toBe('0');   // removed value
        expect(lines(stdout)[5]).toBe('4');   // new length
    });

    it('fill(42) sets every element to 42', () => {
        const { stdout } = compileAndRun(MUTATE);
        expect(lines(stdout)[6]).toBe('42');  // element 0
        expect(lines(stdout)[7]).toBe('42');  // element 3
    });

    it('reverse() reverses the array in-place', () => {
        const { stdout } = compileAndRun(MUTATE);
        expect(lines(stdout)[8]).toBe('3');   // was last (before reverse)
        expect(lines(stdout)[9]).toBe('1');   // was first (before reverse)
    });

    it('sort() sorts in ascending order', () => {
        const { stdout } = compileAndRun(MUTATE);
        expect(lines(stdout)[10]).toBe('1');
        expect(lines(stdout)[11]).toBe('2');
        expect(lines(stdout)[12]).toBe('5');
        expect(lines(stdout)[13]).toBe('8');
    });

    it('exits with code 0', () => {
        const { exitCode } = compileAndRun(MUTATE);
        expect(exitCode).toBe(0);
    });
});

// =============================================================================
// 4. Search (runtime)
// =============================================================================

describe('IntArray — search (runtime)', () => {

    it('indexOf(20) returns 1 for [10,20,30,20,40]', () => {
        const { stdout } = compileAndRun(SEARCH);
        expect(lines(stdout)[0]).toBe('1');
    });

    it('indexOf(99) returns -1 when element is absent', () => {
        const { stdout } = compileAndRun(SEARCH);
        expect(lines(stdout)[1]).toBe('-1');
    });

    it('lastIndexOf(20) returns 3 (last occurrence)', () => {
        const { stdout } = compileAndRun(SEARCH);
        expect(lines(stdout)[2]).toBe('3');
    });

    it('lastIndexOf(10) returns 0 (only occurrence at start)', () => {
        const { stdout } = compileAndRun(SEARCH);
        expect(lines(stdout)[3]).toBe('0');
    });

    it('includes(20) is true (prints 1)', () => {
        const { stdout } = compileAndRun(SEARCH);
        expect(lines(stdout)[4]).toBe('1');
    });

    it('includes(99) is false (prints 0)', () => {
        const { stdout } = compileAndRun(SEARCH);
        expect(lines(stdout)[5]).toBe('0');
    });

    it('exits with code 0', () => {
        const { exitCode } = compileAndRun(SEARCH);
        expect(exitCode).toBe(0);
    });
});

// =============================================================================
// 5. Slice, clone, concat (runtime)
// =============================================================================

describe('IntArray — slice / clone / concat (runtime)', () => {

    it('slice(1, 4) of [1..5] has length 3', () => {
        const { stdout } = compileAndRun(SLICE);
        expect(lines(stdout)[0]).toBe('3');
    });

    it('slice(1, 4)[0] == 2', () => {
        const { stdout } = compileAndRun(SLICE);
        expect(lines(stdout)[1]).toBe('2');
    });

    it('slice(1, 4)[2] == 4', () => {
        const { stdout } = compileAndRun(SLICE);
        expect(lines(stdout)[3]).toBe('4');
    });

    it('slice(-3, -1) with negative indices works', () => {
        const { stdout } = compileAndRun(SLICE);
        expect(lines(stdout)[4]).toBe('2');   // length
        expect(lines(stdout)[5]).toBe('3');   // [0]
        expect(lines(stdout)[6]).toBe('4');   // [1]
    });

    it('sliceFrom(3) returns elements from index 3 to end', () => {
        const { stdout } = compileAndRun(SLICE);
        expect(lines(stdout)[7]).toBe('2');   // length = 2
        expect(lines(stdout)[8]).toBe('4');   // [0]
        expect(lines(stdout)[9]).toBe('5');   // [1]
    });

    it('clone() produces a full copy with same length and elements', () => {
        const { stdout } = compileAndRun(SLICE);
        expect(lines(stdout)[10]).toBe('5');  // length
        expect(lines(stdout)[11]).toBe('1');  // first
        expect(lines(stdout)[12]).toBe('5');  // last
    });

    it('concat(b) produces [a ++ b] with combined length', () => {
        const { stdout } = compileAndRun(SLICE);
        expect(lines(stdout)[13]).toBe('7');  // 5 + 2
    });

    it('concat(b)[5] == first element of b', () => {
        const { stdout } = compileAndRun(SLICE);
        expect(lines(stdout)[14]).toBe('6');
    });

    it('concat(b)[6] == second element of b', () => {
        const { stdout } = compileAndRun(SLICE);
        expect(lines(stdout)[15]).toBe('7');
    });

    it('exits with code 0', () => {
        const { exitCode } = compileAndRun(SLICE);
        expect(exitCode).toBe(0);
    });
});

// =============================================================================
// 6. Output — print, toString, join (runtime)
// =============================================================================

describe('IntArray — output (runtime)', () => {

    it('print(emptyArray) outputs "[]"', () => {
        const { stdout } = compileAndRun(PRINT);
        expect(lines(stdout)[0]).toBe('[]');
    });

    it('print([1, 2, 3]) outputs "[1, 2, 3]"', () => {
        const { stdout } = compileAndRun(PRINT);
        expect(lines(stdout)[1]).toBe('[1, 2, 3]');
    });

    it('toString() returns "[1, 2, 3]"', () => {
        const { stdout } = compileAndRun(PRINT);
        expect(lines(stdout)[2]).toBe('[1, 2, 3]');
    });

    it('join(", ") returns "1, 2, 3"', () => {
        const { stdout } = compileAndRun(PRINT);
        expect(lines(stdout)[3]).toBe('1, 2, 3');
    });

    it('join("-") returns "1-2-3"', () => {
        const { stdout } = compileAndRun(PRINT);
        expect(lines(stdout)[4]).toBe('1-2-3');
    });

    it('produces exactly 5 lines of output', () => {
        const { stdout } = compileAndRun(PRINT);
        expect(lines(stdout)).toHaveLength(5);
    });

    it('exits with code 0', () => {
        const { exitCode } = compileAndRun(PRINT);
        expect(exitCode).toBe(0);
    });

    it('IR: print(intArray) uses intarray_print call', () => {
        const { ir } = compileToIR(PRINT);
        expect(ir).toMatch(/call void @intarray_print\(%IntArray\*/);
    });
});

// =============================================================================
// 7. Disposable — using / auto-dispose (runtime)
// =============================================================================

describe('IntArray — Disposable / using (runtime)', () => {

    it('using array has the correct length', () => {
        const { stdout } = compileAndRun(DISPOSE);
        expect(lines(stdout)[0]).toBe('3');
    });

    it('using array.first() returns the fill value', () => {
        const { stdout } = compileAndRun(DISPOSE);
        expect(lines(stdout)[1]).toBe('5');
    });

    it('using array.last() returns the fill value', () => {
        const { stdout } = compileAndRun(DISPOSE);
        expect(lines(stdout)[2]).toBe('5');
    });

    it('push into using-managed array increases length', () => {
        const { stdout } = compileAndRun(DISPOSE);
        expect(lines(stdout)[3]).toBe('4');
    });

    it('last element after push is the pushed value', () => {
        const { stdout } = compileAndRun(DISPOSE);
        expect(lines(stdout)[4]).toBe('10');
    });

    it('exits with code 0 (no double-free crash)', () => {
        const { exitCode } = compileAndRun(DISPOSE);
        expect(exitCode).toBe(0);
    });

    it('IR: dispose call emits intarray_free via Disposable', () => {
        const { ir } = compileToIR(DISPOSE);
        expect(ir).toMatch(/call void @intarray_free\(%IntArray\*/);
    });
});
