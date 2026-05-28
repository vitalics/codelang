/**
 * Tests for stdlib/random.code — Random namespace.
 *
 * Covers:
 *  1. Seed / reproducibility (Random.seed)
 *  2. Core float generator — range [0, 1) (Random.float, Random.uniform)
 *  3. Integer generator — range [lo, hi] (Random.randInt, fixed boundary)
 *  4. Boolean generators — bool(), coin(p)
 *  5. Statistical distributions — gauss, exponential, triangular
 *  6. Array shuffle — shuffleInts (Fisher-Yates, sum preserved)
 *  7. Array choice — chooseInt (Some/None), chooseString (Some)
 *  8. IR structure — extern declarations present
 */

import { describe, it, expect } from 'vitest';
import { compileToIR, compileAndRun } from './helpers/cli.js';

const FIXTURE = 'random_basic.code';

/** Split stdout into trimmed, non-empty lines. */
function lines(stdout: string): string[] {
    return stdout.trim().split('\n').map(l => l.trim()).filter(Boolean);
}

// =============================================================================
// Core float
// =============================================================================

describe('Random — float()', () => {

    it('float() >= 0.0 (seed 42)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[0]).toBe('true');
    });

    it('float() < 1.0 (seed 42)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[1]).toBe('true');
    });

    it('second float() call also >= 0.0', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[2]).toBe('true');
    });

});

describe('Random — uniform()', () => {

    it('uniform(10, 20) >= 10.0', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[3]).toBe('true');
    });

    it('uniform(10, 20) < 20.0', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[4]).toBe('true');
    });

});

// =============================================================================
// Integer generator
// =============================================================================

describe('Random — randInt()', () => {

    it('randInt(1,6) >= 1 — first roll', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[5]).toBe('true');
    });

    it('randInt(1,6) <= 6 — first roll', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[6]).toBe('true');
    });

    it('randInt(1,6) >= 1 — second roll', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[7]).toBe('true');
    });

    it('randInt(1,6) >= 1 — third roll', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[8]).toBe('true');
    });

    it('randInt(7,7) == 7 — fixed boundary always returns the single value', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[9]).toBe('7');
    });

});

// =============================================================================
// Boolean generators
// =============================================================================

describe('Random — bool() and coin(p)', () => {

    it('bool() returns a valid boolean (seed 0, b1)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        const v = lines(stdout)[10];
        expect(['true', 'false']).toContain(v);
    });

    it('bool() returns a valid boolean (seed 0, b2)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        const v = lines(stdout)[11];
        expect(['true', 'false']).toContain(v);
    });

    it('coin(1.0) always returns true', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[12]).toBe('true');
    });

    it('coin(0.0) always returns false', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[13]).toBe('false');
    });

});

// =============================================================================
// Statistical distributions
// =============================================================================

describe('Random — gauss()', () => {

    it('gauss(0, 1) is not NaN  (g == g is true)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[14]).toBe('true');
    });

});

describe('Random — exponential()', () => {

    it('exponential(1.0) > 0 (always positive)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[15]).toBe('true');
    });

});

describe('Random — triangular()', () => {

    it('triangular(0, 10, 5) >= 0.0', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[16]).toBe('true');
    });

    it('triangular(0, 10, 5) <= 10.0', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[17]).toBe('true');
    });

});

// =============================================================================
// Array operations
// =============================================================================

describe('Random — shuffleInts()', () => {

    it('shuffled [1,2,3,4,5] sum == 15 (elements preserved)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[18]).toBe('15');
    });

});

describe('Random — chooseInt()', () => {

    it('chooseInt on non-empty array returns Some', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[19]).toBe('true');
    });

    it('chosen value >= 10', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[20]).toBe('true');
    });

    it('chosen value <= 30', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[21]).toBe('true');
    });

    it('chooseInt on empty array returns None', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[22]).toBe('true');
    });

});

describe('Random — shuffleStrings() / chooseString()', () => {

    it('shuffled string array preserves length (== 3)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[23]).toBe('3');
    });

    it('chooseString on shuffled array returns Some', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[24]).toBe('true');
    });

});

// =============================================================================
// Overall / IR structure
// =============================================================================

describe('Random — overall', () => {

    it('produces exactly 25 lines of output', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)).toHaveLength(25);
    });

    it('exits with code 0', () => {
        const { exitCode } = compileAndRun(FIXTURE);
        expect(exitCode).toBe(0);
    });

    it('IR: declares random_seed extern', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/declare void @random_seed/);
    });

    it('IR: declares random_float extern', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/declare double @random_float/);
    });

    it('IR: declares random_int extern', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/declare i32 @random_int/);
    });

    it('IR: declares random_shuffle_ints extern', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/declare void @random_shuffle_ints/);
    });

    it('IR: declares random_shuffle_strings extern', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/declare void @random_shuffle_strings/);
    });

    it('IR: declares random_choice_int extern', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/declare i32 @random_choice_int/);
    });

    it('IR: declares random_choice_string extern', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/declare i32 @random_choice_string/);
    });

});
