/**
 * Tests for using Error-protocol values with `panic()`.
 *
 * Any type that conforms to the Error protocol (or any Displayable type with
 * a toString() extension) can be passed to panic().  The compiler
 * automatically emits a toString() call to obtain the i8* message string
 * before forwarding it to the C `runtime_panic` function.
 *
 * Covers:
 *   - Happy path: non-panicking branches compile and run correctly
 *   - IR: AppError path emits `AppError_toString` before `runtime_panic`
 *   - IR: HttpError path emits `HttpError_toString` before `runtime_panic`
 *   - IR: `runtime_panic` is declared `noreturn`
 */

import { describe, it, expect } from 'vitest';
import { compileAndRun, compileToIR } from './helpers/cli.js';

// ── happy-path runtime tests ──────────────────────────────────────────────────

describe('panic with Error protocol — happy path (no panic triggered)', () => {
    it('compiles without error', () =>
        expect(compileAndRun('panic_error_protocol.code').exitCode).toBe(0));

    it('checkPositive(42) prints 42', () => {
        const { stdout } = compileAndRun('panic_error_protocol.code');
        expect(stdout.trim().split('\n')[0]).toBe('42');
    });

    it('fetchResource(200) prints 200', () => {
        const { stdout } = compileAndRun('panic_error_protocol.code');
        expect(stdout.trim().split('\n')[1]).toBe('200');
    });

    it('full output is "42\\n200"', () => {
        const { stdout } = compileAndRun('panic_error_protocol.code');
        expect(stdout.trim().split('\n')).toEqual(['42', '200']);
    });
});

// ── IR structure tests ────────────────────────────────────────────────────────

describe('panic with Error protocol — IR structure', () => {
    it('declares runtime_panic as noreturn', () => {
        const { ir } = compileToIR('panic_error_protocol.code');
        expect(ir).toMatch(/declare void @runtime_panic\(i8\*\) noreturn/);
    });

    it('AppError panic branch calls AppError_toString before runtime_panic', () => {
        const { ir } = compileToIR('panic_error_protocol.code');
        // Find the checkPositive function and verify toString is called
        expect(ir).toMatch(/call i8\* @AppError_toString\(%AppError\* %\d+\)/);
    });

    it('HttpError panic branch calls HttpError_toString before runtime_panic', () => {
        const { ir } = compileToIR('panic_error_protocol.code');
        expect(ir).toMatch(/call i8\* @HttpError_toString\(%HttpError\* %\d+\)/);
    });

    it('toString result is passed directly to runtime_panic', () => {
        const { ir } = compileToIR('panic_error_protocol.code');
        // The pattern: %N = call i8* @X_toString(...) followed by runtime_panic(i8* %N)
        expect(ir).toMatch(/call i8\* @AppError_toString[^)]*\)\s+call void @runtime_panic/);
    });

    it('runtime_panic is called exactly twice (one per guarded function)', () => {
        const { ir } = compileToIR('panic_error_protocol.code');
        const calls = ir.match(/call void @runtime_panic/g) ?? [];
        expect(calls).toHaveLength(2);
    });

    it('each panic site is followed by unreachable', () => {
        const { ir } = compileToIR('panic_error_protocol.code');
        const matches = ir.match(/call void @runtime_panic\(i8\* %\d+\)\s+unreachable/g) ?? [];
        expect(matches).toHaveLength(2);
    });
});
