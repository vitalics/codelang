/**
 * Tests for FloatSet (f32) and DoubleSet (f64), including Set<Float> generic alias.
 *
 * Fixture: tests/fixtures/valid/set_float.code
 *
 * Expected output (9 lines):
 *   3           — FloatSet.size() after 4 adds (1 duplicate)
 *   true        — contains(1.0)
 *   false       — contains(5.0)
 *   {1, 2, 3}   — print(floatSet)
 *   {1, 3}      — print(floatSet) after remove(2.0)
 *   2           — DoubleSet.size()
 *   true        — contains(20.5)
 *   {10.5, 20.5}— print(doubleSet)
 *   3           — Set<Float>.size()
 *   {7, 8, 9}   — print(Set<Float>)
 */

import { describe, it, expect } from 'vitest';
import { compileToIR, compileAndRun } from './helpers/cli.js';

const FIXTURE = 'set_float.code';

function lines(stdout: string): string[] {
    return stdout.trim().split('\n');
}

// =============================================================================
// 1. IR structure
// =============================================================================

describe('FloatSet / DoubleSet — IR structure', () => {

    it('emits %FloatSet = type opaque', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('%FloatSet = type opaque');
    });

    it('emits %DoubleSet = type opaque', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('%DoubleSet = type opaque');
    });

    it('declares floatset_new', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@floatset_new');
    });

    it('declares doubleset_new', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@doubleset_new');
    });

    it('emits floatset_print call for print(floatSet)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@floatset_print');
    });

    it('emits doubleset_print call for print(doubleSet)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@doubleset_print');
    });
});

// =============================================================================
// 2. Runtime — FloatSet
// =============================================================================

describe('FloatSet — runtime', () => {

    it('size() returns 3 after adding 3.0, 1.0, 2.0, 1.0 (duplicate ignored)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[0]).toBe('3');
    });

    it('contains(1.0) returns true', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[1]).toBe('true');
    });

    it('contains(5.0) returns false', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[2]).toBe('false');
    });

    it('print(s) outputs {1, 2, 3} in sorted order', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[3]).toBe('{1, 2, 3}');
    });

    it('print(s) after remove(2.0) outputs {1, 3}', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[4]).toBe('{1, 3}');
    });
});

// =============================================================================
// 3. Runtime — DoubleSet
// =============================================================================

describe('DoubleSet — runtime', () => {

    it('size() returns 2 after adding 10.5, 20.5, 10.5 (duplicate ignored)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[5]).toBe('2');
    });

    it('contains(20.5) returns true', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[6]).toBe('true');
    });

    it('print(s) outputs {10.5, 20.5} in sorted order', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[7]).toBe('{10.5, 20.5}');
    });
});

// =============================================================================
// 4. Runtime — Set<Float> generic alias
// =============================================================================

describe('Set<Float> generic alias — runtime', () => {

    it('Set<Float>: size() returns 3', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[8]).toBe('3');
    });

    it('Set<Float>: print outputs {7, 8, 9} in sorted order', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[9]).toBe('{7, 8, 9}');
    });

    it('produces exactly 10 lines of output', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)).toHaveLength(10);
    });

    it('exits with code 0', () => {
        const { exitCode } = compileAndRun(FIXTURE);
        expect(exitCode).toBe(0);
    });
});
