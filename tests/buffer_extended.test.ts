/**
 * Tests for the extended Buffer stdlib.
 *
 * Covers:
 *  - buffer_new / buffer_set                  (allocation & mutation)
 *  - Buffer.at()   (ByteIndexable; negative indices)
 *  - Buffer.slice / sliceFrom / clone / concat
 *  - Buffer.indexOf / lastIndexOf / includes / equals
 *  - Buffer.fill / reverse
 *  - Buffer.toUtf8 / toString  (Displayable)
 *  - New C-runtime declares emitted correctly
 */

import { describe, it, expect } from 'vitest';
import { compileToIR, compileAndRun } from './helpers/cli.js';

// ── buffer_new / set ──────────────────────────────────────────────────────────

describe('Buffer.new + set', () => {

    it('declares @buffer_new returning %Buffer*', () => {
        const { ir } = compileToIR('buffer_new_set.code');
        expect(ir).toMatch(/declare %Buffer\* @buffer_new\(i32\)/);
    });

    it('declares @buffer_set (void)', () => {
        const { ir } = compileToIR('buffer_new_set.code');
        expect(ir).toMatch(/declare void @buffer_set\(%Buffer\*, i32, i8\)/);
    });

    it('buffer_new(3).length() === 3', () => {
        const { stdout } = compileAndRun('buffer_new_set.code');
        const lines = stdout.trim().split('\n');
        expect(lines[0]).toBe('3');
    });

    it('buffer_new creates zero-filled buffer', () => {
        const { stdout } = compileAndRun('buffer_new_set.code');
        const lines = stdout.trim().split('\n');
        expect(lines[1]).toBe('0');
        expect(lines[2]).toBe('0');
        expect(lines[3]).toBe('0');
    });

    it('set() mutates bytes correctly', () => {
        const { stdout } = compileAndRun('buffer_new_set.code');
        const lines = stdout.trim().split('\n');
        expect(lines[4]).toBe('65');   // 'A'
        expect(lines[5]).toBe('66');   // 'B'
        expect(lines[6]).toBe('67');   // 'C'
    });

    it('exits cleanly (exit code 0)', () => {
        const { exitCode } = compileAndRun('buffer_new_set.code');
        expect(exitCode).toBe(0);
    });
});

// ── Buffer.at() (ByteIndexable) ───────────────────────────────────────────────

describe('Buffer.at() — ByteIndexable', () => {

    it('emits @Buffer_at extension method', () => {
        const { ir } = compileToIR('buffer_at.code');
        expect(ir).toMatch(/define.*@Buffer_at\(%Buffer\* %self\.0, i32 %arg\.0\)/);
    });

    it('at(0) returns first byte', () => {
        const { stdout } = compileAndRun('buffer_at.code');
        expect(stdout.trim().split('\n')[0]).toBe('104');  // 'h'
    });

    it('at(4) returns last byte of "hello"', () => {
        const { stdout } = compileAndRun('buffer_at.code');
        expect(stdout.trim().split('\n')[1]).toBe('111');  // 'o'
    });

    it('at(-1) returns last byte', () => {
        const { stdout } = compileAndRun('buffer_at.code');
        expect(stdout.trim().split('\n')[2]).toBe('111');  // 'o'
    });

    it('at(-5) returns first byte', () => {
        const { stdout } = compileAndRun('buffer_at.code');
        expect(stdout.trim().split('\n')[3]).toBe('104');  // 'h'
    });

    it('at(-6) returns 0 (out of bounds)', () => {
        const { stdout } = compileAndRun('buffer_at.code');
        expect(stdout.trim().split('\n')[4]).toBe('0');
    });

    it('at(5) returns 0 (out of bounds)', () => {
        const { stdout } = compileAndRun('buffer_at.code');
        expect(stdout.trim().split('\n')[5]).toBe('0');
    });
});

// ── slice / sliceFrom / clone / concat ───────────────────────────────────────

describe('Buffer slice / clone / concat', () => {

    it('declares @buffer_slice', () => {
        const { ir } = compileToIR('buffer_slice_ops.code');
        expect(ir).toMatch(/declare %Buffer\* @buffer_slice\(%Buffer\*, i32, i32\)/);
    });

    it('declares @buffer_concat', () => {
        const { ir } = compileToIR('buffer_slice_ops.code');
        expect(ir).toMatch(/declare %Buffer\* @buffer_concat\(%Buffer\*, %Buffer\*\)/);
    });

    it('slice(1,4) has length 3', () => {
        const { stdout } = compileAndRun('buffer_slice_ops.code');
        const lines = stdout.trim().split('\n');
        expect(lines[0]).toBe('3');
    });

    it('slice(1,4) contains "ell" bytes', () => {
        const { stdout } = compileAndRun('buffer_slice_ops.code');
        const lines = stdout.trim().split('\n');
        expect(lines[1]).toBe('101');  // 'e'
        expect(lines[2]).toBe('108');  // 'l'
        expect(lines[3]).toBe('108');  // 'l'
    });

    it('sliceFrom(3) has length 2', () => {
        const { stdout } = compileAndRun('buffer_slice_ops.code');
        const lines = stdout.trim().split('\n');
        expect(lines[4]).toBe('2');
    });

    it('sliceFrom(3) contains "lo" bytes', () => {
        const { stdout } = compileAndRun('buffer_slice_ops.code');
        const lines = stdout.trim().split('\n');
        expect(lines[5]).toBe('108');  // 'l'
        expect(lines[6]).toBe('111');  // 'o'
    });

    it('clone() has same length', () => {
        const { stdout } = compileAndRun('buffer_slice_ops.code');
        expect(stdout.trim().split('\n')[7]).toBe('5');
    });

    it('clone() has same first byte', () => {
        const { stdout } = compileAndRun('buffer_slice_ops.code');
        expect(stdout.trim().split('\n')[8]).toBe('104');  // 'h'
    });

    it('concat() doubles the length', () => {
        const { stdout } = compileAndRun('buffer_slice_ops.code');
        expect(stdout.trim().split('\n')[9]).toBe('10');
    });

    it('concat() second copy starts at index 5', () => {
        const { stdout } = compileAndRun('buffer_slice_ops.code');
        const lines = stdout.trim().split('\n');
        expect(lines[10]).toBe('104');   // first copy [0]
        expect(lines[11]).toBe('104');   // second copy [5]
    });
});

