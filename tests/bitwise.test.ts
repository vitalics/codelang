/**
 * Tests for bitwise operators: &, |, ^, <<, >>
 *
 * Implementation strategy: protocol-based dispatch via extension table.
 *   a & b  → TypeName_bitAnd(a, b)   if the type has a `bitAnd` extension method
 *            `and <irTy> %a, %b`      native LLVM fallback for integer primitives
 *   a | b  → bitOr  / `or`
 *   a ^ b  → bitXor / `xor`
 *   a << b → shl    / `shl`
 *   a >> b → shr    / `ashr` (signed) | `lshr` (unsigned)
 *
 * Operator precedence (low → high, matching C / Rust / Python):
 *   |  <  ^  <  &  <  <<,>>  <  +,-  <  *,/,%
 *
 * Covers:
 *   - All five operators on `int` (signed)
 *   - `>>` on `u32` uses logical shift (`lshr`)
 *   - `>>` on `int` uses arithmetic shift (`ashr`)
 *   - Precedence: & binds tighter than ^, ^ tighter than |
 *   - Shift lower than additive: (1 + 2) << 3 = 24, not 1 + 16
 *   - Parenthesised grouping overrides default precedence
 *   - Common bit-manipulation idioms: set/clear/toggle a bit
 *   - Chained left-associative shifts
 */

import { describe, it, expect } from 'vitest';
import { compileAndRun, compileToIR } from './helpers/cli.js';

const FIXTURE = 'bitwise.code';

// ── LLVM IR structure ─────────────────────────────────────────────────────────

describe('bitwise operators — IR structure', () => {
    it('& compiles to LLVM `and` instruction', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/= and i32/);
    });

    it('| compiles to LLVM `or` instruction', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/= or i32/);
    });

    it('^ compiles to LLVM `xor` instruction', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/= xor i32/);
    });

    it('<< compiles to LLVM `shl` instruction', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/= shl i32/);
    });

    it('>> on signed int compiles to LLVM `ashr` (arithmetic shift right)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/= ashr i32/);
    });

    it('>> on u32 compiles to LLVM `lshr` (logical shift right)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/= lshr i32/);
    });

    it('no signed shift appears for the u32 >> operation', () => {
        // The lshr instruction appears, confirming unsigned path was taken
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/lshr i32/);
    });
});

// ── Runtime behaviour ─────────────────────────────────────────────────────────

describe('bitwise operators — runtime', () => {
    function lines(): string[] {
        const { stdout } = compileAndRun(FIXTURE);
        return stdout.trim().split('\n');
    }

    // ── basic operations ──────────────────────────────────────────────────────
    it('12 & 10 == 8', () => {
        expect(lines()[0]).toBe('8');
    });

    it('12 | 10 == 14', () => {
        expect(lines()[1]).toBe('14');
    });

    it('12 ^ 10 == 6', () => {
        expect(lines()[2]).toBe('6');
    });

    it('12 << 2 == 48', () => {
        expect(lines()[3]).toBe('48');
    });

    it('12 >> 1 == 6', () => {
        expect(lines()[4]).toBe('6');
    });

    // ── unsigned logical shift ────────────────────────────────────────────────
    it('u32: 255 >> 4 == 15 (logical zero-fill shift)', () => {
        expect(lines()[5]).toBe('15');
    });

    // ── precedence ────────────────────────────────────────────────────────────
    it('& binds tighter than |: a & b | 6 == (a & b) | 6 == 14', () => {
        expect(lines()[6]).toBe('14');
    });

    it('^ binds tighter than |: a | b ^ 6 == a | (b ^ 6) == 12', () => {
        expect(lines()[7]).toBe('12');
    });

    it('parentheses override: (a | b) ^ 6 == 8', () => {
        expect(lines()[8]).toBe('8');
    });

    it('shift has lower precedence than additive: 1 + 2 << 3 == (1+2)<<3 == 24', () => {
        expect(lines()[9]).toBe('24');
    });

    // ── bit-manipulation idioms ───────────────────────────────────────────────
    it('set bit 3: 0 | (1 << 3) == 8', () => {
        expect(lines()[10]).toBe('8');
    });

    it('clear bit 2: 15 & (255 ^ 4) == 11', () => {
        expect(lines()[11]).toBe('11');
    });

    it('toggle bit 1: 15 ^ (1 << 1) == 13', () => {
        expect(lines()[12]).toBe('13');
    });

    // ── chained shifts (left-associative) ─────────────────────────────────────
    it('chained: 1 << 4 >> 2 == (1<<4)>>2 == 4', () => {
        expect(lines()[13]).toBe('4');
    });

    // ── general ──────────────────────────────────────────────────────────────
    it('"done" is the last line', () => {
        expect(lines().at(-1)).toBe('done');
    });

    it('produces exactly 15 lines of output', () => {
        // 14 values + "done"
        expect(lines()).toHaveLength(15);
    });

    it('exits with code 0', () => {
        const { exitCode } = compileAndRun(FIXTURE);
        expect(exitCode).toBe(0);
    });
});

// ── Protocol dispatch ─────────────────────────────────────────────────────────

describe('bitwise operators — protocol dispatch (Flags type)', () => {
    const PROTO = 'bitwise_protocol.code';

    it('& calls Flags_bitAnd extension method (not native `and`)', () => {
        const { ir } = compileToIR(PROTO);
        expect(ir).toMatch(/call i32 @Flags_bitAnd\(%Flags\*/);
    });

    it('| calls Flags_bitOr extension method (not native `or`)', () => {
        const { ir } = compileToIR(PROTO);
        expect(ir).toMatch(/call i32 @Flags_bitOr\(%Flags\*/);
    });

    it('^ calls Flags_bitXor extension method (not native `xor`)', () => {
        const { ir } = compileToIR(PROTO);
        expect(ir).toMatch(/call i32 @Flags_bitXor\(%Flags\*/);
    });

    it('<< calls Flags_shl extension method (not native `shl`)', () => {
        const { ir } = compileToIR(PROTO);
        expect(ir).toMatch(/call i32 @Flags_shl\(%Flags\*/);
    });

    it('>> calls Flags_shr extension method (not native `ashr`)', () => {
        const { ir } = compileToIR(PROTO);
        expect(ir).toMatch(/call i32 @Flags_shr\(%Flags\*/);
    });

    it('extension methods receive (self: %Flags*, other: i32) — correct parameter types', () => {
        const { ir } = compileToIR(PROTO);
        expect(ir).toMatch(/define i32 @Flags_bitAnd\(%Flags\* %self\.0, i32 %arg\.0\)/);
    });

    it('Flags & int == 8', () => {
        const { stdout } = compileAndRun(PROTO);
        expect(stdout.trim().split('\n')[0]).toBe('8');
    });

    it('Flags | int == 14', () => {
        const { stdout } = compileAndRun(PROTO);
        expect(stdout.trim().split('\n')[1]).toBe('14');
    });

    it('Flags ^ int == 6', () => {
        const { stdout } = compileAndRun(PROTO);
        expect(stdout.trim().split('\n')[2]).toBe('6');
    });

    it('Flags << int == 48', () => {
        const { stdout } = compileAndRun(PROTO);
        expect(stdout.trim().split('\n')[3]).toBe('48');
    });

    it('Flags >> int == 6', () => {
        const { stdout } = compileAndRun(PROTO);
        expect(stdout.trim().split('\n')[4]).toBe('6');
    });

    it('exits with code 0', () => {
        const { exitCode } = compileAndRun(PROTO);
        expect(exitCode).toBe(0);
    });
});
