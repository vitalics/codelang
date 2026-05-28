/**
 * Tests for stdlib/option.code — Option<T> enum.
 *
 * Covers:
 *  1. IR structure — Option enum types emitted, constructor functions
 *  2. isSome() / isNone() methods
 *  3. unwrapOr() method
 *  4. switch pattern-matching on Option variants
 *  5. Option<string> type
 */

import { describe, it, expect } from 'vitest';
import { compileToIR, compileAndRun } from './helpers/cli.js';

const FIXTURE = 'option_basic.code';

/** Split stdout into trimmed, non-empty lines. */
function lines(stdout: string): string[] {
    return stdout.trim().split('\n').map(l => l.trim()).filter(Boolean);
}

// =============================================================================
// 1. IR structure
// =============================================================================

describe('Option<T> — IR structure', () => {

    it('emits %Option_i32 opaque type for Option<int>', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('%Option_i32');
    });

    it('emits Option_i32_Some constructor', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/@Option_i32_Some/);
    });

    it('emits Option_i32_None constructor', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/@Option_i32_None/);
    });

    it('emits Option_i32_isSome specialization', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/@Option_i32_isSome/);
    });

    it('emits Option_i32_isNone specialization', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/@Option_i32_isNone/);
    });

    it('emits Option_i32_unwrapOr specialization', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/@Option_i32_unwrapOr/);
    });

});

// =============================================================================
// 2. Runtime — isSome() and isNone()
// =============================================================================

describe('Option<T> — isSome() and isNone()', () => {

    it('some_int.isSome() == true', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[0]).toBe('true');
    });

    it('none_int.isSome() == false', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[1]).toBe('false');
    });

    it('some_str.isSome() == true', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[2]).toBe('true');
    });

    it('none_str.isSome() == false', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[3]).toBe('false');
    });

    it('some_int.isNone() == false', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[4]).toBe('false');
    });

    it('none_int.isNone() == true', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[5]).toBe('true');
    });

});

// =============================================================================
// 3. Runtime — unwrapOr()
// =============================================================================

describe('Option<T> — unwrapOr()', () => {

    it('Some(42).unwrapOr(0) == 42', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[6]).toBe('42');
    });

    it('None.unwrapOr(99) == 99', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[7]).toBe('99');
    });

    it('Some("hello").unwrapOr("default") == "hello"', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[8]).toBe('hello');
    });

    it('None.unwrapOr("default") == "default"', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[9]).toBe('default');
    });

});

// =============================================================================
// 4. Runtime — switch pattern matching
// =============================================================================

describe('Option<T> — switch pattern matching', () => {

    it('switch Some(42) extracts 42', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[10]).toBe('42');
    });

    it('switch None falls through to default arm', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[11]).toBe('-1');
    });

});

// =============================================================================
// 5. Runtime — overall
// =============================================================================

describe('Option<T> — overall output', () => {

    it('produces exactly 12 lines of output', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)).toHaveLength(12);
    });

    it('exits with code 0', () => {
        const { exitCode } = compileAndRun(FIXTURE);
        expect(exitCode).toBe(0);
    });

});
