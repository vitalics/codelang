/**
 * Tests for FloatArray (f32) and DoubleArray (f64), including the generic
 * Array<Float> and Array<float> aliases.
 *
 * Fixture: tests/fixtures/valid/array_float.code
 *
 * Expected output (12 lines):
 *   3          — FloatArray.length()
 *   1.5        — FloatArray.get(0)
 *   3.5        — FloatArray.get(2)
 *   [1.5, 2.5, 3.5]  — print(floatArray)
 *   3          — DoubleArray.length()
 *   20.2       — DoubleArray.get(1)
 *   [10.1, 20.2, 30.3] — print(doubleArray)
 *   2          — Array<Float>.length()
 *   [7, 8]     — print(Array<Float>)
 *   2          — Array<float>.length()
 *   [100.5, 200.5] — print(Array<float>)
 */

import { describe, it, expect } from 'vitest';
import { compileToIR, compileAndRun } from './helpers/cli.js';

const FIXTURE = 'array_float.code';

function lines(stdout: string): string[] {
    return stdout.trim().split('\n');
}

// =============================================================================
// 1. IR structure
// =============================================================================

describe('FloatArray / DoubleArray — IR structure', () => {

    it('emits %FloatArray = type opaque', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('%FloatArray = type opaque');
    });

    it('emits %DoubleArray = type opaque', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('%DoubleArray = type opaque');
    });

    it('declares floatarray_new', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@floatarray_new');
    });

    it('declares doublearray_new', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@doublearray_new');
    });

    it('emits floatarray_print call for print(floatArray)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@floatarray_print');
    });

    it('emits doublearray_print call for print(doubleArray)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@doublearray_print');
    });
});

// =============================================================================
// 2. Runtime — FloatArray
// =============================================================================

describe('FloatArray — runtime', () => {

    it('length() returns 3 after three pushes', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[0]).toBe('3');
    });

    it('get(0) returns 1.5', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[1]).toBe('1.5');
    });

    it('get(2) returns 3.5', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[2]).toBe('3.5');
    });

    it('print outputs [1.5, 2.5, 3.5]', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[3]).toBe('[1.5, 2.5, 3.5]');
    });
});

// =============================================================================
// 3. Runtime — DoubleArray
// =============================================================================

describe('DoubleArray — runtime', () => {

    it('length() returns 3 after three pushes', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[4]).toBe('3');
    });

    it('get(1) returns 20.2', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[5]).toBe('20.2');
    });

    it('print outputs [10.1, 20.2, 30.3]', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[6]).toBe('[10.1, 20.2, 30.3]');
    });
});

// =============================================================================
// 4. Runtime — Array<Float> and Array<float> generic aliases
// =============================================================================

describe('Array<Float> / Array<float> generic aliases — runtime', () => {

    it('Array<Float>: length() returns 2', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[7]).toBe('2');
    });

    it('Array<Float>: print outputs [7, 8]', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[8]).toBe('[7, 8]');
    });

    it('Array<float>: length() returns 2', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[9]).toBe('2');
    });

    it('Array<float>: print outputs [100.5, 200.5]', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[10]).toBe('[100.5, 200.5]');
    });

    it('produces exactly 11 lines of output', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)).toHaveLength(11);
    });

    it('exits with code 0', () => {
        const { exitCode } = compileAndRun(FIXTURE);
        expect(exitCode).toBe(0);
    });
});
