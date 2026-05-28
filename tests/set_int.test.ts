/**
 * Tests for IntSet — ordered, duplicate-free set of 32-bit integers.
 *
 * Covers:
 *  1. IR structure — %IntSet opaque type, intset_* runtime declares
 *  2. Runtime — add, remove, contains, size, print
 */

import { describe, it, expect } from 'vitest';
import { compileToIR, compileAndRun } from './helpers/cli.js';

const FIXTURE = 'set_int.code';

/** Split stdout into trimmed, non-empty lines. */
function lines(stdout: string): string[] {
    return stdout.trim().split('\n');
}

// =============================================================================
// 1. IR structure
// =============================================================================

describe('IntSet — IR structure', () => {

    it('emits %IntSet = type opaque', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('%IntSet = type opaque');
    });

    it('declares intset_new : %IntSet* ()', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('declare %IntSet* @intset_new()');
    });

    it('declares intset_add : void (%IntSet*, i32)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('declare void @intset_add(%IntSet*, i32)');
    });

    it('declares intset_remove : void (%IntSet*, i32)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('declare void @intset_remove(%IntSet*, i32)');
    });

    it('declares intset_contains : i32 (%IntSet*, i32)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('declare i32 @intset_contains(%IntSet*, i32)');
    });

    it('declares intset_size : i32 (%IntSet*)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('declare i32 @intset_size(%IntSet*)');
    });

    it('emits intset_print call for print(set)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@intset_print');
    });
});

// =============================================================================
// 2. Runtime
// =============================================================================

describe('IntSet — runtime', () => {

    it('size() returns 3 after adding 3, 1, 2, 1 (duplicate ignored)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[0]).toBe('3');
    });

    it('contains(1) returns true', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[1]).toBe('true');
    });

    it('contains(5) returns false (not in set)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[2]).toBe('false');
    });

    it('print(s) outputs {1, 2, 3} in sorted order', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[3]).toBe('{1, 2, 3}');
    });

    it('print(s) after remove(2) outputs {1, 3}', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[4]).toBe('{1, 3}');
    });

    it('produces exactly 5 lines of output', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)).toHaveLength(5);
    });

    it('exits with code 0', () => {
        const { exitCode } = compileAndRun(FIXTURE);
        expect(exitCode).toBe(0);
    });
});
