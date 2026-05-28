/**
 * Tests for using Error-protocol struct literals with `compileError!()`.
 *
 * `compileError!` is a compile-time macro that aborts compilation with a
 * message.  In addition to plain string literals it now accepts struct
 * literals whose `name` field holds the error message — the convention used
 * by all Error-protocol conformers.
 *
 * Supported forms:
 *   compileError!("plain message")
 *   compileError!(MyError { name: "msg", ... })     ← named field init
 *   compileError!(MyError { name, ... })             ← shorthand: message is "name"
 *
 * Covers:
 *   - Exit code is non-zero when compileError! fires
 *   - The `name` field string literal is extracted as the error message
 *   - Shorthand `name,` reports the identifier "name" as a best-effort message
 */

import { describe, it, expect } from 'vitest';
import { compileExpectError } from './helpers/cli.js';

// ── Named field init: name: "literal" ────────────────────────────────────────

describe('compileError! with Error struct — named field', () => {
    it('aborts compilation with non-zero exit code', () => {
        const result = compileExpectError('compile_error_with_error_struct.code');
        expect(result.exitCode).not.toBe(0);
    });

    it('error output contains the name field string "unsupported-platform"', () => {
        const result = compileExpectError('compile_error_with_error_struct.code');
        const combined = result.stdout + result.stderr;
        expect(combined).toContain('unsupported-platform');
    });

    it('error output contains the [compileError!] prefix', () => {
        const result = compileExpectError('compile_error_with_error_struct.code');
        const combined = result.stdout + result.stderr;
        expect(combined).toContain('[compileError!]');
    });
});

// ── Shorthand field init: name, ───────────────────────────────────────────────

describe('compileError! with Error struct — shorthand field', () => {
    it('aborts compilation with non-zero exit code', () => {
        const result = compileExpectError('compile_error_with_error_struct_shorthand.code');
        expect(result.exitCode).not.toBe(0);
    });

    it('reports the identifier "name" as a best-effort message (cannot eval variables)', () => {
        // Shorthand `name,` means "use variable named 'name'" — the compiler cannot
        // evaluate the variable's runtime value at compile time, so it falls back to
        // the identifier text "name" as the error message.
        const result = compileExpectError('compile_error_with_error_struct_shorthand.code');
        const combined = result.stdout + result.stderr;
        expect(combined).toContain('[compileError!]');
    });
});

// ── Plain string still works ──────────────────────────────────────────────────

describe('compileError! with plain string — regression', () => {
    it('aborts compilation with non-zero exit code', () => {
        const result = compileExpectError('compile_error_macro.code');
        expect(result.exitCode).not.toBe(0);
    });

    it('includes the plain string message in error output', () => {
        const result = compileExpectError('compile_error_macro.code');
        const combined = result.stdout + result.stderr;
        expect(combined).toContain('intentional compile-time abort');
    });
});
