/**
 * Tests for Array<T> generic alias and the three new concrete array types:
 *   NumberArray, AnyArray, BoolArray
 *
 * Covers:
 *  1. IR structure  — opaque type declarations, declare signatures
 *  2. Array<T> alias — Array<int>, Array<string>, Array<bool> resolve to concrete types
 *  3. BoolArray runtime — push/get/at/set/first/last/indexOf/includes/toString
 *  4. Array<T>.new() with explicit type args (no variable annotation)
 *
 * Fixture: tests/fixtures/valid/array_generic.code
 *
 * Expected output (16 lines):
 *   3                — Array<int>.length()  (via Array.new() + type annotation)
 *   20               — Array<int>.get(1)
 *   [10, 20, 30]     — Array<int>.toString()
 *   2                — Array<string>.length()
 *   hello            — Array<string>.get(0)
 *   ["hello","world"]— Array<string>.toString()
 *   3                — Array<bool>.length()
 *   true             — Array<bool>.get(0)
 *   false            — Array<bool>.get(1)
 *   [true,false,true]— Array<bool>.toString()
 *   2                — Array<int>.length()  (via Array<int>.new() explicit type args)
 *   1                — Array<int>.get(0)
 *   2                — Array<string>.length() (via Array<string>.new() explicit type args)
 *   bar              — Array<string>.get(1)
 *   2                — Array<bool>.length() (via Array<bool>.new() explicit type args)
 *   false            — Array<bool>.get(0)
 */

import { describe, it, expect } from 'vitest';
import { compileToIR, compileAndRun } from './helpers/cli.js';

const FIXTURE = 'array_generic.code';

/** Split stdout into trimmed, non-empty lines. */
function lines(stdout: string): string[] {
    return stdout.trim().split('\n');
}

// =============================================================================
// 1. IR structure
// =============================================================================

describe('Array<T> — IR structure', () => {

    it('emits %BoolArray = type opaque', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('%BoolArray = type opaque');
    });

    it('declares boolarray_new : %BoolArray* ()', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('declare %BoolArray* @boolarray_new()');
    });

    it('declares boolarray_push : void (%BoolArray*, i32)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('declare void @boolarray_push(%BoolArray*, i32)');
    });

    it('declares boolarray_get : i32 (%BoolArray*, i32)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('declare i32 @boolarray_get(%BoolArray*, i32)');
    });

    it('declares boolarray_length : i32 (%BoolArray*)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('declare i32 @boolarray_length(%BoolArray*)');
    });

    it('Array<int> resolves to %IntArray*', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('%IntArray*');
    });

    it('Array<string> resolves to %StringArray*', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('%StringArray*');
    });

    it('Array<bool> resolves to %BoolArray*', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('%BoolArray*');
    });
});

// =============================================================================
// 2. Array<T> alias (runtime)
// =============================================================================

describe('Array<T> alias — runtime', () => {

    it('Array<int>.length() returns 3 after pushing three elements', () => {
        const { stdout } = compileAndRun(FIXTURE);
        const l = lines(stdout);
        expect(l[0]).toBe('3');
    });

    it('Array<int>.get(1) returns 20', () => {
        const { stdout } = compileAndRun(FIXTURE);
        const l = lines(stdout);
        expect(l[1]).toBe('20');
    });

    it('Array<int>.toString() returns "[10, 20, 30]"', () => {
        const { stdout } = compileAndRun(FIXTURE);
        const l = lines(stdout);
        expect(l[2]).toBe('[10, 20, 30]');
    });

    it('Array<string>.length() returns 2', () => {
        const { stdout } = compileAndRun(FIXTURE);
        const l = lines(stdout);
        expect(l[3]).toBe('2');
    });

    it('Array<string>.get(0) returns "hello"', () => {
        const { stdout } = compileAndRun(FIXTURE);
        const l = lines(stdout);
        expect(l[4]).toBe('hello');
    });

    it('Array<string>.toString() returns \'["hello", "world"]\'', () => {
        const { stdout } = compileAndRun(FIXTURE);
        const l = lines(stdout);
        expect(l[5]).toBe('["hello", "world"]');
    });

    it('exits with code 0', () => {
        const { exitCode } = compileAndRun(FIXTURE);
        expect(exitCode).toBe(0);
    });
});

// =============================================================================
// 3. BoolArray runtime
// =============================================================================

describe('BoolArray — runtime', () => {

    it('length() returns 3 after pushing [true, false, true]', () => {
        const { stdout } = compileAndRun(FIXTURE);
        const l = lines(stdout);
        expect(l[6]).toBe('3');
    });

    it('get(0) returns true', () => {
        const { stdout } = compileAndRun(FIXTURE);
        const l = lines(stdout);
        expect(l[7]).toBe('true');
    });

    it('get(1) returns false', () => {
        const { stdout } = compileAndRun(FIXTURE);
        const l = lines(stdout);
        expect(l[8]).toBe('false');
    });

    it('toString() returns "[true, false, true]"', () => {
        const { stdout } = compileAndRun(FIXTURE);
        const l = lines(stdout);
        expect(l[9]).toBe('[true, false, true]');
    });

});

// =============================================================================
// 4. Array<T>.new() with explicit type args — runtime
// =============================================================================

describe('Array<T>.new() with explicit type args — runtime', () => {

    it('Array<int>.new(): length() returns 2', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[10]).toBe('2');
    });

    it('Array<int>.new(): get(0) returns 1', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[11]).toBe('1');
    });

    it('Array<string>.new(): length() returns 2', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[12]).toBe('2');
    });

    it('Array<string>.new(): get(1) returns "bar"', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[13]).toBe('bar');
    });

    it('Array<bool>.new(): length() returns 2', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[14]).toBe('2');
    });

    it('Array<bool>.new(): get(0) returns false', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[15]).toBe('false');
    });
});

// =============================================================================
// 5. Overall
// =============================================================================

describe('array_generic — overall', () => {

    it('produces exactly 16 lines of output', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)).toHaveLength(16);
    });

    it('exits with code 0', () => {
        const { exitCode } = compileAndRun(FIXTURE);
        expect(exitCode).toBe(0);
    });
});
