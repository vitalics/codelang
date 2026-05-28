/**
 * Tests for Countable (length()) and Indexable / at() protocols on Set and Map.
 *
 * Covers:
 *   IntSet    — Countable + at(i):int
 *   StringSet — Countable + Indexable (at(i):string)
 *   BoolSet   — Countable + at(i):bool
 *   FloatSet  — Countable
 *   DoubleSet — Countable
 *   NumberSet — Countable
 *   IntIntMap, IntStringMap, StringIntMap, StringStringMap — Countable
 *
 * Fixture: tests/fixtures/valid/set_countable_indexable.code
 *
 * Expected output (22 lines):
 *   3          — IntSet length()
 *   10         — IntSet at(0)
 *   20         — IntSet at(1)
 *   30         — IntSet at(2)
 *   3          — StringSet length()
 *   apple      — StringSet at(0)
 *   banana     — StringSet at(1)
 *   cherry     — StringSet at(2)
 *   2          — BoolSet length()
 *   false      — BoolSet at(0)
 *   true       — BoolSet at(1)
 *   3          — FloatSet length()
 *   3          — DoubleSet length()
 *   3          — NumberSet length()
 *   30         — IntSet at(-1)  (negative index: last element)
 *   banana     — StringSet at(-2) (negative index: second-to-last)
 *   0          — IntSet at(99)  (OOB → default 0)
 *   2          — length() == size() for IntSet
 *   2          — IntIntMap length()
 *   2          — IntStringMap length()
 *   2          — StringIntMap length()
 *   2          — StringStringMap length()
 */

import { describe, it, expect } from 'vitest';
import { compileToIR, compileAndRun } from './helpers/cli.js';

const FIXTURE = 'set_countable_indexable.code';

function lines(stdout: string): string[] {
    return stdout.trim().split('\n');
}

// =============================================================================
// 1. IR structure
// =============================================================================

describe('Countable/Indexable for Set — IR structure', () => {

    it('emits Countable length() call on IntSet (calls intset_size)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/@intset_size/);
    });

    it('emits at() call on IntSet (calls intset_at)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/@intset_at/);
    });

    it('emits Countable length() call on StringSet (calls stringset_size)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/@stringset_size/);
    });

    it('emits at() call on StringSet (calls stringset_at)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/@stringset_at/);
    });

    it('emits Countable length() on BoolSet (calls boolset_size)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/@boolset_size/);
    });

    it('emits at() call on BoolSet (calls boolset_at)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/@boolset_at/);
    });

    it('emits Countable length() on FloatSet (calls floatset_size)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/@floatset_size/);
    });

    it('emits Countable length() on DoubleSet (calls doubleset_size)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/@doubleset_size/);
    });

    it('emits Countable length() on NumberSet (calls numberset_size)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/@numberset_size/);
    });

    it('emits Countable length() on IntIntMap (calls intintmap_size)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/@intintmap_size/);
    });

    it('emits Countable length() on IntStringMap (calls intstringmap_size)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/@intstringmap_size/);
    });

    it('emits Countable length() on StringIntMap (calls stringintmap_size)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/@stringintmap_size/);
    });

    it('emits Countable length() on StringStringMap (calls stringstringmap_size)', () => {
        const { ir } = compileToIR(FIXTURE);
        expect(ir).toMatch(/@stringstringmap_size/);
    });
});

// =============================================================================
// 2. Runtime — Countable (length())
// =============================================================================

describe('Countable protocol for Sets — runtime', () => {

    it('IntSet.length() returns 3 after three adds', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[0]).toBe('3');
    });

    it('StringSet.length() returns 3 after three adds', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[4]).toBe('3');
    });

    it('BoolSet.length() returns 2 after adding false and true', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[8]).toBe('2');
    });

    it('FloatSet.length() returns 3 after three adds', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[11]).toBe('3');
    });

    it('DoubleSet.length() returns 3 after three adds', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[12]).toBe('3');
    });

    it('NumberSet.length() returns 3 after three adds', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[13]).toBe('3');
    });

    it('IntSet.length() equals IntSet.size()', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[17]).toBe('2');
    });
});

// =============================================================================
// 3. Runtime — Indexable / at() on Sets
// =============================================================================

describe('at() for Sets — runtime', () => {

    it('IntSet.at(0) returns 10 (first in sorted order)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[1]).toBe('10');
    });

    it('IntSet.at(1) returns 20', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[2]).toBe('20');
    });

    it('IntSet.at(2) returns 30', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[3]).toBe('30');
    });

    it('StringSet.at(0) returns "apple" (first in lex order)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[5]).toBe('apple');
    });

    it('StringSet.at(1) returns "banana"', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[6]).toBe('banana');
    });

    it('StringSet.at(2) returns "cherry"', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[7]).toBe('cherry');
    });

    it('BoolSet.at(0) returns false (false < true in sorted order)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[9]).toBe('false');
    });

    it('BoolSet.at(1) returns true', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[10]).toBe('true');
    });

    it('IntSet.at(-1) returns 30 (last element)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[14]).toBe('30');
    });

    it('StringSet.at(-2) returns "banana" (second-to-last)', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[15]).toBe('banana');
    });

    it('IntSet.at(99) returns 0 for out-of-bounds', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[16]).toBe('0');
    });
});

// =============================================================================
// 4. Runtime — Countable (length()) on Maps
// =============================================================================

describe('Countable protocol for Maps — runtime', () => {

    it('IntIntMap.length() returns 2 after two puts', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[18]).toBe('2');
    });

    it('IntStringMap.length() returns 2 after two puts', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[19]).toBe('2');
    });

    it('StringIntMap.length() returns 2 after two puts', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[20]).toBe('2');
    });

    it('StringStringMap.length() returns 2 after two puts', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)[21]).toBe('2');
    });
});

// =============================================================================
// 5. Exit code and line count
// =============================================================================

describe('set_countable_indexable — overall', () => {

    it('produces exactly 22 lines of output', () => {
        const { stdout } = compileAndRun(FIXTURE);
        expect(lines(stdout)).toHaveLength(22);
    });

    it('exits with code 0', () => {
        const { exitCode } = compileAndRun(FIXTURE);
        expect(exitCode).toBe(0);
    });
});
