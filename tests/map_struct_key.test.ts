/**
 * Tests for Map with user-defined struct as KEY (pointer identity ordering).
 *
 * Covers:
 *   Map<Point, int>    → PtrIntMap    (struct key, int value)
 *   Map<Point, string> → PtrStringMap (struct key, string value)
 *
 * Key identity: two struct pointers with the same field values but different
 * allocations are treated as distinct keys (pointer-address comparison).
 *
 * Fixture: tests/fixtures/valid/map_struct_key.code
 *
 * Expected output (11 lines):
 *   2       — PtrIntMap size()
 *   true    — contains(p1)
 *   false   — contains(p3)  ← same values as p1 but different pointer
 *   100     — get(p1)
 *   200     — get(p2)
 *   1       — size() after remove(p1)
 *   false   — contains(p1) after remove
 *   2       — PtrStringMap size()
 *   hello   — get(p1)
 *   world   — get(p2)
 *   1       — size() after remove(p1)
 */

import { describe, it, expect } from 'vitest';
import { compileToIR, compileAndRun } from './helpers/cli.js';

const FIXTURE = 'map_struct_key.code';

function lines(stdout: string): string[] {
    return stdout.trim().split('\n');
}

// =============================================================================
// 1. IR structure
// =============================================================================

describe('Map<Struct, int> / Map<Struct, string> — IR structure', () => {

    it('emits %PtrIntMap = type opaque', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('%PtrIntMap = type opaque');
    });

    it('emits %PtrStringMap = type opaque', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('%PtrStringMap = type opaque');
    });

    it('declares ptrintmap_new', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@ptrintmap_new');
    });

    it('declares ptrintmap_get', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@ptrintmap_get');
    });

    it('declares ptrintmap_put', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@ptrintmap_put');
    });

    it('declares ptrintmap_contains', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@ptrintmap_contains');
    });

    it('declares ptrstrmap_new', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@ptrstrmap_new');
    });

    it('declares ptrstrmap_get', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@ptrstrmap_get');
    });

    it('uses %PtrIntMap* alloca for Map<Point, int>', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/alloca %PtrIntMap\*/);
    });

    it('uses %PtrStringMap* alloca for Map<Point, string>', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/alloca %PtrStringMap\*/);
    });
});

// =============================================================================
// 2. Runtime — Map<Point, int>  (PtrIntMap, key = struct pointer identity)
// =============================================================================

describe('Map<Point, int> (PtrIntMap) — runtime', () => {

    it('size() returns 2 after two puts', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[0]).toBe('2');
    });

    it('contains(p1) returns true', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[1]).toBe('true');
    });

    it('contains(p3) returns false — same field values but different pointer', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[2]).toBe('false');
    });

    it('get(p1) returns 100', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[3]).toBe('100');
    });

    it('get(p2) returns 200', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[4]).toBe('200');
    });

    it('size() returns 1 after remove(p1)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[5]).toBe('1');
    });

    it('contains(p1) returns false after remove', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[6]).toBe('false');
    });
});

// =============================================================================
// 3. Runtime — Map<Point, string>  (PtrStringMap, key = struct pointer identity)
// =============================================================================

describe('Map<Point, string> (PtrStringMap) — runtime', () => {

    it('size() returns 2 after two puts', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[7]).toBe('2');
    });

    it('get(p1) returns "hello"', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[8]).toBe('hello');
    });

    it('get(p2) returns "world"', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[9]).toBe('world');
    });

    it('size() returns 1 after remove(p1)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[10]).toBe('1');
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
