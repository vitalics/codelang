/**
 * Tests for NumberSet — ordered set of arbitrary-precision Number values.
 * Also covers the Set<Number> generic alias.
 *
 * Fixture: tests/fixtures/valid/set_number.code
 *
 * Expected output (8 lines):
 *   3           — NumberSet.size() after 4 adds (1 duplicate)
 *   true        — contains(b = 10)
 *   {10, 20, 30}— print(ns) sorted
 *   2           — size() after remove(c = 20)
 *   {10, 30}    — print(ns) after remove
 *   2           — Set<Number>.size()
 *   {5, 15}     — print(Set<Number>)
 */

import { describe, it, expect } from 'vitest';
import { compileToIR, compileAndRun } from './helpers/cli.js';

const FIXTURE = 'set_number.code';

function lines(stdout: string): string[] {
    return stdout.trim().split('\n');
}

// =============================================================================
// 1. IR structure
// =============================================================================

describe('NumberSet — IR structure', () => {

    it('emits %NumberSet = type opaque', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('%NumberSet = type opaque');
    });

    it('declares numberset_new', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@numberset_new');
    });

    it('declares numberset_add', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@numberset_add');
    });

    it('declares numberset_remove', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@numberset_remove');
    });

    it('declares numberset_contains', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@numberset_contains');
    });

    it('emits numberset_print call for print(ns)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@numberset_print');
    });
});

// =============================================================================
// 2. Runtime
// =============================================================================

describe('NumberSet — runtime', () => {

    it('size() returns 3 after adding 30, 10, 20, 10 (duplicate ignored)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[0]).toBe('3');
    });

    it('contains(b=10) returns true', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[1]).toBe('true');
    });

    it('print(ns) outputs {10, 20, 30} in sorted order', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[2]).toBe('{10, 20, 30}');
    });

    it('size() returns 2 after remove(c=20)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[3]).toBe('2');
    });

    it('print(ns) after remove outputs {10, 30}', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[4]).toBe('{10, 30}');
    });
});

// =============================================================================
// 3. Runtime — Set<Number> generic alias
// =============================================================================

describe('Set<Number> generic alias — runtime', () => {

    it('Set<Number>: size() returns 2', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[5]).toBe('2');
    });

    it('Set<Number>: print outputs {5, 15}', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[6]).toBe('{5, 15}');
    });

    it('produces exactly 7 lines of output', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)).toHaveLength(7);
    });

    it('exits with code 0', () => {
        const { exitCode } = compileAndRun(FIXTURE);
        expect(exitCode).toBe(0);
    });
});
