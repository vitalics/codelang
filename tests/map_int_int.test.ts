/**
 * Tests for IntIntMap — ordered map of int keys to int values.
 *
 * Fixture: tests/fixtures/valid/map_int_int.code
 *
 * Expected output (8 lines):
 *   3                  — size() after three distinct puts
 *   true               — contains(1)
 *   false              — contains(5)
 *   11                 — get(1) after update
 *   20                 — get(2)
 *   0                  — get(99) absent key
 *   {1: 11, 2: 20, 3: 30}  — print sorted
 *   {1: 11, 3: 30}     — print after remove(2)
 */

import { describe, it, expect } from 'vitest';
import { compileToIR, compileAndRun } from './helpers/cli.js';

const FIXTURE = 'map_int_int.code';

function lines(stdout: string): string[] {
    return stdout.trim().split('\n');
}

// =============================================================================
// 1. IR structure
// =============================================================================

describe('IntIntMap — IR structure', () => {

    it('emits %IntIntMap = type opaque', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('%IntIntMap = type opaque');
    });

    it('declares intintmap_new', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@intintmap_new');
    });

    it('declares intintmap_put', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@intintmap_put');
    });

    it('declares intintmap_get', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@intintmap_get');
    });

    it('declares intintmap_contains', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@intintmap_contains');
    });

    it('declares intintmap_remove', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@intintmap_remove');
    });

    it('emits intintmap_print call for print(m)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@intintmap_print');
    });
});

// =============================================================================
// 2. Runtime
// =============================================================================

describe('IntIntMap — runtime', () => {

    it('size() returns 3 after three distinct puts', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[0]).toBe('3');
    });

    it('contains(1) returns true', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[1]).toBe('true');
    });

    it('contains(5) returns false', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[2]).toBe('false');
    });

    it('get(1) returns 11 (updated value)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[3]).toBe('11');
    });

    it('get(2) returns 20', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[4]).toBe('20');
    });

    it('get(99) returns 0 for absent key', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[5]).toBe('0');
    });

    it('print(m) outputs {1: 11, 2: 20, 3: 30} in key-sorted order', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[6]).toBe('{1: 11, 2: 20, 3: 30}');
    });

    it('print(m) after remove(2) outputs {1: 11, 3: 30}', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[7]).toBe('{1: 11, 3: 30}');
    });

    it('produces exactly 8 lines of output', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)).toHaveLength(8);
    });

    it('exits with code 0', () => {
        const { exitCode } = compileAndRun(FIXTURE);
        expect(exitCode).toBe(0);
    });
});
