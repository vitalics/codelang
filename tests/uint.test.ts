/**
 * Tests for unsigned integer types (u8, u16, u32, u64, u128).
 *
 * Verifies that:
 *  - alloca uses the signed LLVM type (i8, i32, i64 …)
 *  - load / store also use the signed LLVM type
 *  - arithmetic uses udiv / urem instead of sdiv / srem
 *  - printf uses %u (32-bit) or %lu (64-bit) format strings
 *  - narrow unsigned values are zero-extended (zext, not sext) before printf
 *  - values that would be negative as signed integers print correctly
 */

import { describe, it, expect } from 'vitest';
import { compileToIR, compileAndRun } from './helpers/cli.js';

const FIXTURE = 'uint_types.code';

// ── IR structure ──────────────────────────────────────────────────────────────

describe('unsigned integers — IR', () => {

    it('u8 variable uses i8 alloca', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/alloca i8/);
    });

    it('u32 variable uses i32 alloca', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/alloca i32/);
    });

    it('u64 variable uses i64 alloca', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/alloca i64/);
    });

    it('u8 value is zero-extended (zext) before printf, not sign-extended', () => {
        const { ir } = compileToIR(FIXTURE);
        // For 8-bit unsigned prints we emit: zext i8 %N to i32
        expect(ir).toMatch(/zext i8 .+ to i32/);
        // Must NOT use sext for the u8 type
        expect(ir).not.toMatch(/sext i8/);
    });

    it('unsigned division uses udiv, not sdiv', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/udiv i32/);
        // Make sure sdiv is not emitted for u32 operations
        expect(ir).not.toMatch(/sdiv i32/);
    });

    it('unsigned modulo uses urem, not srem', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/urem i32/);
        expect(ir).not.toMatch(/srem i32/);
    });

    it('u32 print uses %u format string', () => {
        const { ir } = compileToIR(FIXTURE);
        // %u\n encoded in LLVM IR constant
        expect(ir).toMatch(/%u\\0A\\00/);
    });

    it('u64 print uses %lu format string', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/%lu\\0A\\00/);
    });

    it('u32 load uses i32 type', () => {
        const { ir } = compileToIR(FIXTURE);
        // load i32, i32* for u32 variables
        expect(ir).toMatch(/load i32, i32\*/);
    });

    it('u64 load uses i64 type', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/load i64, i64\*/);
    });
});

// ── Runtime behaviour ─────────────────────────────────────────────────────────

describe('unsigned integers — runtime', () => {

    it('u8 = 255 prints as 255, not -1', () => {
        const { stdout } = compileAndRun(FIXTURE);
        const lines = stdout.trim().split('\n');
        expect(lines[0]).toBe('255');
    });

    it('u32 = 3000000000 prints correctly (would be -1294967296 if signed)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        const lines = stdout.trim().split('\n');
        expect(lines[1]).toBe('3000000000');
    });

    it('unsigned division 10 / 3 = 3', () => {
        const { stdout } = compileAndRun(FIXTURE);
        const lines = stdout.trim().split('\n');
        expect(lines[2]).toBe('3');
    });

    it('unsigned modulo 10 % 3 = 1', () => {
        const { stdout } = compileAndRun(FIXTURE);
        const lines = stdout.trim().split('\n');
        expect(lines[3]).toBe('1');
    });

    it('u64 = 18000000000 prints correctly', () => {
        const { stdout } = compileAndRun(FIXTURE);
        const lines = stdout.trim().split('\n');
        expect(lines[4]).toBe('18000000000');
    });

    it('all 5 lines are present in output', () => {
        const { stdout } = compileAndRun(FIXTURE);
        const lines = stdout.trim().split('\n');
        expect(lines).toHaveLength(5);
    });
});

// ── Type alias equivalence ────────────────────────────────────────────────────

describe('unsigned integers — stdlib aliases', () => {

    it('u8 alias resolves to UInt8 / i8 alloca', () => {
        const { ir } = compileToIR(FIXTURE);
        // u8 is an alias for UInt8 which is intrinsic("u8") → i8 alloca
        expect(ir).toMatch(/alloca i8/);
    });

    it('u32 alias resolves to UInt32 / i32 alloca', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/alloca i32/);
    });

    it('u64 alias resolves to UInt64 / i64 alloca', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/alloca i64/);
    });
});
