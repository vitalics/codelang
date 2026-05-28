/**
 * Tests for StringArray (stdlib/array.code)
 *
 * Covers:
 *  1. IR structure  — %StringArray = type opaque, declare signatures
 *  2. Basic access  — new, with, length, get, at, set, first, last
 *  3. Mutation      — push, pop, unshift, shift, fill, reverse, sort
 *  4. Search        — indexOf, lastIndexOf, includes
 *  5. Extraction    — slice, sliceFrom, clone, concat
 *  6. Output        — print (stringarray_print), toString, join
 *  7. Disposable    — using / auto-dispose
 */

import { describe, it, expect } from 'vitest';
import { compileToIR, compileAndRun } from './helpers/cli.js';

const BASIC   = 'string_array_basic.code';
const MUTATE  = 'string_array_mutation.code';
const SEARCH  = 'string_array_search.code';
const SLICE   = 'string_array_slice.code';
const PRINT   = 'string_array_print.code';
const DISPOSE = 'string_array_dispose.code';
const IR      = 'string_array_ir.code';

function lines(stdout: string): string[] {
    return stdout.trim().split('\n');
}

// =============================================================================
// 1. IR — opaque type and extern signatures
// =============================================================================

describe('StringArray — IR structure', () => {

    it('emits %StringArray = type opaque forward declaration', () => {
        const { ir } = compileToIR(IR);
        expect(ir).toContain('%StringArray = type opaque');
    });

    it('declares stringarray_new    : %StringArray* ()', () => {
        const { ir } = compileToIR(IR);
        expect(ir).toContain('declare %StringArray* @stringarray_new()');
    });

    it('declares stringarray_with   : %StringArray* (i8*, i8*) — (n as i32, v as i8*)', () => {
        const { ir } = compileToIR(BASIC);
        // n: int → i32, v: string → i8*
        expect(ir).toContain('declare %StringArray* @stringarray_with(i32, i8*)');
    });

    it('declares stringarray_free   : void (%StringArray*)', () => {
        const { ir } = compileToIR(IR);
        expect(ir).toContain('declare void @stringarray_free(%StringArray*)');
    });

    it('declares stringarray_length : i32 (%StringArray*)', () => {
        const { ir } = compileToIR(IR);
        expect(ir).toContain('declare i32 @stringarray_length(%StringArray*)');
    });

    it('declares stringarray_get    : i8* (%StringArray*, i32)', () => {
        const { ir } = compileToIR(IR);
        expect(ir).toContain('declare i8* @stringarray_get(%StringArray*, i32)');
    });

    it('declares stringarray_at     : i8* (%StringArray*, i32)', () => {
        const { ir } = compileToIR(BASIC);
        expect(ir).toContain('declare i8* @stringarray_at(%StringArray*, i32)');
    });

    it('declares stringarray_set    : void (%StringArray*, i32, i8*)', () => {
        const { ir } = compileToIR(BASIC);
        expect(ir).toContain('declare void @stringarray_set(%StringArray*, i32, i8*)');
    });

    it('declares stringarray_push   : void (%StringArray*, i8*)', () => {
        const { ir } = compileToIR(IR);
        expect(ir).toContain('declare void @stringarray_push(%StringArray*, i8*)');
    });

    it('declares stringarray_pop    : i8* (%StringArray*)', () => {
        const { ir } = compileToIR(MUTATE);
        expect(ir).toContain('declare i8* @stringarray_pop(%StringArray*)');
    });

    it('declares stringarray_reverse : void (%StringArray*)', () => {
        const { ir } = compileToIR(MUTATE);
        expect(ir).toContain('declare void @stringarray_reverse(%StringArray*)');
    });

    it('declares stringarray_sort    : void (%StringArray*)', () => {
        const { ir } = compileToIR(MUTATE);
        expect(ir).toContain('declare void @stringarray_sort(%StringArray*)');
    });

    it('declares stringarray_index_of      : i32 (%StringArray*, i8*)', () => {
        const { ir } = compileToIR(SEARCH);
        expect(ir).toContain('declare i32 @stringarray_index_of(%StringArray*, i8*)');
    });

    it('declares stringarray_last_index_of : i32 (%StringArray*, i8*)', () => {
        const { ir } = compileToIR(SEARCH);
        expect(ir).toContain('declare i32 @stringarray_last_index_of(%StringArray*, i8*)');
    });

    it('declares stringarray_slice  : %StringArray* (%StringArray*, i32, i32)', () => {
        const { ir } = compileToIR(SLICE);
        expect(ir).toContain('declare %StringArray* @stringarray_slice(%StringArray*, i32, i32)');
    });

    it('declares stringarray_concat : %StringArray* (%StringArray*, %StringArray*)', () => {
        const { ir } = compileToIR(SLICE);
        expect(ir).toContain('declare %StringArray* @stringarray_concat(%StringArray*, %StringArray*)');
    });

    it('declares stringarray_join      : i8* (%StringArray*, i8*)', () => {
        const { ir } = compileToIR(PRINT);
        expect(ir).toContain('declare i8* @stringarray_join(%StringArray*, i8*)');
    });

    it('declares stringarray_to_string : i8* (%StringArray*)', () => {
        const { ir } = compileToIR(PRINT);
        expect(ir).toContain('declare i8* @stringarray_to_string(%StringArray*)');
    });

    it('IR: stringarray_new is called to construct an empty array', () => {
        const { ir } = compileToIR(IR);
        expect(ir).toMatch(/call %StringArray\* @stringarray_new\(\)/);
    });

    it('IR: stringarray_push takes (%StringArray*, i8*)', () => {
        const { ir } = compileToIR(IR);
        expect(ir).toMatch(/call void @stringarray_push\(%StringArray\* .+, i8\* .+\)/);
    });

    it('IR: stringarray_length returns i32', () => {
        const { ir } = compileToIR(IR);
        expect(ir).toMatch(/call i32 @stringarray_length\(%StringArray\*/);
    });
});

// =============================================================================
// 2. Basic access (runtime)
// =============================================================================

describe('StringArray — basic access (runtime)', () => {

    it('length() of ["apple","banana","cherry"] is 3', () => {
        const { stdout } = compileAndRun(BASIC);
        expect(lines(stdout)[0]).toBe('3');
    });

    it('get(0) returns "apple"', () => {
        const { stdout } = compileAndRun(BASIC);
        expect(lines(stdout)[1]).toBe('apple');
    });

    it('get(1) returns "banana"', () => {
        const { stdout } = compileAndRun(BASIC);
        expect(lines(stdout)[2]).toBe('banana');
    });

    it('get(2) returns "cherry"', () => {
        const { stdout } = compileAndRun(BASIC);
        expect(lines(stdout)[3]).toBe('cherry');
    });

    it('at(0) equals get(0)', () => {
        const { stdout } = compileAndRun(BASIC);
        expect(lines(stdout)[4]).toBe('apple');
    });

    it('at(-1) returns the last element', () => {
        const { stdout } = compileAndRun(BASIC);
        expect(lines(stdout)[5]).toBe('cherry');
    });

    it('at(-2) returns second-to-last', () => {
        const { stdout } = compileAndRun(BASIC);
        expect(lines(stdout)[6]).toBe('banana');
    });

    it('first() returns the first element', () => {
        const { stdout } = compileAndRun(BASIC);
        expect(lines(stdout)[7]).toBe('apple');
    });

    it('last() returns the last element', () => {
        const { stdout } = compileAndRun(BASIC);
        expect(lines(stdout)[8]).toBe('cherry');
    });

    it('StringArray.with(3, "hi") creates 3 elements all equal to "hi"', () => {
        const { stdout } = compileAndRun(BASIC);
        expect(lines(stdout)[9]).toBe('3');   // length
        expect(lines(stdout)[10]).toBe('hi'); // get(0)
        expect(lines(stdout)[11]).toBe('hi'); // get(2)
    });

    it('set(1, "bye") mutates the element', () => {
        const { stdout } = compileAndRun(BASIC);
        expect(lines(stdout)[12]).toBe('bye');
    });

    it('exits with code 0', () => {
        expect(compileAndRun(BASIC).exitCode).toBe(0);
    });

    it('produces exactly 13 lines of output', () => {
        expect(lines(compileAndRun(BASIC).stdout)).toHaveLength(13);
    });
});

// =============================================================================
// 3. Mutation (runtime)
// =============================================================================

describe('StringArray — mutation (runtime)', () => {

    it('pop() returns "b" and reduces length to 2', () => {
        const { stdout } = compileAndRun(MUTATE);
        expect(lines(stdout)[0]).toBe('b');
        expect(lines(stdout)[1]).toBe('2');
    });

    it('unshift("z") prepends, first element becomes "z"', () => {
        const { stdout } = compileAndRun(MUTATE);
        expect(lines(stdout)[2]).toBe('z');
        expect(lines(stdout)[3]).toBe('3');
    });

    it('shift() removes and returns "z"', () => {
        const { stdout } = compileAndRun(MUTATE);
        expect(lines(stdout)[4]).toBe('z');
        expect(lines(stdout)[5]).toBe('2');
    });

    it('fill("x") sets all elements to "x"', () => {
        const { stdout } = compileAndRun(MUTATE);
        expect(lines(stdout)[6]).toBe('x');
        expect(lines(stdout)[7]).toBe('x');
    });

    it('reverse() reverses ["one","two","three"] → ["three","two","one"]', () => {
        const { stdout } = compileAndRun(MUTATE);
        expect(lines(stdout)[8]).toBe('three');
        expect(lines(stdout)[9]).toBe('one');
    });

    it('sort() sorts ["banana","apple","cherry"] alphabetically', () => {
        const { stdout } = compileAndRun(MUTATE);
        expect(lines(stdout)[10]).toBe('apple');
        expect(lines(stdout)[11]).toBe('banana');
        expect(lines(stdout)[12]).toBe('cherry');
    });

    it('exits with code 0', () => {
        expect(compileAndRun(MUTATE).exitCode).toBe(0);
    });
});

// =============================================================================
// 4. Search (runtime)
// =============================================================================

describe('StringArray — search (runtime)', () => {

    it('indexOf("bar") returns 1 (first occurrence)', () => {
        expect(lines(compileAndRun(SEARCH).stdout)[0]).toBe('1');
    });

    it('indexOf("nope") returns -1 (absent)', () => {
        expect(lines(compileAndRun(SEARCH).stdout)[1]).toBe('-1');
    });

    it('lastIndexOf("bar") returns 3 (last occurrence)', () => {
        expect(lines(compileAndRun(SEARCH).stdout)[2]).toBe('3');
    });

    it('lastIndexOf("foo") returns 0', () => {
        expect(lines(compileAndRun(SEARCH).stdout)[3]).toBe('0');
    });

    it('includes("baz") is true (prints 1)', () => {
        expect(lines(compileAndRun(SEARCH).stdout)[4]).toBe('1');
    });

    it('includes("nope") is false (prints 0)', () => {
        expect(lines(compileAndRun(SEARCH).stdout)[5]).toBe('0');
    });

    it('exits with code 0', () => {
        expect(compileAndRun(SEARCH).exitCode).toBe(0);
    });
});

// =============================================================================
// 5. Slice / clone / concat (runtime)
// =============================================================================

describe('StringArray — slice / clone / concat (runtime)', () => {

    it('slice(1, 4) of ["a".."e"] has length 3', () => {
        expect(lines(compileAndRun(SLICE).stdout)[0]).toBe('3');
    });

    it('slice(1,4)[0] == "b"', () => {
        expect(lines(compileAndRun(SLICE).stdout)[1]).toBe('b');
    });

    it('slice(1,4)[2] == "d"', () => {
        expect(lines(compileAndRun(SLICE).stdout)[3]).toBe('d');
    });

    it('slice(-3,-1) returns ["c","d"]', () => {
        const out = lines(compileAndRun(SLICE).stdout);
        expect(out[4]).toBe('2');
        expect(out[5]).toBe('c');
        expect(out[6]).toBe('d');
    });

    it('sliceFrom(3) returns ["d","e"]', () => {
        const out = lines(compileAndRun(SLICE).stdout);
        expect(out[7]).toBe('2');
        expect(out[8]).toBe('d');
        expect(out[9]).toBe('e');
    });

    it('clone() has same length and elements', () => {
        const out = lines(compileAndRun(SLICE).stdout);
        expect(out[10]).toBe('5');
        expect(out[11]).toBe('a');
        expect(out[12]).toBe('e');
    });

    it('concat(b) gives combined length 7', () => {
        expect(lines(compileAndRun(SLICE).stdout)[13]).toBe('7');
    });

    it('concat(b)[5] == "f", concat(b)[6] == "g"', () => {
        const out = lines(compileAndRun(SLICE).stdout);
        expect(out[14]).toBe('f');
        expect(out[15]).toBe('g');
    });

    it('exits with code 0', () => {
        expect(compileAndRun(SLICE).exitCode).toBe(0);
    });
});

// =============================================================================
// 6. Output — print, toString, join (runtime)
// =============================================================================

describe('StringArray — output (runtime)', () => {

    it('print(empty) outputs "[]"', () => {
        expect(lines(compileAndRun(PRINT).stdout)[0]).toBe('[]');
    });

    it('print(["hello","world"]) outputs [\"hello\", \"world\"]', () => {
        expect(lines(compileAndRun(PRINT).stdout)[1]).toBe('["hello", "world"]');
    });

    it('toString() returns ["hello", "world"] with quotes', () => {
        expect(lines(compileAndRun(PRINT).stdout)[2]).toBe('["hello", "world"]');
    });

    it('join(", ") returns "hello, world" (no quotes)', () => {
        expect(lines(compileAndRun(PRINT).stdout)[3]).toBe('hello, world');
    });

    it('join(" | ") returns "hello | world"', () => {
        expect(lines(compileAndRun(PRINT).stdout)[4]).toBe('hello | world');
    });

    it('produces exactly 5 lines of output', () => {
        expect(lines(compileAndRun(PRINT).stdout)).toHaveLength(5);
    });

    it('exits with code 0', () => {
        expect(compileAndRun(PRINT).exitCode).toBe(0);
    });

    it('IR: print(stringArray) uses stringarray_print call', () => {
        const { ir } = compileToIR(PRINT);
        expect(ir).toMatch(/call void @stringarray_print\(%StringArray\*/);
    });
});

// =============================================================================
// 7. Disposable — using / auto-dispose (runtime)
// =============================================================================

describe('StringArray — Disposable / using (runtime)', () => {

    it('using array has the correct length', () => {
        expect(lines(compileAndRun(DISPOSE).stdout)[0]).toBe('2');
    });

    it('using array.first() returns the fill value', () => {
        expect(lines(compileAndRun(DISPOSE).stdout)[1]).toBe('ok');
    });

    it('using array.last() returns the fill value', () => {
        expect(lines(compileAndRun(DISPOSE).stdout)[2]).toBe('ok');
    });

    it('push into using-managed array increases length', () => {
        expect(lines(compileAndRun(DISPOSE).stdout)[3]).toBe('3');
    });

    it('last element after push is the pushed string', () => {
        expect(lines(compileAndRun(DISPOSE).stdout)[4]).toBe('extra');
    });

    it('exits with code 0 (no double-free crash)', () => {
        expect(compileAndRun(DISPOSE).exitCode).toBe(0);
    });

    it('IR: dispose emits stringarray_free via Disposable', () => {
        const { ir } = compileToIR(DISPOSE);
        expect(ir).toMatch(/call void @stringarray_free\(%StringArray\*/);
    });
});
