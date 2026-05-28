/**
 * Tests for postfix method-call chaining: expr.method(args)
 *
 * Grammar change: ExprPostfix wraps ExprAtom with optional `.member(args)` suffixes,
 * allowing arbitrary chaining such as `arr.getSafe(i).unwrapOr(0)`.
 *
 * Covers:
 *  1. IR structure — PostfixCallExpr nodes are compiled without errors
 *  2. Runtime — int array chaining with unwrapOr
 *  3. Runtime — isSome() chained on getSafe result
 *  4. Runtime — string array chaining with unwrapOr
 */

import { describe, it, expect } from 'vitest';
import { compileToIR, compileAndRun } from './helpers/cli.js';

const FIXTURE = 'method_chaining.code';

/** Split stdout into trimmed, non-empty lines. */
function lines(stdout: string): string[] {
    return stdout.trim().split('\n').map(l => l.trim()).filter(Boolean);
}

// =============================================================================
// 1. IR structure
// =============================================================================

describe('PostfixCallExpr — IR structure', () => {

    it('compiles method_chaining.code without IR errors', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).not.toContain('WARNING: cannot infer receiver type');
        expect(ir).not.toContain('WARNING: \'undef\'');
    });

    it('emits calls to Option_i32_unwrapOr', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/@Option_i32_unwrapOr/);
    });

    it('emits calls to Option_i32_isSome', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/@Option_i32_isSome/);
    });

});

// =============================================================================
// 2. Runtime — int chaining with unwrapOr
// =============================================================================

describe('PostfixCallExpr — arr.getSafe(i).unwrapOr(default)', () => {

    it('in-bounds index 0 → value 10', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[0]).toBe('10');
    });

    it('in-bounds index 1 → value 20', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[1]).toBe('20');
    });

    it('out-of-bounds index 5 → default -1', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[2]).toBe('-1');
    });

});

// =============================================================================
// 3. Runtime — isSome() chaining
// =============================================================================

describe('PostfixCallExpr — arr.getSafe(i).isSome()', () => {

    it('in-bounds getSafe(0).isSome() → true (1)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[3]).toBe('true');
    });

    it('out-of-bounds getSafe(99).isSome() → false (0)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[4]).toBe('false');
    });

});

// =============================================================================
// 4. Runtime — string array chaining
// =============================================================================

describe('PostfixCallExpr — string array chaining', () => {

    it('sarr.getSafe(0).unwrapOr("none") → "hello"', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[5]).toBe('hello');
    });

    it('sarr.getSafe(9).unwrapOr("none") → "none"', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[6]).toBe('none');
    });

});

// =============================================================================
// 5. Overall
// =============================================================================

describe('PostfixCallExpr — overall output', () => {

    it('produces exactly 7 lines of output', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)).toHaveLength(7);
    });

    it('exits with code 0', () => {
        const { exitCode } = compileAndRun(FIXTURE);
        expect(exitCode).toBe(0);
    });

});
