/**
 * Tests for Option-returning safe accessor methods on stdlib collections.
 *
 *   IntArray.getSafe(i)         → Option<int>
 *   StringArray.getSafe(i)      → Option<string>
 *   IntArray.popSafe()          → Option<int>
 *   IntArray.firstSafe()        → Option<int>
 *   IntIntMap.getSafe(key)      → Option<int>
 *   StringStringMap.getSafe(k)  → Option<string>
 *   IntSet.atSafe(i)            → Option<int>
 */

import { describe, it, expect } from 'vitest';
import { compileAndRun } from './helpers/cli.js';

const FIXTURE = 'safe_collections.code';

/** Split stdout into trimmed, non-empty lines. */
function lines(stdout: string): string[] {
    return stdout.trim().split('\n').map(l => l.trim()).filter(Boolean);
}

// =============================================================================
// IntArray.getSafe
// =============================================================================

describe('IntArray.getSafe — bounds-checked access', () => {

    it('getSafe(0) returns Some(10)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[0]).toBe('10');
    });

    it('getSafe(2) returns Some(30)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[1]).toBe('30');
    });

    it('getSafe(3) returns None (out of bounds)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[2]).toBe('-1');
    });

    it('getSafe(-1) returns None (negative OOB)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[3]).toBe('-1');
    });

    it('getSafe(valid).isSome() == true', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[4]).toBe('true');
    });

    it('getSafe(OOB).isNone() == true', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[5]).toBe('true');
    });

});

// =============================================================================
// StringArray.getSafe
// =============================================================================

describe('StringArray.getSafe — bounds-checked access', () => {

    it('getSafe(1) returns Some("bar")', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[6]).toBe('bar');
    });

    it('getSafe(99) returns None', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[7]).toBe('none');
    });

});

// =============================================================================
// IntIntMap.getSafe
// =============================================================================

describe('IntIntMap.getSafe — safe key lookup', () => {

    it('getSafe(existing key) returns Some(value)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[8]).toBe('100');
    });

    it('getSafe(missing key) returns None', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[9]).toBe('-1');
    });

});

// =============================================================================
// StringStringMap.getSafe
// =============================================================================

describe('StringStringMap.getSafe — safe key lookup', () => {

    it('getSafe(existing key) returns Some("value")', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[10]).toBe('value');
    });

    it('getSafe(missing key) returns None', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[11]).toBe('none');
    });

});

// =============================================================================
// IntSet.atSafe
// =============================================================================

describe('IntSet.atSafe — bounds-checked indexed access', () => {

    it('atSafe(1) returns Some(15)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[12]).toBe('15');
    });

    it('atSafe(5) returns None (OOB)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[13]).toBe('-1');
    });

});

// =============================================================================
// IntArray.popSafe and firstSafe
// =============================================================================

describe('IntArray.popSafe and firstSafe', () => {

    it('popSafe on empty array returns None', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[14]).toBe('-1');
    });

    it('firstSafe on non-empty array returns Some(42)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[15]).toBe('42');
    });

});

// =============================================================================
// Overall
// =============================================================================

describe('safe_collections — overall output', () => {

    it('produces exactly 16 lines of output', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)).toHaveLength(16);
    });

    it('exits with code 0', () => {
        const { exitCode } = compileAndRun(FIXTURE);
        expect(exitCode).toBe(0);
    });

});