// ── indexOf / lastIndexOf / includes / equals ─────────────────────────────────

describe('Buffer search', () => {

    it('declares @buffer_index_of', () => {
        const { ir } = compileToIR('buffer_search.code');
        expect(ir).toMatch(/declare i32 @buffer_index_of\(%Buffer\*, %Buffer\*\)/);
    });

    it('declares @buffer_last_index_of', () => {
        const { ir } = compileToIR('buffer_search.code');
        expect(ir).toMatch(/declare i32 @buffer_last_index_of\(%Buffer\*, %Buffer\*\)/);
    });

    it('declares @buffer_equals', () => {
        const { ir } = compileToIR('buffer_search.code');
        expect(ir).toMatch(/declare i32 @buffer_equals\(%Buffer\*, %Buffer\*\)/);
    });

    it('indexOf returns first occurrence', () => {
        const { stdout } = compileAndRun('buffer_search.code');
        expect(stdout.trim().split('\n')[0]).toBe('1');
    });

    it('lastIndexOf returns last occurrence', () => {
        const { stdout } = compileAndRun('buffer_search.code');
        expect(stdout.trim().split('\n')[1]).toBe('4');
    });

    it('indexOf returns -1 for absent needle', () => {
        const { stdout } = compileAndRun('buffer_search.code');
        expect(stdout.trim().split('\n')[2]).toBe('-1');
    });

    it('includes returns true when needle found', () => {
        const { stdout } = compileAndRun('buffer_search.code');
        expect(stdout.trim().split('\n')[3]).toBe('1');
    });

    it('includes returns false when needle absent', () => {
        const { stdout } = compileAndRun('buffer_search.code');
        expect(stdout.trim().split('\n')[4]).toBe('0');
    });

    it('equals returns true for identical content', () => {
        const { stdout } = compileAndRun('buffer_search.code');
        expect(stdout.trim().split('\n')[5]).toBe('1');
    });

    it('equals returns false for different content', () => {
        const { stdout } = compileAndRun('buffer_search.code');
        expect(stdout.trim().split('\n')[6]).toBe('0');
    });
});

// ── fill / reverse ────────────────────────────────────────────────────────────

describe('Buffer mutate — fill + reverse', () => {

    it('fill sets every byte', () => {
        const { stdout } = compileAndRun('buffer_mutate.code');
        const lines = stdout.trim().split('\n');
        expect(lines[0]).toBe('42');
        expect(lines[1]).toBe('42');
        expect(lines[2]).toBe('42');
        expect(lines[3]).toBe('42');
    });

    it('reverse — odd length "hello" → "olleh"', () => {
        const { stdout } = compileAndRun('buffer_mutate.code');
        const lines = stdout.trim().split('\n');
        expect(lines[4]).toBe('111');  // 'o'
        expect(lines[5]).toBe('108');  // 'l'
        expect(lines[6]).toBe('108');  // 'l'
        expect(lines[7]).toBe('101');  // 'e'
        expect(lines[8]).toBe('104');  // 'h'
    });

    it('reverse — even length "abcd" → "dcba"', () => {
        const { stdout } = compileAndRun('buffer_mutate.code');
        const lines = stdout.trim().split('\n');
        expect(lines[9]).toBe('100');   // 'd'
        expect(lines[10]).toBe('99');   // 'c'
        expect(lines[11]).toBe('98');   // 'b'
        expect(lines[12]).toBe('97');   // 'a'
    });
});

// ── toUtf8 / toString ─────────────────────────────────────────────────────────

describe('Buffer.toUtf8 + toString (Displayable)', () => {

    it('declares @buffer_to_string', () => {
        const { ir } = compileToIR('buffer_to_string.code');
        expect(ir).toMatch(/declare i8\* @buffer_to_string\(%Buffer\*\)/);
    });

    it('emits @Buffer_toUtf8 extension method', () => {
        const { ir } = compileToIR('buffer_to_string.code');
        expect(ir).toMatch(/define.*@Buffer_toUtf8\(%Buffer\* %self\.0\)/);
    });

    it('emits @Buffer_toString extension method', () => {
        const { ir } = compileToIR('buffer_to_string.code');
        expect(ir).toMatch(/define.*@Buffer_toString\(%Buffer\* %self\.0\)/);
    });

    it('toUtf8() recovers original string', () => {
        const { stdout } = compileAndRun('buffer_to_string.code');
        expect(stdout.trim().split('\n')[0]).toBe('hi');
    });

    it('toString() renders as [104, 105] for "hi"', () => {
        const { stdout } = compileAndRun('buffer_to_string.code');
        expect(stdout.trim().split('\n')[1]).toBe('[104, 105]');
    });

    it('toString() uses @concat for building the string', () => {
        const { ir } = compileToIR('buffer_to_string.code');
        expect(ir).toMatch(/call i8\* @concat/);
    });

    it('toString() uses @int_to_string for byte values', () => {
        const { ir } = compileToIR('buffer_to_string.code');
        expect(ir).toMatch(/call i8\* @int_to_string/);
    });
});
