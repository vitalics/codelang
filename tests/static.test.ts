/**
 * Tests for static extension methods.
 *
 * Static methods are declared with the `static` keyword inside an extension
 * block and called as `TypeName.method(args)` — no receiver is passed.
 *
 * The primary surface under test is `String.new(n)` (a static factory that
 * allocates a zero-filled string buffer) and `str.set(i, v)` (an instance
 * method that writes a byte into a mutable buffer).
 */

import { describe, it, expect } from 'vitest';
import { compileToIR, compileAndRun } from './helpers/cli.js';

const FIXTURE = 'static_string_test.code';

// ── IR structure ──────────────────────────────────────────────────────────────

describe('static extension methods — IR structure', () => {

    it('emits @String_new as a define (not declare)', () => {
        const { ir } = compileToIR(FIXTURE);
        // Must be a definition with a body, not just a forward declare
        expect(ir).toMatch(/define\b.*\bvoid\b.*@String_new|define\b.*@String_new/);
    });

    it('@String_new calls @string_alloc internally', () => {
        const { ir } = compileToIR(FIXTURE);
        // The static method body must delegate to the C runtime function
        expect(ir).toContain('call i8* @string_alloc(');
    });

    it('emits @String_set as a define with self + i + v parameters', () => {
        const { ir } = compileToIR(FIXTURE);
        // define void @String_set(i8* %self.0, i32 %arg.0, i32 %arg.1)
        expect(ir).toMatch(/define\b.*@String_set\(.*%self\.0/);
    });

    it('@String_set calls @string_set_byte internally', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('call void @string_set_byte(');
    });

    it('call to String.new in @main uses @String_new (no self)', () => {
        const { ir } = compileToIR(FIXTURE);
        // In @main: call to String.new(5) → call i8* @String_new(i32 5)
        expect(ir).toContain('call i8* @String_new(i32 5)');
    });

    it('call to buf.set in @main uses @String_set with loaded self', () => {
        const { ir } = compileToIR(FIXTURE);
        // Instance method: loads the buffer pointer, then calls @String_set
        expect(ir).toMatch(/call void @String_set\(i8\* %\d+, i32 0, i32 72\)/);
    });

    it('declares @string_alloc (C runtime binding)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('declare i8* @string_alloc(i32)');
    });

    it('declares @string_set_byte (C runtime binding)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toContain('declare void @string_set_byte(i8*, i32, i32)');
    });

    it('no duplicate extern declarations in IR', () => {
        const { ir } = compileToIR(FIXTURE);
        // Count occurrences of declare for concat (historically duplicated)
        const matches = (ir.match(/^declare .*@concat\b/gm) ?? []);
        expect(matches.length).toBeLessThanOrEqual(1);
    });
});

// ── Runtime behaviour ─────────────────────────────────────────────────────────

describe('static extension methods — runtime', () => {

    it('exits with code 0', () => {
        const { exitCode } = compileAndRun(FIXTURE);
        expect(exitCode).toBe(0);
    });

    it('produces exactly 2 lines of output', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(stdout.trim().split('\n')).toHaveLength(2);
    });

    it('first line is "Hello" (bytes 72 101 108 108 111)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        const lines = stdout.trim().split('\n');
        expect(lines[0]).toBe('Hello');
    });

    it('second line is "5" (length of the 5-byte buffer)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        const lines = stdout.trim().split('\n');
        expect(lines[1]).toBe('5');
    });

    it('buffer is NUL-terminated (no extra garbage after 5 bytes)', () => {
        // The binary output must be exactly "Hello\n5\n" — no trailing junk
        const { stdout } = compileAndRun(FIXTURE);
        expect(stdout).toBe('Hello\n5\n');
    });
});
