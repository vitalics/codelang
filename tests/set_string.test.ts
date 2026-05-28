/**
 * Tests for StringSet — ordered, duplicate-free set of string pointers.
 *
 * Covers:
 *  1. IR structure — %StringSet opaque type, stringset_* runtime declares
 *  2. Runtime — add, remove, contains, size, print (lexicographic order)
 */

import { describe, it, expect } from 'vitest';
import { compileToIR, compileAndRun } from './helpers/cli.js';

const FIXTURE = 'set_string.code';

function lines(stdout: string): string[] {
    return stdout.trim().split('\n');
}

// =============================================================================
// 1. IR structure
// =============================================================================

describe('StringSet — IR structure', () => {

    it('emits %StringSet = type opaque', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('%StringSet = type opaque');
    });

    it('declares stringset_new : %StringSet* ()', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('declare %StringSet* @stringset_new()');
    });

    it('declares stringset_add : void (%StringSet*, i8*)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('declare void @stringset_add(%StringSet*, i8*)');
    });

    it('declares stringset_contains : i32 (%StringSet*, i8*)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('declare i32 @stringset_contains(%StringSet*, i8*)');
    });

    it('declares stringset_size : i32 (%StringSet*)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('declare i32 @stringset_size(%StringSet*)');
    });

    it('emits stringset_print call for print(set)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@stringset_print');
    });
});

// =============================================================================
// 2. Runtime
// =============================================================================

describe('StringSet — runtime', () => {

    it('size() returns 3 after adding banana, apple, cherry, apple (duplicate ignored)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[0]).toBe('3');
    });

    it('contains("apple") returns true', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[1]).toBe('true');
    });

    it('contains("mango") returns false', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[2]).toBe('false');
    });

    it('print(s) outputs elements in lexicographic order', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[3]).toBe('{"apple", "banana", "cherry"}');
    });

    it('print(s) after remove("banana") outputs {"apple", "cherry"}', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[4]).toBe('{"apple", "cherry"}');
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
