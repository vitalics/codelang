/**
 * Tests for Countable (length()) protocol on all PtrMap types.
 *
 * Covers:
 *   IntPtrMap    — Map<int, Struct>
 *   StringPtrMap — Map<string, Struct>
 *   PtrIntMap    — Map<Struct, int>
 *   PtrStringMap — Map<Struct, string>
 *   PtrPtrMap    — Map<Struct, Struct>
 *
 * Fixture: tests/fixtures/valid/map_countable.code
 *
 * Expected output (5 lines):
 *   2    — IntPtrMap length()
 *   2    — StringPtrMap length()
 *   2    — PtrIntMap length()
 *   2    — PtrStringMap length()
 *   2    — PtrPtrMap length()
 */

import { describe, it, expect } from 'vitest';
import { compileToIR, compileAndRun } from './helpers/cli.js';

const FIXTURE = 'map_countable.code';

function lines(stdout: string): string[] {
    return stdout.trim().split('\n');
}

// =============================================================================
// 1. IR structure — length() dispatches to _size for all PtrMap types
// =============================================================================

describe('Countable for PtrMaps — IR structure', () => {

    it('dispatches IntPtrMap.length() to @intptrmap_size', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/@intptrmap_size/);
    });

    it('dispatches StringPtrMap.length() to @stringptrmap_size', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/@stringptrmap_size/);
    });

    it('dispatches PtrIntMap.length() to @ptrintmap_size', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/@ptrintmap_size/);
    });

    it('dispatches PtrStringMap.length() to @ptrstrmap_size', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/@ptrstrmap_size/);
    });

    it('dispatches PtrPtrMap.length() to @ptrptrmap_size', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/@ptrptrmap_size/);
    });

    it('emits no WARNING for length() on any PtrMap type', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).not.toMatch(/WARNING: unknown PtrMap method 'length'/);
    });
});

// =============================================================================
// 2. Runtime
// =============================================================================

describe('Countable for PtrMaps — runtime', () => {

    it('IntPtrMap.length() returns 2 after two puts', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[0]).toBe('2');
    });

    it('StringPtrMap.length() returns 2 after two puts', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[1]).toBe('2');
    });

    it('PtrIntMap.length() returns 2 after two puts', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[2]).toBe('2');
    });

    it('PtrStringMap.length() returns 2 after two puts', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[3]).toBe('2');
    });

    it('PtrPtrMap.length() returns 2 after two puts', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[4]).toBe('2');
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
