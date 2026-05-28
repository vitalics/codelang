/**
 * Tests for StringIntMap — ordered map of string keys to int values.
 * (Most common map type: word counts, name→id, etc.)
 *
 * Fixture: tests/fixtures/valid/map_string_int.code
 *
 * Expected output (8 lines):
 *   3          — size() after 3 distinct puts
 *   true       — contains("apple")
 *   false      — contains("grape")
 *   7          — get("apple") after update
 *   1          — get("cherry")
 *   0          — get("missing") absent key
 *   {"apple": 7, "banana": 2, "cherry": 1}  — sorted by key
 *   {"apple": 7, "cherry": 1}               — after remove("banana")
 */

import { describe, it, expect } from 'vitest';
import { compileToIR, compileAndRun } from './helpers/cli.js';

const FIXTURE = 'map_string_int.code';

function lines(stdout: string): string[] {
    return stdout.trim().split('\n');
}

// =============================================================================
// 1. IR structure
// =============================================================================

describe('StringIntMap — IR structure', () => {

    it('emits %StringIntMap = type opaque', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('%StringIntMap = type opaque');
    });

    it('declares stringintmap_new', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@stringintmap_new');
    });

    it('declares stringintmap_put', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@stringintmap_put');
    });

    it('declares stringintmap_get', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@stringintmap_get');
    });

    it('declares stringintmap_contains', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@stringintmap_contains');
    });

    it('emits stringintmap_print call for print(m)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@stringintmap_print');
    });
});

// =============================================================================
// 2. Runtime
// =============================================================================

describe('StringIntMap — runtime', () => {

    it('size() returns 3 after three distinct puts', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[0]).toBe('3');
    });

    it('contains("apple") returns true', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[1]).toBe('true');
    });

    it('contains("grape") returns false', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[2]).toBe('false');
    });

    it('get("apple") returns 7 (updated value)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[3]).toBe('7');
    });

    it('get("cherry") returns 1', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[4]).toBe('1');
    });

    it('get("missing") returns 0 for absent key', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[5]).toBe('0');
    });

    it('print(m) outputs entries sorted alphabetically by key', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[6]).toBe('{"apple": 7, "banana": 2, "cherry": 1}');
    });

    it('print(m) after remove("banana") outputs two entries', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[7]).toBe('{"apple": 7, "cherry": 1}');
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
