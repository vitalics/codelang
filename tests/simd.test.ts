/**
 * SIMD vector type tests — Float2, Float4, Float8, Float16
 *
 * Exercises the stdlib/simd.code extensions: construction, element access,
 * arithmetic operators, length / normalize, dot / cross, sum / get, and
 * the Displayable toString() path for each type.
 *
 * Float8 / Float16 use a pointer-based C ABI (runtime/simd.c) to work
 * around the ARM64 AAPCS64 limit of 128-bit NEON registers.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { compileAndRun } from './helpers/cli.js';

let lines:    string[]    = [];
let ir:       string      = '';
let exitCode: number|null = null;

beforeAll(() => {
    const r  = compileAndRun('simd_basic.code');
    exitCode = r.exitCode;
    lines    = r.stdout.trim().split('\n');
    ir       = r.ir;
}, 300_000);

// ── Compilation ───────────────────────────────────────────────────────────────

describe('simd_basic — compilation', () => {
    it('compiles and exits with code 0', () => {
        expect(exitCode).toBe(0);
    });
});

// ── Float2 — construction / element access ────────────────────────────────────

describe('Float2 — element access', () => {
    it('a.x() === 3', () => expect(lines[0]).toBe('3'));
    it('a.y() === 4', () => expect(lines[1]).toBe('4'));
    it('print(a) → Float2(3, 4)', () => expect(lines[2]).toBe('Float2(3, 4)'));
});

// ── Float2 — arithmetic operators ─────────────────────────────────────────────

describe('Float2 — arithmetic', () => {
    it('a + b === Float2(4, 6)',  () => expect(lines[3]).toBe('Float2(4, 6)'));
    it('a - b === Float2(2, 2)',  () => expect(lines[4]).toBe('Float2(2, 2)'));
    it('a * b === Float2(3, 8)',  () => expect(lines[5]).toBe('Float2(3, 8)'));
});

// ── Float2 — length / normalize ───────────────────────────────────────────────

describe('Float2 — length and normalize', () => {
    it('a.length() === 5',          () => expect(lines[6]).toBe('5'));
    it('unit.x() ≈ 0.6',            () => expect(parseFloat(lines[7])).toBeCloseTo(0.6, 5));
    it('unit.y() ≈ 0.8',            () => expect(parseFloat(lines[8])).toBeCloseTo(0.8, 5));
});

// ── Float2 — dot product ──────────────────────────────────────────────────────

describe('Float2 — dot product', () => {
    it('a.dot(b) === 11', () => expect(lines[9]).toBe('11'));
});

// ── Float4 — construction / element access ────────────────────────────────────

describe('Float4 — element access', () => {
    it('v.x() === 1', () => expect(lines[10]).toBe('1'));
    it('v.y() === 2', () => expect(lines[11]).toBe('2'));
    it('v.z() === 3', () => expect(lines[12]).toBe('3'));
    it('v.w() === 4', () => expect(lines[13]).toBe('4'));
    it('print(v) → Float4(1, 2, 3, 4)', () => expect(lines[14]).toBe('Float4(1, 2, 3, 4)'));
});

// ── Float4 — arithmetic operators ─────────────────────────────────────────────

describe('Float4 — arithmetic', () => {
    it('v * splat(2) === Float4(2, 4, 6, 8)', () => expect(lines[15]).toBe('Float4(2, 4, 6, 8)'));
    it('v + splat(2) === Float4(3, 4, 5, 6)', () => expect(lines[16]).toBe('Float4(3, 4, 5, 6)'));
});

// ── Float4 — cross / dot ──────────────────────────────────────────────────────

describe('Float4 — dot3 / cross3', () => {
    it('unitX.cross3(unitY) === Float4(0, 0, 1, 0)', () => expect(lines[17]).toBe('Float4(0, 0, 1, 0)'));
    it('unitX.dot3(unitY)   === 0',                   () => expect(lines[18]).toBe('0'));
});

// ── Float4 — length3 ─────────────────────────────────────────────────────────

describe('Float4 — length3', () => {
    it('Float4.xyz(0,3,4).length3() === 5', () => expect(lines[19]).toBe('5'));
});

// ── Float8 — construction / get / sum ────────────────────────────────────────

describe('Float8 — construction, get, sum', () => {
    it('w.sum() === 36',    () => expect(lines[20]).toBe('36'));
    it('w.get(0) === 1',    () => expect(lines[21]).toBe('1'));
    it('w.get(7) === 8',    () => expect(lines[22]).toBe('8'));
    it('ws.sum() === 52',   () => expect(lines[23]).toBe('52'));
});

// ── IR — wide SIMD pointer-based ABI ─────────────────────────────────────────

describe('LLVM IR — Float8 uses pointer-based ABI', () => {
    it('float8_of declared as void with float* out-param', () => {
        expect(ir).toContain('declare void @float8_of(float*');
    });
    it('float8_sum declared with float* parameter (not <8 x float>)', () => {
        expect(ir).toContain('declare float @float8_sum(float*)');
    });
    it('float8_splat declared as void with float* out-param', () => {
        expect(ir).toContain('declare void @float8_splat(float*');
    });
});
