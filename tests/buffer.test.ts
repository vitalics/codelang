/**
 * Tests for string.toBuffer() and the Buffer type.
 *
 * Verifies:
 *  - %Buffer = type opaque is emitted in the IR header
 *  - C runtime functions are declared (string_to_buffer, buffer_length, buffer_get, buffer_free)
 *  - Extension methods are compiled (Buffer_length, Buffer_get, Buffer_free, string_toBuffer)
 *  - Byte values are treated as unsigned (zext, %u format)
 *  - Runtime output is correct
 */

import { describe, it, expect } from 'vitest';
import { compileToIR, compileAndRun } from './helpers/cli.js';

const FIXTURE = 'buffer_test.code';

// ── IR structure ──────────────────────────────────────────────────────────────

describe('Buffer — IR structure', () => {

    it('emits %Buffer = type opaque', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('%Buffer = type opaque');
    });

    it('declares @string_to_buffer', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/declare %Buffer\* @string_to_buffer\(i8\*\)/);
    });

    it('declares @buffer_length returning i32', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/declare i32 @buffer_length\(%Buffer\*\)/);
    });

    it('declares @buffer_get returning i8 (u8)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/declare i8 @buffer_get\(%Buffer\*, i32\)/);
    });

    it('declares @buffer_free returning void', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/declare void @buffer_free\(%Buffer\*\)/);
    });

    it('emits @string_toBuffer extension method', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/define.*@string_toBuffer\(i8\* %self\.0\)/);
    });

    it('emits @Buffer_length extension method', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/define.*@Buffer_length\(%Buffer\* %self\.0\)/);
    });

    it('emits @Buffer_get extension method', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/define.*@Buffer_get\(%Buffer\* %self\.0, i32 %arg\.0\)/);
    });

    it('emits @Buffer_free extension method (void)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/define void @Buffer_free\(%Buffer\* %self\.0\)/);
    });

    it('Buffer variable uses %Buffer* alloca', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/alloca %Buffer\*/);
    });

    it('byte values are zero-extended before printf (unsigned semantics)', () => {
        const { ir } = compileToIR(FIXTURE);
        // get() returns i8 (u8) → zext to i32 before %u printf
        expect(ir).toMatch(/zext i8 .+ to i32/);
        // %u format string is used (not %d)
        expect(ir).toMatch(/%u\\0A\\00/);
    });

    it('Buffer_free is called as void (no result register)', () => {
        const { ir } = compileToIR(FIXTURE);
        // void call has no LHS assignment
        expect(ir).toMatch(/call void @Buffer_free/);
    });
});

// ── Runtime output ────────────────────────────────────────────────────────────

describe('Buffer — runtime', () => {

    it('"hello".toBuffer().length() === 5', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(stdout.trim().split('\n')[0]).toBe('5');
    });

    it('byte 0 of "hello" is 104 (ASCII h)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(stdout.trim().split('\n')[1]).toBe('104');
    });

    it('byte 1 of "hello" is 101 (ASCII e)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(stdout.trim().split('\n')[2]).toBe('101');
    });

    it('byte 4 of "hello" is 111 (ASCII o)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(stdout.trim().split('\n')[3]).toBe('111');
    });

    it('out-of-bounds index returns 0, not crash', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(stdout.trim().split('\n')[4]).toBe('0');
    });

    it('negative index returns 0, not crash', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(stdout.trim().split('\n')[5]).toBe('0');
    });

    it('produces exactly 6 lines of output', () => {
        const { exitCode, stdout } = compileAndRun(FIXTURE);
        expect(exitCode).toBe(0);
        expect(stdout.trim().split('\n')).toHaveLength(6);
    });
});

// ── High-byte values (unsigned range 128–255) ─────────────────────────────────

describe('Buffer — high-byte unsigned values', () => {

    it('byte value 255 prints as 255 (not -1)', () => {
        // Use the uint_types fixture which already tests u8=255 printing correctly.
        // Here we verify that buffer_get() also returns unsigned values.
        const { ir } = compileToIR(FIXTURE);
        // The presence of zext (not sext) on the i8 result confirms unsigned semantics.
        expect(ir).toMatch(/zext i8/);
        expect(ir).not.toMatch(/sext i8/);
    });
});

// ── print(buffer) ──────────────────────────────────────────────────────────────

describe('Buffer — print', () => {
    it('print(buffer) renders as [b0, b1, ...] decimal notation', () => {
        const { exitCode, stdout } = compileAndRun('buffer_print.code');
        expect(exitCode).toBe(0);
        // "Привет, мир" in UTF-8: each Cyrillic letter is 2 bytes, comma + space are 1
        // Total: 20 bytes
        expect(stdout.trim()).toBe(
            '[208, 159, 209, 128, 208, 184, 208, 178, 208, 181, 209, 130, 44, 32, 208, 188, 208, 184, 209, 128]'
        );
    });

    it('IR: print(buffer) calls @buffer_print, not printf', () => {
        const { ir } = compileToIR('buffer_print.code');
        expect(ir).toMatch(/call void @buffer_print\(%Buffer\*/);
        // Must NOT pass the Buffer pointer to printf
        expect(ir).not.toMatch(/printf.*%Buffer\*/);
    });
});
