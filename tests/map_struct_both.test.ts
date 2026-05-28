/**
 * Tests for Map with user-defined struct as BOTH KEY and VALUE.
 *
 * Covers:
 *   Map<Tag, Document> → PtrPtrMap (struct key by pointer identity, struct value)
 *
 * Fixture: tests/fixtures/valid/map_struct_both.code
 *
 * Expected output (7 lines):
 *   2       — size() after two puts
 *   true    — contains(t1)
 *   true    — contains(t2)
 *   hello   — get(t1).title
 *   world   — get(t2).title
 *   1       — size() after remove(t1)
 *   false   — contains(t1) after remove
 */

import { describe, it, expect } from 'vitest';
import { compileToIR, compileAndRun } from './helpers/cli.js';

const FIXTURE = 'map_struct_both.code';

function lines(stdout: string): string[] {
    return stdout.trim().split('\n');
}

// =============================================================================
// 1. IR structure
// =============================================================================

describe('Map<Struct, Struct> (PtrPtrMap) — IR structure', () => {

    it('emits %PtrPtrMap = type opaque', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('%PtrPtrMap = type opaque');
    });

    it('declares ptrptrmap_new', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@ptrptrmap_new');
    });

    it('declares ptrptrmap_get', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@ptrptrmap_get');
    });

    it('declares ptrptrmap_put', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@ptrptrmap_put');
    });

    it('declares ptrptrmap_contains', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('@ptrptrmap_contains');
    });

    it('uses %PtrPtrMap* alloca for Map<Tag, Document>', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/alloca %PtrPtrMap\*/);
    });

    it('bitcasts struct pointers to i8* for put() key', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/bitcast %Tag\* .* to i8\*/);
    });

    it('bitcasts i8* result of get() back to Document*', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/bitcast i8\* .* to %Document\*/);
    });
});

// =============================================================================
// 2. Runtime — Map<Tag, Document>  (PtrPtrMap)
// =============================================================================

describe('Map<Tag, Document> (PtrPtrMap) — runtime', () => {

    it('size() returns 2 after two puts', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[0]).toBe('2');
    });

    it('contains(t1) returns true', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[1]).toBe('true');
    });

    it('contains(t2) returns true', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[2]).toBe('true');
    });

    it('get(t1).title returns "hello"', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[3]).toBe('hello');
    });

    it('get(t2).title returns "world"', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[4]).toBe('world');
    });

    it('size() returns 1 after remove(t1)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[5]).toBe('1');
    });

    it('contains(t1) returns false after remove', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[6]).toBe('false');
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
