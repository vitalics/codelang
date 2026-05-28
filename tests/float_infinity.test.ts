/**
 * Tests for Float64.inf / Float64.negInf (short) and
 * Float64.Infinity / Float64.NegativeInfinity (long-hand aliases).
 *
 * inf    / Infinity         → intrinsic("inf")    — positive IEEE 754 infinity (double)
 * negInf / NegativeInfinity → intrinsic("negInf") — negative IEEE 754 infinity (double)
 *
 * Both types resolve to `double` in LLVM IR.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { compileAndRun } from './helpers/cli.js';

// ── short-hand: Float64.inf / Float64.negInf ──────────────────────────────────

let lines:    string[]    = [];
let ir:       string      = '';
let exitCode: number|null = null;

// ── long-hand: Float64.Infinity / Float64.NegativeInfinity ───────────────────

let aliasLines:    string[]    = [];
let aliasIR:       string      = '';
let aliasExitCode: number|null = null;

beforeAll(() => {
    const r  = compileAndRun('float_infinity.code');
    exitCode = r.exitCode;
    lines    = r.stdout.trim().split('\n');
    ir       = r.ir;

    const a  = compileAndRun('float_infinity_aliases.code');
    aliasExitCode = a.exitCode;
    aliasLines    = a.stdout.trim().split('\n');
    aliasIR       = a.ir;
}, 120_000);

// ── short-hand runtime ────────────────────────────────────────────────────────

describe('Float64.inf / Float64.negInf — runtime values', () => {
    it('compiles and exits cleanly', () => {
        expect(exitCode).toBe(0);
    });

    it('Float64.inf prints as "inf"', () => {
        expect(lines[0]).toBe('inf');
    });

    it('Float64.negInf prints as "-inf"', () => {
        expect(lines[1]).toBe('-inf');
    });

    it('Float64.inf > 1000.0 is true', () => {
        expect(lines[2]).toBe('true');
    });

    it('Float64.negInf < -1000.0 is true', () => {
        expect(lines[3]).toBe('true');
    });
});

// ── short-hand IR ─────────────────────────────────────────────────────────────

describe('Float64.inf / Float64.negInf — LLVM IR', () => {
    it('f64_positive_infinity is declared as returning double', () => {
        expect(ir).toMatch(/declare double @f64_positive_infinity\(\)/);
    });

    it('f64_negative_infinity is declared as returning double', () => {
        expect(ir).toMatch(/declare double @f64_negative_infinity\(\)/);
    });

    it('Float64_inf static property returns double', () => {
        expect(ir).toMatch(/define private double @Float64_inf\(\)/);
    });

    it('Float64_negInf static property returns double', () => {
        expect(ir).toMatch(/define private double @Float64_negInf\(\)/);
    });

    it('infinity variables are allocated as double (not float or i32)', () => {
        const allocaDoubleCount = (ir.match(/alloca double/g) ?? []).length;
        expect(allocaDoubleCount).toBeGreaterThanOrEqual(2);
    });

    it('comparison with infinity uses fcmp (float opcode, not icmp)', () => {
        expect(ir).toMatch(/fcmp ogt double/);
        expect(ir).toMatch(/fcmp olt double/);
    });
});

// ── long-hand runtime ─────────────────────────────────────────────────────────

describe('Float64.Infinity / Float64.NegativeInfinity — runtime values', () => {
    it('compiles and exits cleanly', () => {
        expect(aliasExitCode).toBe(0);
    });

    it('Float64.Infinity prints as "inf"', () => {
        expect(aliasLines[0]).toBe('inf');
    });

    it('Float64.NegativeInfinity prints as "-inf"', () => {
        expect(aliasLines[1]).toBe('-inf');
    });

    it('Float64.Infinity > 9999.0 is true', () => {
        expect(aliasLines[2]).toBe('true');
    });

    it('Float64.NegativeInfinity < -9999.0 is true', () => {
        expect(aliasLines[3]).toBe('true');
    });
});

// ── long-hand IR ──────────────────────────────────────────────────────────────

describe('Float64.Infinity / Float64.NegativeInfinity — LLVM IR', () => {
    it('Float64_Infinity static property returns double', () => {
        expect(aliasIR).toMatch(/define private double @Float64_Infinity\(\)/);
    });

    it('Float64_NegativeInfinity static property returns double', () => {
        expect(aliasIR).toMatch(/define private double @Float64_NegativeInfinity\(\)/);
    });
});
