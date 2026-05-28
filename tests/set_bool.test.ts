/**
 * Tests for BoolSet — set of boolean values (at most {false, true}).
 *
 * Covers:
 *  1. IR structure — %BoolSet opaque type, boolset_* runtime declares
 *  2. Runtime — add, remove, contains, size, print
 */

import { describe, it, expect } from 'vitest';
import { compileToIR, compileAndRun } from './helpers/cli.js';

const FIXTURE = 'set_bool.code';

function lines(stdout: string): string[] {
    return stdout.trim().split('\n');
}

// =============================================================================
// 1. IR structure
// =============================================================================

describe('BoolSet — IR structure', () => {

    it('emits %BoolSet = type opaque', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('%BoolSet = type opaque');
    });

    it('declares boolset_new : %BoolSet* ()', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('declare %BoolSet* @boolset_new()');
    });

    it('declares boolset_add', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@boolset_add');
    });

    it('declares boolset_contains', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@boolset_contains');
    });

    it('declares boolset_size', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@boolset_size');
    });

    it('emits boolset_print call for print(set)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@boolset_print');
    });
});

// =============================================================================
// 2. Runtime
// =============================================================================

describe('BoolSet — runtime', () => {

    it('size() returns 2 after adding false, true, false (duplicate ignored)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[0]).toBe('2');
    });

    it('contains(true) returns true', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[1]).toBe('true');
    });

    it('contains(false) returns true', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[2]).toBe('true');
    });

    it('print(s) outputs {false, true}', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[3]).toBe('{false, true}');
    });

    it('print(s) after remove(false) outputs {true}', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[4]).toBe('{true}');
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
