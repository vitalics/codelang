/**
 * Tests for stdlib/math.code — Math namespace.
 *
 * Covers:
 *  1. Constants (PI, E, LN2, LN10, LOG2E, LOG10E, SQRT2, TAU)
 *  2. Rounding (floor, ceil, round, trunc, sign)
 *  3. Absolute value (abs int, absF float)
 *  4. Powers / roots (sqrt, cbrt, pow, exp, exp2)
 *  5. Logarithms (log, log2, log10, log1p)
 *  6. Trigonometry (sin, cos, atan2)
 *  7. Hyperbolic (tanh)
 *  8. Min / max / clamp (int and float variants)
 *  9. Misc (hypot, fmod, toRadians, toDegrees)
 * 10. IEEE 754 queries (isNaN, isFinite, isInfinite)
 * 11. Random (seeded, finite, in range)
 */

import { describe, it, expect } from 'vitest';
import { compileToIR, compileAndRun } from './helpers/cli.js';

const FIXTURE = 'math_basic.code';

/** Split stdout into trimmed, non-empty lines. */
function lines(stdout: string): string[] {
    return stdout.trim().split('\n').map(l => l.trim()).filter(Boolean);
}

// =============================================================================
// Shared compilation — run once, check many things
// =============================================================================

describe('Math — constants', () => {

    it('Math.PI starts with 3.14159', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[0]).toMatch(/^3\.14159/);
    });

    it('Math.E starts with 2.71828', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[1]).toMatch(/^2\.71828/);
    });

    it('Math.SQRT2 starts with 1.41421', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[2]).toMatch(/^1\.41421/);
    });

    it('Math.LN2 starts with 0.69314', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[3]).toMatch(/^0\.69314/);
    });

    it('Math.TAU ≈ 2 × PI (starts with 6.28318)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[4]).toMatch(/^6\.28318/);
    });

});

describe('Math — rounding', () => {

    it('floor(4.7) == 4', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[5]).toBe('4');
    });

    it('ceil(4.2) == 5', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[6]).toBe('5');
    });

    it('round(4.5) == 5', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[7]).toBe('5');
    });

    it('trunc(-4.9) == -4', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[8]).toBe('-4');
    });

    it('sign(-7.3) == -1', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[9]).toBe('-1');
    });

    it('sign(0.0) == 0', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[10]).toBe('0');
    });

    it('sign(3.14) == 1', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[11]).toBe('1');
    });

});

describe('Math — absolute value', () => {

    it('abs(-42) == 42 (int)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[12]).toBe('42');
    });

    it('absF(-3.5) == 3.5 (float)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[13]).toBe('3.5');
    });

});

describe('Math — powers and roots', () => {

    it('sqrt(9.0) == 3', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[14]).toBe('3');
    });

    it('cbrt(27.0) == 3', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[15]).toBe('3');
    });

    it('pow(2.0, 10.0) == 1024', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[16]).toBe('1024');
    });

    it('exp(1.0) ≈ E', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[17]).toMatch(/^2\.71828/);
    });

    it('exp2(8.0) == 256', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[18]).toBe('256');
    });

});

describe('Math — logarithms', () => {

    it('log(E) == 1', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[19]).toBe('1');
    });

    it('log2(1024.0) == 10', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[20]).toBe('10');
    });

    it('log10(1000.0) == 3', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[21]).toBe('3');
    });

    it('log1p(0.0) == 0', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[22]).toBe('0');
    });

});

describe('Math — trigonometry', () => {

    it('sin(0.0) == 0', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[23]).toBe('0');
    });

    it('cos(0.0) == 1', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[24]).toBe('1');
    });

    it('atan2(1, 1) ≈ π/4', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[25]).toMatch(/^0\.785398/);
    });

});

describe('Math — hyperbolic', () => {

    it('tanh(0.0) == 0', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[26]).toBe('0');
    });

});

describe('Math — min / max / clamp', () => {

    it('min(3, 7) == 3', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[27]).toBe('3');
    });

    it('max(3, 7) == 7', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[28]).toBe('7');
    });

    it('minF(3.5, 7.5) == 3.5', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[29]).toBe('3.5');
    });

    it('maxF(3.5, 7.5) == 7.5', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[30]).toBe('7.5');
    });

    it('clamp(15, 0, 10) == 10 — clamps to upper bound', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[31]).toBe('10');
    });

    it('clamp(-5, 0, 10) == 0 — clamps to lower bound', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[32]).toBe('0');
    });

    it('clampF(0.8, 0.0, 1.0) == 0.8 — value already in range', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[33]).toBe('0.8');
    });

});

describe('Math — misc', () => {

    it('hypot(3, 4) == 5 — Pythagorean triple', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[34]).toBe('5');
    });

    it('fmod(10.0, 3.0) == 1', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[35]).toBe('1');
    });

    it('toRadians(180) == PI', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[36]).toMatch(/^3\.14159/);
    });

    it('toDegrees(PI) == 180', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[37]).toBe('180');
    });

});

describe('Math — IEEE 754 queries', () => {

    it('isNaN(0.0) == false', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[38]).toBe('false');
    });

    it('isFinite(1.0) == true', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[39]).toBe('true');
    });

    it('isInfinite(1.0) == false', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[40]).toBe('false');
    });

});

describe('Math — random', () => {

    it('seeded random() produces a finite value', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[41]).toBe('true');
    });

    it('seeded random() produces a value >= 0', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[42]).toBe('true');
    });

});

describe('Math — overall', () => {

    it('produces exactly 43 lines of output', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)).toHaveLength(43);
    });

    it('exits with code 0', () => {
        const { exitCode } = compileAndRun(FIXTURE);
        expect(exitCode).toBe(0);
    });

    it('IR structure: emits math_pi extern declaration', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/declare double @math_pi/);
    });

    it('IR structure: emits math_sin extern declaration', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/declare double @math_sin/);
    });

    it('IR structure: emits math_pow extern declaration', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/declare double @math_pow/);
    });

});
