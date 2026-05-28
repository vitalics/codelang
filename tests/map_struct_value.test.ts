/**
 * Tests for Map with user-defined struct as VALUE.
 *
 * Covers:
 *   Map<int,    Point> → IntPtrMap    (int key, struct value)
 *   Map<string, Point> → StringPtrMap (string key, struct value)
 *
 * Fixture: tests/fixtures/valid/map_struct_value.code
 *
 * Expected output (10 lines):
 *   2       — IntPtrMap size()
 *   true    — IntPtrMap contains(1)
 *   false   — IntPtrMap contains(5)
 *   10      — get(1).x
 *   1       — IntPtrMap size() after remove(2)
 *   2       — StringPtrMap size()
 *   true    — StringPtrMap contains("alice")
 *   false   — StringPtrMap contains("carol")
 *   20      — get("alice").y
 *   1       — StringPtrMap size() after remove("bob")
 */

import { describe, it, expect } from 'vitest';
import { compileToIR, compileAndRun } from './helpers/cli.js';

const FIXTURE = 'map_struct_value.code';

function lines(stdout: string): string[] {
    return stdout.trim().split('\n');
}

// =============================================================================
// 1. IR structure
// =============================================================================

describe('Map<int, Struct> / Map<string, Struct> — IR structure', () => {

    it('emits %IntPtrMap = type opaque', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('%IntPtrMap = type opaque');
    });

    it('emits %StringPtrMap = type opaque', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('%StringPtrMap = type opaque');
    });

    it('declares intptrmap_new', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@intptrmap_new');
    });

    it('declares intptrmap_get', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@intptrmap_get');
    });

    it('declares intptrmap_put', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@intptrmap_put');
    });

    it('declares stringptrmap_new', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@stringptrmap_new');
    });

    it('declares stringptrmap_get', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@stringptrmap_get');
    });

    it('declares stringptrmap_put', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@stringptrmap_put');
    });

    it('uses %IntPtrMap* alloca for Map<int, Point>', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/alloca %IntPtrMap\*/);
    });

    it('uses %StringPtrMap* alloca for Map<string, Point>', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/alloca %StringPtrMap\*/);
    });
});

// =============================================================================
// 2. Runtime — Map<int, Point>  (IntPtrMap)
// =============================================================================

describe('Map<int, Point> (IntPtrMap) — runtime', () => {

    it('size() returns 2 after two puts', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[0]).toBe('2');
    });

    it('contains(1) returns true', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[1]).toBe('true');
    });

    it('contains(5) returns false for absent key', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[2]).toBe('false');
    });

    it('get(1).x returns 10 (correct struct field)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[3]).toBe('10');
    });

    it('size() returns 1 after remove(2)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[4]).toBe('1');
    });
});

// =============================================================================
// 3. Runtime — Map<string, Point>  (StringPtrMap)
// =============================================================================

describe('Map<string, Point> (StringPtrMap) — runtime', () => {

    it('size() returns 2 after two puts', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[5]).toBe('2');
    });

    it('contains("alice") returns true', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[6]).toBe('true');
    });

    it('contains("carol") returns false for absent key', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[7]).toBe('false');
    });

    it('get("alice").y returns 20 (correct struct field)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[8]).toBe('20');
    });

    it('size() returns 1 after remove("bob")', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[9]).toBe('1');
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
