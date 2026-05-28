/**
 * Tests for HOF (higher-order function) methods on collection types:
 *   IntArray  — forEach, map, filter, every, some, reduce, find, findIndex
 *   IntSet    — forEach, every, some, filter, find
 *   StringArray — some, filter, find, findIndex
 *
 * The fixture imports stdlib/collections.code, which re-exports array.code,
 * map.code, and set.code.  All 31 expected output lines are verified.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { compileAndRun } from './helpers/cli.js';

const FIXTURE = 'functional_collections.code';

// ── Shared output — compiled ONCE for all tests ───────────────────────────────
//
// Each test used to call compileAndRun() independently, triggering 33 separate
// clang compilations that caused resource exhaustion and flaky timeouts.
// Now we compile a single time in beforeAll() and share the stdout lines.

let _lines:    string[]    = [];
let _exitCode: number|null = null;

beforeAll(() => {
    const result = compileAndRun(FIXTURE);
    _exitCode = result.exitCode;
    _lines    = result.stdout.trim().split('\n');
});

function lines(): string[] { return _lines; }

// ── Top-level sanity ──────────────────────────────────────────────────────────

describe('functional_collections — sanity', () => {
    it('exits with code 0', () => {
        expect(_exitCode).toBe(0);
    });

    it('produces exactly 31 lines of output', () => {
        expect(lines()).toHaveLength(31);
    });
});

// ── IntArray.forEach ──────────────────────────────────────────────────────────

describe('IntArray.forEach', () => {
    it('prints element 0 → 1', () => expect(lines()[0]).toBe('1'));
    it('prints element 1 → 2', () => expect(lines()[1]).toBe('2'));
    it('prints element 2 → 3', () => expect(lines()[2]).toBe('3'));
    it('prints element 3 → 4', () => expect(lines()[3]).toBe('4'));
    it('prints element 4 → 5', () => expect(lines()[4]).toBe('5'));
});

// ── IntArray.map ──────────────────────────────────────────────────────────────

describe('IntArray.map', () => {
    it('map(double)[0] == 2  (1 * 2)', () => expect(lines()[5]).toBe('2'));
    it('map(double)[4] == 10 (5 * 2)', () => expect(lines()[6]).toBe('10'));
});

// ── IntArray.filter ───────────────────────────────────────────────────────────

describe('IntArray.filter', () => {
    it('filter(isEven).length() == 2', () => expect(lines()[7]).toBe('2'));
    it('filter(isEven)[0] == 2',       () => expect(lines()[8]).toBe('2'));
    it('filter(isEven)[1] == 4',       () => expect(lines()[9]).toBe('4'));
});

// ── IntArray.every ────────────────────────────────────────────────────────────

describe('IntArray.every', () => {
    it('every(isPositive) is true  → prints 1', () => expect(lines()[10]).toBe('1'));
    it('every(isEven)     is false → prints 0', () => expect(lines()[11]).toBe('0'));
});

// ── IntArray.some ─────────────────────────────────────────────────────────────

describe('IntArray.some', () => {
    it('some(isEven)   is true  → prints 1', () => expect(lines()[12]).toBe('1'));
    it('some(x > 99)   is false → prints 0', () => expect(lines()[13]).toBe('0'));
});

// ── IntArray.reduce ───────────────────────────────────────────────────────────

describe('IntArray.reduce', () => {
    it('reduce(addInts, 0) == 15  (1+2+3+4+5)', () => expect(lines()[14]).toBe('15'));
});

// ── IntArray.find ─────────────────────────────────────────────────────────────

describe('IntArray.find', () => {
    it('find(isEven).unwrapOr(-1) == 2  (first even in [1,2,3,4,5])',
        () => expect(lines()[15]).toBe('2'));
    it('find(x > 99).unwrapOr(-1) == -1 (no match)',
        () => expect(lines()[16]).toBe('-1'));
});

// ── IntArray.findIndex ────────────────────────────────────────────────────────

describe('IntArray.findIndex', () => {
    it('findIndex(isEven) == 1  (element 2 is at index 1)',
        () => expect(lines()[17]).toBe('1'));
    it('findIndex(gt3)    == 3  (element 4 is at index 3)',
        () => expect(lines()[18]).toBe('3'));
    it('findIndex(x > 99) == -1 (no match)',
        () => expect(lines()[19]).toBe('-1'));
});

// ── IntSet HOF ────────────────────────────────────────────────────────────────
// IntSet stores elements in ascending sorted order: 10, 20, 30 after add(30,10,20)

describe('IntSet.forEach', () => {
    it('prints sorted element 0 → 10', () => expect(lines()[20]).toBe('10'));
    it('prints sorted element 1 → 20', () => expect(lines()[21]).toBe('20'));
    it('prints sorted element 2 → 30', () => expect(lines()[22]).toBe('30'));
});

describe('IntSet.every', () => {
    it('every(isPositive) is true → prints 1', () => expect(lines()[23]).toBe('1'));
});

describe('IntSet.some', () => {
    it('some(isEven) is true → prints 1  (10, 20, 30 are even)',
        () => expect(lines()[24]).toBe('1'));
});

describe('IntSet.filter', () => {
    it('filter(isEven).size() == 3  (10, 20, 30 are all even)',
        () => expect(lines()[25]).toBe('3'));
});

describe('IntSet.find', () => {
    it('find(gt3).unwrapOr(-1) == 10  (first element > 3 in sorted order)',
        () => expect(lines()[26]).toBe('10'));
});

// ── StringArray HOF ───────────────────────────────────────────────────────────

describe('StringArray.some', () => {
    it('some(v == "hello") is true → prints 1', () => expect(lines()[27]).toBe('1'));
});

describe('StringArray.filter', () => {
    it('filter(v == "banana").length() == 1', () => expect(lines()[28]).toBe('1'));
});

describe('StringArray.find', () => {
    it('find(v == "hello").unwrapOr("none") == "hello"',
        () => expect(lines()[29]).toBe('hello'));
});

describe('StringArray.findIndex', () => {
    it('findIndex(v == "hello") == 1  ("hello" is at index 1 in ["hi","hello","banana"])',
        () => expect(lines()[30]).toBe('1'));
});
