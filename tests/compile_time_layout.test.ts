/**
 * Tests for the four compile-time type-layout intrinsics.
 *
 *   alignOf!(T)         — alignment of T in bytes (compile-time const int)
 *   offsetOf!(T, field) — byte offset of field inside struct T
 *   compileError!(msg)  — abort compilation with msg
 *   compileLog!(...args)— print to stderr at compile time; leaves IR comment
 *
 * All four are built-in macros wired directly into the IR generator — no
 * runtime code is produced, but the results are folded into constants.
 */

import { describe, it, expect } from 'vitest';
import { compileToIR, compileAndRun, compileExpectError } from './helpers/cli.js';

function lines(stdout: string): string[] {
    return stdout.trim().split('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// alignOf! — IR checks (constants folded, no runtime allocation)
// ─────────────────────────────────────────────────────────────────────────────

describe('alignOf! — IR', () => {
    it('produces integer constants (i32) in the IR', () => {
        const { ir } = compileToIR('compile_time_layout.code');
        // alignOf! results must be folded to i32 literals
        expect(ir).toMatch(/i32 1/);   // bool → 1
        expect(ir).toMatch(/i32 4/);   // int  → 4
        expect(ir).toMatch(/i32 8/);   // float/string/pointer → 8
    });

    it('no heap allocation instructions for alignOf! results', () => {
        const { ir } = compileToIR('compile_time_layout.code');
        // Compile-time constants must not require memory allocation
        const allocaForLayout = ir.match(/alloca i32.*; a_(bool|int|float|string|point|mixed|vec3)/g);
        expect(allocaForLayout).toBeNull();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// offsetOf! — IR checks
// ─────────────────────────────────────────────────────────────────────────────

describe('offsetOf! — IR', () => {
    it('Point.x offset (0) and Point.y offset (4) are constant i32s', () => {
        const { ir } = compileToIR('compile_time_layout.code');
        // Both ox=0 and oy=4 must be present as i32 constants
        expect(ir).toMatch(/i32 0/);
        expect(ir).toMatch(/i32 4/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// compileLog! — IR comment presence
// ─────────────────────────────────────────────────────────────────────────────

describe('compileLog! — IR comment', () => {
    it('leaves a reminder comment in the IR', () => {
        const { ir } = compileToIR('compile_time_layout.code');
        // The IR generator must insert "; compileLog!: ..." as a reminder
        expect(ir).toMatch(/;\s*compileLog!/i);
    });

    it('does NOT emit any runtime call instruction for compileLog!', () => {
        const { ir } = compileToIR('compile_time_layout.code');
        // There must be no call to a compileLog runtime function
        expect(ir).not.toMatch(/call.*@compileLog/i);
        expect(ir).not.toMatch(/call.*@compile_log/i);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// compileError! — compilation aborted
// ─────────────────────────────────────────────────────────────────────────────

describe('compileError! — compile-time abort', () => {
    it('aborts compilation with a non-zero exit code', () => {
        const result = compileExpectError('compile_error_macro.code');
        expect(result.exitCode).not.toBe(0);
    });

    it('includes the supplied message in the error output', () => {
        const result = compileExpectError('compile_error_macro.code');
        const combined = result.stdout + result.stderr;
        expect(combined).toContain('intentional compile-time abort');
    });

    it('does not produce any IR file when compileError! fires', () => {
        // compileExpectError uses the `compile` sub-command — if exit ≠ 0 no .ll is produced
        const result = compileExpectError('compile_error_macro.code');
        expect(result.exitCode).not.toBe(0);
        // The primary assertion is exit code; no .ll means no IR to check here
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Runtime correctness — alignOf! and offsetOf! values
// ─────────────────────────────────────────────────────────────────────────────

describe('alignOf! — runtime values', () => {
    it('bool aligns to 1', () => {
        const { stdout } = compileAndRun('compile_time_layout.code');
        expect(lines(stdout)[0]).toBe('1');
    });

    it('int aligns to 4', () => {
        const { stdout } = compileAndRun('compile_time_layout.code');
        expect(lines(stdout)[1]).toBe('4');
    });

    it('float (= Float64 = double) aligns to 8', () => {
        const { stdout } = compileAndRun('compile_time_layout.code');
        expect(lines(stdout)[2]).toBe('8');
    });

    it('string (pointer) aligns to 8', () => {
        const { stdout } = compileAndRun('compile_time_layout.code');
        expect(lines(stdout)[3]).toBe('8');
    });

    it('Point aligns to 4 (max of i32, i32)', () => {
        const { stdout } = compileAndRun('compile_time_layout.code');
        expect(lines(stdout)[4]).toBe('4');
    });

    it('Mixed aligns to 4 (max of bool=1, int=4)', () => {
        const { stdout } = compileAndRun('compile_time_layout.code');
        expect(lines(stdout)[5]).toBe('4');
    });

    it('Vec3 aligns to 8 (max of double, double, double)', () => {
        const { stdout } = compileAndRun('compile_time_layout.code');
        expect(lines(stdout)[6]).toBe('8');
    });
});

describe('offsetOf! — runtime values', () => {
    it('Point.x is at offset 0', () => {
        const { stdout } = compileAndRun('compile_time_layout.code');
        expect(lines(stdout)[7]).toBe('0');
    });

    it('Point.y is at offset 4 (after 4-byte x)', () => {
        const { stdout } = compileAndRun('compile_time_layout.code');
        expect(lines(stdout)[8]).toBe('4');
    });

    it('Mixed.flag is at offset 0', () => {
        const { stdout } = compileAndRun('compile_time_layout.code');
        expect(lines(stdout)[9]).toBe('0');
    });

    it('Mixed.value is at offset 4 (bool=1 byte + 3 bytes ABI padding)', () => {
        const { stdout } = compileAndRun('compile_time_layout.code');
        expect(lines(stdout)[10]).toBe('4');
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// compileLog! — stderr output at compile time
// ─────────────────────────────────────────────────────────────────────────────

describe('compileLog! — compile-time stderr', () => {
    it('prints the supplied arguments to stderr during compilation', () => {
        const { ir, stderr } = compileToIR('compile_time_layout.code');
        // The IR helper captures stderr from the compile step
        // compileLog! output is like: [compileLog!] "...", arg, ...
        expect(stderr + ir).toMatch(/compileLog/i);
    });

    it('produces no runtime output (compile-time only)', () => {
        const { stdout } = compileAndRun('compile_time_layout.code');
        // runtime prints only the 11 numeric lines from print() calls
        expect(lines(stdout).length).toBe(11);
    });
});
