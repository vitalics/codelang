/**
 * Tests for stdlib/result.code — Result<T, E> enum.
 *
 * Covers:
 *  1. IR structure — Result enum types emitted
 *  2. isOk() / isErr() methods
 *  3. unwrapOr() method
 *  4. Functions returning Result and switch pattern matching
 */

import { describe, it, expect } from 'vitest';
import { compileToIR, compileAndRun } from './helpers/cli.js';

const FIXTURE = 'result_basic.code';

/** Split stdout into trimmed, non-empty lines. */
function lines(stdout: string): string[] {
    return stdout.trim().split('\n').map(l => l.trim()).filter(Boolean);
}

// =============================================================================
// 1. IR structure
// =============================================================================

describe('Result<T, E> — IR structure', () => {

    it('emits Result_i32_MathError opaque type', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('%Result_i32_MathError');
    });

    it('emits Result_i32_MathError_Ok constructor', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/@Result_i32_MathError_Ok/);
    });

    it('emits Result_i32_MathError_Err constructor', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/@Result_i32_MathError_Err/);
    });

    it('emits Result_i32_MathError_isOk specialization', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/@Result_i32_MathError_isOk/);
    });

    it('emits Result_i32_MathError_unwrapOr specialization', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/@Result_i32_MathError_unwrapOr/);
    });

});

// =============================================================================
// 2. Runtime — isOk() and isErr()
// =============================================================================

describe('Result<T, E> — isOk() and isErr()', () => {

    it('Ok(10).isOk() == true', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[0]).toBe('true');
    });

    it('Err(Overflow).isOk() == false', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[1]).toBe('false');
    });

    it('Ok(10).isErr() == false', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[2]).toBe('false');
    });

    it('Err(Overflow).isErr() == true', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[3]).toBe('true');
    });

});

// =============================================================================
// 3. Runtime — unwrapOr()
// =============================================================================

describe('Result<T, E> — unwrapOr()', () => {

    it('Ok(10).unwrapOr(-1) == 10', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[4]).toBe('10');
    });

    it('Err.unwrapOr(-1) == -1', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[5]).toBe('-1');
    });

});

// =============================================================================
// 4. Runtime — fallible functions and switch
// =============================================================================

describe('Result<T, E> — fallible functions', () => {

    it('safe_div(10, 2) isOk == true', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[6]).toBe('true');
    });

    it('safe_div(10, 0) isErr == true', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[7]).toBe('true');
    });

    it('safe_div(10, 2).unwrapOr(-1) == 5', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[8]).toBe('5');
    });

    it('safe_div(10, 0).unwrapOr(-1) == -1', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[9]).toBe('-1');
    });

    it('find_user(1) returns "Alice"', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[10]).toBe('Alice');
    });

    it('find_user(99) returns "not found"', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[11]).toBe('not found');
    });

});

// =============================================================================
// 5. Overall
// =============================================================================

describe('Result<T, E> — overall output', () => {

    it('produces exactly 12 lines of output', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)).toHaveLength(12);
    });

    it('exits with code 0', () => {
        const { exitCode } = compileAndRun(FIXTURE);
        expect(exitCode).toBe(0);
    });

});
